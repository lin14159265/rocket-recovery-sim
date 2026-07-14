import { describe, expect, it } from "vitest";
import {
  createNominalScenario,
  evaluateEnergyBalance,
  runLocalSensitivity,
  runSimulation,
  runStepConvergenceStudy
} from "../src";

describe("model validation utilities", () => {
  it("produces finite step convergence comparisons", () => {
    const config = createNominalScenario();
    config.durationS = 1;
    const report = runStepConvergenceStudy(config);
    expect(report.cases).toHaveLength(3);
    expect(report.comparisons).toHaveLength(2);
    expect(Number.isFinite(report.comparisons[0]!.maximumNormalizedDifference)).toBe(true);
  });

  it("returns a bounded energy report even without contact", () => {
    const config = createNominalScenario();
    config.durationS = 0.2;
    const report = evaluateEnergyBalance(runSimulation(config, { frameRateHz: 50 }));
    expect(report.contactDetected).toBe(false);
    expect(Number.isFinite(report.normalizedResidual)).toBe(true);
  });

  it("does not double-count final elastic storage as damping dissipation", () => {
    const config = createNominalScenario();
    const report = evaluateEnergyBalance(runSimulation(config, { frameRateHz: 100, stopOnTerminal: true }));
    expect(report.contactDetected).toBe(true);
    expect(report.contactWorkProxyJ).toBeGreaterThanOrEqual(report.contactDissipationProxyJ);
    expect(report.contactDissipationProxyJ + report.finalElasticProxyJ)
      .toBeCloseTo(report.contactWorkProxyJ, -3);
  });

  it("builds deterministic local sensitivity rows", () => {
    const config = createNominalScenario();
    config.durationS = 0.1;
    const first = runLocalSensitivity(config);
    const second = runLocalSensitivity(config);
    expect(first).toEqual(second);
    expect(first.rows.every((row) => row.sensitivityScore !== null)).toBe(true);
    expect(first.rows.every((row) => row.source.source.length > 0)).toBe(true);
    expect(first.rows.every((row) => row.dominantEffectChangePercent !== null)).toBe(true);
  });
});
