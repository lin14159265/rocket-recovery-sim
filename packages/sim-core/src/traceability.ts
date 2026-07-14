import type { ParameterSource, ScenarioConfig } from "./contracts";
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
  get: (config: ScenarioConfig) => number;
  set: (config: ScenarioConfig, value: number) => void;
  sourceFallback: string;
}

const DEFINITIONS: readonly Definition[] = [
  { path: "rocket.massKg", label: "等效回收质量", unit: "kg", perturbationPercent: 5, get: (c) => c.rocket.massKg, set: (c, v) => { c.rocket.massKg = v; }, sourceFallback: "rocket.massKg" },
  { path: "rocket.initialVelocityMps.2", label: "初始垂向速度", unit: "m/s", perturbationPercent: 5, get: (c) => c.rocket.initialVelocityMps[2], set: (c, v) => { c.rocket.initialVelocityMps[2] = v; }, sourceFallback: "rocket.massKg" },
  { path: "net.totalStiffnessNpm", label: "网系总等效刚度", unit: "N/m", perturbationPercent: 5, get: (c) => c.net.totalStiffnessNpm, set: (c, v) => { c.net.totalStiffnessNpm = v; }, sourceFallback: "net.totalStiffnessNpm" },
  { path: "net.totalDampingNspm", label: "网系总等效阻尼", unit: "N·s/m", perturbationPercent: 5, get: (c) => c.net.totalDampingNspm, set: (c, v) => { c.net.totalDampingNspm = v; }, sourceFallback: "net.totalDampingNspm" },
  { path: "net.totalStrengthLimitN", label: "网系总强度上限", unit: "N", perturbationPercent: 5, get: (c) => c.net.totalStrengthLimitN, set: (c, v) => { c.net.totalStrengthLimitN = v; }, sourceFallback: "net.totalStiffnessNpm" },
  { path: "radio.baseLatencyMs", label: "无线基础时延", unit: "ms", perturbationPercent: 10, get: (c) => c.radio.baseLatencyMs, set: (c, v) => { c.radio.baseLatencyMs = v; }, sourceFallback: "radio" },
  { path: "radio.lossRate", label: "无线丢包率", unit: "ratio", perturbationPercent: 25, get: (c) => c.radio.lossRate, set: (c, v) => { c.radio.lossRate = Math.min(1, Math.max(0, v)); }, sourceFallback: "radio" },
  { path: "sensors.rocketPositionNoiseM", label: "箭上位置噪声", unit: "m", perturbationPercent: 10, get: (c) => c.sensors.rocketPositionNoiseM, set: (c, v) => { c.sensors.rocketPositionNoiseM = Math.max(0, v); }, sourceFallback: "sensors" },
  { path: "controller.netCenterKp", label: "网中心位置增益", unit: "", perturbationPercent: 5, get: (c) => c.controller.netCenterKp, set: (c, v) => { c.controller.netCenterKp = v; }, sourceFallback: "controller.attitudeGains" },
  { path: "controller.staleTelemetryAbortS", label: "遥测失效中止阈值", unit: "s", perturbationPercent: 5, get: (c) => c.controller.staleTelemetryAbortS, set: (c, v) => { c.controller.staleTelemetryAbortS = v; }, sourceFallback: "radio" }
];

const unknownSource: ParameterSource = {
  status: "assumed",
  source: "未单独建立证据条目",
  note: "该值仍属于公开机理代理模型参数"
};

const scoreLevel = (score: number): SensitivityLevel =>
  score >= 1 ? "high" : score >= 0.25 ? "medium" : "low";

const metricVector = (run: ReturnType<typeof runSimulation>) => ({
  miss: run.metrics.missDistanceM,
  speed: run.metrics.captureRelativeSpeedMps,
  load: run.metrics.peakContactForceN,
  estimate: run.metrics.maxEstimateErrorM,
  secured: run.metrics.secured ? 1 : 0
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
  onProgress?.({ completed: 1, total: DEFINITIONS.length + 1, label: "基线完成" });

  for (const [index, definition] of DEFINITIONS.entries()) {
    const perturbed = structuredClone(config);
    const original = definition.get(perturbed);
    const delta = Math.abs(original) > 1e-12
      ? original * definition.perturbationPercent / 100
      : definition.perturbationPercent / 100;
    definition.set(perturbed, original + delta);
    perturbed.id = `${config.id}-sensitivity-${definition.path}`;
    const next = metricVector(runSimulation(perturbed, { frameRateHz: 1, stopOnTerminal: true }));
    const effects = {
      "最小错位": relativeChange(next.miss, baseline.miss, 0.1),
      "捕获速度": relativeChange(next.speed, baseline.speed, 0.5),
      "峰值接触力": relativeChange(next.load, baseline.load, 10_000),
      "估计误差": relativeChange(next.estimate, baseline.estimate, 0.1),
      "稳定终态": Math.abs(next.secured - baseline.secured)
    };
    const [dominantEffect, relativeOutputChange] = Object.entries(effects)
      .sort((a, b) => b[1] - a[1])[0]!;
    const inputFraction = definition.perturbationPercent / 100;
    const normalizedSensitivity = relativeOutputChange / Math.max(inputFraction, 1e-12);
    const row = rows[index]!;
    row.sensitivityScore = normalizedSensitivity;
    row.sensitivityLevel = scoreLevel(normalizedSensitivity);
    row.dominantEffect = dominantEffect;
    row.dominantEffectChangePercent = relativeOutputChange * 100;
    onProgress?.({
      completed: index + 2,
      total: DEFINITIONS.length + 1,
      label: `${definition.label} 完成`
    });
  }

  return {
    baselineFingerprint: baselineRun.configFingerprint,
    rows,
    notice: "敏感性系数=主导指标相对变化/参数相对扰动；为当前场景附近的单因素幅值扰动结果，不代表真实型号参数不确定度。"
  };
};
