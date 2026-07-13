import type {
  PlatformTruthState,
  RocketTruthState,
  SensorConfig,
  Vec3
} from "./contracts";
import { DeterministicRng } from "./engine/rng";
import type { KinematicMeasurement } from "./estimation";

type KinematicTruth = RocketTruthState | PlatformTruthState;

const validateTick = (tick: number): void => {
  if (!Number.isInteger(tick) || tick < 0) {
    throw new RangeError(`tick must be a non-negative integer, received ${tick}`);
  }
};

const validateNoise = (name: string, value: number): void => {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be finite and non-negative`);
  }
};

const validateVector = (name: string, value: readonly number[]): void => {
  if (value.some((component) => !Number.isFinite(component))) {
    throw new RangeError(`${name} must contain only finite values`);
  }
};

const noisyVector = (
  value: Vec3,
  standardDeviation: number,
  rng: DeterministicRng,
  bias: Vec3 = [0, 0, 0]
): Vec3 => [
  value[0] + bias[0] + rng.normal(0, standardDeviation),
  value[1] + bias[1] + rng.normal(0, standardDeviation),
  value[2] + bias[2] + rng.normal(0, standardDeviation)
];

const sampleKinematics = (
  tick: number,
  truth: KinematicTruth,
  positionNoiseM: number,
  velocityNoiseMps: number,
  positionBiasM: Vec3,
  rng: DeterministicRng
): KinematicMeasurement => {
  validateTick(tick);
  validateNoise("position noise", positionNoiseM);
  validateNoise("velocity noise", velocityNoiseMps);
  validateVector("position bias", positionBiasM);
  validateVector("truth position", truth.positionM);
  validateVector("truth velocity", truth.velocityMps);

  return {
    tick,
    positionM: noisyVector(truth.positionM, positionNoiseM, rng, positionBiasM),
    velocityMps: noisyVector(truth.velocityMps, velocityNoiseMps, rng),
    positionVarianceM2: positionNoiseM * positionNoiseM,
    velocityVarianceM2ps2: velocityNoiseMps * velocityNoiseMps
  };
};

/**
 * Samples the rocket's onboard navigation solution in the world frame.
 *
 * `positionBiasM` belongs only to this onboard-navigation proxy. The returned
 * arrays are newly allocated and never alias the supplied truth or config.
 */
export const sampleRocketNavigation = (
  tick: number,
  truth: RocketTruthState,
  config: SensorConfig,
  rng: DeterministicRng
): KinematicMeasurement => sampleKinematics(
  tick,
  truth,
  config.rocketPositionNoiseM,
  config.rocketVelocityNoiseMps,
  config.positionBiasM,
  rng
);

/**
 * Samples a platform-based tracker observing either the rocket or platform in
 * the world frame. Ground tracking deliberately does not share the onboard
 * `positionBiasM`; its independent error proxy is the configured ground noise.
 */
export const sampleGroundTracking = (
  tick: number,
  truth: RocketTruthState | PlatformTruthState,
  config: SensorConfig,
  rng: DeterministicRng
): KinematicMeasurement => sampleKinematics(
  tick,
  truth,
  config.groundPositionNoiseM,
  config.groundVelocityNoiseMps,
  [0, 0, 0],
  rng
);
