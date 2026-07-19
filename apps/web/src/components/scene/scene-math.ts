export type ScenePoint3 = [number, number, number];

export interface CaptureCableInput {
  frameHalfWidthM: number;
  frameHalfDepthM: number;
  capturePlaneY: number;
  centerM: [number, number];
  halfSpacingM: [number, number];
  attachmentPoint: ScenePoint3;
  rocketRadiusM: number;
  deformation: number;
  timeS: number;
  seed: number;
  reducedMotion: boolean;
  segments: number;
}

export interface CaptureCableCurve {
  id: "x-negative" | "x-positive" | "y-negative" | "y-positive";
  tensionIndex: 0 | 1 | 2 | 3;
  points: ScenePoint3[];
}

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

const mix = (from: number, to: number, amount: number): number => from + (to - from) * amount;

const hash32 = (value: number): number => {
  let hash = value | 0;
  hash = Math.imul(hash ^ (hash >>> 16), 0x45d9f3b);
  hash = Math.imul(hash ^ (hash >>> 16), 0x45d9f3b);
  return (hash ^ (hash >>> 16)) >>> 0;
};

export const seededVisualNoise = (seed: number, index: number): number =>
  hash32((seed | 0) ^ Math.imul(index + 1, 0x9e3779b1)) / 0xffff_ffff;

export function generateVisualNoiseBytes(seed: number, size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  for (let index = 0; index < size; index += 1) {
    bytes[index] = Math.round(seededVisualNoise(seed, index) * 255);
  }
  return bytes;
}

const quadraticPoint = (
  start: ScenePoint3,
  control: ScenePoint3,
  end: ScenePoint3,
  t: number
): ScenePoint3 => {
  const inverse = 1 - t;
  return [
    inverse * inverse * start[0] + 2 * inverse * t * control[0] + t * t * end[0],
    inverse * inverse * start[1] + 2 * inverse * t * control[1] + t * t * end[1],
    inverse * inverse * start[2] + 2 * inverse * t * control[2] + t * t * end[2]
  ];
};

const sampleCurve = (
  start: ScenePoint3,
  end: ScenePoint3,
  target: ScenePoint3,
  deformation: number,
  timeS: number,
  phase: number,
  reducedMotion: boolean,
  segments: number
): ScenePoint3[] => {
  const control: ScenePoint3 = [
    mix((start[0] + end[0]) / 2, target[0], deformation),
    mix((start[1] + end[1]) / 2, target[1], deformation),
    mix((start[2] + end[2]) / 2, target[2], deformation)
  ];
  const count = Math.max(4, Math.floor(segments));
  return Array.from({ length: count + 1 }, (_, index) => {
    const t = index / count;
    if (deformation <= 0) {
      return [
        mix(start[0], end[0], t),
        start[1],
        mix(start[2], end[2], t)
      ];
    }
    const point = quadraticPoint(start, control, end, t);
    if (reducedMotion || index === 0 || index === count) return point;
    const envelope = Math.sin(Math.PI * t);
    const vibration = Math.sin(timeS * 14 + phase + t * Math.PI * 5) * 0.08 * deformation * envelope;
    return [point[0], point[1] + vibration, point[2] + vibration * 0.35];
  });
};

export function sampleCaptureCables(input: CaptureCableInput): CaptureCableCurve[] {
  const deformation = clamp01(input.deformation);
  const [centerX, centerZ] = input.centerM;
  const [halfX, halfZ] = input.halfSpacingM;
  const [attachX, attachY, attachZ] = input.attachmentPoint;
  const ringOffset = Math.max(0.35, input.rocketRadiusM * 0.68);
  const phase = seededVisualNoise(input.seed, 17) * Math.PI * 2;
  const xStart = -input.frameHalfWidthM;
  const xEnd = input.frameHalfWidthM;
  const zStart = -input.frameHalfDepthM;
  const zEnd = input.frameHalfDepthM;

  const definitions: Array<{
    id: CaptureCableCurve["id"];
    tensionIndex: CaptureCableCurve["tensionIndex"];
    start: ScenePoint3;
    end: ScenePoint3;
    target: ScenePoint3;
  }> = [
    {
      id: "x-negative",
      tensionIndex: 0,
      start: [xStart, input.capturePlaneY, centerZ - halfZ],
      end: [xEnd, input.capturePlaneY, centerZ - halfZ],
      target: [attachX, attachY, attachZ - ringOffset]
    },
    {
      id: "x-positive",
      tensionIndex: 1,
      start: [xStart, input.capturePlaneY, centerZ + halfZ],
      end: [xEnd, input.capturePlaneY, centerZ + halfZ],
      target: [attachX, attachY, attachZ + ringOffset]
    },
    {
      id: "y-negative",
      tensionIndex: 2,
      start: [centerX - halfX, input.capturePlaneY, zStart],
      end: [centerX - halfX, input.capturePlaneY, zEnd],
      target: [attachX - ringOffset, attachY, attachZ]
    },
    {
      id: "y-positive",
      tensionIndex: 3,
      start: [centerX + halfX, input.capturePlaneY, zStart],
      end: [centerX + halfX, input.capturePlaneY, zEnd],
      target: [attachX + ringOffset, attachY, attachZ]
    }
  ];

  return definitions.map((definition, index) => ({
    id: definition.id,
    tensionIndex: definition.tensionIndex,
    points: sampleCurve(
      definition.start,
      definition.end,
      definition.target,
      deformation,
      input.timeS,
      phase + index * 1.37,
      input.reducedMotion,
      input.segments
    )
  }));
}

export const cablePeakVerticalDeflection = (
  curve: CaptureCableCurve,
  capturePlaneY: number
): number => curve.points.reduce(
  (peak, point) => Math.max(peak, Math.abs(point[1] - capturePlaneY)),
  0
);
