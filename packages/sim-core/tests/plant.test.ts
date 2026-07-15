import { describe, expect, it } from "vitest";
import { createNominalScenario } from "../src/config";
import { DeterministicRng } from "../src/engine/rng";
import {
  RecoveryPlant,
  createNeutralPlantInput,
  type PlantStepInput
} from "../src/plant";
import { WinchTensionController } from "../src/control";

const makeForceFreeScenario = () => {
  const config = createNominalScenario();
  config.physicsDtS = 0.01;
  config.environment.gravityMps2 = 0;
  config.environment.airDensityKgpm3 = 0;
  config.environment.meanWindMps = [0, 0, 0];
  config.environment.gustSigmaMps = 0;
  config.platform.surgeAmplitudeM = 0;
  config.platform.swayAmplitudeM = 0;
  config.platform.heaveAmplitudeM = 0;
  config.platform.rollAmplitudeRad = 0;
  config.platform.pitchAmplitudeRad = 0;
  config.platform.capturePlaneZ = -1_000_000;
  config.rocket.initialPositionM = [0, 0, 100];
  config.rocket.initialVelocityMps = [0, 0, 0];
  config.rocket.initialAngularVelocityRadps = [0, 0, 0];
  return config;
};

const makeClosedNetInput = (config: ReturnType<typeof createNominalScenario>): PlantStepInput => ({
  ...createNeutralPlantInput(config),
  netCommand: {
    desiredAxisPositionsM: [
      -config.net.closedHalfSpacingM,
      config.net.closedHalfSpacingM,
      -config.net.closedHalfSpacingM,
      config.net.closedHalfSpacingM
    ],
    targetTotalTensionN: 0,
    desiredTensionsN: [0, 0, 0, 0],
    desiredActiveDampingNspm: Array(4).fill(Math.min(
      config.net.activeDampingMaxNspm,
      Math.max(config.net.activeDampingMinNspm, config.net.totalDampingNspm / 4)
    )) as [number, number, number, number],
    tensionControllerSaturated: [false, false, false, false],
    requestedMode: "closing"
  }
});

const makeEquilibriumCaptureScenario = () => {
  const config = makeForceFreeScenario();
  config.environment.gravityMps2 = 10;
  config.rocket.massKg = 100;
  config.rocket.initialPositionM = [0, 0, 45.01];
  config.rocket.initialVelocityMps = [0, 0, -1];
  config.platform.capturePlaneZ = 45;
  config.net.openHalfSpacingM = 3;
  config.net.closedHalfSpacingM = 3;
  config.net.totalStiffnessNpm = 1_000_000;
  config.net.totalDampingNspm = 10_000;
  config.net.activeDampingMinNspm = 0;
  config.net.activeDampingMaxNspm = 100_000;
  config.net.activeDampingRateNspmPerS = 10_000_000;
  config.net.lateralStiffnessNpm = 2_000;
  config.net.lateralDampingNspm = 1_000;
  config.net.totalStrengthLimitN = 1_000_000;
  config.net.arrestDistanceM = 1;
  config.controller.maxCaptureSpeedMps = 5;
  return config;
};

describe("DeterministicRng", () => {
  it("repeats uniform and Gaussian streams for an identical seed", () => {
    const first = new DeterministicRng(20260710);
    const second = new DeterministicRng(20260710);
    const sample = (rng: DeterministicRng) => [
      rng.nextUint32(),
      rng.nextFloat(),
      rng.normal(),
      rng.normal(),
      rng.integer(-7, 11),
      rng.bernoulli(0.3)
    ];

    expect(sample(first)).toEqual(sample(second));
  });

  it("restores the cached Gaussian sample as part of its state", () => {
    const original = new DeterministicRng(7);
    original.normal();
    const restored = new DeterministicRng(0);
    restored.setState(original.getState());

    expect(restored.normal()).toBe(original.normal());
    expect(restored.nextUint32()).toBe(original.nextUint32());
  });
});

describe("RecoveryPlant rigid-body and environment integration", () => {
  it("matches the semi-implicit analytical solution for free fall", () => {
    const config = makeForceFreeScenario();
    config.environment.gravityMps2 = 9.81;
    const plant = new RecoveryPlant(config);
    const input = createNeutralPlantInput(config);
    const steps = 100;
    let result = plant.getState();

    for (let index = 0; index < steps; index += 1) result = plant.step(input);

    const expectedVelocity = -config.environment.gravityMps2 * config.physicsDtS * steps;
    const expectedPosition =
      config.rocket.initialPositionM[2] -
      config.environment.gravityMps2 *
        config.physicsDtS ** 2 *
        ((steps * (steps + 1)) / 2);
    expect(result.rocket.velocityMps[2]).toBeCloseTo(expectedVelocity, 12);
    expect(result.rocket.positionM[2]).toBeCloseTo(expectedPosition, 12);
  });

  it("applies the exact first-order thrust lag before the velocity update", () => {
    const config = makeForceFreeScenario();
    config.physicsDtS = 0.1;
    config.rocket.massKg = 10;
    config.rocket.thrustMaxN = 100;
    config.rocket.thrustTimeConstantS = 0.5;
    const plant = new RecoveryPlant(config);
    const input = createNeutralPlantInput(config);
    input.rocketControl.desiredThrustN = 100;
    input.rocketControl.engineEnabled = true;

    const result = plant.step(input);
    const expectedThrust = 100 * (1 - Math.exp(-0.1 / 0.5));
    expect(result.rocket.actualThrustN).toBeCloseTo(expectedThrust, 12);
    expect(result.rocket.velocityMps[2]).toBeCloseTo((expectedThrust / 10) * 0.1, 12);
  });

  it("keeps the attitude quaternion normalized during torque-free 6DoF motion", () => {
    const config = makeForceFreeScenario();
    config.rocket.initialAngularVelocityRadps = [0.31, -0.22, 0.17];
    const plant = new RecoveryPlant(config);
    const input = createNeutralPlantInput(config);
    let result = plant.getState();

    for (let index = 0; index < 2_000; index += 1) result = plant.step(input);

    expect(Math.hypot(...result.rocket.attitudeWxyz)).toBeCloseTo(1, 12);
    expect(result.rocket.angularVelocityRadps.every(Number.isFinite)).toBe(true);
  });

  it("evaluates platform harmonic position and analytic velocity at integer ticks", () => {
    const config = makeForceFreeScenario();
    config.physicsDtS = 0.25;
    config.platform.wavePeriodS = 1;
    config.platform.surgeAmplitudeM = 2;
    const plant = new RecoveryPlant(config);

    const result = plant.step(createNeutralPlantInput(config));
    expect(result.platform.positionM[0]).toBeCloseTo(2, 12);
    expect(result.platform.velocityMps[0]).toBeCloseTo(0, 12);
  });

  it("produces bit-identical gust and trajectory histories for the same seed", () => {
    const config = makeForceFreeScenario();
    config.environment.airDensityKgpm3 = 1.1;
    config.environment.gustSigmaMps = 2;
    config.environment.gustTimeConstantS = 0.8;
    const first = new RecoveryPlant(config);
    const second = new RecoveryPlant(config);
    const input = createNeutralPlantInput(config);

    for (let index = 0; index < 200; index += 1) {
      const firstResult = first.step(input);
      const secondResult = second.step(input);
      expect(firstResult.gustMps).toEqual(secondResult.gustMps);
      expect(firstResult.rocket.positionM).toEqual(secondResult.rocket.positionM);
    }
  });
});

describe("RecoveryPlant winches and capture mechanics", () => {
  it("respects each winch speed and acceleration limit without overshooting", () => {
    const config = makeForceFreeScenario();
    config.net.openHalfSpacingM = 10;
    config.net.closedHalfSpacingM = 2;
    config.net.winchMaxSpeedMps = 1;
    config.net.winchMaxAccelerationMps2 = 2;
    config.net.winchTimeConstantS = 0.1;
    const plant = new RecoveryPlant(config);
    const input = makeClosedNetInput(config);
    let result = plant.getState();

    for (let index = 0; index < 1_200; index += 1) {
      result = plant.step(input);
      for (const axis of [
        result.net.xNegative,
        result.net.xPositive,
        result.net.yNegative,
        result.net.yPositive
      ]) {
        expect(Math.abs(axis.velocityMps)).toBeLessThanOrEqual(
          config.net.winchMaxSpeedMps + 1e-12
        );
        expect(Math.abs(axis.appliedAccelerationMps2)).toBeLessThanOrEqual(
          config.net.winchMaxAccelerationMps2 + 1e-12
        );
      }
      expect(result.net.halfSpacingM[0]).toBeGreaterThanOrEqual(
        config.net.closedHalfSpacingM - 1e-12
      );
    }

    expect(result.net.halfSpacingM[0]).toBeCloseTo(config.net.closedHalfSpacingM, 12);
    expect(result.net.halfSpacingM[1]).toBeCloseTo(config.net.closedHalfSpacingM, 12);
  });

  it("captures only on a downward, closed-net, admissible plane crossing", () => {
    const config = makeEquilibriumCaptureScenario();
    const plant = new RecoveryPlant(config);

    const result = plant.step(makeClosedNetInput(config));
    expect(result.capture.attempted).toBe(true);
    expect(result.capture.captured).toBe(true);
    expect(result.capturedThisStep).toBe(true);
    expect(result.net.mode).toBe("latched");
    expect(result.rocket.mode).toBe("CAPTURED");
  });

  it("computes Kelvin-Voigt force, lateral restoration, and nonnegative four-rope load", () => {
    const config = makeEquilibriumCaptureScenario();
    config.rocket.initialPositionM[0] = 0.05;
    const plant = new RecoveryPlant(config);
    const input = makeClosedNetInput(config);
    plant.step(input);

    const result = plant.step(input);
    const expectedVerticalForceN = config.net.totalStiffnessNpm * 0.001 +
      result.net.activeDampingNspm.reduce((sum, value) => sum + value, 0) * 1.1;
    expect(result.net.totalContactForceN[2]).toBeCloseTo(expectedVerticalForceN, 7);
    expect(result.net.totalContactForceN[0]).toBeCloseTo(
      -config.net.lateralStiffnessNpm * 0.05,
      7
    );
    expect(result.net.tensionsN.every((value) => value >= 0)).toBe(true);
    expect(result.net.tensionsN[0]).toBeGreaterThan(result.net.tensionsN[1]);
    expect(result.net.tensionsN.reduce((sum, value) => sum + value, 0)).toBeCloseTo(
      Math.hypot(...result.net.totalContactForceN),
      7
    );
  });

  it("declares a rope break when the equivalent total strength is exceeded", () => {
    const config = makeEquilibriumCaptureScenario();
    config.net.totalStrengthLimitN = 10_000;
    const plant = new RecoveryPlant(config);
    const input = makeClosedNetInput(config);
    plant.step(input);

    const result = plant.step(input);
    expect(result.ropeBrokenThisStep).toBe(true);
    expect(result.failureReason).toBe("strength-limit-exceeded");
    expect(result.net.mode).toBe("broken");
  });

  it("recognizes a damped static equilibrium after the required dwell time", () => {
    const config = makeEquilibriumCaptureScenario();
    const plant = new RecoveryPlant(config);
    const input = makeClosedNetInput(config);
    let result = plant.getState();

    for (let index = 0; index < 100; index += 1) result = plant.step(input);

    expect(result.net.mode).toBe("secured");
    expect(result.net.payoutM).toBeCloseTo(
      (config.rocket.massKg * config.environment.gravityMps2) /
        config.net.totalStiffnessNpm,
      7
    );
    expect(result.net.totalContactForceN[2]).toBeCloseTo(
      config.rocket.massKg * config.environment.gravityMps2,
      7
    );
    expect(result.rocket.velocityMps[2]).toBeCloseTo(0, 7);
  });

  it("turns a higher tension demand into active damping, contact force, and shorter payout", () => {
    const config = makeEquilibriumCaptureScenario();
    config.net.activeDampingMinNspm = 0;
    config.net.activeDampingMaxNspm = 100_000;
    config.net.activeDampingRateNspmPerS = 10_000_000;
    config.net.totalStrengthLimitN = 10_000_000;
    config.net.arrestDistanceM = 10;
    const lowPlant = new RecoveryPlant(config);
    const highPlant = new RecoveryPlant(config);
    const lowInput = makeClosedNetInput(config);
    const highInput = makeClosedNetInput(config);
    const lowController = new WinchTensionController(config.controller.tension, config.net);
    const highController = new WinchTensionController(config.controller.tension, config.net);
    const low = lowController.update(0, 0, 0.01);
    const high = highController.update(100_000, 0, 0.01);
    lowInput.netCommand.desiredActiveDampingNspm = [
      low.desiredDampingNspm, low.desiredDampingNspm,
      low.desiredDampingNspm, low.desiredDampingNspm
    ];
    highInput.netCommand.desiredActiveDampingNspm = [
      high.desiredDampingNspm, high.desiredDampingNspm,
      high.desiredDampingNspm, high.desiredDampingNspm
    ];
    lowInput.netCommand.desiredTensionsN = [0, 0, 0, 0];
    highInput.netCommand.desiredTensionsN = [100_000, 100_000, 100_000, 100_000];

    lowPlant.step(lowInput);
    highPlant.step(highInput);
    let lowResult = lowPlant.step(lowInput);
    let highResult = highPlant.step(highInput);
    expect(highResult.net.activeDampingNspm[0]).toBeGreaterThan(
      lowResult.net.activeDampingNspm[0]
    );
    expect(highResult.net.totalContactForceN[2]).toBeGreaterThan(
      lowResult.net.totalContactForceN[2]
    );
    let maximumLowPayoutM = lowResult.net.payoutM;
    let maximumHighPayoutM = highResult.net.payoutM;
    for (let index = 0; index < 100; index += 1) {
      lowResult = lowPlant.step(lowInput);
      highResult = highPlant.step(highInput);
      maximumLowPayoutM = Math.max(maximumLowPayoutM, lowResult.net.payoutM);
      maximumHighPayoutM = Math.max(maximumHighPayoutM, highResult.net.payoutM);
    }
    expect(maximumHighPayoutM).toBeLessThan(maximumLowPayoutM);
  });
});
