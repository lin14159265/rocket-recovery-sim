import { createNominalScenario, createPresetScenario } from "../packages/sim-core/src/config";
import type { AlgorithmMode } from "../packages/sim-core/src/contracts";
import { runSimulation } from "../packages/sim-core/src/simulation";

type Preset = Parameters<typeof createPresetScenario>[0];

const algorithms = new Set<AlgorithmMode>(["fixed", "alpha-beta", "predictive"]);
const presets = new Set<Preset>([
  "nominal",
  "late-close",
  "low-damping",
  "overload",
  "radio-blackout"
]);

const valueAfter = (flag: string): string | undefined => {
  const index = process.argv.indexOf(flag);
  return index < 0 ? undefined : process.argv[index + 1];
};

const parseInteger = (value: string | undefined, fallback: number, label: string): number => {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${label} 必须是整数`);
  return parsed;
};

if (process.argv.includes("--help")) {
  console.log("用法：npm run lab -- [--preset nominal] [--algorithm predictive] [--seed 20260710]");
} else {
  const presetValue = (valueAfter("--preset") ?? "nominal") as Preset;
  const algorithmValue = (valueAfter("--algorithm") ?? "predictive") as AlgorithmMode;
  if (!presets.has(presetValue)) throw new Error(`未知场景：${presetValue}`);
  if (!algorithms.has(algorithmValue)) throw new Error(`未知算法：${algorithmValue}`);

  const config = presetValue === "nominal"
    ? createNominalScenario()
    : createPresetScenario(presetValue);
  config.controller.algorithm = algorithmValue;
  config.seed = parseInteger(valueAfter("--seed"), config.seed, "seed");
  const run = runSimulation(config, { frameRateHz: 2, stopOnTerminal: true });
  const metrics = run.metrics;
  const missWasEvaluated = metrics.captured ||
    metrics.missDistanceM > 0 ||
    metrics.captureRelativeSpeedMps > 0 ||
    metrics.captureTiltRad > 0;
  const missText = missWasEvaluated ? `${metrics.missDistanceM.toFixed(3)} m` : "未穿越捕获面";

  console.log("候选代理模型单场景结果（不是官方算法或真实型号结论）");
  console.log(`场景：${config.name}　算法：${algorithmValue}　seed：${config.seed}`);
  console.log(`终态：${run.finalSnapshot.supervisorState}　捕获：${metrics.captured ? "是" : "否"}　稳定：${metrics.secured ? "是" : "否"}`);
  console.log(`峰值接触载荷：${(metrics.peakContactForceN / 1_000).toFixed(1)} kN　脱靶：${missText}`);
  console.log(`结果说明：${metrics.failureReason ?? (metrics.secured ? "完成代理模型稳定判据" : "时限内未稳定")}`);
}
