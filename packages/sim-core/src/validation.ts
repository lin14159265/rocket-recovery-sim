import type { RecoveryMetrics, ScenarioConfig, SimulationRun, Vec3 } from "./contracts";
import { dot3, norm3, sub3 } from "./math";
import { runSimulation } from "./simulation";

export type ValidationQuality = "good" | "caution" | "poor";

export interface ValidationProgress {
  completed: number;
  total: number;
  label: string;
}

export interface StepConvergenceCase {
  physicsDtS: number;
  finalTimeS: number;
  captured: boolean;
  secured: boolean;
  failed: boolean;
  metrics: RecoveryMetrics;
  finalRelativePositionM: Vec3;
  finalRelativeSpeedMps: number;
}

export interface StepConvergenceComparison {
  coarseDtS: number;
  fineDtS: number;
  differences: {
    missDistance: number;
    captureRelativeSpeed: number;
    peakContactForce: number;
    finalRelativePosition: number;
    finalRelativeSpeed: number;
  };
  maximumNormalizedDifference: number;
  categoricalAgreement: boolean;
}

export interface StepConvergenceReport {
  cases: StepConvergenceCase[];
  comparisons: StepConvergenceComparison[];
  quality: ValidationQuality;
  interpretation: string;
}

export interface EnergyBalanceReport {
  contactDetected: boolean;
  startTimeS: number | null;
  endTimeS: number;
  initialRelativeKineticJ: number;
  finalRelativeKineticJ: number;
  gravitationalReleaseJ: number;
  contactWorkProxyJ: number;
  contactDissipationProxyJ: number;
  finalElasticProxyJ: number;
  unobservedResidualJ: number;
  normalizedResidual: number;
  quality: ValidationQuality;
  interpretation: string;
}

export interface ValidationSuiteResult {
  modelNotice: string;
  convergence: StepConvergenceReport;
  energy: EnergyBalanceReport;
}

export interface ValidationSuiteOptions {
  onProgress?: (progress: ValidationProgress) => void;
}

const normalizedDifference = (coarse: number, fine: number, floor: number): number =>
  Math.abs(coarse - fine) / Math.max(Math.abs(fine), floor);

const relativePosition = (run: SimulationRun): Vec3 =>
  sub3(run.finalSnapshot.rocket.positionM, run.finalSnapshot.platform.positionM);

const toCase = (run: SimulationRun): StepConvergenceCase => ({
  physicsDtS: run.config.physicsDtS,
  finalTimeS: run.finalSnapshot.timeS,
  captured: run.metrics.captured,
  secured: run.metrics.secured,
  failed: run.metrics.failed,
  metrics: structuredClone(run.metrics),
  finalRelativePositionM: relativePosition(run),
  finalRelativeSpeedMps: norm3(
    sub3(run.finalSnapshot.rocket.velocityMps, run.finalSnapshot.platform.velocityMps)
  )
});

const compareCases = (
  coarse: StepConvergenceCase,
  fine: StepConvergenceCase
): StepConvergenceComparison => {
  const positionDelta = norm3(sub3(coarse.finalRelativePositionM, fine.finalRelativePositionM));
  const differences = {
    missDistance: normalizedDifference(coarse.metrics.missDistanceM, fine.metrics.missDistanceM, 0.1),
    captureRelativeSpeed: normalizedDifference(
      coarse.metrics.captureRelativeSpeedMps,
      fine.metrics.captureRelativeSpeedMps,
      0.5
    ),
    peakContactForce: normalizedDifference(
      coarse.metrics.peakContactForceN,
      fine.metrics.peakContactForceN,
      10_000
    ),
    finalRelativePosition: positionDelta / Math.max(norm3(fine.finalRelativePositionM), 0.1),
    finalRelativeSpeed: normalizedDifference(
      coarse.finalRelativeSpeedMps,
      fine.finalRelativeSpeedMps,
      0.1
    )
  };
  return {
    coarseDtS: coarse.physicsDtS,
    fineDtS: fine.physicsDtS,
    differences,
    maximumNormalizedDifference: Math.max(...Object.values(differences)),
    categoricalAgreement:
      coarse.captured === fine.captured &&
      coarse.secured === fine.secured &&
      coarse.failed === fine.failed
  };
};

const convergenceQuality = (
  comparisons: readonly StepConvergenceComparison[]
): ValidationQuality => {
  const categorical = comparisons.every((comparison) => comparison.categoricalAgreement);
  const maximum = Math.max(0, ...comparisons.map((comparison) => comparison.maximumNormalizedDifference));
  if (categorical && maximum <= 0.05) return "good";
  if (categorical && maximum <= 0.15) return "caution";
  return "poor";
};

export const runStepConvergenceStudy = (
  config: ScenarioConfig,
  onProgress?: (progress: ValidationProgress) => void
): StepConvergenceReport => {
  const timeSteps = [config.physicsDtS, config.physicsDtS / 2, config.physicsDtS / 4];
  const cases: StepConvergenceCase[] = [];
  for (const [index, physicsDtS] of timeSteps.entries()) {
    const next = structuredClone(config);
    next.physicsDtS = physicsDtS;
    next.id = `${config.id}-dt-${physicsDtS}`;
    const run = runSimulation(next, { frameRateHz: 20, stopOnTerminal: true });
    cases.push(toCase(run));
    onProgress?.({
      completed: index + 1,
      total: timeSteps.length + 1,
      label: `步长 ${physicsDtS.toFixed(6)} s 完成`
    });
  }
  const comparisons = [
    compareCases(cases[0]!, cases[1]!),
    compareCases(cases[1]!, cases[2]!)
  ];
  const quality = convergenceQuality(comparisons);
  return {
    cases,
    comparisons,
    quality,
    interpretation: quality === "good"
      ? "终态分类一致，关键连续指标随步长减半的变化不超过 5%。"
      : quality === "caution"
        ? "终态分类一致，但至少一个关键指标仍有 5%–15% 的步长敏感性。"
        : "终态分类或关键指标对步长明显敏感；不应据此给出定量工程结论。"
  };
};

const relativeVelocity = (frame: SimulationRun["frames"][number]): Vec3 =>
  sub3(frame.rocket.velocityMps, frame.platform.velocityMps);

const relativeAltitude = (frame: SimulationRun["frames"][number]): number =>
  frame.rocket.positionM[2] - frame.platform.positionM[2];

/**
 * Builds a transparent contact-phase proxy ledger. It deliberately leaves
 * aerodynamic, rotational, actuator and discretization terms in the residual.
 */
export const evaluateEnergyBalance = (run: SimulationRun): EnergyBalanceReport => {
  const contactIndex = run.frames.findIndex(
    (frame) => norm3(frame.net.totalContactForceN) > 100 ||
      ["latched", "arresting", "secured", "broken"].includes(frame.net.mode)
  );
  if (contactIndex < 0) {
    return {
      contactDetected: false,
      startTimeS: null,
      endTimeS: run.finalSnapshot.timeS,
      initialRelativeKineticJ: 0,
      finalRelativeKineticJ: 0,
      gravitationalReleaseJ: 0,
      contactWorkProxyJ: 0,
      contactDissipationProxyJ: 0,
      finalElasticProxyJ: 0,
      unobservedResidualJ: 0,
      normalizedResidual: 0,
      quality: "caution",
      interpretation: "未发生接触，无法建立接触阶段能量账本。"
    };
  }

  const start = run.frames[Math.max(0, contactIndex - 1)]!;
  const end = run.finalSnapshot;
  const massKg = start.rocket.massKg;
  const initialRelativeKineticJ = 0.5 * massKg * dot3(relativeVelocity(start), relativeVelocity(start));
  const finalRelativeKineticJ = 0.5 * end.rocket.massKg * dot3(relativeVelocity(end), relativeVelocity(end));
  const gravitationalReleaseJ = Math.max(
    0,
    massKg * run.config.environment.gravityMps2 * (relativeAltitude(start) - relativeAltitude(end))
  );

  let contactWorkProxyJ = 0;
  for (let index = Math.max(1, contactIndex); index < run.frames.length; index += 1) {
    const previous = run.frames[index - 1]!;
    const current = run.frames[index]!;
    const dtS = current.timeS - previous.timeS;
    if (dtS <= 0) continue;
    const previousPower = -dot3(previous.net.totalContactForceN, relativeVelocity(previous));
    const currentPower = -dot3(current.net.totalContactForceN, relativeVelocity(current));
    contactWorkProxyJ += (previousPower + currentPower) * 0.5 * dtS;
  }

  contactWorkProxyJ = Math.max(0, contactWorkProxyJ);
  const finalElasticProxyJ = 0.5 * run.config.net.totalStiffnessNpm * end.net.payoutM ** 2;
  // The signed contact work contains both recoverable spring storage and
  // irreversible damping. Subtracting the final elastic proxy avoids counting
  // the stored spring term twice in the ledger.
  const contactDissipationProxyJ = Math.max(0, contactWorkProxyJ - finalElasticProxyJ);
  const availableJ = initialRelativeKineticJ + gravitationalReleaseJ;
  const accountedJ = finalRelativeKineticJ + contactDissipationProxyJ + finalElasticProxyJ;
  const unobservedResidualJ = availableJ - accountedJ;
  const normalizedResidual = Math.abs(unobservedResidualJ) / Math.max(availableJ, 1);
  const quality: ValidationQuality = normalizedResidual <= 0.15
    ? "good"
    : normalizedResidual <= 0.35 ? "caution" : "poor";

  return {
    contactDetected: true,
    startTimeS: start.timeS,
    endTimeS: end.timeS,
    initialRelativeKineticJ,
    finalRelativeKineticJ,
    gravitationalReleaseJ,
    contactWorkProxyJ,
    contactDissipationProxyJ,
    finalElasticProxyJ,
    unobservedResidualJ,
    normalizedResidual,
    quality,
    interpretation: quality === "good"
      ? "接触阶段代理能量账本残差低于 15%；仍不等同于结构能量守恒认证。"
      : quality === "caution"
        ? "代理账本存在 15%–35% 未观测残差，需关注气动、转动与离散化项。"
        : "代理账本残差超过 35%；当前结果只能用于定性闭环演示。"
  };
};

export const runValidationSuite = (
  config: ScenarioConfig,
  options: ValidationSuiteOptions = {}
): ValidationSuiteResult => {
  const convergence = runStepConvergenceStudy(config, options.onProgress);
  const energyRun = runSimulation(config, { frameRateHz: 100, stopOnTerminal: true });
  options.onProgress?.({ completed: 4, total: 4, label: "能量账本完成" });
  return {
    modelNotice: "验证结果仅适用于当前公开机理代理模型，不构成真实型号验证。",
    convergence,
    energy: evaluateEnergyBalance(energyRun)
  };
};
