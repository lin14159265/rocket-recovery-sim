import { createNominalScenario, createPresetScenario } from "../packages/sim-core/src/config";
import type { ScenarioConfig } from "../packages/sim-core/src/contracts";
import { runLocalSensitivity } from "../packages/sim-core/src/traceability";

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
  console.log("用法：npm run lab:sensitivity -- [--preset nominal] [--json]");
} else {
  const config = loadPreset();
  const result = runLocalSensitivity(config, ({ completed, total, label }) => {
    if (!process.argv.includes("--json")) console.log(`[${completed}/${total}] ${label}`);
  });

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log("\n参数—证据—敏感性追溯（仅适用于当前代理场景附近）");
    console.table(result.rows.map((row) => ({
      参数: row.label,
      路径: row.path,
      值: `${row.value} ${row.unit}`.trim(),
      证据等级: row.source.status,
      扰动: `${row.perturbationPercent}%`,
      敏感性: row.sensitivityLevel,
      系数: row.sensitivityScore?.toFixed(3) ?? "—",
      主导指标: row.dominantEffect ?? "—",
      "指标变化": row.dominantEffectChangePercent === null
        ? "—"
        : `${row.dominantEffectChangePercent.toFixed(2)}%`
    })));
    console.log(result.notice);
  }
}
