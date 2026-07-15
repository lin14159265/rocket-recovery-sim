import { describe, expect, it } from "vitest";
import { createNominalScenario } from "../src/config";
import type { StateEstimate, Vec3 } from "../src/contracts";
import {
  CaptureCoordinator,
  RocketController,
  computeVerticalVelocityReference,
  sampleMinimumJerk,
  type CaptureCoordinatorInput,
  type CaptureVehicleObservation,
  type NetControlFeedback
} from "../src/control";
import {
  AlphaBetaEstimator,
  ConstantAccelerationKalman,
  predictCapturePlaneIntersection
} from "../src/estimation";

const norm = (value: Vec3): number => Math.hypot(...value);

const estimate = (
  tick: number,
  positionM: Vec3,
  velocityMps: Vec3,
  accelerationMps2: Vec3 = [0, 0, 0],
  variance = 0.01
): StateEstimate => ({
  tick,
  positionM,
  velocityMps,
  accelerationMps2,
  covarianceDiagonal: [variance, variance, variance, variance, variance, variance],
  source: "ground-kalman"
});

describe("kinematic estimators", () => {
  it("tracks a constant velocity with the alpha-beta baseline", () => {
    const tracker = new AlphaBetaEstimator({
      tickDurationS: 0.1,
      alpha: 0.8,
      beta: 0.12,
      positionMeasurementVarianceM2: 0.01,
      velocityMeasurementVarianceM2ps2: 0.01
    });

    for (let tick = 0; tick <= 30; tick += 1) {
      const time = tick * 0.1;
      tracker.update({
        tick,
        positionM: [time, -2 * time, 10 - 3 * time],
        velocityMps: [1, -2, -3]
      });
    }

    const result = tracker.snapshot();
    expect(result).not.toBeNull();
    expect(result?.positionM[0]).toBeCloseTo(3, 3);
    expect(result?.positionM[1]).toBeCloseTo(-6, 3);
    expect(result?.velocityMps[2]).toBeCloseTo(-3, 3);
    expect(() => tracker.update({ tick: 29, positionM: [0, 0, 0] })).toThrow(
      /out-of-order/
    );
  });

  it("estimates all three constant accelerations with a fixed-dimension Kalman filter", () => {
    const filter = new ConstantAccelerationKalman({
      tickDurationS: 0.1,
      jerkProcessNoiseM2ps5: 0.01,
      positionMeasurementVarianceM2: 0.0025,
      velocityMeasurementVarianceM2ps2: 0.0025
    });
    const initialPosition: Vec3 = [2, -1, 100];
    const initialVelocity: Vec3 = [1, 0.5, -10];
    const acceleration: Vec3 = [0.2, -0.1, 0.5];

    let result: StateEstimate | null = null;
    for (let tick = 0; tick <= 100; tick += 1) {
      const time = tick * 0.1;
      result = filter.update({
        tick,
        positionM: [
          initialPosition[0] + initialVelocity[0] * time + 0.5 * acceleration[0] * time * time,
          initialPosition[1] + initialVelocity[1] * time + 0.5 * acceleration[1] * time * time,
          initialPosition[2] + initialVelocity[2] * time + 0.5 * acceleration[2] * time * time
        ],
        velocityMps: [
          initialVelocity[0] + acceleration[0] * time,
          initialVelocity[1] + acceleration[1] * time,
          initialVelocity[2] + acceleration[2] * time
        ]
      });
    }

    expect(result?.accelerationMps2[0]).toBeCloseTo(acceleration[0], 2);
    expect(result?.accelerationMps2[1]).toBeCloseTo(acceleration[1], 2);
    expect(result?.accelerationMps2[2]).toBeCloseTo(acceleration[2], 2);
    expect(result?.covarianceDiagonal.every((value) => value > 0)).toBe(true);

    const predicted = filter.predict(110);
    expect(predicted.tick).toBe(110);
    expect(predicted.positionM[2]).toBeCloseTo(100 - 10 * 11 + 0.25 * 11 * 11, 1);
  });

  it("predicts the capture-plane crossing and grows a non-zero uncertainty radius", () => {
    const prediction = predictCapturePlaneIntersection(
      estimate(20, [2, -3, 100], [1, 0.5, -10]),
      0,
      { tickDurationS: 0.1, confidenceSigma: 3, unmodelledAccelerationStdMps2: 0.1 }
    );

    expect(prediction).not.toBeNull();
    expect(prediction?.timeToInterceptS).toBeCloseTo(10, 8);
    expect(prediction?.predictedInterceptTick).toBe(120);
    expect(prediction?.predictedInterceptPositionM).toEqual([12, 2, 0]);
    expect(prediction?.confidenceRadiusM).toBeGreaterThan(0);
    expect(
      predictCapturePlaneIntersection(estimate(0, [0, 0, 10], [0, 0, 2]), 0, 10)
    ).toBeNull();
  });
});

describe("rocket controller", () => {
  it("builds a downward stopping-distance velocity envelope from the estimate", () => {
    const high = computeVerticalVelocityReference(
      estimate(0, [0, 0, 900], [0, 0, -58]),
      45
    );
    const near = computeVerticalVelocityReference(
      estimate(0, [0, 0, 45], [0, 0, -8]),
      45
    );
    expect(high).toBe(-75);
    expect(near).toBe(-6);
  });

  it("applies lateral, thrust and quaternion-PD torque saturation", () => {
    const scenario = createNominalScenario();
    const controller = new RocketController(
      scenario.controller,
      scenario.rocket,
      scenario.environment.gravityMps2
    );
    const command = controller.compute({
      estimate: estimate(0, [100, -100, 80], [20, -20, -40]),
      attitudeWxyz: [0, 1, 0, 0],
      angularVelocityRadps: [20, -15, 12],
      targetPositionM: [0, 0, scenario.platform.capturePlaneZ],
      targetVelocityMps: [0, 0, -5],
      verticalVelocityReferenceMps: -5
    });

    expect(command.desiredThrustN).toBeLessThanOrEqual(scenario.rocket.thrustMaxN + 1e-8);
    expect(norm(command.desiredTorqueNm)).toBeLessThanOrEqual(scenario.rocket.torqueMaxNm + 1e-8);
    expect(Math.hypot(command.desiredAccelerationMps2[0], command.desiredAccelerationMps2[1]))
      .toBeLessThanOrEqual(scenario.rocket.lateralAccelerationLimitMps2 + 1e-8);
    expect(Math.hypot(...command.desiredAttitudeWxyz)).toBeCloseTo(1, 10);

    const cutoff = controller.compute({
      estimate: estimate(0, [0, 0, 40], [0, 0, -2]),
      attitudeWxyz: [1, 0, 0, 0],
      angularVelocityRadps: [0, 0, 0],
      targetPositionM: [0, 0, 40],
      verticalVelocityReferenceMps: -2,
      engineEnabled: false
    });
    expect(cutoff.desiredThrustN).toBe(0);
    expect(cutoff.desiredTorqueNm).toEqual([0, 0, 0]);
    expect(cutoff.desiredAccelerationMps2[2]).toBe(-scenario.environment.gravityMps2);
  });
});

describe("capture coordinator", () => {
  const platform = (tick: number): StateEstimate => estimate(tick, [0, 0, 0], [0, 0, 0]);
  const vehicle = (
    tick: number,
    ready: boolean,
    verticalSpeed = -2,
    planRevision = 1
  ): CaptureVehicleObservation => ({
    estimate: estimate(tick, [1, -1, Math.max(0, 4 + verticalSpeed * tick * 0.1)], [0, 0, verticalSpeed]),
    attitudeWxyz: [1, 0, 0, 0],
    angularVelocityRadps: [0, 0, 0],
    rocketMode: ready ? "CAPTURE_READY" : "TERMINAL",
    captureReady: ready,
    acknowledgedWindowId: ready ? 1 : null,
    acknowledgedPlanRevision: ready ? planRevision : null,
    healthFlags: 0
  });
  const net = (overrides: Partial<NetControlFeedback> = {}): NetControlFeedback => ({
    centerM: [0, 0],
    centerVelocityMps: [0, 0],
    halfSpacingM: [6, 6],
    halfSpacingRateMps: [0, 0],
    winchesReady: true,
    winchStatuses: {
      "winch-x-negative": { positionM: -6, velocityMps: 0, tensionN: 0, stuck: false, readyWindowId: 1, readyPlanRevision: 1, ready: true, estimatedArrivalTick: 0, readinessReason: "ready" },
      "winch-x-positive": { positionM: 6, velocityMps: 0, tensionN: 0, stuck: false, readyWindowId: 1, readyPlanRevision: 1, ready: true, estimatedArrivalTick: 0, readinessReason: "ready" },
      "winch-y-negative": { positionM: -6, velocityMps: 0, tensionN: 0, stuck: false, readyWindowId: 1, readyPlanRevision: 1, ready: true, estimatedArrivalTick: 0, readinessReason: "ready" },
      "winch-y-positive": { positionM: 6, velocityMps: 0, tensionN: 0, stuck: false, readyWindowId: 1, readyPlanRevision: 1, ready: true, estimatedArrivalTick: 0, readinessReason: "ready" }
    },
    anyWinchStuck: false,
    contactDetected: false,
    broken: false,
    secured: false,
    ...overrides
  });

  const makeCoordinator = (): CaptureCoordinator => {
    const scenario = createNominalScenario();
    scenario.net.openHalfSpacingM = 6;
    scenario.net.closedHalfSpacingM = 3;
    scenario.net.closureDurationS = 1;
    scenario.net.winchMaxSpeedMps = 10;
    scenario.net.winchMaxAccelerationMps2 = 20;
    scenario.controller.staleTelemetryAbortS = 0.8;
    scenario.controller.guidance.captureDescentSpeedMps = 0.5;
    scenario.controller.guidance.maximumDescentSpeedMps = 3;
    scenario.controller.guidance.brakingAccelerationMps2 = 0.5;
    return new CaptureCoordinator({
      tickDurationS: 0.1,
      controller: scenario.controller,
      net: scenario.net,
      rocket: scenario.rocket,
      gravityMps2: scenario.environment.gravityMps2,
      capturePlaneZ: 0,
      stableTrackSamples: 1,
      prepareLeadTimeS: 3,
      commitMarginS: 0.25,
      postContactTargetTensionN: 400_000
    });
  };

  const step = (
    coordinator: CaptureCoordinator,
    tick: number,
    ready: boolean,
    netFeedback = net(),
    verticalSpeed = -2,
    planRevision = 1
  ) => coordinator.step({
    tick,
    vehicleState: vehicle(tick, ready, verticalSpeed, planRevision),
    groundVehicleEstimate: vehicle(tick, ready, verticalSpeed).estimate,
    platformEstimate: platform(tick),
    net: ready
      ? {
          ...netFeedback,
          winchStatuses: Object.fromEntries(Object.entries(netFeedback.winchStatuses).map(
            ([node, status]) => [
              node,
              status === null ? null : { ...status, readyPlanRevision: planRevision }
            ]
          )) as NetControlFeedback["winchStatuses"]
        }
      : netFeedback
  });

  it("has exact minimum-jerk endpoints", () => {
    expect(sampleMinimumJerk(21, 3, 0, 5)).toEqual({
      position: 21,
      velocity: 0,
      acceleration: 0
    });
    const middle = sampleMinimumJerk(21, 3, 2.5, 5);
    expect(middle.position).toBeCloseTo(12, 10);
    expect(middle.velocity).toBeLessThan(0);
    expect(sampleMinimumJerk(21, 3, 5, 5)).toEqual({
      position: 3,
      velocity: 0,
      acceleration: 0
    });
  });

  it("requires PREPARE readiness before COMMIT and changes to tension after contact", () => {
    const coordinator = makeCoordinator();
    expect(step(coordinator, 0, false).state).toBe("SEARCH");
    expect(step(coordinator, 1, false).state).toBe("TRACK");
    const prepared = step(coordinator, 2, false);
    expect(prepared.state).toBe("SYNC");
    expect(prepared.handshakePhase).toBe("PREPARE");
    expect(prepared.winchCommands["winch-x-positive"].controlMode).toBe("position");

    const waiting = step(coordinator, 3, false);
    expect(waiting.state).toBe("SYNC");
    expect(waiting.handshakePhase).toBe("PREPARE");

    let committed = waiting;
    for (let tick = 4; tick <= 30; tick += 1) {
      const acknowledgedRevision = committed.plan?.planRevision ?? 1;
      committed = step(coordinator, tick, tick >= 8, net(), -2, acknowledgedRevision);
      if (committed.state === "ARMED") break;
    }
    expect(committed.state).toBe("ARMED");
    expect(committed.handshakePhase).toBe("COMMIT");

    const closing = step(coordinator, 11, true);
    expect(closing.state).toBe("CLOSING");
    const midClosure = step(coordinator, 14, true);
    expect(midClosure.desiredHalfSpacingM[0]).toBeLessThan(6);
    expect(midClosure.desiredHalfSpacingM[0]).toBeGreaterThan(3);

    const contact = step(coordinator, 15, true, net({ contactDetected: true }));
    expect(contact.state).toBe("CONTACT");
    expect(contact.captureMode).toBe("latched");
    expect(contact.targetTotalTensionN).toBeGreaterThan(0);
    expect(contact.winchCommands["winch-x-negative"].controlMode).toBe("tension");

    expect(step(coordinator, 16, true, net({ contactDetected: true, secured: true }), 0).state)
      .toBe("ARREST");
    expect(step(coordinator, 17, true, net({ contactDetected: true, secured: true }), 0).state)
      .toBe("SECURED");
  });

  it("aborts when PREPARE cannot become ready before the closure deadline", () => {
    const coordinator = makeCoordinator();
    const fastVehicle = (tick: number): CaptureVehicleObservation => ({
      ...vehicle(tick, false),
      estimate: estimate(tick, [0, 0, 2.4 - 2 * tick * 0.1], [0, 0, -2])
    });
    const input = (tick: number): CaptureCoordinatorInput => ({
      tick,
      vehicleState: fastVehicle(tick),
      groundVehicleEstimate: fastVehicle(tick).estimate,
      platformEstimate: platform(tick),
      net: net({ winchesReady: false })
    });

    expect(coordinator.step(input(0)).state).toBe("SEARCH");
    expect(coordinator.step(input(1)).state).toBe("TRACK");
    expect(coordinator.step(input(2)).handshakePhase).toBe("PREPARE");
    const deadlineTick = coordinator.step(input(3)).plan?.commitDeadlineTick ?? 3;
    const aborted = coordinator.step(input(deadlineTick + 1));
    expect(aborted.state).toBe("ABORT");
    expect(aborted.abortReason).toMatch(/PREPARE timed out/);
    expect(aborted.handshakePhase).toBe("ABORT");
  });

  it("aborts a live window when vehicle telemetry becomes stale", () => {
    const coordinator = makeCoordinator();
    step(coordinator, 0, false);
    step(coordinator, 1, false);
    const staleVehicle = vehicle(1, false);
    let result = coordinator.step({
      tick: 2,
      vehicleState: staleVehicle,
      groundVehicleEstimate: staleVehicle.estimate,
      platformEstimate: platform(2),
      net: net()
    });
    for (let tick = 3; tick <= 11; tick += 1) {
      result = coordinator.step({
        tick,
        vehicleState: null,
        groundVehicleEstimate: staleVehicle.estimate,
        platformEstimate: platform(tick),
        net: net()
      });
    }
    expect(result.state).toBe("ABORT");
    expect(result.abortReason).toMatch(/telemetry timeout/);
  });
});
