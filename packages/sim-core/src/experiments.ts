import type { AlgorithmMode, MpcFallbackCounts, ScenarioConfig } from "./contracts";
import { DeterministicRng } from "./engine/rng";
import { runSimulation, type SimulationOptions } from "./simulation";

export const ALGORITHM_VARIANTS = [
  "fixed",
  "alpha-beta",
  "predictive",
  "mpc"
] as const satisfies readonly AlgorithmMode[];

export type NumericRange = readonly [minimum: number, maximum: number];

/**
 * Bounded study ranges used by the local comparison experiment.
 *
 * The values are research assumptions. They are deliberately kept separate
 * from the nominal scenario and are not claims about the flight vehicle.
 */
export interface PerturbationBounds {
  initialLateralPositionDeltaM: NumericRange;
  initialLateralVelocityDeltaMps: NumericRange;
  meanWindDeltaMps: NumericRange;
  gustSigmaMps: NumericRange;
  massScale: NumericRange;
  sensorPositionBiasDeltaM: NumericRange;
  radioBaseLatencyMs: NumericRange;
  radioJitterMs: NumericRange;
  radioLossRate: NumericRange;
}

export const DEFAULT_PERTURBATION_BOUNDS: PerturbationBounds = {
  initialLateralPositionDeltaM: [-6, 6],
  initialLateralVelocityDeltaMps: [-1.5, 1.5],
  meanWindDeltaMps: [-3, 3],
  gustSigmaMps: [1, 3],
  massScale: [0.92, 1.08],
  sensorPositionBiasDeltaM: [-0.45, 0.45],
  radioBaseLatencyMs: [30, 140],
  radioJitterMs: [5, 50],
  radioLossRate: [0, 0.1]
};

export interface ScenarioPerturbation {
  sampleIndex: number;
  seed: number;
  initialLateralPositionDeltaM: [number, number];
  initialLateralVelocityDeltaMps: [number, number];
  meanWindDeltaMps: [number, number];
  gustSigmaMps: number;
  massScale: number;
  sensorPositionBiasDeltaM: [number, number, number];
  radioBaseLatencyMs: number;
  radioJitterMs: number;
  radioLossRate: number;
}

export interface ExperimentTrialResult {
  algorithm: AlgorithmMode;
  sampleIndex: number;
  scenarioSeed: number;
  captured: boolean;
  secured: boolean;
  failed: boolean;
  peakLoadN: number;
  /** Null means the run ended before a physical capture-plane evaluation. */
  missDistanceM: number | null;
  failureReason: string | null;
  failureStage: FailureStage;
  capturePlaneCenterErrorM: number;
  captureRelativeSpeedMps: number;
  captureTiltRad: number;
  predictionTimeErrorS: number;
  mpcFallbackCount: number;
  mpcFallbackReasons: MpcFallbackCounts;
}

export type FailureStage =
  | "none"
  | "estimation"
  | "unreachable"
  | "handshake"
  | "missed"
  | "overspeed"
  | "attitude"
  | "rope-break"
  | "captured-not-secured";

export interface AlgorithmExperimentSummary {
  algorithm: AlgorithmMode;
  runs: number;
  captures: number;
  secured: number;
  captureRate: number;
  securedRate: number;
  meanPeakLoadN: number;
  p95PeakLoadN: number;
  missEvaluatedRuns: number;
  meanMissDistanceM: number | null;
  failureReasons: Record<string, number>;
  failureStages: Record<FailureStage, number>;
  mpcFallbackCount: number;
  mpcFallbackReasons: MpcFallbackCounts;
}

export interface AlgorithmComparisonProgress {
  completed: number;
  total: number;
  algorithm: AlgorithmMode;
  sampleIndex: number;
  label: string;
}

export interface AlgorithmComparisonOptions {
  samplesPerVariant?: number;
  seed?: number;
  bounds?: Partial<PerturbationBounds>;
  simulationOptions?: SimulationOptions;
  onProgress?: (progress: AlgorithmComparisonProgress) => void;
}

export interface AlgorithmComparisonResult {
  seed: number;
  samplesPerVariant: number;
  bounds: PerturbationBounds;
  perturbations: ScenarioPerturbation[];
  trials: ExperimentTrialResult[];
  variants: AlgorithmExperimentSummary[];
}

const assertRange = (range: NumericRange, label: string): void => {
  if (
    range.length !== 2 ||
    !Number.isFinite(range[0]) ||
    !Number.isFinite(range[1]) ||
    range[1] < range[0]
  ) {
    throw new RangeError(`${label} must be a finite ascending range`);
  }
};

const copyRange = (range: NumericRange): [number, number] => [range[0], range[1]];

const resolveBounds = (partial: Partial<PerturbationBounds> = {}): PerturbationBounds => {
  const bounds: PerturbationBounds = {
    initialLateralPositionDeltaM: copyRange(
      partial.initialLateralPositionDeltaM ??
        DEFAULT_PERTURBATION_BOUNDS.initialLateralPositionDeltaM
    ),
    initialLateralVelocityDeltaMps: copyRange(
      partial.initialLateralVelocityDeltaMps ??
        DEFAULT_PERTURBATION_BOUNDS.initialLateralVelocityDeltaMps
    ),
    meanWindDeltaMps: copyRange(
      partial.meanWindDeltaMps ?? DEFAULT_PERTURBATION_BOUNDS.meanWindDeltaMps
    ),
    gustSigmaMps: copyRange(
      partial.gustSigmaMps ?? DEFAULT_PERTURBATION_BOUNDS.gustSigmaMps
    ),
    massScale: copyRange(
      partial.massScale ?? DEFAULT_PERTURBATION_BOUNDS.massScale
    ),
    sensorPositionBiasDeltaM: copyRange(
      partial.sensorPositionBiasDeltaM ??
        DEFAULT_PERTURBATION_BOUNDS.sensorPositionBiasDeltaM
    ),
    radioBaseLatencyMs: copyRange(
      partial.radioBaseLatencyMs ?? DEFAULT_PERTURBATION_BOUNDS.radioBaseLatencyMs
    ),
    radioJitterMs: copyRange(
      partial.radioJitterMs ?? DEFAULT_PERTURBATION_BOUNDS.radioJitterMs
    ),
    radioLossRate: copyRange(
      partial.radioLossRate ?? DEFAULT_PERTURBATION_BOUNDS.radioLossRate
    )
  };

  for (const [label, range] of Object.entries(bounds)) {
    assertRange(range, label);
  }
  if (bounds.massScale[0] <= 0) {
    throw new RangeError("massScale must remain greater than zero");
  }
  if (bounds.gustSigmaMps[0] < 0) {
    throw new RangeError("gustSigmaMps cannot be negative");
  }
  if (bounds.radioBaseLatencyMs[0] < 0 || bounds.radioJitterMs[0] < 0) {
    throw new RangeError("radio latency and jitter cannot be negative");
  }
  if (bounds.radioLossRate[0] < 0 || bounds.radioLossRate[1] > 1) {
    throw new RangeError("radioLossRate must stay within [0, 1]");
  }
  return bounds;
};

const sample = (rng: DeterministicRng, range: NumericRange): number =>
  rng.uniform(range[0], range[1]);

/** Produces a stable perturbation matrix; the same rows can be paired across algorithms. */
export const generateScenarioPerturbations = (
  sampleCount: number,
  seed: number,
  partialBounds: Partial<PerturbationBounds> = {}
): ScenarioPerturbation[] => {
  if (!Number.isSafeInteger(sampleCount) || sampleCount <= 0) {
    throw new RangeError("sampleCount must be a positive safe integer");
  }
  if (!Number.isSafeInteger(seed)) {
    throw new RangeError("experiment seed must be a safe integer");
  }
  const bounds = resolveBounds(partialBounds);
  const rng = new DeterministicRng(seed);
  const perturbations: ScenarioPerturbation[] = [];

  for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
    perturbations.push({
      sampleIndex,
      seed: rng.nextUint32(),
      initialLateralPositionDeltaM: [
        sample(rng, bounds.initialLateralPositionDeltaM),
        sample(rng, bounds.initialLateralPositionDeltaM)
      ],
      initialLateralVelocityDeltaMps: [
        sample(rng, bounds.initialLateralVelocityDeltaMps),
        sample(rng, bounds.initialLateralVelocityDeltaMps)
      ],
      meanWindDeltaMps: [
        sample(rng, bounds.meanWindDeltaMps),
        sample(rng, bounds.meanWindDeltaMps)
      ],
      gustSigmaMps: sample(rng, bounds.gustSigmaMps),
      massScale: sample(rng, bounds.massScale),
      sensorPositionBiasDeltaM: [
        sample(rng, bounds.sensorPositionBiasDeltaM),
        sample(rng, bounds.sensorPositionBiasDeltaM),
        sample(rng, bounds.sensorPositionBiasDeltaM)
      ],
      radioBaseLatencyMs: sample(rng, bounds.radioBaseLatencyMs),
      radioJitterMs: sample(rng, bounds.radioJitterMs),
      radioLossRate: sample(rng, bounds.radioLossRate)
    });
  }
  return perturbations;
};

/** Applies one row to a clone, preserving the caller's baseline configuration. */
export const applyScenarioPerturbation = (
  baseline: ScenarioConfig,
  perturbation: ScenarioPerturbation
): ScenarioConfig => {
  const config = structuredClone(baseline);
  config.id = `${baseline.id}-sample-${perturbation.sampleIndex + 1}`;
  config.name = `${baseline.name} · 扰动样本 ${perturbation.sampleIndex + 1}`;
  config.seed = perturbation.seed;

  config.rocket.initialPositionM[0] += perturbation.initialLateralPositionDeltaM[0];
  config.rocket.initialPositionM[1] += perturbation.initialLateralPositionDeltaM[1];
  config.rocket.initialVelocityMps[0] += perturbation.initialLateralVelocityDeltaMps[0];
  config.rocket.initialVelocityMps[1] += perturbation.initialLateralVelocityDeltaMps[1];
  config.rocket.massKg *= perturbation.massScale;
  config.rocket.inertiaKgM2 = config.rocket.inertiaKgM2.map(
    (inertia) => inertia * perturbation.massScale
  ) as [number, number, number];

  config.environment.meanWindMps[0] += perturbation.meanWindDeltaMps[0];
  config.environment.meanWindMps[1] += perturbation.meanWindDeltaMps[1];
  config.environment.gustSigmaMps = perturbation.gustSigmaMps;

  config.sensors.positionBiasM[0] += perturbation.sensorPositionBiasDeltaM[0];
  config.sensors.positionBiasM[1] += perturbation.sensorPositionBiasDeltaM[1];
  config.sensors.positionBiasM[2] += perturbation.sensorPositionBiasDeltaM[2];

  config.radio.baseLatencyMs = perturbation.radioBaseLatencyMs;
  config.radio.jitterMs = perturbation.radioJitterMs;
  config.radio.lossRate = perturbation.radioLossRate;
  config.parameterSources["experiment.perturbations"] = {
    status: "assumed",
    source: "本地确定性有界抽样",
    note: "仅用于候选算法压力对照，不是型号参数分布"
  };
  return config;
};

const hasCapturePlaneEvaluation = (trial: {
  captured: boolean;
  missDistanceM: number;
  captureRelativeSpeedMps: number;
  captureTiltRad: number;
}): boolean =>
  trial.captured ||
  trial.missDistanceM > 0 ||
  trial.captureRelativeSpeedMps > 0 ||
  trial.captureTiltRad > 0;

const reasonForUnsecuredRun = (
  secured: boolean,
  captured: boolean,
  failureReason: string | null
): string | null => {
  if (secured) return null;
  if (failureReason !== null) return failureReason;
  return captured ? "captured-but-not-secured" : "capture-not-evaluated";
};

export const classifyFailureStage = (
  secured: boolean,
  captured: boolean,
  reason: string | null
): FailureStage => {
  if (secured) return "none";
  const normalized = reason?.toLowerCase() ?? "";
  if (normalized.includes("strength") || normalized.includes("rope") || normalized.includes("broken")) {
    return "rope-break";
  }
  if (captured) return "captured-not-secured";
  if (normalized.includes("speed")) return "overspeed";
  if (normalized.includes("tilt") || normalized.includes("attitude")) return "attitude";
  if (normalized.includes("telemetry") || normalized.includes("estimate") || normalized.includes("navigation")) {
    return "estimation";
  }
  if (normalized.includes("prepare") || normalized.includes("ready") || normalized.includes("window")) {
    return "handshake";
  }
  if (normalized.includes("unreachable") || normalized.includes("not-closed") || normalized.includes("not-closing")) {
    return "unreachable";
  }
  return "missed";
};

const mean = (values: readonly number[]): number =>
  values.length === 0
    ? 0
    : values.reduce((sum, value) => sum + value, 0) / values.length;

const percentile95 = (values: readonly number[]): number => {
  if (values.length === 0) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.max(0, Math.ceil(ordered.length * 0.95) - 1)] ?? 0;
};

const summarize = (
  algorithm: AlgorithmMode,
  trials: readonly ExperimentTrialResult[]
): AlgorithmExperimentSummary => {
  const captures = trials.filter((trial) => trial.captured).length;
  const secured = trials.filter((trial) => trial.secured).length;
  const peakLoads = trials.map((trial) => trial.peakLoadN);
  const misses = trials.flatMap((trial) =>
    trial.missDistanceM === null ? [] : [trial.missDistanceM]
  );
  const failureReasons: Record<string, number> = {};
  const failureStages = Object.fromEntries([
    "none", "estimation", "unreachable", "handshake", "missed", "overspeed",
    "attitude", "rope-break", "captured-not-secured"
  ].map((stage) => [stage, 0])) as Record<FailureStage, number>;
  const mpcFallbackReasons: MpcFallbackCounts = {
    "stale-input": 0,
    "strength-proxy": 0,
    "non-finite": 0,
    "not-converged": 0
  };
  for (const trial of trials) {
    failureStages[trial.failureStage] += 1;
    for (const reason of Object.keys(mpcFallbackReasons) as Array<keyof MpcFallbackCounts>) {
      mpcFallbackReasons[reason] += trial.mpcFallbackReasons[reason];
    }
    if (trial.failureReason === null) continue;
    failureReasons[trial.failureReason] = (failureReasons[trial.failureReason] ?? 0) + 1;
  }
  return {
    algorithm,
    runs: trials.length,
    captures,
    secured,
    captureRate: trials.length === 0 ? 0 : captures / trials.length,
    securedRate: trials.length === 0 ? 0 : secured / trials.length,
    meanPeakLoadN: mean(peakLoads),
    p95PeakLoadN: percentile95(peakLoads),
    missEvaluatedRuns: misses.length,
    meanMissDistanceM: misses.length === 0 ? null : mean(misses),
    failureReasons,
    failureStages,
    mpcFallbackCount: trials.reduce((sum, trial) => sum + trial.mpcFallbackCount, 0),
    mpcFallbackReasons
  };
};

/** Runs a paired fixed / alpha-beta / predictive comparison on bounded perturbations. */
export const runAlgorithmComparison = (
  baseline: ScenarioConfig,
  options: AlgorithmComparisonOptions = {}
): AlgorithmComparisonResult => {
  const samplesPerVariant = options.samplesPerVariant ?? 5;
  const seed = options.seed ?? baseline.seed;
  const bounds = resolveBounds(options.bounds);
  const perturbations = generateScenarioPerturbations(samplesPerVariant, seed, bounds);
  const simulationOptions: SimulationOptions = {
    ...(options.simulationOptions ?? {}),
    frameRateHz: options.simulationOptions?.frameRateHz ?? 1,
    stopOnTerminal: options.simulationOptions?.stopOnTerminal ?? true
  };
  const trials: ExperimentTrialResult[] = [];

  for (const algorithm of ALGORITHM_VARIANTS) {
    for (const perturbation of perturbations) {
      const config = applyScenarioPerturbation(baseline, perturbation);
      config.controller.algorithm = algorithm;
      config.id = `${config.id}-${algorithm}`;
      const run = runSimulation(config, simulationOptions);
      const metrics = run.metrics;
      const evaluated = hasCapturePlaneEvaluation(metrics);
      const failureReason = reasonForUnsecuredRun(
        metrics.secured,
        metrics.captured,
        metrics.failureReason
      );
      trials.push({
        algorithm,
        sampleIndex: perturbation.sampleIndex,
        scenarioSeed: perturbation.seed,
        captured: metrics.captured,
        secured: metrics.secured,
        failed: metrics.failed || !metrics.secured,
        peakLoadN: metrics.peakContactForceN,
        missDistanceM: evaluated ? metrics.missDistanceM : null,
        failureReason,
        failureStage: classifyFailureStage(metrics.secured, metrics.captured, failureReason),
        capturePlaneCenterErrorM: metrics.capturePlaneCenterErrorM,
        captureRelativeSpeedMps: metrics.captureRelativeSpeedMps,
        captureTiltRad: metrics.captureTiltRad,
        predictionTimeErrorS: metrics.predictionTimeErrorS,
        mpcFallbackCount: metrics.mpcFallbackCount,
        mpcFallbackReasons: { ...metrics.mpcFallbackReasons }
      });
      options.onProgress?.({
        completed: trials.length,
        total: ALGORITHM_VARIANTS.length * samplesPerVariant,
        algorithm,
        sampleIndex: perturbation.sampleIndex,
        label: `${algorithm} · 样本 ${perturbation.sampleIndex + 1}/${samplesPerVariant}`
      });
    }
  }

  return {
    seed,
    samplesPerVariant,
    bounds,
    perturbations,
    trials,
    variants: ALGORITHM_VARIANTS.map((algorithm) =>
      summarize(
        algorithm,
        trials.filter((trial) => trial.algorithm === algorithm)
      )
    )
  };
};
