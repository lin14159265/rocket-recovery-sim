import type { StateEstimate, Vec3 } from "./contracts";

const MIN_VARIANCE = 1e-12;

export interface KinematicMeasurement {
  tick: number;
  positionM: Vec3;
  velocityMps?: Vec3;
  positionVarianceM2?: number | Vec3;
  velocityVarianceM2ps2?: number | Vec3;
}

export interface AlphaBetaEstimatorOptions {
  tickDurationS: number;
  alpha?: number;
  beta?: number;
  processAccelerationVarianceM2ps4?: number;
  positionMeasurementVarianceM2?: number | Vec3;
  velocityMeasurementVarianceM2ps2?: number | Vec3;
  initialPositionVarianceM2?: number;
  initialVelocityVarianceM2ps2?: number;
}

const component = (value: number | Vec3, axis: 0 | 1 | 2): number =>
  typeof value === "number" ? value : value[axis];

const cloneEstimate = (estimate: StateEstimate): StateEstimate => ({
  ...estimate,
  positionM: [...estimate.positionM],
  velocityMps: [...estimate.velocityMps],
  accelerationMps2: [...estimate.accelerationMps2],
  covarianceDiagonal: [...estimate.covarianceDiagonal]
});

const validateTick = (tick: number): void => {
  if (!Number.isInteger(tick) || tick < 0) {
    throw new RangeError(`tick must be a non-negative integer, received ${tick}`);
  }
};

const validatePositive = (name: string, value: number): void => {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be finite and greater than zero`);
  }
};

/**
 * Position-led alpha-beta tracker used as the deliberately simple baseline.
 * Inputs are timestamped measurements; no plant/truth object is accepted.
 */
export class AlphaBetaEstimator {
  private readonly tickDurationS: number;
  private readonly alpha: number;
  private readonly beta: number;
  private readonly processAccelerationVariance: number;
  private readonly defaultPositionVariance: number | Vec3;
  private readonly defaultVelocityVariance: number | Vec3;
  private readonly initialPositionVariance: number;
  private readonly initialVelocityVariance: number;
  private current: StateEstimate | null = null;

  public constructor(options: AlphaBetaEstimatorOptions) {
    validatePositive("tickDurationS", options.tickDurationS);
    this.tickDurationS = options.tickDurationS;
    this.alpha = options.alpha ?? 0.82;
    this.beta = options.beta ?? 0.12;
    if (this.alpha <= 0 || this.alpha > 1 || this.beta < 0 || this.beta > 1) {
      throw new RangeError("alpha must be in (0, 1] and beta must be in [0, 1]");
    }
    this.processAccelerationVariance =
      options.processAccelerationVarianceM2ps4 ?? 0.36;
    this.defaultPositionVariance = options.positionMeasurementVarianceM2 ?? 1;
    this.defaultVelocityVariance = options.velocityMeasurementVarianceM2ps2 ?? 0.25;
    this.initialPositionVariance = options.initialPositionVarianceM2 ?? 25;
    this.initialVelocityVariance = options.initialVelocityVarianceM2ps2 ?? 16;
  }

  public reset(): void {
    this.current = null;
  }

  public get initialized(): boolean {
    return this.current !== null;
  }

  public snapshot(): StateEstimate | null {
    return this.current === null ? null : cloneEstimate(this.current);
  }

  /** Propagates the tracker with a constant-velocity model. */
  public predict(tick: number): StateEstimate {
    validateTick(tick);
    if (this.current === null) {
      throw new Error("alpha-beta estimator must receive a measurement before predict");
    }
    if (tick < this.current.tick) {
      throw new RangeError("alpha-beta estimator cannot predict backwards in time");
    }

    const dt = (tick - this.current.tick) * this.tickDurationS;
    if (dt === 0) return cloneEstimate(this.current);

    const dt2 = dt * dt;
    const dt4 = dt2 * dt2;
    const covariance = this.current.covarianceDiagonal;
    this.current = {
      tick,
      positionM: [
        this.current.positionM[0] + this.current.velocityMps[0] * dt,
        this.current.positionM[1] + this.current.velocityMps[1] * dt,
        this.current.positionM[2] + this.current.velocityMps[2] * dt
      ],
      velocityMps: [...this.current.velocityMps],
      accelerationMps2: [0, 0, 0],
      covarianceDiagonal: [
        covariance[0] + dt2 * covariance[3] + 0.25 * dt4 * this.processAccelerationVariance,
        covariance[1] + dt2 * covariance[4] + 0.25 * dt4 * this.processAccelerationVariance,
        covariance[2] + dt2 * covariance[5] + 0.25 * dt4 * this.processAccelerationVariance,
        covariance[3] + dt2 * this.processAccelerationVariance,
        covariance[4] + dt2 * this.processAccelerationVariance,
        covariance[5] + dt2 * this.processAccelerationVariance
      ],
      source: "ground-alpha-beta"
    };
    return cloneEstimate(this.current);
  }

  public update(measurement: KinematicMeasurement): StateEstimate {
    validateTick(measurement.tick);
    if (this.current === null) {
      this.current = {
        tick: measurement.tick,
        positionM: [...measurement.positionM],
        velocityMps: measurement.velocityMps === undefined ? [0, 0, 0] : [...measurement.velocityMps],
        accelerationMps2: [0, 0, 0],
        covarianceDiagonal: [
          this.initialPositionVariance,
          this.initialPositionVariance,
          this.initialPositionVariance,
          this.initialVelocityVariance,
          this.initialVelocityVariance,
          this.initialVelocityVariance
        ],
        source: "ground-alpha-beta"
      };
      return cloneEstimate(this.current);
    }
    if (measurement.tick < this.current.tick) {
      throw new RangeError("alpha-beta estimator rejected an out-of-order measurement");
    }

    const previousVelocity: Vec3 = [...this.current.velocityMps];
    const dt = (measurement.tick - this.current.tick) * this.tickDurationS;
    if (dt > 0) this.predict(measurement.tick);

    const predicted = this.current;
    const positionVariance = measurement.positionVarianceM2 ?? this.defaultPositionVariance;
    const velocityVariance = measurement.velocityVarianceM2ps2 ?? this.defaultVelocityVariance;
    const position: Vec3 = [...predicted.positionM];
    const velocity: Vec3 = [...predicted.velocityMps];
    const acceleration: Vec3 = [...predicted.accelerationMps2];
    const covariance = [...predicted.covarianceDiagonal] as StateEstimate["covarianceDiagonal"];

    for (const axis of [0, 1, 2] as const) {
      const residual = measurement.positionM[axis] - predicted.positionM[axis];
      position[axis] = predicted.positionM[axis] + this.alpha * residual;
      if (dt > 0) {
        velocity[axis] = predicted.velocityMps[axis] + (this.beta / dt) * residual;
      }

      const positionMeasurementVariance = Math.max(
        MIN_VARIANCE,
        component(positionVariance, axis)
      );
      covariance[axis] = Math.max(
        MIN_VARIANCE,
        (1 - this.alpha) ** 2 * covariance[axis] +
          this.alpha ** 2 * positionMeasurementVariance
      );

      const velocityIndex = (axis + 3) as 3 | 4 | 5;
      if (dt > 0) {
        covariance[velocityIndex] = Math.max(
          MIN_VARIANCE,
          (1 - this.beta) ** 2 * covariance[velocityIndex] +
            (this.beta / dt) ** 2 * positionMeasurementVariance
        );
      }

      if (measurement.velocityMps !== undefined) {
        const velocityResidual = measurement.velocityMps[axis] - velocity[axis];
        velocity[axis] += this.alpha * velocityResidual;
        covariance[velocityIndex] = Math.max(
          MIN_VARIANCE,
          (1 - this.alpha) ** 2 * covariance[velocityIndex] +
            this.alpha ** 2 * Math.max(MIN_VARIANCE, component(velocityVariance, axis))
        );
      }
      if (dt > 0) {
        const rawAcceleration = (velocity[axis] - previousVelocity[axis]) / dt;
        acceleration[axis] = 0.5 * predicted.accelerationMps2[axis] + 0.5 * rawAcceleration;
      }
    }

    this.current = {
      tick: measurement.tick,
      positionM: position,
      velocityMps: velocity,
      accelerationMps2: acceleration,
      covarianceDiagonal: covariance,
      source: "ground-alpha-beta"
    };
    return cloneEstimate(this.current);
  }
}

type Vector3State = [number, number, number];
type Matrix3 = [Vector3State, Vector3State, Vector3State];

interface AxisKalmanState {
  value: Vector3State;
  covariance: Matrix3;
}

export interface ConstantAccelerationKalmanOptions {
  tickDurationS: number;
  jerkProcessNoiseM2ps5?: number;
  positionMeasurementVarianceM2?: number | Vec3;
  velocityMeasurementVarianceM2ps2?: number | Vec3;
  initialPositionVarianceM2?: number;
  initialVelocityVarianceM2ps2?: number;
  initialAccelerationVarianceM2ps4?: number;
}

const multiplyMatrix3 = (a: Matrix3, b: Matrix3): Matrix3 => [
  [
    a[0][0] * b[0][0] + a[0][1] * b[1][0] + a[0][2] * b[2][0],
    a[0][0] * b[0][1] + a[0][1] * b[1][1] + a[0][2] * b[2][1],
    a[0][0] * b[0][2] + a[0][1] * b[1][2] + a[0][2] * b[2][2]
  ],
  [
    a[1][0] * b[0][0] + a[1][1] * b[1][0] + a[1][2] * b[2][0],
    a[1][0] * b[0][1] + a[1][1] * b[1][1] + a[1][2] * b[2][1],
    a[1][0] * b[0][2] + a[1][1] * b[1][2] + a[1][2] * b[2][2]
  ],
  [
    a[2][0] * b[0][0] + a[2][1] * b[1][0] + a[2][2] * b[2][0],
    a[2][0] * b[0][1] + a[2][1] * b[1][1] + a[2][2] * b[2][1],
    a[2][0] * b[0][2] + a[2][1] * b[1][2] + a[2][2] * b[2][2]
  ]
];

const transposeMatrix3 = (matrix: Matrix3): Matrix3 => [
  [matrix[0][0], matrix[1][0], matrix[2][0]],
  [matrix[0][1], matrix[1][1], matrix[2][1]],
  [matrix[0][2], matrix[1][2], matrix[2][2]]
];

const addMatrix3 = (a: Matrix3, b: Matrix3): Matrix3 => [
  [a[0][0] + b[0][0], a[0][1] + b[0][1], a[0][2] + b[0][2]],
  [a[1][0] + b[1][0], a[1][1] + b[1][1], a[1][2] + b[1][2]],
  [a[2][0] + b[2][0], a[2][1] + b[2][1], a[2][2] + b[2][2]]
];

const stabilizeCovariance = (matrix: Matrix3): Matrix3 => {
  const p01 = 0.5 * (matrix[0][1] + matrix[1][0]);
  const p02 = 0.5 * (matrix[0][2] + matrix[2][0]);
  const p12 = 0.5 * (matrix[1][2] + matrix[2][1]);
  return [
    [Math.max(MIN_VARIANCE, matrix[0][0]), p01, p02],
    [p01, Math.max(MIN_VARIANCE, matrix[1][1]), p12],
    [p02, p12, Math.max(MIN_VARIANCE, matrix[2][2])]
  ];
};

const scalarMeasurementUpdate = (
  state: AxisKalmanState,
  measuredIndex: 0 | 1,
  measurement: number,
  measurementVariance: number
): AxisKalmanState => {
  const p = state.covariance;
  const variance = Math.max(MIN_VARIANCE, measurementVariance);
  const innovation = measurement - state.value[measuredIndex];

  if (measuredIndex === 0) {
    const innovationVariance = p[0][0] + variance;
    const gain: Vector3State = [
      p[0][0] / innovationVariance,
      p[1][0] / innovationVariance,
      p[2][0] / innovationVariance
    ];
    const covariance: Matrix3 = [
      [p[0][0] - gain[0] * p[0][0], p[0][1] - gain[0] * p[0][1], p[0][2] - gain[0] * p[0][2]],
      [p[1][0] - gain[1] * p[0][0], p[1][1] - gain[1] * p[0][1], p[1][2] - gain[1] * p[0][2]],
      [p[2][0] - gain[2] * p[0][0], p[2][1] - gain[2] * p[0][1], p[2][2] - gain[2] * p[0][2]]
    ];
    return {
      value: [
        state.value[0] + gain[0] * innovation,
        state.value[1] + gain[1] * innovation,
        state.value[2] + gain[2] * innovation
      ],
      covariance: stabilizeCovariance(covariance)
    };
  }

  const innovationVariance = p[1][1] + variance;
  const gain: Vector3State = [
    p[0][1] / innovationVariance,
    p[1][1] / innovationVariance,
    p[2][1] / innovationVariance
  ];
  const covariance: Matrix3 = [
    [p[0][0] - gain[0] * p[1][0], p[0][1] - gain[0] * p[1][1], p[0][2] - gain[0] * p[1][2]],
    [p[1][0] - gain[1] * p[1][0], p[1][1] - gain[1] * p[1][1], p[1][2] - gain[1] * p[1][2]],
    [p[2][0] - gain[2] * p[1][0], p[2][1] - gain[2] * p[1][1], p[2][2] - gain[2] * p[1][2]]
  ];
  return {
    value: [
      state.value[0] + gain[0] * innovation,
      state.value[1] + gain[1] * innovation,
      state.value[2] + gain[2] * innovation
    ],
    covariance: stabilizeCovariance(covariance)
  };
};

/** Three independent [position, velocity, acceleration] Kalman filters. */
export class ConstantAccelerationKalman {
  private readonly tickDurationS: number;
  private readonly jerkProcessNoise: number;
  private readonly defaultPositionVariance: number | Vec3;
  private readonly defaultVelocityVariance: number | Vec3;
  private readonly initialPositionVariance: number;
  private readonly initialVelocityVariance: number;
  private readonly initialAccelerationVariance: number;
  private axes: [AxisKalmanState, AxisKalmanState, AxisKalmanState] | null = null;
  private currentTick: number | null = null;

  public constructor(options: ConstantAccelerationKalmanOptions) {
    validatePositive("tickDurationS", options.tickDurationS);
    this.tickDurationS = options.tickDurationS;
    this.jerkProcessNoise = options.jerkProcessNoiseM2ps5 ?? 0.16;
    this.defaultPositionVariance = options.positionMeasurementVarianceM2 ?? 1;
    this.defaultVelocityVariance = options.velocityMeasurementVarianceM2ps2 ?? 0.25;
    this.initialPositionVariance = options.initialPositionVarianceM2 ?? 25;
    this.initialVelocityVariance = options.initialVelocityVarianceM2ps2 ?? 16;
    this.initialAccelerationVariance = options.initialAccelerationVarianceM2ps4 ?? 9;
  }

  public reset(): void {
    this.axes = null;
    this.currentTick = null;
  }

  public get initialized(): boolean {
    return this.axes !== null;
  }

  private toEstimate(): StateEstimate {
    if (this.axes === null || this.currentTick === null) {
      throw new Error("Kalman filter is not initialized");
    }
    return {
      tick: this.currentTick,
      positionM: [this.axes[0].value[0], this.axes[1].value[0], this.axes[2].value[0]],
      velocityMps: [this.axes[0].value[1], this.axes[1].value[1], this.axes[2].value[1]],
      accelerationMps2: [this.axes[0].value[2], this.axes[1].value[2], this.axes[2].value[2]],
      covarianceDiagonal: [
        this.axes[0].covariance[0][0],
        this.axes[1].covariance[0][0],
        this.axes[2].covariance[0][0],
        this.axes[0].covariance[1][1],
        this.axes[1].covariance[1][1],
        this.axes[2].covariance[1][1]
      ],
      source: "ground-kalman"
    };
  }

  public snapshot(): StateEstimate | null {
    return this.axes === null ? null : this.toEstimate();
  }

  public predict(tick: number): StateEstimate {
    validateTick(tick);
    if (this.axes === null || this.currentTick === null) {
      throw new Error("Kalman filter must receive a measurement before predict");
    }
    if (tick < this.currentTick) {
      throw new RangeError("Kalman filter cannot predict backwards in time");
    }
    const dt = (tick - this.currentTick) * this.tickDurationS;
    if (dt === 0) return this.toEstimate();

    const dt2 = dt * dt;
    const dt3 = dt2 * dt;
    const dt4 = dt3 * dt;
    const dt5 = dt4 * dt;
    const transition: Matrix3 = [
      [1, dt, 0.5 * dt2],
      [0, 1, dt],
      [0, 0, 1]
    ];
    const q = this.jerkProcessNoise;
    const processNoise: Matrix3 = [
      [q * dt5 / 20, q * dt4 / 8, q * dt3 / 6],
      [q * dt4 / 8, q * dt3 / 3, q * dt2 / 2],
      [q * dt3 / 6, q * dt2 / 2, q * dt]
    ];

    this.axes = this.axes.map((axis): AxisKalmanState => ({
      value: [
        axis.value[0] + axis.value[1] * dt + 0.5 * axis.value[2] * dt2,
        axis.value[1] + axis.value[2] * dt,
        axis.value[2]
      ],
      covariance: stabilizeCovariance(
        addMatrix3(
          multiplyMatrix3(
            multiplyMatrix3(transition, axis.covariance),
            transposeMatrix3(transition)
          ),
          processNoise
        )
      )
    })) as [AxisKalmanState, AxisKalmanState, AxisKalmanState];
    this.currentTick = tick;
    return this.toEstimate();
  }

  public update(measurement: KinematicMeasurement): StateEstimate {
    validateTick(measurement.tick);
    if (this.axes === null || this.currentTick === null) {
      const velocity = measurement.velocityMps ?? [0, 0, 0];
      const initialCovariance = (): Matrix3 => [
        [this.initialPositionVariance, 0, 0],
        [0, this.initialVelocityVariance, 0],
        [0, 0, this.initialAccelerationVariance]
      ];
      this.axes = [
        { value: [measurement.positionM[0], velocity[0], 0], covariance: initialCovariance() },
        { value: [measurement.positionM[1], velocity[1], 0], covariance: initialCovariance() },
        { value: [measurement.positionM[2], velocity[2], 0], covariance: initialCovariance() }
      ];
      this.currentTick = measurement.tick;
    } else {
      if (measurement.tick < this.currentTick) {
        throw new RangeError("Kalman filter rejected an out-of-order measurement");
      }
      if (measurement.tick > this.currentTick) this.predict(measurement.tick);
    }

    const positionVariance = measurement.positionVarianceM2 ?? this.defaultPositionVariance;
    const velocityVariance = measurement.velocityVarianceM2ps2 ?? this.defaultVelocityVariance;
    for (const axis of [0, 1, 2] as const) {
      let updated = scalarMeasurementUpdate(
        this.axes[axis],
        0,
        measurement.positionM[axis],
        component(positionVariance, axis)
      );
      if (measurement.velocityMps !== undefined) {
        updated = scalarMeasurementUpdate(
          updated,
          1,
          measurement.velocityMps[axis],
          component(velocityVariance, axis)
        );
      }
      this.axes[axis] = updated;
    }
    return this.toEstimate();
  }
}

export interface CapturePredictionOptions {
  tickDurationS: number;
  maximumLookaheadS?: number;
  confidenceSigma?: number;
  unmodelledAccelerationStdMps2?: number;
}

export interface CapturePlanePrediction {
  timeToInterceptS: number;
  predictedInterceptTick: number;
  predictedInterceptPositionM: Vec3;
  predictedInterceptVelocityMps: Vec3;
  horizontalVarianceM2: [number, number];
  interceptTimeStdS: number;
  confidenceRadiusM: number;
}

const positiveInterceptTime = (
  position: number,
  velocity: number,
  acceleration: number,
  plane: number
): number | null => {
  const offset = position - plane;
  if (Math.abs(offset) < 1e-9) return 0;
  if (Math.abs(acceleration) < 1e-9) {
    if (Math.abs(velocity) < 1e-9) return null;
    const time = -offset / velocity;
    return time >= 0 ? time : null;
  }
  const discriminant = velocity * velocity - 2 * acceleration * offset;
  if (discriminant < 0) return null;
  const root = Math.sqrt(discriminant);
  const roots = [(-velocity - root) / acceleration, (-velocity + root) / acceleration]
    .filter((time) => time >= 0)
    .toSorted((a, b) => a - b);
  return roots[0] ?? null;
};

export function predictCapturePlaneIntersection(
  estimate: StateEstimate,
  capturePlaneZ: number,
  tickRateHz: number
): CapturePlanePrediction | null;
export function predictCapturePlaneIntersection(
  estimate: StateEstimate,
  capturePlaneZ: number,
  options: CapturePredictionOptions
): CapturePlanePrediction | null;
/** Constant-acceleration plane crossing with propagated horizontal/time uncertainty. */
export function predictCapturePlaneIntersection(
  estimate: StateEstimate,
  capturePlaneZ: number,
  optionsOrTickRate: CapturePredictionOptions | number
): CapturePlanePrediction | null {
  const options: CapturePredictionOptions =
    typeof optionsOrTickRate === "number"
      ? { tickDurationS: 1 / optionsOrTickRate }
      : optionsOrTickRate;
  validatePositive("tickDurationS", options.tickDurationS);
  const maximumLookaheadS = options.maximumLookaheadS ?? 120;
  const time = positiveInterceptTime(
    estimate.positionM[2],
    estimate.velocityMps[2],
    estimate.accelerationMps2[2],
    capturePlaneZ
  );
  if (time === null || time > maximumLookaheadS) return null;

  const time2 = time * time;
  const accelerationScale = 0.5 * time2;
  const predictedPosition: Vec3 = [
    estimate.positionM[0] + estimate.velocityMps[0] * time + accelerationScale * estimate.accelerationMps2[0],
    estimate.positionM[1] + estimate.velocityMps[1] * time + accelerationScale * estimate.accelerationMps2[1],
    capturePlaneZ
  ];
  const predictedVelocity: Vec3 = [
    estimate.velocityMps[0] + estimate.accelerationMps2[0] * time,
    estimate.velocityMps[1] + estimate.accelerationMps2[1] * time,
    estimate.velocityMps[2] + estimate.accelerationMps2[2] * time
  ];

  const accelerationStd = options.unmodelledAccelerationStdMps2 ?? 0.1;
  const accelerationVarianceContribution = accelerationScale ** 2 * accelerationStd ** 2;
  const verticalVariance = Math.max(
    MIN_VARIANCE,
    estimate.covarianceDiagonal[2] +
      time2 * estimate.covarianceDiagonal[5] +
      accelerationVarianceContribution
  );
  const interceptTimeStd = Math.sqrt(verticalVariance) /
    Math.max(0.25, Math.abs(predictedVelocity[2]));
  const interceptTimeVariance = interceptTimeStd * interceptTimeStd;
  const horizontalVariance: [number, number] = [
    Math.max(
      MIN_VARIANCE,
      estimate.covarianceDiagonal[0] +
        time2 * estimate.covarianceDiagonal[3] +
        accelerationVarianceContribution +
        predictedVelocity[0] ** 2 * interceptTimeVariance
    ),
    Math.max(
      MIN_VARIANCE,
      estimate.covarianceDiagonal[1] +
        time2 * estimate.covarianceDiagonal[4] +
        accelerationVarianceContribution +
        predictedVelocity[1] ** 2 * interceptTimeVariance
    )
  ];
  const confidenceSigma = options.confidenceSigma ?? 3;

  return {
    timeToInterceptS: time,
    predictedInterceptTick: estimate.tick + Math.max(0, Math.round(time / options.tickDurationS)),
    predictedInterceptPositionM: predictedPosition,
    predictedInterceptVelocityMps: predictedVelocity,
    horizontalVarianceM2: horizontalVariance,
    interceptTimeStdS: interceptTimeStd,
    confidenceRadiusM: confidenceSigma * Math.sqrt(horizontalVariance[0] + horizontalVariance[1])
  };
}
