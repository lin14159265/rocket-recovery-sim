import { describe, expect, it } from "vitest";
import type {
  NetTruthState,
  PlatformTruthState,
  RocketTruthState,
  StateEstimate,
  Vec3
} from "../src/contracts";
import { RecoveryMetricsAccumulator } from "../src/metrics";
import type {
  CaptureEvaluation,
  PlantAppliedForces,
  PlantStepEnergy,
  PlantStepResult
} from "../src/plant";

const makeRocket = (positionM: Vec3 = [0, 0, 10]): RocketTruthState => ({
  positionM: [...positionM],
  velocityMps: [0, 0, -1],
  attitudeWxyz: [1, 0, 0, 0],
  angularVelocityRadps: [0, 0, 0],
  massKg: 100,
  actualThrustN: 0,
  actualTorqueNm: [0, 0, 0],
  mode: "TERMINAL"
});

const makePlatform = (): PlatformTruthState => ({
  positionM: [0, 0, 0],
  velocityMps: [0, 0, 0],
  rollRad: 0,
  pitchRad: 0
});

const makeNet = (): NetTruthState => {
  const axis = (positionM: number) => ({
    positionM,
    velocityMps: 0,
    desiredPositionM: positionM,
    appliedAccelerationMps2: 0,
    stuck: false
  });

  return {
    xNegative: axis(-3),
    xPositive: axis(3),
    yNegative: axis(-3),
    yPositive: axis(3),
    centerM: [0, 0],
    halfSpacingM: [3, 3],
    tensionsN: [0, 0, 0, 0],
    totalContactForceN: [0, 0, 0],
    payoutM: 0,
    payoutVelocityMps: 0,
    targetTotalTensionN: 0,
    desiredTensionsN: [0, 0, 0, 0],
    activeDampingNspm: [26_250, 26_250, 26_250, 26_250],
    tensionControllerSaturated: [false, false, false, false],
    mode: "closing"
  };
};

const noCapture = (): CaptureEvaluation => ({
  attempted: false,
  captured: false,
  rejectionReason: null,
  centerOffsetM: [0, 0],
  missDistanceM: 0,
  relativeSpeedMps: 0,
  tiltRad: 0
});

const makeForces = (): PlantAppliedForces => ({
  gravityN: [0, 0, -981],
  thrustN: [0, 0, 0],
  aerodynamicDragN: [0, 0, 0],
  contactN: [0, 0, 0],
  totalN: [0, 0, -981]
});


const makeEnergy = (): PlantStepEnergy => ({
  contactActive: false,
  translationalKineticBeforeJ: 0,
  translationalKineticAfterJ: 0,
  relativeKineticBeforeJ: 0,
  relativeKineticAfterJ: 0,
  rotationalKineticBeforeJ: 0,
  rotationalKineticAfterJ: 0,
  gravitationalPotentialBeforeJ: 0,
  gravitationalPotentialAfterJ: 0,
  gravityWorkJ: 0,
  thrustWorkJ: 0,
  aerodynamicWorkJ: 0,
  contactWorkOnRocketJ: 0,
  controlTorqueWorkJ: 0,
  relativeContactWorkExtractedJ: 0,
  platformBoundaryWorkJ: 0,
  contactDampingDissipationJ: 0,
  elasticStorageBeforeJ: 0,
  elasticStorageAfterJ: 0
});

const makeStep = (tick = 1): PlantStepResult => ({
  tick,
  timeS: tick * 0.01,
  rocket: makeRocket(),
  platform: makePlatform(),
  net: makeNet(),
  gustMps: [0, 0, 0],
  windMps: [0, 0, 0],
  forces: makeForces(),
  energy: makeEnergy(),
  capture: noCapture(),
  capturedThisStep: false,
  missedThisStep: false,
  ropeBrokenThisStep: false,
  securedThisStep: false,
  failureReason: null
});

const makeEstimate = (positionM: Vec3 = [0, 0, 10]): StateEstimate => ({
  tick: 1,
  positionM: [...positionM],
  velocityMps: [0, 0, -1],
  accelerationMps2: [0, 0, 0],
  covarianceDiagonal: [1, 1, 1, 1, 1, 1],
  source: "ground-kalman"
});

describe("RecoveryMetricsAccumulator", () => {
  it("records the first capture crossing and later secured transition", () => {
    const accumulator = new RecoveryMetricsAccumulator();
    const captureStep = makeStep(42);
    captureStep.capture = {
      attempted: true,
      captured: true,
      rejectionReason: null,
      centerOffsetM: [0.2, -0.1],
      missDistanceM: 0,
      relativeSpeedMps: 7.5,
      tiltRad: 0.08
    };
    captureStep.capturedThisStep = true;
    captureStep.net.mode = "latched";

    const captured = accumulator.update(captureStep, makeEstimate(), 9.81);
    expect(captured).toMatchObject({
      captured: true,
      secured: false,
      failed: false,
      captureTick: 42,
      missDistanceM: 0,
      captureRelativeSpeedMps: 7.5,
      captureTiltRad: 0.08
    });

    const securedStep = makeStep(84);
    securedStep.net.mode = "secured";
    securedStep.securedThisStep = true;
    expect(accumulator.update(securedStep, makeEstimate(), 9.81).secured).toBe(true);

    captured.failed = true;
    expect(accumulator.snapshot().failed).toBe(false);
  });

  it("marks a rope break failed and preserves the physical failure reason", () => {
    const accumulator = new RecoveryMetricsAccumulator();
    const step = makeStep(9);
    step.net.mode = "broken";
    step.ropeBrokenThisStep = true;
    step.failureReason = "strength-limit-exceeded";

    expect(accumulator.update(step, makeEstimate(), 9.81)).toMatchObject({
      captured: false,
      secured: false,
      failed: true,
      failureReason: "strength-limit-exceeded"
    });
  });

  it("keeps peak contact force, apparent load, and single-rope tension", () => {
    const accumulator = new RecoveryMetricsAccumulator();
    const first = makeStep(1);
    first.forces.contactN = [300, 400, 0];
    first.forces.totalN = [300, 400, -981];
    first.net.tensionsN = [80, 120, 90, 110];

    const firstMetrics = accumulator.update(first, makeEstimate(), 9.81);
    expect(firstMetrics.peakContactForceN).toBeCloseTo(500, 12);
    expect(firstMetrics.peakApparentLoadG).toBeCloseTo(500 / 981, 12);
    expect(firstMetrics.peakRopeTensionN).toBe(120);

    const second = makeStep(2);
    second.forces.contactN = [0, 100, 0];
    second.forces.totalN = [0, 100, -981];
    second.net.tensionsN = [50, 60, 70, 80];
    expect(accumulator.update(second, makeEstimate(), 9.81)).toMatchObject({
      peakContactForceN: 500,
      peakRopeTensionN: 120
    });
  });

  it("tracks the maximum Euclidean position-estimate error", () => {
    const accumulator = new RecoveryMetricsAccumulator();
    const step = makeStep();
    step.rocket.positionM = [1, 2, 3];

    expect(accumulator.update(step, makeEstimate([4, 6, 3]), 9.81).maxEstimateErrorM).toBe(5);
    expect(accumulator.update(step, makeEstimate([2, 2, 3]), 9.81).maxEstimateErrorM).toBe(5);
  });
});
