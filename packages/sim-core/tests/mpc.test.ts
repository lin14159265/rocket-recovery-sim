import { describe, expect, it } from "vitest";
import { createNominalScenario } from "../src/config";
import { CooperativeMpcPlanner, type CooperativeMpcInput } from "../src/mpc";

const input = (): CooperativeMpcInput => ({
  rocketPositionM: [5, -3],
  rocketVelocityMps: [-1, 0.5],
  netCenterM: [0, 0],
  netCenterVelocityMps: [0, 0],
  halfSpacingM: [21, 21],
  halfSpacingRateMps: [0, 0],
  predictedInterceptCenterM: [1, -1],
  predictedRelativeInterceptVelocityMps: [0, 0, -10],
  timeToInterceptS: 7,
  communicationAgeS: 0.05
});

describe("deterministic cooperative MPC", () => {
  it("converges inside the fixed iteration budget and respects projected controls", () => {
    const config = createNominalScenario();
    const solution = new CooperativeMpcPlanner(config.controller, config.rocket, config.net)
      .solve(input());

    expect(solution.diagnostics.converged).toBe(true);
    expect(solution.diagnostics.fallbackReason).toBe("none");
    expect(solution.diagnostics.iterations).toBeLessThanOrEqual(40);
    expect(Math.hypot(...solution.rocketAccelerationReferenceMps2))
      .toBeLessThanOrEqual(config.rocket.lateralAccelerationLimitMps2);
    expect(Math.hypot(...solution.netAccelerationReferenceMps2))
      .toBeLessThanOrEqual(config.net.winchMaxAccelerationMps2);
    expect(Math.abs(solution.halfSpacingClosureRateMps))
      .toBeLessThanOrEqual(config.net.winchMaxSpeedMps);
  });

  it("is bit-repeatable including iterations and active constraints", () => {
    const config = createNominalScenario();
    const first = new CooperativeMpcPlanner(config.controller, config.rocket, config.net)
      .solve(input());
    const second = new CooperativeMpcPlanner(config.controller, config.rocket, config.net)
      .solve(input());
    expect(second).toEqual(first);
  });

  it("falls back for stale or unsafe inputs without emitting a control reference", () => {
    const config = createNominalScenario();
    const planner = new CooperativeMpcPlanner(config.controller, config.rocket, config.net);
    const stale = planner.solve({
      ...input(),
      communicationAgeS: config.controller.staleTelemetryAbortS
    });
    expect(stale.diagnostics.fallbackReason).toBe("stale-input");
    expect(stale.rocketAccelerationReferenceMps2).toEqual([0, 0]);

    const unsafe = planner.solve({
      ...input(),
      predictedRelativeInterceptVelocityMps: [0, 0, -30]
    });
    expect(unsafe.diagnostics.fallbackReason).toBe("strength-proxy");
  });
});
