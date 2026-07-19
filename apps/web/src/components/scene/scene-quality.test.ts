import { describe, expect, it } from "vitest";
import {
  QUALITY_PROFILES,
  type AutoQualityState,
  chooseInitialAutoQuality,
  observeAutoQuality,
  readSceneQualityPreference,
  resolveSceneQuality,
  writeSceneQualityPreference
} from "./scene-quality";

describe("scene quality", () => {
  it("maps every quality profile to the agreed render budget", () => {
    expect(QUALITY_PROFILES.high).toMatchObject({ dpr: 1.5, shadowMapSize: 1024, oceanSegments: 128 });
    expect(QUALITY_PROFILES.medium).toMatchObject({ dpr: 1.25, shadowMapSize: 1024, oceanSegments: 128 });
    expect(QUALITY_PROFILES.low).toMatchObject({ dpr: 1, shadowMapSize: 512, oceanSegments: 64 });
  });

  it("falls back for reduced motion or unavailable WebGL2", () => {
    expect(chooseInitialAutoQuality({ reducedMotion: true, webgl2: true })).toBe("low");
    expect(chooseInitialAutoQuality({ reducedMotion: false, webgl2: false })).toBe("low");
    expect(chooseInitialAutoQuality({ reducedMotion: false, webgl2: true, deviceMemoryGb: 4, hardwareConcurrency: 6 })).toBe("medium");
    expect(resolveSceneQuality("high", "low")).toBe("high");
    expect(resolveSceneQuality("auto", "medium")).toBe("medium");
  });

  it("requires sustained performance evidence and a 30 second cooldown", () => {
    let state: AutoQualityState = { resolved: "high", poorWindows: 0, stableWindows: 0, lastChangeMs: -30_000 };
    state = observeAutoQuality(state, "poor", 0);
    state = observeAutoQuality(state, "poor", 1_000);
    expect(state.resolved).toBe("high");
    state = observeAutoQuality(state, "poor", 2_000);
    expect(state.resolved).toBe("medium");
    state = observeAutoQuality(state, "poor", 3_000);
    state = observeAutoQuality(state, "poor", 4_000);
    state = observeAutoQuality(state, "poor", 5_000);
    expect(state.resolved).toBe("medium");
    state = observeAutoQuality(state, "poor", 33_000);
    state = observeAutoQuality(state, "poor", 34_000);
    state = observeAutoQuality(state, "poor", 35_000);
    expect(state.resolved).toBe("low");
  });

  it("handles unavailable storage without affecting the simulation", () => {
    const memory = new Map<string, string>();
    const storage = {
      getItem: (key: string) => memory.get(key) ?? null,
      setItem: (key: string, value: string) => memory.set(key, value)
    };
    writeSceneQualityPreference(storage, "medium");
    expect(readSceneQualityPreference(storage)).toBe("medium");
    expect(readSceneQualityPreference({ getItem: () => { throw new Error("blocked"); } })).toBe("auto");
    expect(() => writeSceneQualityPreference({ setItem: () => { throw new Error("blocked"); } }, "high")).not.toThrow();
  });
});
