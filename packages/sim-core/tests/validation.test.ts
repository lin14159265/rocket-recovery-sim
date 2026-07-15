import { describe, expect, it } from "vitest";
import {
  createNominalScenario,
  evaluateEnergyBalance,
  runLocalSensitivity,
  runSimulation,
  runStepConvergenceStudy
} from "../src";

describe("model validation utilities", () => {
  it("isolates step size from stochastic terms and compares a common physical end time", () => {
    const config = createNominalScenario();
    config.durationS = 1;
    const report = runStepConvergenceStudy(config);
    expect(report.cases).toHaveLength(3);
    expect(report.comparisons).toHaveLength(2);
    expect(report.cases.every((entry) => entry.finalTimeS === config.durationS)).toBe(true);
    expect(report.stochasticTermsDisabled.length).toBeGreaterThan(0);
    expect(Number.isFinite(report.comparisons[0]!.maximumNormalizedDifference)).toBe(true);
  });

  it("returns a bounded energy report even without contact", () => {
    const config = createNominalScenario();
    config.durationS = 0.2;
    const report = evaluateEnergyBalance(runSimulation(config, { frameRateHz: 1 }));
    expect(report.contactDetected).toBe(false);
    expect(report.physicsStepCount).toBe(0);
    expect(Number.isFinite(report.normalizedResidual)).toBe(true);
  });

  it("uses the physics-tick ledger and reports separate closure residuals", () => {
    const config = createNominalScenario();
    const run = runSimulation(config, { frameRateHz: 1, stopOnTerminal: true });
    const report = evaluateEnergyBalance(run);
    expect(report.contactDetected).toBe(true);
    expect(report.physicsStepCount).toBeGreaterThan(100);
    expect(run.frames.length).toBeLessThan(report.physicsStepCount);
    expect(report.normalizedTranslationalResidual).toBeLessThan(1e-6);
    expect(report.normalizedRotationalResidual).toBeLessThan(0.01);
    expect(Number.isFinite(report.normalizedContactPartitionResidual)).toBe(true);
    expect(report.normalizedResidual).toBe(Math.max(
      report.normalizedTranslationalResidual,
      report.normalizedRotationalResidual,
      report.normalizedGravityPotentialResidual,
      report.normalizedContactPartitionResidual
    ));
  });

  it("marks terminal mode changes instead of fabricating a continuous sensitivity coefficient", () => {
    const config = createNominalScenario();
    // Place the research strength proxy close to the nominal peak so the
    // lower 5% perturbation crosses a real categorical boundary.
    config.net.totalStrengthLimitN = 850_000;
    const result = runLocalSensitivity(config);
    const strength = result.rows.find((row) => row.path === "net.totalStrengthLimitN");
    expect(strength).toBeDefined();
    expect(strength?.modeTransition).toBe(true);
    expect(strength?.sensitivityScore).toBeNull();
    expect(strength?.dominantEffect).toBe("终态模式切换");
  }, 40_000);

  it("uses an explicit absolute floor for a zero-valued probability", () => {
    const config = createNominalScenario();
    config.durationS = 0.1;
    config.radio.lossRate = 0;
    const result = runLocalSensitivity(config);
    const loss = result.rows.find((row) => row.path === "radio.lossRate");
    expect(loss?.perturbationMode).toBe("absolute-floor");
    expect(loss?.perturbationAbsolute).toBeCloseTo(0.01);
    expect(loss?.upperValue).toBeCloseTo(0.01);
    expect(loss?.lowerValue).toBe(0);
  });

  it("builds deterministic local sensitivity rows", () => {
    const config = createNominalScenario();
    config.durationS = 0.1;
    const first = runLocalSensitivity(config);
    const second = runLocalSensitivity(config);
    expect(first).toEqual(second);
    expect(first.rows.every((row) => row.source.source.length > 0)).toBe(true);
    expect(first.rows.every((row) => row.lowerValue !== null && row.upperValue !== null)).toBe(true);
  });
});
