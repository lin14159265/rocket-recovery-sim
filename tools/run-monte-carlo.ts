import { createNominalScenario } from "../packages/sim-core/src/config";
import {
  runAlgorithmComparison,
  type AlgorithmExperimentSummary
} from "../packages/sim-core/src/experiments";

const valueAfter = (flag: string): string | undefined => {
  const index = process.argv.indexOf(flag);
  return index < 0 ? undefined : process.argv[index + 1];
};

const parsePositiveInteger = (
  value: string | undefined,
  fallback: number,
  label: string
): number => {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} 必须是正整数`);
  }
  return parsed;
};

const percent = (value: number): string => `${(value * 100).toFixed(1)}%`;
const metres = (value: number | null): string => value === null ? "无穿越" : value.toFixed(3);
const algorithmName = (algorithm: AlgorithmExperimentSummary["algorithm"]): string => {
  if (algorithm === "fixed") return "固定网";
  if (algorithm === "alpha-beta") return "α–β 协同";
  return "预测协同";
};

if (process.argv.includes("--help")) {
  console.log("用法：npm run lab:monte-carlo -- [--runs 5] [--seed 20260714]");
} else {
  const runs = parsePositiveInteger(valueAfter("--runs"), 5, "runs");
  const seed = parsePositiveInteger(valueAfter("--seed"), 20260714, "seed");
  const result = runAlgorithmComparison(createNominalScenario(), {
    samplesPerVariant: runs,
    seed
  });

  console.log("候选代理模型有界扰动对照（结果不是实际型号成功概率）");
  console.log(`每种算法 ${runs} 次，成对使用相同扰动；实验 seed=${seed}`);
  console.table(result.variants.map((variant) => ({
    算法: algorithmName(variant.algorithm),
    运行: variant.runs,
    捕获: variant.captures,
    稳定: variant.secured,
    捕获率: percent(variant.captureRate),
    "峰值均值(kN)": (variant.meanPeakLoadN / 1_000).toFixed(1),
    "峰值p95(kN)": (variant.p95PeakLoadN / 1_000).toFixed(1),
    "平均脱靶(m)": metres(variant.meanMissDistanceM)
  })));

  for (const variant of result.variants) {
    const reasons = Object.entries(variant.failureReasons);
    const detail = reasons.length === 0
      ? "无"
      : reasons.map(([reason, count]) => `${reason} × ${count}`).join("；");
    console.log(`${algorithmName(variant.algorithm)}失败/未稳定原因：${detail}`);
  }
}
