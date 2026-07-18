import type { ControllerConfig, NetConfig, RocketConfig } from "./contracts";
import { clamp } from "./math";

const VARIABLES_PER_STEP = 5;

export type MpcFallbackReason =
  | "none"
  | "stale-input"
  | "strength-proxy"
  | "non-finite"
  | "not-converged";

export interface CooperativeMpcInput {
  rocketPositionM: [number, number];
  rocketVelocityMps: [number, number];
  netCenterM: [number, number];
  netCenterVelocityMps: [number, number];
  halfSpacingM: [number, number];
  halfSpacingRateMps: [number, number];
  predictedInterceptCenterM: [number, number];
  predictedRelativeInterceptVelocityMps: [number, number, number];
  timeToInterceptS: number;
  communicationAgeS: number;
}

export interface MpcDiagnostics {
  iterations: number;
  converged: boolean;
  fallbackReason: MpcFallbackReason;
  objective: number;
  projectedPeakLoadN: number;
  optimalityResidual: number;
  constraintActivations: number;
  activeConstraints: string[];
  baselineObjective: number;
  baselineTerminalErrorM: number;
  optimizedTerminalErrorM: number;
}

export interface CooperativeMpcSolution {
  rocketAccelerationReferenceMps2: [number, number];
  netAccelerationReferenceMps2: [number, number];
  halfSpacingClosureRateMps: number;
  predictedNetCenterAtInterceptM: [number, number];
  diagnostics: MpcDiagnostics;
}

interface RolloutResult {
  objective: number;
  rocketFinalM: [number, number];
  rocketFinalVelocityMps: [number, number];
  netFinalM: [number, number];
  netFinalVelocityMps: [number, number];
  spacingFinalM: number;
  terminalRelativeErrorM: number;
}

const finiteInput = (input: CooperativeMpcInput): boolean => [
  ...input.rocketPositionM,
  ...input.rocketVelocityMps,
  ...input.netCenterM,
  ...input.netCenterVelocityMps,
  ...input.halfSpacingM,
  ...input.halfSpacingRateMps,
  ...input.predictedInterceptCenterM,
  ...input.predictedRelativeInterceptVelocityMps,
  input.timeToInterceptS,
  input.communicationAgeS
].every(Number.isFinite);

const magnitudeClamp = (x: number, y: number, limit: number): [number, number, boolean] => {
  const magnitude = Math.hypot(x, y);
  if (magnitude <= limit || magnitude <= 1e-12) return [x, y, false];
  const scale = limit / magnitude;
  return [x * scale, y * scale, true];
};

/**
 * Small deterministic projected-gradient QP for the 20 Hz supervisory layer.
 * Local rocket and winch loops remain responsible for the 100 Hz tracking law.
 */
export class CooperativeMpcPlanner {
  private warmStart: Float64Array | null = null;

  public constructor(
    private readonly controller: ControllerConfig,
    private readonly rocket: RocketConfig,
    private readonly net: NetConfig
  ) {}

  public reset(): void {
    this.warmStart = null;
  }

  public solve(input: CooperativeMpcInput): CooperativeMpcSolution {
    const settings = this.controller.mpc;
    const horizon = settings.horizonSteps;
    const stepS = settings.stepS;
    const variableCount = horizon * VARIABLES_PER_STEP;
    const fallback = (
      reason: MpcFallbackReason,
      projectedPeakLoadN = Number.POSITIVE_INFINITY
    ): CooperativeMpcSolution => ({
      rocketAccelerationReferenceMps2: [0, 0],
      netAccelerationReferenceMps2: [0, 0],
      halfSpacingClosureRateMps: 0,
      predictedNetCenterAtInterceptM: [...input.netCenterM],
      diagnostics: {
        iterations: 0,
        converged: false,
        fallbackReason: reason,
        objective: Number.POSITIVE_INFINITY,
        projectedPeakLoadN,
        optimalityResidual: Number.POSITIVE_INFINITY,
        constraintActivations: 0,
        activeConstraints: [],
        baselineObjective: Number.POSITIVE_INFINITY,
        baselineTerminalErrorM: Number.POSITIVE_INFINITY,
        optimizedTerminalErrorM: Number.POSITIVE_INFINITY
      }
    });

    if (!finiteInput(input)) return fallback("non-finite");
    if (input.communicationAgeS > this.controller.staleTelemetryAbortS * 0.75) {
      return fallback("stale-input");
    }
    const projectedPeakLoadN =
      Math.abs(input.predictedRelativeInterceptVelocityMps[2]) *
        this.net.activeDampingMinNspm * 4 +
      this.net.totalStiffnessNpm * this.net.arrestDistanceM * 0.45;
    if (projectedPeakLoadN > this.net.totalStrengthLimitN) {
      return fallback("strength-proxy", projectedPeakLoadN);
    }

    const values = new Float64Array(variableCount);
    if (this.warmStart !== null && this.warmStart.length === variableCount) {
      for (let step = 0; step < horizon - 1; step += 1) {
        const source = (step + 1) * VARIABLES_PER_STEP;
        values.set(this.warmStart.subarray(source, source + VARIABLES_PER_STEP), step * VARIABLES_PER_STEP);
      }
      values.set(
        this.warmStart.subarray(variableCount - VARIABLES_PER_STEP),
        variableCount - VARIABLES_PER_STEP
      );
    }

    const effectiveSteps = Math.max(
      1,
      Math.min(horizon, Math.ceil(Math.max(stepS, input.timeToInterceptS) / stepS))
    );
    const timeHorizonS = effectiveSteps * stepS;

    // The 100 Hz rocket and net loops already implement the predictive baseline.
    // MPC therefore optimises bounded increments around those commands instead
    // of issuing a second full-authority absolute command on top of them.
    const rocketBaseline = magnitudeClamp(
      this.controller.rocketPositionKp *
          (input.predictedInterceptCenterM[0] - input.rocketPositionM[0]) -
        this.controller.rocketVelocityKd * input.rocketVelocityMps[0],
      this.controller.rocketPositionKp *
          (input.predictedInterceptCenterM[1] - input.rocketPositionM[1]) -
        this.controller.rocketVelocityKd * input.rocketVelocityMps[1],
      this.rocket.lateralAccelerationLimitMps2
    );
    const netBaseline = magnitudeClamp(
      this.controller.netCenterKp * (input.predictedInterceptCenterM[0] - input.netCenterM[0]) -
        this.controller.netCenterKd * input.netCenterVelocityMps[0],
      this.controller.netCenterKp * (input.predictedInterceptCenterM[1] - input.netCenterM[1]) -
        this.controller.netCenterKd * input.netCenterVelocityMps[1],
      this.net.winchMaxAccelerationMps2
    );
    const meanSpacingM = (input.halfSpacingM[0] + input.halfSpacingM[1]) / 2;
    const closureBaselineMps = clamp(
      (this.net.closedHalfSpacingM - meanSpacingM) / timeHorizonS,
      -this.net.winchMaxSpeedMps,
      this.net.winchMaxSpeedMps
    );
    const rocketTrustRadiusMps2 = Math.min(
      0.65,
      this.rocket.lateralAccelerationLimitMps2 * 0.2
    );
    const netTrustRadiusMps2 = Math.min(
      1.5,
      this.net.winchMaxAccelerationMps2 * 0.15
    );
    const closureTrustRadiusMps = Math.min(0.75, this.net.winchMaxSpeedMps * 0.15);

    const gradient = new Float64Array(variableCount);
    const weights = {
      increment: 2.4 + Math.min(4, input.communicationAgeS * 8),
      smooth: 0.35,
      relativePosition: 8,
      relativeVelocity: 1.4,
      netTarget: 3,
      spacing: 6
    };

    const rollout = (): RolloutResult => {
      const rocketPosition: [number, number] = [...input.rocketPositionM];
      const rocketVelocity: [number, number] = [...input.rocketVelocityMps];
      const netPosition: [number, number] = [...input.netCenterM];
      const netVelocity: [number, number] = [...input.netCenterVelocityMps];
      let spacingM = meanSpacingM;
      let objective = 0;
      for (let step = 0; step < effectiveSteps; step += 1) {
        const index = step * VARIABLES_PER_STEP;
        for (let variable = 0; variable < VARIABLES_PER_STEP; variable += 1) {
          const increment = values[index + variable] ?? 0;
          objective += weights.increment * increment * increment;
          if (step > 0) {
            const delta = (values[index + variable] ?? 0) -
              (values[index + variable - VARIABLES_PER_STEP] ?? 0);
            objective += weights.smooth * delta * delta;
          }
        }
        for (const axis of [0, 1] as const) {
          const rocketAccelerationMps2 = rocketBaseline[axis] + (values[index + axis] ?? 0);
          const netAccelerationMps2 = netBaseline[axis] + (values[index + 2 + axis] ?? 0);
          rocketVelocity[axis] += rocketAccelerationMps2 * stepS;
          rocketPosition[axis] += rocketVelocity[axis] * stepS;
          netVelocity[axis] += netAccelerationMps2 * stepS;
          netPosition[axis] += netVelocity[axis] * stepS;
        }
        spacingM += (closureBaselineMps + (values[index + 4] ?? 0)) * stepS;
      }
      const relativeError: [number, number] = [
        rocketPosition[0] - netPosition[0],
        rocketPosition[1] - netPosition[1]
      ];
      const relativeVelocityError: [number, number] = [
        rocketVelocity[0] - netVelocity[0],
        rocketVelocity[1] - netVelocity[1]
      ];
      const netTargetError: [number, number] = [
        netPosition[0] - input.predictedInterceptCenterM[0],
        netPosition[1] - input.predictedInterceptCenterM[1]
      ];
      const spacingError = spacingM - this.net.closedHalfSpacingM;
      objective += weights.relativePosition * (relativeError[0] ** 2 + relativeError[1] ** 2) +
        weights.relativeVelocity * (relativeVelocityError[0] ** 2 + relativeVelocityError[1] ** 2) +
        weights.netTarget * (netTargetError[0] ** 2 + netTargetError[1] ** 2) +
        weights.spacing * spacingError ** 2;
      return {
        objective,
        rocketFinalM: rocketPosition,
        rocketFinalVelocityMps: rocketVelocity,
        netFinalM: netPosition,
        netFinalVelocityMps: netVelocity,
        spacingFinalM: spacingM,
        terminalRelativeErrorM: Math.hypot(relativeError[0], relativeError[1])
      };
    };

    let constraintActivations = 0;
    const activeConstraints = new Set<string>();
    const project = (): void => {
      const netPosition: [number, number] = [...input.netCenterM];
      const netVelocity: [number, number] = [...input.netCenterVelocityMps];
      let spacingM = meanSpacingM;
      let previousClosureRate = (input.halfSpacingRateMps[0] + input.halfSpacingRateMps[1]) / 2;
      for (let step = 0; step < horizon; step += 1) {
        const index = step * VARIABLES_PER_STEP;
        if (step >= effectiveSteps) {
          values.fill(0, index, index + VARIABLES_PER_STEP);
          continue;
        }

        const rocketIncrementLimited = magnitudeClamp(
          values[index] ?? 0,
          values[index + 1] ?? 0,
          rocketTrustRadiusMps2
        );
        if (rocketIncrementLimited[2]) {
          constraintActivations += 1;
          activeConstraints.add("rocket-trust-region");
        }
        const rocketTotalLimited = magnitudeClamp(
          rocketBaseline[0] + rocketIncrementLimited[0],
          rocketBaseline[1] + rocketIncrementLimited[1],
          this.rocket.lateralAccelerationLimitMps2
        );
        values[index] = rocketTotalLimited[0] - rocketBaseline[0];
        values[index + 1] = rocketTotalLimited[1] - rocketBaseline[1];
        if (rocketTotalLimited[2]) {
          constraintActivations += 1;
          activeConstraints.add("rocket-lateral-acceleration");
        }

        const netIncrementLimited = magnitudeClamp(
          values[index + 2] ?? 0,
          values[index + 3] ?? 0,
          netTrustRadiusMps2
        );
        if (netIncrementLimited[2]) {
          constraintActivations += 1;
          activeConstraints.add("net-trust-region");
        }
        const netTotalLimited = magnitudeClamp(
          netBaseline[0] + netIncrementLimited[0],
          netBaseline[1] + netIncrementLimited[1],
          this.net.winchMaxAccelerationMps2
        );
        for (const axis of [0, 1] as const) {
          let acceleration = netTotalLimited[axis];
          const nextVelocity = clamp(
            netVelocity[axis] + acceleration * stepS,
            -this.net.winchMaxSpeedMps,
            this.net.winchMaxSpeedMps
          );
          if (nextVelocity !== netVelocity[axis] + acceleration * stepS) {
            constraintActivations += 1;
            activeConstraints.add("winch-speed");
          }
          acceleration = (nextVelocity - netVelocity[axis]) / stepS;
          let nextPosition = netPosition[axis] + nextVelocity * stepS;
          if (Math.abs(nextPosition) > this.net.centerTravelLimitM) {
            nextPosition = clamp(
              nextPosition,
              -this.net.centerTravelLimitM,
              this.net.centerTravelLimitM
            );
            acceleration = ((nextPosition - netPosition[axis]) / stepS - netVelocity[axis]) / stepS;
            constraintActivations += 1;
            activeConstraints.add("net-center-travel");
          }
          values[index + 2 + axis] = acceleration - netBaseline[axis];
          netVelocity[axis] += acceleration * stepS;
          netPosition[axis] += netVelocity[axis] * stepS;
        }

        const rateDeltaLimit = this.net.winchMaxAccelerationMps2 * stepS;
        const closureIncrement = clamp(
          values[index + 4] ?? 0,
          -closureTrustRadiusMps,
          closureTrustRadiusMps
        );
        if (closureIncrement !== (values[index + 4] ?? 0)) {
          constraintActivations += 1;
          activeConstraints.add("closure-trust-region");
        }
        let closureRate = clamp(
          closureBaselineMps + closureIncrement,
          previousClosureRate - rateDeltaLimit,
          previousClosureRate + rateDeltaLimit
        );
        closureRate = clamp(closureRate, -this.net.winchMaxSpeedMps, this.net.winchMaxSpeedMps);
        const nextSpacing = clamp(
          spacingM + closureRate * stepS,
          this.net.closedHalfSpacingM,
          this.net.openHalfSpacingM
        );
        if (nextSpacing !== spacingM + closureRate * stepS) {
          closureRate = (nextSpacing - spacingM) / stepS;
          constraintActivations += 1;
          activeConstraints.add("half-spacing");
        }
        values[index + 4] = closureRate - closureBaselineMps;
        previousClosureRate = closureRate;
        spacingM = nextSpacing;
      }
    };

    const savedWarmStart = new Float64Array(values);
    values.fill(0);
    project();
    const baseline = rollout();
    values.set(savedWarmStart);
    project();
    let converged = false;
    let iterations = 0;
    let previousObjective = Number.POSITIVE_INFINITY;
    let optimalityResidual = Number.POSITIVE_INFINITY;
    const learningRate = 0.08;
    for (let iteration = 0; iteration < settings.maximumIterations; iteration += 1) {
      iterations = iteration + 1;
      gradient.fill(0);
      const result = rollout();
      const relativeObjectiveChange = Math.abs(previousObjective - result.objective) /
        Math.max(1, Math.abs(previousObjective));
      const relativePositionError: [number, number] = [
        result.rocketFinalM[0] - result.netFinalM[0],
        result.rocketFinalM[1] - result.netFinalM[1]
      ];
      const relativeVelocityError: [number, number] = [
        result.rocketFinalVelocityMps[0] - result.netFinalVelocityMps[0],
        result.rocketFinalVelocityMps[1] - result.netFinalVelocityMps[1]
      ];
      const netTargetError: [number, number] = [
        result.netFinalM[0] - input.predictedInterceptCenterM[0],
        result.netFinalM[1] - input.predictedInterceptCenterM[1]
      ];
      const spacingError = result.spacingFinalM - this.net.closedHalfSpacingM;
      const previousValues = new Float64Array(values);
      for (let step = 0; step < effectiveSteps; step += 1) {
        const index = step * VARIABLES_PER_STEP;
        const remainingS = (effectiveSteps - step - 0.5) * stepS;
        for (let variable = 0; variable < VARIABLES_PER_STEP; variable += 1) {
          gradient[index + variable] = (gradient[index + variable] ?? 0) +
            2 * weights.increment * (values[index + variable] ?? 0);
          if (step > 0) {
            gradient[index + variable] = (gradient[index + variable] ?? 0) +
              2 * weights.smooth *
                ((values[index + variable] ?? 0) -
                  (values[index + variable - VARIABLES_PER_STEP] ?? 0));
          }
        }
        for (const axis of [0, 1] as const) {
          gradient[index + axis] = (gradient[index + axis] ?? 0) +
            2 * weights.relativePosition * relativePositionError[axis] * remainingS * stepS +
            2 * weights.relativeVelocity * relativeVelocityError[axis] * stepS;
          gradient[index + 2 + axis] = (gradient[index + 2 + axis] ?? 0) +
            -2 * weights.relativePosition * relativePositionError[axis] * remainingS * stepS -
            2 * weights.relativeVelocity * relativeVelocityError[axis] * stepS +
            2 * weights.netTarget * netTargetError[axis] * remainingS * stepS;
        }
        gradient[index + 4] = (gradient[index + 4] ?? 0) +
          2 * weights.spacing * spacingError * stepS;
      }
      for (let index = 0; index < values.length; index += 1) {
        const before = values[index] ?? 0;
        const rawGradient = gradient[index] ?? 0;
        values[index] = before - learningRate * rawGradient / (1 + Math.abs(rawGradient));
      }
      project();
      let maximumChange = 0;
      for (let index = 0; index < values.length; index += 1) {
        maximumChange = Math.max(
          maximumChange,
          Math.abs((values[index] ?? 0) - (previousValues[index] ?? 0))
        );
      }
      optimalityResidual = Math.min(maximumChange, relativeObjectiveChange);
      if (!Array.from(values).every(Number.isFinite)) return fallback("non-finite", projectedPeakLoadN);
      if (
        maximumChange <= settings.convergenceTolerance ||
        (iteration >= 2 && relativeObjectiveChange <= settings.convergenceTolerance)
      ) {
        converged = true;
        break;
      }
      previousObjective = result.objective;
    }

    const final = rollout();
    if (!Number.isFinite(final.objective)) return fallback("non-finite", projectedPeakLoadN);
    // A deterministic bounded iteration budget is intentional. Accept a finite
    // stationary iterate only when the final improvement threshold was met.
    if (!converged) {
      const failed = fallback("not-converged", projectedPeakLoadN);
      failed.diagnostics.iterations = iterations;
      failed.diagnostics.objective = final.objective;
      failed.diagnostics.optimalityResidual = optimalityResidual;
      failed.diagnostics.constraintActivations = constraintActivations;
      failed.diagnostics.activeConstraints = [...activeConstraints].sort();
      failed.diagnostics.baselineObjective = baseline.objective;
      failed.diagnostics.baselineTerminalErrorM = baseline.terminalRelativeErrorM;
      failed.diagnostics.optimizedTerminalErrorM = final.terminalRelativeErrorM;
      return failed;
    }
    this.warmStart = new Float64Array(values);
    return {
      rocketAccelerationReferenceMps2: [values[0] ?? 0, values[1] ?? 0],
      netAccelerationReferenceMps2: [values[2] ?? 0, values[3] ?? 0],
      halfSpacingClosureRateMps: values[4] ?? 0,
      predictedNetCenterAtInterceptM: [...final.netFinalM],
      diagnostics: {
        iterations,
        converged: true,
        fallbackReason: "none",
        objective: final.objective,
        projectedPeakLoadN,
        optimalityResidual,
        constraintActivations,
        activeConstraints: [...activeConstraints].sort(),
        baselineObjective: baseline.objective,
        baselineTerminalErrorM: baseline.terminalRelativeErrorM,
        optimizedTerminalErrorM: final.terminalRelativeErrorM
      }
    };
  }
}
