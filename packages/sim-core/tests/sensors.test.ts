import { describe, expect, it } from "vitest";
import { createNominalScenario } from "../src/config";
import type { PlatformTruthState, RocketTruthState } from "../src/contracts";
import { DeterministicRng } from "../src/engine/rng";
import { sampleGroundTracking, sampleRocketNavigation } from "../src/sensors";

const rocketTruth = (): RocketTruthState => ({
  positionM: [10, -20, 300],
  velocityMps: [1.5, -2.5, -30],
  attitudeWxyz: [1, 0, 0, 0],
  angularVelocityRadps: [0.01, -0.02, 0.03],
  massKg: 40_000,
  actualThrustN: 400_000,
  actualTorqueNm: [10, 20, 30],
  mode: "TERMINAL"
});

const platformTruth = (): PlatformTruthState => ({
  positionM: [2, -3, 0.4],
  velocityMps: [0.1, -0.2, 0.05],
  rollRad: 0.01,
  pitchRad: -0.02
});

describe("deterministic sensor proxies", () => {
  it("returns exact zero-noise measurements and applies bias only onboard", () => {
    const config = createNominalScenario().sensors;
    config.rocketPositionNoiseM = 0;
    config.rocketVelocityNoiseMps = 0;
    config.groundPositionNoiseM = 0;
    config.groundVelocityNoiseMps = 0;
    config.positionBiasM = [0.5, -0.25, 0.125];
    const rocket = rocketTruth();
    const platform = platformTruth();

    const onboard = sampleRocketNavigation(42, rocket, config, new DeterministicRng(1));
    const groundRocket = sampleGroundTracking(42, rocket, config, new DeterministicRng(2));
    const groundPlatform = sampleGroundTracking(42, platform, config, new DeterministicRng(3));

    expect(onboard).toEqual({
      tick: 42,
      positionM: [10.5, -20.25, 300.125],
      velocityMps: [1.5, -2.5, -30],
      positionVarianceM2: 0,
      velocityVarianceM2ps2: 0
    });
    expect(groundRocket.positionM).toEqual(rocket.positionM);
    expect(groundRocket.velocityMps).toEqual(rocket.velocityMps);
    expect(groundPlatform.positionM).toEqual(platform.positionM);
    expect(groundPlatform.velocityMps).toEqual(platform.velocityMps);
  });

  it("produces bit-identical sequences for the same seed", () => {
    const config = createNominalScenario().sensors;
    const first = new DeterministicRng(20260710);
    const second = new DeterministicRng(20260710);
    const rocket = rocketTruth();
    const platform = platformTruth();

    const firstSequence = [
      sampleRocketNavigation(10, rocket, config, first),
      sampleGroundTracking(10, rocket, config, first),
      sampleGroundTracking(10, platform, config, first)
    ];
    const secondSequence = [
      sampleRocketNavigation(10, rocket, config, second),
      sampleGroundTracking(10, rocket, config, second),
      sampleGroundTracking(10, platform, config, second)
    ];

    expect(firstSequence).toEqual(secondSequence);
  });

  it("uses the configured Gaussian noise scales and onboard position bias", () => {
    const config = createNominalScenario().sensors;
    config.rocketPositionNoiseM = 2;
    config.rocketVelocityNoiseMps = 0.5;
    config.groundPositionNoiseM = 4;
    config.groundVelocityNoiseMps = 1.5;
    config.positionBiasM = [1, -2, 3];
    const truth = rocketTruth();
    const actualRng = new DeterministicRng(99);
    const expectedRng = new DeterministicRng(99);

    const measurement = sampleRocketNavigation(7, truth, config, actualRng);
    const expectedPosition = truth.positionM.map((value, axis) =>
      value + config.positionBiasM[axis]! + expectedRng.normal(0, 2)
    );
    const expectedVelocity = truth.velocityMps.map((value) =>
      value + expectedRng.normal(0, 0.5)
    );

    expect(measurement.positionM).toEqual(expectedPosition);
    expect(measurement.velocityMps).toEqual(expectedVelocity);
    expect(measurement.positionVarianceM2).toBe(4);
    expect(measurement.velocityVarianceM2ps2).toBe(0.25);
    expect(measurement.positionM).not.toEqual([
      truth.positionM[0] + config.positionBiasM[0],
      truth.positionM[1] + config.positionBiasM[1],
      truth.positionM[2] + config.positionBiasM[2]
    ]);

    const platform = platformTruth();
    const groundActualRng = new DeterministicRng(101);
    const groundExpectedRng = new DeterministicRng(101);
    const groundMeasurement = sampleGroundTracking(8, platform, config, groundActualRng);
    const expectedGroundPosition = platform.positionM.map((value) =>
      value + groundExpectedRng.normal(0, 4)
    );
    const expectedGroundVelocity = platform.velocityMps.map((value) =>
      value + groundExpectedRng.normal(0, 1.5)
    );

    expect(groundMeasurement.positionM).toEqual(expectedGroundPosition);
    expect(groundMeasurement.velocityMps).toEqual(expectedGroundVelocity);
    expect(groundMeasurement.positionVarianceM2).toBe(16);
    expect(groundMeasurement.velocityVarianceM2ps2).toBe(2.25);
  });

  it("does not mutate or expose aliases to truth and configuration inputs", () => {
    const config = createNominalScenario().sensors;
    config.rocketPositionNoiseM = 0;
    config.rocketVelocityNoiseMps = 0;
    const truth = rocketTruth();
    const truthBefore = structuredClone(truth);
    const configBefore = structuredClone(config);

    const measurement = sampleRocketNavigation(0, truth, config, new DeterministicRng(5));
    measurement.positionM[0] = 999;
    measurement.velocityMps![1] = 888;

    expect(truth).toEqual(truthBefore);
    expect(config).toEqual(configBefore);
    expect(measurement.positionM).not.toBe(truth.positionM);
    expect(measurement.velocityMps).not.toBe(truth.velocityMps);
  });
});
