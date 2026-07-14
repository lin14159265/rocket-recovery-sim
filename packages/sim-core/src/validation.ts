import type { RecoveryMetrics, ScenarioConfig, SimulationRun, Vec3 } from "./contracts";
import { norm3, sub3 } from "./math";
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
  comparisonTimeS: number;
  stochasticTermsDisabled: string[];
  interpretation: string;
}

export interface EnergyBalanceReport {
  contactDetected: boolean;
  startTimeS: number | null;
  endTimeS: number;
  physicsStepCount: number;
  initialRelativeKineticJ: number;
  finalRelativeKineticJ: number;
  gravitationalReleaseJ: number;
  contactWorkProxyJ: number;
  contactDissipationProxyJ: number;
  initialElasticProxyJ: number;
  finalElasticProxyJ: number;
  thrustWorkJ: number;
  aerodynamicWorkJ: number;
  platformBoundaryWorkJ: number;
  translationalWorkResidualJ: number;
  normalizedTranslationalResidual: number;
  rotationalWorkResidualJ: number;
  normalizedRotationalResidual: number;
  gravityPotentialResidualJ: number;
  normalizedGravityPotentialResidual: number;
  contactPartitionResidualJ: number;
  normalizedContactPartitionResidual: number;
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

const createDeterministicConvergenceScenario = (config: ScenarioConfig): ScenarioConfig => {
  const next = structuredClone(config);
  next.environment.gustSigmaMps = 0;
  next.sensors.rocketPositionNoiseM = 0;
  next.sensors.rocketVelocityNoiseMps = 0;
  next.sensors.groundPositionNoiseM = 0;
  next.sensors.groundVelocityNoiseMps = 0;
  for (const link of [next.radio, next.fieldbus]) {
    link.jitterMs = 0;
    link.lossRate = 0;
    link.duplicateRate = 0;
    link.corruptionRate = 0;
  }
  next.parameterSources["validation.convergence"] = {
    status: "assumed",
    source: "v0.3.1 数值验证方法",
    note: "步长收敛运行关闭随机阵风、传感器噪声和随机链路事件，仅比较积分步长影响"
  };
  return next;
};

export const runStepConvergenceStudy = (
  config: ScenarioConfig,
  onProgress?: (progress: ValidationProgress) => void
): StepConvergenceReport => {
  const deterministic = createDeterministicConvergenceScenario(config);
  const timeSteps = [config.physicsDtS, config.physicsDtS / 2, config.physicsDtS / 4];
  const cases: StepConvergenceCase[] = [];
  for (const [index, physicsDtS] of timeSteps.entries()) {
    const next = structuredClone(deterministic);
    next.physicsDtS = physicsDtS;
    next.id = `${config.id}-deterministic-dt-${physicsDtS}`;
    // All cases run to the same physical end time. A terminal state does not
    // shorten one trajectory and thereby invalidate the final-state comparison.
    const run = runSimulation(next, { frameRateHz: 2, stopOnTerminal: false });
    cases.push(toCase(run));
    onProgress?.({
      completed: index + 1,
      total: timeSteps.length + 1,
      label: `确定性步长 ${physicsDtS.toFixed(6)} s 完成`
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
    comparisonTimeS: config.durationS,
    stochasticTermsDisabled: [
      "阵风随机过程",
      "箭上与地面传感器随机噪声",
      "无线与现场总线的抖动、丢包、重复和损坏"
    ],
    interpretation: quality === "good"
      ? "在相同物理终止时刻和无随机扰动条件下，终态分类一致，关键连续指标变化不超过 5%。"
      : quality === "caution"
        ? "终态分类一致，但至少一个关键指标仍有 5%–15% 的纯步长敏感性。"
        : "终态分类或关键指标对积分步长明显敏感；不应据此给出定量工程结论。"
  };
};

const normalizedResidual = (residual: number, ...scales: number[]): number =>
  Math.abs(residual) / Math.max(1, ...scales.map((value) => Math.abs(value)));

/**
 * Evaluates a physics-tick ledger accumulated inside the simulation loop.
 * It reports three separate closures instead of using display-frame samples:
 * translational work-energy, rotational work-energy, and contact storage/damping.
 */
export const evaluateEnergyBalance = (run: SimulationRun): EnergyBalanceReport => {
  const ledger = run.energyLedger;
  if (!ledger.contactDetected) {
    return {
      contactDetected: false,
      startTimeS: null,
      endTimeS: run.finalSnapshot.timeS,
      physicsStepCount: 0,
      initialRelativeKineticJ: 0,
      finalRelativeKineticJ: 0,
      gravitationalReleaseJ: 0,
      contactWorkProxyJ: 0,
      contactDissipationProxyJ: 0,
      initialElasticProxyJ: 0,
      finalElasticProxyJ: 0,
      thrustWorkJ: 0,
      aerodynamicWorkJ: 0,
      platformBoundaryWorkJ: 0,
      translationalWorkResidualJ: 0,
      normalizedTranslationalResidual: 0,
      rotationalWorkResidualJ: 0,
      normalizedRotationalResidual: 0,
      gravityPotentialResidualJ: 0,
      normalizedGravityPotentialResidual: 0,
      contactPartitionResidualJ: 0,
      normalizedContactPartitionResidual: 0,
      unobservedResidualJ: 0,
      normalizedResidual: 0,
      quality: "caution",
      interpretation: "未发生接触，无法建立接触阶段的物理 tick 能量账本。"
    };
  }

  const translationalDeltaJ =
    ledger.finalTranslationalKineticJ - ledger.initialTranslationalKineticJ;
  const forceWorkJ =
    ledger.gravityWorkJ + ledger.thrustWorkJ + ledger.aerodynamicWorkJ +
    ledger.contactWorkOnRocketJ;
  const translationalWorkResidualJ = translationalDeltaJ - forceWorkJ;
  const normalizedTranslationalResidual = normalizedResidual(
    translationalWorkResidualJ,
    translationalDeltaJ,
    forceWorkJ,
    ledger.initialTranslationalKineticJ
  );

  const rotationalDeltaJ = ledger.finalRotationalKineticJ - ledger.initialRotationalKineticJ;
  const rotationalWorkResidualJ = rotationalDeltaJ - ledger.controlTorqueWorkJ;
  const normalizedRotationalResidual = normalizedResidual(
    rotationalWorkResidualJ,
    rotationalDeltaJ,
    ledger.controlTorqueWorkJ,
    ledger.initialRotationalKineticJ,
    1_000
  );

  const potentialDeltaJ =
    ledger.finalGravitationalPotentialJ - ledger.initialGravitationalPotentialJ;
  const gravityPotentialResidualJ = potentialDeltaJ + ledger.gravityWorkJ;
  const normalizedGravityPotentialResidual = normalizedResidual(
    gravityPotentialResidualJ,
    potentialDeltaJ,
    ledger.gravityWorkJ
  );

  const elasticDeltaJ = ledger.finalElasticStorageJ - ledger.initialElasticStorageJ;
  const contactPartitionResidualJ = ledger.relativeContactWorkExtractedJ -
    ledger.contactDampingDissipationJ - elasticDeltaJ;
  const normalizedContactPartitionResidual = normalizedResidual(
    contactPartitionResidualJ,
    ledger.relativeContactWorkExtractedJ,
    ledger.contactDampingDissipationJ,
    elasticDeltaJ,
    ledger.initialRelativeKineticJ
  );

  const maximumNormalizedResidual = Math.max(
    normalizedTranslationalResidual,
    normalizedRotationalResidual,
    normalizedGravityPotentialResidual,
    normalizedContactPartitionResidual
  );
  const quality: ValidationQuality = maximumNormalizedResidual <= 0.05
    ? "good"
    : maximumNormalizedResidual <= 0.15 ? "caution" : "poor";

  return {
    contactDetected: true,
    startTimeS: ledger.startTimeS,
    endTimeS: ledger.endTimeS,
    physicsStepCount: ledger.physicsStepCount,
    initialRelativeKineticJ: ledger.initialRelativeKineticJ,
    finalRelativeKineticJ: ledger.finalRelativeKineticJ,
    gravitationalReleaseJ: Math.max(
      0,
      ledger.initialGravitationalPotentialJ - ledger.finalGravitationalPotentialJ
    ),
    contactWorkProxyJ: ledger.relativeContactWorkExtractedJ,
    contactDissipationProxyJ: ledger.contactDampingDissipationJ,
    initialElasticProxyJ: ledger.initialElasticStorageJ,
    finalElasticProxyJ: ledger.finalElasticStorageJ,
    thrustWorkJ: ledger.thrustWorkJ,
    aerodynamicWorkJ: ledger.aerodynamicWorkJ,
    platformBoundaryWorkJ: ledger.platformBoundaryWorkJ,
    translationalWorkResidualJ,
    normalizedTranslationalResidual,
    rotationalWorkResidualJ,
    normalizedRotationalResidual,
    gravityPotentialResidualJ,
    normalizedGravityPotentialResidual,
    contactPartitionResidualJ,
    normalizedContactPartitionResidual,
    unobservedResidualJ: contactPartitionResidualJ,
    normalizedResidual: maximumNormalizedResidual,
    quality,
    interpretation: quality === "good"
      ? "物理 tick 级平动、转动、重力势能与接触分区账本的最大归一残差低于 5%；仍不等同于结构认证。"
      : quality === "caution"
        ? "物理 tick 账本最大归一残差为 5%–15%，可用于代理模型诊断但不宜外推。"
        : "至少一个物理 tick 能量闭合项残差超过 15%；当前定量结果需先排查模型或离散化。"
  };
};

export const runValidationSuite = (
  config: ScenarioConfig,
  options: ValidationSuiteOptions = {}
): ValidationSuiteResult => {
  const convergence = runStepConvergenceStudy(config, options.onProgress);
  const energyRun = runSimulation(config, { frameRateHz: 2, stopOnTerminal: true });
  options.onProgress?.({ completed: 4, total: 4, label: "物理 tick 能量账本完成" });
  return {
    modelNotice: "验证结果仅适用于当前公开机理代理模型，不构成真实型号验证。",
    convergence,
    energy: evaluateEnergyBalance(energyRun)
  };
};
