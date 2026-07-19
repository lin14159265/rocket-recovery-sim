export type SceneQualityPreference = "auto" | "high" | "medium" | "low";

export type ResolvedSceneQuality = Exclude<SceneQualityPreference, "auto">;

export interface QualityProfile {
  id: ResolvedSceneQuality;
  dpr: number;
  shadowMapSize: 512 | 1024 | 2048;
  oceanSegments: 64 | 128 | 192;
  particleCount: number;
  cableSegments: number;
  antialias: boolean;
}

export const QUALITY_PROFILES: Record<ResolvedSceneQuality, QualityProfile> = {
  high: {
    id: "high",
    dpr: 1.5,
    shadowMapSize: 1024,
    oceanSegments: 128,
    particleCount: 72,
    cableSegments: 32,
    antialias: true
  },
  medium: {
    id: "medium",
    dpr: 1.25,
    shadowMapSize: 1024,
    oceanSegments: 128,
    particleCount: 38,
    cableSegments: 24,
    antialias: true
  },
  low: {
    id: "low",
    dpr: 1,
    shadowMapSize: 512,
    oceanSegments: 64,
    particleCount: 16,
    cableSegments: 16,
    antialias: false
  }
};

export const SCENE_QUALITY_STORAGE_KEY = "recovery-scene-quality:v1";
export const QUALITY_CHANGE_COOLDOWN_MS = 30_000;

export interface AutoQualityState {
  resolved: ResolvedSceneQuality;
  poorWindows: number;
  stableWindows: number;
  lastChangeMs: number;
}

export type PerformanceSignal = "poor" | "stable";

const downgrade = (quality: ResolvedSceneQuality): ResolvedSceneQuality =>
  quality === "high" ? "medium" : "low";

const upgrade = (quality: ResolvedSceneQuality): ResolvedSceneQuality =>
  quality === "low" ? "medium" : "high";

export const isSceneQualityPreference = (value: unknown): value is SceneQualityPreference =>
  value === "auto" || value === "high" || value === "medium" || value === "low";

export function chooseInitialAutoQuality(options: {
  reducedMotion: boolean;
  webgl2: boolean;
  deviceMemoryGb?: number;
  hardwareConcurrency?: number;
}): ResolvedSceneQuality {
  if (!options.webgl2 || options.reducedMotion) return "low";
  const memory = options.deviceMemoryGb ?? 8;
  const cores = options.hardwareConcurrency ?? 8;
  if (memory >= 8 && cores >= 8) return "high";
  if (memory >= 4 && cores >= 4) return "medium";
  return "low";
}

export function resolveSceneQuality(
  preference: SceneQualityPreference,
  automaticQuality: ResolvedSceneQuality
): ResolvedSceneQuality {
  return preference === "auto" ? automaticQuality : preference;
}

export function observeAutoQuality(
  state: AutoQualityState,
  signal: PerformanceSignal,
  nowMs: number
): AutoQualityState {
  const poorWindows = signal === "poor" ? state.poorWindows + 1 : 0;
  const stableWindows = signal === "stable" ? state.stableWindows + 1 : 0;
  const cooldownPassed = nowMs - state.lastChangeMs >= QUALITY_CHANGE_COOLDOWN_MS;
  const shouldDowngrade = signal === "poor" && poorWindows >= 3 && state.resolved !== "low";
  const shouldUpgrade = signal === "stable" && stableWindows >= 5 && state.resolved !== "high";

  if (!cooldownPassed || (!shouldDowngrade && !shouldUpgrade)) {
    return { ...state, poorWindows, stableWindows };
  }

  return {
    resolved: shouldDowngrade ? downgrade(state.resolved) : upgrade(state.resolved),
    poorWindows: 0,
    stableWindows: 0,
    lastChangeMs: nowMs
  };
}

export function readSceneQualityPreference(
  storage: Pick<Storage, "getItem"> | null | undefined
): SceneQualityPreference {
  try {
    const value = storage?.getItem(SCENE_QUALITY_STORAGE_KEY);
    return isSceneQualityPreference(value) ? value : "auto";
  } catch {
    return "auto";
  }
}

export function writeSceneQualityPreference(
  storage: Pick<Storage, "setItem"> | null | undefined,
  preference: SceneQualityPreference
): void {
  try {
    storage?.setItem(SCENE_QUALITY_STORAGE_KEY, preference);
  } catch {
    // Storage is a display preference only; privacy mode must not block the simulator.
  }
}
