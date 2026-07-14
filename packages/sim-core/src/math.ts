import type { Quat, Vec3 } from "./contracts";

export const vec3 = (x = 0, y = 0, z = 0): Vec3 => [x, y, z];

export const add3 = (a: Vec3, b: Vec3): Vec3 => [
  a[0] + b[0],
  a[1] + b[1],
  a[2] + b[2]
];

export const sub3 = (a: Vec3, b: Vec3): Vec3 => [
  a[0] - b[0],
  a[1] - b[1],
  a[2] - b[2]
];

export const scale3 = (a: Vec3, scalar: number): Vec3 => [
  a[0] * scalar,
  a[1] * scalar,
  a[2] * scalar
];

export const mul3 = (a: Vec3, b: Vec3): Vec3 => [
  a[0] * b[0],
  a[1] * b[1],
  a[2] * b[2]
];

export const dot3 = (a: Vec3, b: Vec3): number =>
  a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

export const cross3 = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0]
];

export const norm3 = (a: Vec3): number => Math.sqrt(dot3(a, a));

export const normalize3 = (a: Vec3, fallback: Vec3 = [0, 0, 0]): Vec3 => {
  const length = norm3(a);
  return length > 1e-12 ? scale3(a, 1 / length) : [...fallback];
};

export const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.max(minimum, Math.min(maximum, value));

export const clampMagnitude3 = (value: Vec3, maximum: number): Vec3 => {
  const length = norm3(value);
  return length > maximum && length > 0 ? scale3(value, maximum / length) : [...value];
};

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

export const smoothstep = (t: number): number => {
  const u = clamp(t, 0, 1);
  return u * u * (3 - 2 * u);
};

export const minimumJerk = (t: number): number => {
  const u = clamp(t, 0, 1);
  return u * u * u * (10 + u * (-15 + 6 * u));
};

export const quatNormalize = (q: Quat): Quat => {
  const length = Math.hypot(q[0], q[1], q[2], q[3]);
  return length > 1e-12
    ? [q[0] / length, q[1] / length, q[2] / length, q[3] / length]
    : [1, 0, 0, 0];
};

export const quatConjugate = (q: Quat): Quat => [q[0], -q[1], -q[2], -q[3]];

export const quatMultiply = (a: Quat, b: Quat): Quat => [
  a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
  a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
  a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
  a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0]
];

export const quatRotate = (q: Quat, value: Vec3): Vec3 => {
  const rotated = quatMultiply(quatMultiply(q, [0, ...value]), quatConjugate(q));
  return [rotated[1], rotated[2], rotated[3]];
};

export const quatFromTwoVectors = (from: Vec3, to: Vec3): Quat => {
  const a = normalize3(from, [0, 0, 1]);
  const b = normalize3(to, [0, 0, 1]);
  const cosine = dot3(a, b);
  if (cosine < -0.999999) {
    const axis = normalize3(Math.abs(a[0]) < 0.9 ? cross3(a, [1, 0, 0]) : cross3(a, [0, 1, 0]));
    return [0, axis[0], axis[1], axis[2]];
  }
  const axis = cross3(a, b);
  return quatNormalize([1 + cosine, axis[0], axis[1], axis[2]]);
};

export const quatErrorVector = (desired: Quat, current: Quat): Vec3 => {
  let error = quatMultiply(desired, quatConjugate(current));
  if (error[0] < 0) error = scaleQuat(error, -1);
  return [2 * error[1], 2 * error[2], 2 * error[3]];
};

const scaleQuat = (q: Quat, scalar: number): Quat => [
  q[0] * scalar,
  q[1] * scalar,
  q[2] * scalar,
  q[3] * scalar
];

export const integrateQuaternion = (q: Quat, angularVelocity: Vec3, dt: number): Quat => {
  const derivative = quatMultiply(q, [0, ...angularVelocity]);
  return quatNormalize([
    q[0] + 0.5 * derivative[0] * dt,
    q[1] + 0.5 * derivative[1] * dt,
    q[2] + 0.5 * derivative[2] * dt,
    q[3] + 0.5 * derivative[3] * dt
  ]);
};

export const tiltFromVertical = (q: Quat): number => {
  const bodyUp = quatRotate(q, [0, 0, 1]);
  return Math.acos(clamp(bodyUp[2], -1, 1));
};

export const percentile = (values: number[], quantile: number): number => {
  if (values.length === 0) return 0;
  const sorted = values.toSorted((a, b) => a - b);
  const index = clamp(Math.ceil(quantile * sorted.length) - 1, 0, sorted.length - 1);
  return sorted[index] ?? 0;
};
