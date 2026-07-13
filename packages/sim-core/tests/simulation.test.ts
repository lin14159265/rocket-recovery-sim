import { describe, expect, it } from "vitest";
import { createNominalScenario } from "../src/config";
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
});
