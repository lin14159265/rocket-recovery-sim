import { describe, expect, it } from "vitest";
import { createNominalScenario, runSimulation } from "@recovery/sim-core";
import { displayedConfigFor, frameAtTime, patchParameter } from "../src/app-state";

describe("web app state boundaries", () => {
  it("keeps rendered results bound to run.config while a draft is dirty", () => {
    const run = runSimulation(createNominalScenario(), { frameRateHz: 1, stopOnTerminal: true });
    const draft = patchParameter(run.config, "rocket.massKg", run.config.rocket.massKg + 5_000);
    expect(displayedConfigFor(run, draft)).toBe(run.config);
    expect(displayedConfigFor(run, draft).rocket.massKg).toBe(run.config.rocket.massKg);
    expect(draft.rocket.massKg).not.toBe(run.config.rocket.massKg);
  });

  it("uses the draft only before a run exists", () => {
    const draft = createNominalScenario();
    expect(displayedConfigFor(null, draft)).toBe(draft);
  });

  it("selects the latest frame not later than the requested time", () => {
    const run = runSimulation(createNominalScenario(), { frameRateHz: 2, stopOnTerminal: true });
    const selected = frameAtTime(run.frames, 0.76);
    expect(selected?.timeS).toBeLessThanOrEqual(0.76);
    const next = run.frames.find((frame) => frame.timeS > 0.76);
    if (next !== undefined) expect(next.timeS).toBeGreaterThan(selected?.timeS ?? -1);
  });
});
