import { createNominalScenario, createPresetScenario } from "../packages/sim-core/src/config";
import type { ScenarioConfig } from "../packages/sim-core/src/contracts";
import { runValidationSuite } from "../packages/sim-core/src/validation";

type Preset = Parameters<typeof createPresetScenario>[0];

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

const loadPreset = (): ScenarioConfig => {
  const preset = (valueAfter("--preset") ?? "nominal") as Preset;
  if (!presets.has(preset)) throw new Error(`未知场景：${preset}`);
  return preset === "nominal" ? createNominalScenario() : createPresetScenario(preset);
};

if (process.argv.includes("--help")) {
  console.log("用法：npm run lab:validate -- [--preset nominal] [--json]");
} else {
  const config = loadPreset();
  const result = runValidationSuite(config, {
    onProgress: ({ completed, total, label }) => {
      if (!process.argv.includes("--json")) console.log(`[${completed}/${total}] ${label}`);
    }
  });

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log("\n公开机理代理模型数值验证（不构成真实型号验证）");
    console.log(`场景：${config.name}　物理步长：${config.physicsDtS} s`);
    console.table(result.convergence.comparisons.map((comparison) => ({
      步长对: `${comparison.coarseDtS} → ${comparison.fineDtS} s`,
      最大归一差: `${(comparison.maximumNormalizedDifference * 100).toFixed(2)}%`,
      终态一致: comparison.categoricalAgreement ? "是" : "否"
    })));
    console.log(`收敛分级：${result.convergence.quality}；${result.convergence.interpretation}`);
    console.log(
      `能量账本：${result.energy.quality}；未观测残差 ${(result.energy.normalizedResidual * 100).toFixed(2)}%`
    );
    console.log(
      `接触净做功代理 ${(result.energy.contactWorkProxyJ / 1e6).toFixed(3)} MJ，` +
      `阻尼耗散代理 ${(result.energy.contactDissipationProxyJ / 1e6).toFixed(3)} MJ，` +
      `末态弹性能代理 ${(result.energy.finalElasticProxyJ / 1e6).toFixed(3)} MJ`
    );
    console.log(result.modelNotice);
  }
}
