import type { ParameterSource, ScenarioConfig, SimulationRun } from "./contracts";
import { runSimulation } from "./simulation";

export type SensitivityLevel = "low" | "medium" | "high";

export interface TraceabilityProgress {
  completed: number;
  total: number;
  label: string;
}

export interface ParameterTraceabilityRow {
  path: string;
  label: string;
  value: number;
  unit: string;
  source: ParameterSource;
  perturbationPercent: number;
  perturbationAbsolute: number;
  perturbationMode: "relative" | "absolute-floor";
  lowerValue: number | null;
  upperValue: number | null;
  baselineOutcome: string | null;
  lowerOutcome: string | null;
  upperOutcome: string | null;
  modeTransition: boolean;
  sensitivityScore: number | null;
  sensitivityLevel: SensitivityLevel | null;
  dominantEffect: string | null;
  dominantEffectChangePercent: number | null;
}

export interface ParameterTraceabilityResult {
  baselineFingerprint: string;
  rows: ParameterTraceabilityRow[];
  notice: string;
}

interface Definition {
  path: string;
  label: string;
  unit: string;
  perturbationPercent: number;
  absoluteStep: number;
  normalizationScale: number;
  get: (config: ScenarioConfig) => number;
  set: (config: ScenarioConfig, value: number) => void;
  sourceFallback: string;
}

const DEFINITIONS: readonly Definition[] = [
  { path: "rocket.massKg", label: "等效回收质量", unit: "kg", perturbationPercent: 5, absoluteStep: 100, normalizationScale: 10_000, get: (c) => c.rocket.massKg, set: (c, v) => { c.rocket.massKg = Math.max(1, v); }, sourceFallback: "rocket.massKg" },
  { path: "rocket.initialVelocityMps.2", label: "初始垂向速度", unit: "m/s", perturbationPercent: 5, absoluteStep: 0.5, normalizationScale: 10, get: (c) => c.rocket.initialVelocityMps[2], set: (c, v) => { c.rocket.initialVelocityMps[2] = v; }, sourceFallback: "rocket.initialVelocityMps.2" },
  { path: "net.totalStiffnessNpm", label: "网系总等效刚度", unit: "N/m", perturbationPercent: 5, absoluteStep: 1_000, normalizationScale: 20_000, get: (c) => c.net.totalStiffnessNpm, set: (c, v) => { c.net.totalStiffnessNpm = Math.max(1, v); }, sourceFallback: "net.totalStiffnessNpm" },
  { path: "net.totalDampingNspm", label: "网系总等效阻尼", unit: "N·s/m", perturbationPercent: 5, absoluteStep: 1_000, normalizationScale: 20_000, get: (c) => c.net.totalDampingNspm, set: (c, v) => { c.net.totalDampingNspm = Math.max(1, v); }, sourceFallback: "net.totalDampingNspm" },
  { path: "net.totalStrengthLimitN", label: "网系总强度上限", unit: "N", perturbationPercent: 5, absoluteStep: 10_000, normalizationScale: 200_000, get: (c) => c.net.totalStrengthLimitN, set: (c, v) => { c.net.totalStrengthLimitN = Math.max(1, v); }, sourceFallback: "net.totalStrengthLimitN" },
  { path: "radio.baseLatencyMs", label: "无线基础时延", unit: "ms", perturbationPercent: 10, absoluteStep: 5, normalizationScale: 50, get: (c) => c.radio.baseLatencyMs, set: (c, v) => { c.radio.baseLatencyMs = Math.max(0, v); }, sourceFallback: "radio.baseLatencyMs" },
  { path: "radio.lossRate", label: "无线丢包率", unit: "ratio", perturbationPercent: 25, absoluteStep: 0.01, normalizationScale: 0.05, get: (c) => c.radio.lossRate, set: (c, v) => { c.radio.lossRate = Math.min(1, Math.max(0, v)); }, sourceFallback: "radio.lossRate" },
  { path: "sensors.rocketPositionNoiseM", label: "箭上位置噪声", unit: "m", perturbationPercent: 10, absoluteStep: 0.05, normalizationScale: 0.5, get: (c) => c.sensors.rocketPositionNoiseM, set: (c, v) => { c.sensors.rocketPositionNoiseM = Math.max(0, v); }, sourceFallback: "sensors.rocketPositionNoiseM" },
  { path: "controller.netCenterKp", label: "网中心位置增益", unit: "", perturbationPercent: 5, absoluteStep: 0.05, normalizationScale: 1, get: (c) => c.controller.netCenterKp, set: (c, v) => { c.controller.netCenterKp = Math.max(0, v); }, sourceFallback: "controller.netCenterKp" },
  { path: "controller.staleTelemetryAbortS", label: "遥测失效中止阈值", unit: "s", perturbationPercent: 5, absoluteStep: 0.05, normalizationScale: 0.5, get: (c) => c.controller.staleTelemetryAbortS, set: (c, v) => { c.controller.staleTelemetryAbortS = Math.max(0.001, v); }, sourceFallback: "controller.staleTelemetryAbortS" }
];

const unknownSource: ParameterSource = {
  status: "assumed",
  source: "未单独建立证据条目",
  note: "该值仍属于公开机理代理模型参数"
};

const scoreLevel = (score: number): SensitivityLevel =>
  score >= 1 ? "high" : score >= 0.25 ? "medium" : "low";

const outcomeFor = (run: SimulationRun): string => {
  if (run.metrics.secured) return "SECURED";
  if (run.metrics.captured && run.metrics.failed) {
    return `CAPTURED_FAILED:${run.metrics.failureReason ?? run.finalSnapshot.supervisorState}`;
  }
  if (run.metrics.captured) return "CAPTURED_NOT_SECURED";
  if (run.metrics.failed) return `FAILED:${run.metrics.failureReason ?? run.finalSnapshot.supervisorState}`;
  return `INCOMPLETE:${run.finalSnapshot.supervisorState}`;
};

const metricVector = (run: SimulationRun) => ({
  miss: run.metrics.missDistanceM,
  speed: run.metrics.captureRelativeSpeedMps,
  load: run.metrics.peakContactForceN,
  estimate: run.metrics.maxEstimateErrorM,
  outcome: outcomeFor(run)
});

const relativeChange = (next: number, baseline: number, floor: number): number =>
  Math.abs(next - baseline) / Math.max(Math.abs(baseline), floor);

export const buildParameterTraceability = (config: ScenarioConfig): ParameterTraceabilityRow[] =>
  DEFINITIONS.map((definition) => ({
    path: definition.path,
    label: definition.label,
    value: definition.get(config),
    unit: definition.unit,
    source: structuredClone(
      config.parameterSources[definition.path] ??
      config.parameterSources[definition.sourceFallback] ??
      unknownSource
    ),
    perturbationPercent: definition.perturbationPercent,
    perturbationAbsolute: 0,
    perturbationMode: Math.abs(definition.get(config)) > 1e-12 ? "relative" : "absolute-floor",
    lowerValue: null,
    upperValue: null,
    baselineOutcome: null,
    lowerOutcome: null,
    upperOutcome: null,
    modeTransition: false,
    sensitivityScore: null,
    sensitivityLevel: null,
    dominantEffect: null,
    dominantEffectChangePercent: null
  }));

export const runLocalSensitivity = (
  config: ScenarioConfig,
  onProgress?: (progress: TraceabilityProgress) => void
): ParameterTraceabilityResult => {
  const baselineRun = runSimulation(config, { frameRateHz: 1, stopOnTerminal: true });
  const baseline = metricVector(baselineRun);
  const rows = buildParameterTraceability(config);
  const total = DEFINITIONS.length * 2 + 1;
  let completed = 1;
  onProgress?.({ completed, total, label: "基线完成" });

  for (const [index, definition] of DEFINITIONS.entries()) {
    const original = definition.get(config);
    const relativeDelta = Math.abs(original) * definition.perturbationPercent / 100;
    const requestedDelta = Math.max(relativeDelta, definition.absoluteStep);

    const lowerConfig = structuredClone(config);
    definition.set(lowerConfig, original - requestedDelta);
    lowerConfig.id = `${config.id}-sensitivity-${definition.path}-lower`;
    const lowerValue = definition.get(lowerConfig);
    const lower = metricVector(runSimulation(lowerConfig, { frameRateHz: 1, stopOnTerminal: true }));
    completed += 1;
    onProgress?.({ completed, total, label: `${definition.label} 下扰动完成` });

    const upperConfig = structuredClone(config);
    definition.set(upperConfig, original + requestedDelta);
    upperConfig.id = `${config.id}-sensitivity-${definition.path}-upper`;
    const upperValue = definition.get(upperConfig);
    const upper = metricVector(runSimulation(upperConfig, { frameRateHz: 1, stopOnTerminal: true }));
    completed += 1;
    onProgress?.({ completed, total, label: `${definition.label} 上扰动完成` });

    const actualDelta = Math.max(Math.abs(original - lowerValue), Math.abs(upperValue - original));
    const inputFraction = actualDelta / Math.max(Math.abs(original), definition.normalizationScale);
    const row = rows[index]!;
    row.perturbationAbsolute = actualDelta;
    row.perturbationMode = relativeDelta >= definition.absoluteStep ? "relative" : "absolute-floor";
    row.lowerValue = lowerValue;
    row.upperValue = upperValue;
    row.baselineOutcome = baseline.outcome;
    row.lowerOutcome = lower.outcome;
    row.upperOutcome = upper.outcome;
    row.modeTransition = lower.outcome !== baseline.outcome || upper.outcome !== baseline.outcome;

    if (row.modeTransition) {
      row.sensitivityScore = null;
      row.sensitivityLevel = null;
      row.dominantEffect = "终态模式切换";
      row.dominantEffectChangePercent = null;
      continue;
    }

    const effects = {
      "最小错位": Math.max(
        relativeChange(lower.miss, baseline.miss, 0.1),
        relativeChange(upper.miss, baseline.miss, 0.1)
      ),
      "捕获速度": Math.max(
        relativeChange(lower.speed, baseline.speed, 0.5),
        relativeChange(upper.speed, baseline.speed, 0.5)
      ),
      "峰值接触力": Math.max(
        relativeChange(lower.load, baseline.load, 10_000),
        relativeChange(upper.load, baseline.load, 10_000)
      ),
      "估计误差": Math.max(
        relativeChange(lower.estimate, baseline.estimate, 0.1),
        relativeChange(upper.estimate, baseline.estimate, 0.1)
      )
    };
    const [dominantEffect, relativeOutputChange] = Object.entries(effects)
      .sort((a, b) => b[1] - a[1])[0]!;
    const normalizedSensitivity = relativeOutputChange / Math.max(inputFraction, 1e-12);
    row.sensitivityScore = normalizedSensitivity;
    row.sensitivityLevel = scoreLevel(normalizedSensitivity);
    row.dominantEffect = dominantEffect;
    row.dominantEffectChangePercent = relativeOutputChange * 100;
  }

  return {
    baselineFingerprint: baselineRun.configFingerprint,
    rows,
    notice: "使用上下双侧扰动；一旦结果类别发生切换，改报模式边界而不计算连续敏感性。零值参数采用表中绝对扰动下限，不再把 0→0.25 误写成 +25%。"
  };
};
