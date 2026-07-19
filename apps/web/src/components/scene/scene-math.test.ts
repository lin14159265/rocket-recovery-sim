import { describe, expect, it } from "vitest";
import {
  cablePeakVerticalDeflection,
  generateVisualNoiseBytes,
  sampleCaptureCables
} from "./scene-math";

const input = {
  frameHalfWidthM: 22,
  frameHalfDepthM: 20,
  capturePlaneY: 12,
  centerM: [1, -2] as [number, number],
  halfSpacingM: [3, 3] as [number, number],
  attachmentPoint: [0.5, 18, -1] as [number, number, number],
  rocketRadiusM: 2.5,
  timeS: 9,
  seed: 4401,
  reducedMotion: true,
  segments: 20
};

describe("deterministic visual scene math", () => {
  it("generates the same visual noise for the same seed", () => {
    expect(generateVisualNoiseBytes(99, 64)).toEqual(generateVisualNoiseBytes(99, 64));
    expect(generateVisualNoiseBytes(99, 64)).not.toEqual(generateVisualNoiseBytes(100, 64));
  });

  it("keeps four continuous pre-contact ropes in one capture plane", () => {
    const cables = sampleCaptureCables({ ...input, deformation: 0 });
    expect(cables).toHaveLength(4);
    for (const cable of cables) {
      expect(cable.points).toHaveLength(21);
      expect(cable.points.every((point) => point[1] === input.capturePlaneY)).toBe(true);
      for (let index = 1; index < cable.points.length; index += 1) {
        const previous = cable.points[index - 1]!;
        const current = cable.points[index]!;
        expect(Math.hypot(current[0] - previous[0], current[1] - previous[1], current[2] - previous[2])).toBeLessThan(3);
      }
    }
  });

  it("preserves endpoints and increases cable deflection monotonically after contact", () => {
    const flat = sampleCaptureCables({ ...input, deformation: 0 });
    const half = sampleCaptureCables({ ...input, deformation: 0.5 });
    const full = sampleCaptureCables({ ...input, deformation: 1 });
    for (let index = 0; index < 4; index += 1) {
      expect(half[index]!.points[0]).toEqual(flat[index]!.points[0]);
      expect(half[index]!.points.at(-1)).toEqual(flat[index]!.points.at(-1));
      expect(cablePeakVerticalDeflection(half[index]!, input.capturePlaneY)).toBeGreaterThan(0);
      expect(cablePeakVerticalDeflection(full[index]!, input.capturePlaneY)).toBeGreaterThanOrEqual(
        cablePeakVerticalDeflection(half[index]!, input.capturePlaneY)
      );
    }
  });
});
