import { describe, expect, it } from "vitest";
import { createNominalScenario } from "../src/config";
import {
  ALGORITHM_VARIANTS,
  DEFAULT_PERTURBATION_BOUNDS,
  applyScenarioPerturbation,
  generateScenarioPerturbations,
  runAlgorithmComparison
} from "../src/experiments";

const within = (value: number, [minimum, maximum]: readonly [number, number]): boolean =>
  value >= minimum && value <= maximum;

describe("paired algorithm experiments", () => {
  it("generates deterministic perturbations inside the declared bounds", () => {
    const first = generateScenarioPerturbations(2, 20260714);
    const second = generateScenarioPerturbations(2, 20260714);

    expect(second).toEqual(first);
    for (const perturbation of first) {
      expect(perturbation.initialLateralPositionDeltaM.every((value) =>
        within(value, DEFAULT_PERTURBATION_BOUNDS.initialLateralPositionDeltaM)
      )).toBe(true);
      expect(perturbation.initialLateralVelocityDeltaMps.every((value) =>
        within(value, DEFAULT_PERTURBATION_BOUNDS.initialLateralVelocityDeltaMps)
      )).toBe(true);
      expect(perturbation.meanWindDeltaMps.every((value) =>
        within(value, DEFAULT_PERTURBATION_BOUNDS.meanWindDeltaMps)
      )).toBe(true);
      expect(within(
        perturbation.gustSigmaMps,
        DEFAULT_PERTURBATION_BOUNDS.gustSigmaMps
      )).toBe(true);
      expect(within(perturbation.massScale, DEFAULT_PERTURBATION_BOUNDS.massScale)).toBe(true);
      expect(perturbation.sensorPositionBiasDeltaM.every((value) =>
        within(value, DEFAULT_PERTURBATION_BOUNDS.sensorPositionBiasDeltaM)
      )).toBe(true);
      expect(within(
        perturbation.radioBaseLatencyMs,
        DEFAULT_PERTURBATION_BOUNDS.radioBaseLatencyMs
      )).toBe(true);
      expect(within(perturbation.radioJitterMs, DEFAULT_PERTURBATION_BOUNDS.radioJitterMs)).toBe(true);
      expect(within(perturbation.radioLossRate, DEFAULT_PERTURBATION_BOUNDS.radioLossRate)).toBe(true);
    }
  });

  it("applies a perturbation without rewriting the baseline configuration", () => {
    const baseline = createNominalScenario();
    const before = structuredClone(baseline);
    const perturbation = generateScenarioPerturbations(1, 81)[0];
    expect(perturbation).toBeDefined();

    const changed = applyScenarioPerturbation(baseline, perturbation!);

    expect(baseline).toEqual(before);
    expect(changed).not.toBe(baseline);
    expect(changed.seed).toBe(perturbation!.seed);
    expect(changed.parameterSources["experiment.perturbations"]).toMatchObject({
      status: "assumed"
    });
  });

  it("returns repeatable counts for every variant and preserves the baseline", () => {
    const baseline = createNominalScenario();
    baseline.durationS = 0.02;
    const before = structuredClone(baseline);
    const options = { samplesPerVariant: 2, seed: 901 } as const;

    const first = runAlgorithmComparison(baseline, options);
    const second = runAlgorithmComparison(baseline, options);

    expect(second).toEqual(first);
    expect(baseline).toEqual(before);
    expect(first.trials).toHaveLength(ALGORITHM_VARIANTS.length * options.samplesPerVariant);
    expect(first.variants.map((variant) => variant.algorithm)).toEqual(ALGORITHM_VARIANTS);
    for (const variant of first.variants) {
      expect(variant.runs).toBe(options.samplesPerVariant);
      expect(variant.captures).toBeLessThanOrEqual(variant.runs);
      expect(variant.secured).toBeLessThanOrEqual(variant.captures);
      expect(variant.captureRate).toBe(variant.captures / variant.runs);
      expect(Object.values(variant.failureReasons).reduce((sum, count) => sum + count, 0))
        .toBe(variant.runs - variant.secured);
    }
  });
});
