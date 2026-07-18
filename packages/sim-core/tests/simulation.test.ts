import { describe, expect, it } from "vitest";
import { createNominalScenario } from "../src/config";
import { tiltFromVertical } from "../src/math";
import { runSimulation } from "../src/simulation";

describe("multi-rate recovery simulation", () => {
  it("closes the nominal sensor-comms-control-plant loop", () => {
    const config = createNominalScenario();
    const run = runSimulation(config, { frameRateHz: 2 });

    expect(run.finalSnapshot.supervisorState).toBe("SECURED");
    expect(run.metrics.captured).toBe(true);
    expect(run.metrics.secured).toBe(true);
    expect(run.metrics.failed).toBe(false);
    expect(run.metrics.captureRelativeSpeedMps).toBeLessThanOrEqual(
      config.controller.maxCaptureSpeedMps
    );
    expect(run.metrics.captureTiltRad).toBeLessThanOrEqual(
      config.controller.maxCaptureTiltRad
    );
    expect(tiltFromVertical(run.finalSnapshot.rocket.attitudeWxyz)).toBeLessThan(
      Math.PI / 60
    );
    expect(run.metrics.peakContactForceN).toBeLessThanOrEqual(
      config.net.totalStrengthLimitN
    );
    expect(run.finalSnapshot.radioStats.delivered).toBeGreaterThan(0);
    expect(run.finalSnapshot.fieldbusStats.delivered).toBeGreaterThan(0);
    expect(run.events.map((event) => event.message)).toEqual(expect.arrayContaining([
      "TRACK → SYNC",
      "SYNC → ARMED",
      "ARMED → CLOSING",
      "CLOSING → CONTACT",
      "CONTACT → ARREST",
      "ARREST → SECURED"
    ]));
  });

  it("records the physical terminal snapshot when stopOnTerminal is enabled", () => {
    const run = runSimulation(createNominalScenario(), {
      frameRateHz: 2,
      stopOnTerminal: true
    });

    expect(run.finalSnapshot.supervisorState).toBe("SECURED");
    expect(run.metrics.secured).toBe(true);
    expect(run.finalSnapshot.metrics.secured).toBe(true);
    expect(run.frames.at(-1)).toEqual(run.finalSnapshot);
  });

  it("is bit-repeatable for the same scenario and seed", () => {
    const first = runSimulation(createNominalScenario(), { frameRateHz: 2 });
    const second = runSimulation(createNominalScenario(), { frameRateHz: 2 });

    expect(second.metrics).toEqual(first.metrics);
    expect(second.events).toEqual(first.events);
    expect(second.telemetry).toEqual(first.telemetry);
    expect(second.finalSnapshot.rocket).toEqual(first.finalSnapshot.rocket);
    expect(second.finalSnapshot.net).toEqual(first.finalSnapshot.net);
    expect(second.finalSnapshot.radioStats).toEqual(first.finalSnapshot.radioStats);
  });

  it("identifies the model version and exact configuration", () => {
    const baseline = runSimulation(createNominalScenario(), { frameRateHz: 1 });
    const changedConfig = createNominalScenario();
    changedConfig.rocket.massKg += 1;
    const changed = runSimulation(changedConfig, { frameRateHz: 1 });

    expect(baseline.modelVersion).toMatch(/^0\.4\./);
    expect(baseline.configFingerprint).toMatch(/^[0-9a-f]{8}$/);
    expect(changed.configFingerprint).not.toBe(baseline.configFingerprint);
    expect(baseline.finalSnapshot.runId).toContain(baseline.configFingerprint);
    expect(baseline.finalSnapshot.runId).toContain(baseline.config.controller.algorithm);
  });

  it("cannot magically capture through a sustained radio blackout", () => {
    const run = runSimulation(createNominalScenario(), {
      frameRateHz: 2,
      faults: {
        radioBlackouts: [{ startTimeS: 14, endTimeS: 22 }]
      }
    });

    expect(run.finalSnapshot.supervisorState).toBe("ABORT");
    expect(run.metrics.captured).toBe(false);
    expect(run.metrics.failed).toBe(true);
    expect(run.metrics.failureReason).toMatch(/telemetry timeout/);
  });

  it("aborts when a reported winch becomes stuck", () => {
    const run = runSimulation(createNominalScenario(), {
      frameRateHz: 2,
      faults: {
        winchStuck: [{ node: "winch-x-negative", startTimeS: 12 }]
      }
    });

    expect(run.finalSnapshot.supervisorState).toBe("ABORT");
    expect(run.metrics.captured).toBe(false);
    expect(run.metrics.failed).toBe(true);
    expect(run.metrics.failureReason).toMatch(/winch unavailable/);
  });
  it("records scenario-defined fault activation and clearing", () => {
    const config = createNominalScenario();
    config.durationS = 0.08;
    config.faults.sensorBiasStep = {
      enabled: true,
      startTimeS: 0.01,
      durationS: 0.02,
      deltaM: [1, 0, 0]
    };
    const run = runSimulation(config, { frameRateHz: 20 });
    const faultEvents = run.events.filter((event) =>
      event.type === "FAULT_INJECTED" || event.type === "FAULT_CLEARED"
    );
    expect(faultEvents.map((event) => event.type)).toEqual([
      "FAULT_INJECTED",
      "FAULT_CLEARED"
    ]);
    expect(faultEvents[0]?.message).toMatch(/导航偏置阶跃/);
  });

  it("is bit-repeatable in MPC mode including iterations and fallback reasons", () => {
    const config = createNominalScenario();
    config.controller.algorithm = "mpc";
    const first = runSimulation(config, { frameRateHz: 1, stopOnTerminal: true });
    const second = runSimulation(config, { frameRateHz: 1, stopOnTerminal: true });

    expect(second.metrics).toEqual(first.metrics);
    expect(second.events).toEqual(first.events);
    expect(second.telemetry).toEqual(first.telemetry);
    expect(second.metrics.mpcFallbackReasons).toEqual(first.metrics.mpcFallbackReasons);
    expect(second.telemetry.map((sample) => sample.mpcIterations))
      .toEqual(first.telemetry.map((sample) => sample.mpcIterations));
  });

});
