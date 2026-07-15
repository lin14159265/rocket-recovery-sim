import type {
  CaptureMode,
  CapturePlanPayload,
  ControlCommand,
  ControllerConfig,
  NetConfig,
  Quat,
  RocketConfig,
  StateEstimate,
  SupervisorState,
  VehicleStatePayload,
  Vec3,
  WinchCommandPayload,
  WinchNodeId,
  WinchStatusPayload
} from "./contracts";
import { WINCH_IDS } from "./contracts";
import {
  clamp,
  clampMagnitude3,
  cross3,
  integrateQuaternion,
  minimumJerk,
  norm3,
  quatErrorVector,
  quatFromTwoVectors,
  quatRotate,
  tiltFromVertical
} from "./math";
import type { CapturePlanePrediction } from "./estimation";

export interface RocketControllerInput {
  estimate: StateEstimate;
  attitudeWxyz: Quat;
  angularVelocityRadps: Vec3;
  targetPositionM: Vec3;
  targetVelocityMps?: Vec3;
  verticalVelocityReferenceMps: number;
  estimatedMassKg?: number;
  engineEnabled?: boolean;
}

export interface VerticalVelocityReferenceOptions {
  captureDescentSpeedMps?: number;
  maximumDescentSpeedMps?: number;
  brakingAccelerationMps2?: number;
}

export interface GuidedCapturePrediction extends CapturePlanePrediction {
  predictionUncertaintyM: Vec3;
  controlAuthorityMarginMps2: number;
  rolloutSteps: number;
}

export interface GuidedCapturePredictionOptions {
  controller: ControllerConfig;
  rocket: Pick<
    RocketConfig,
    | "massKg"
    | "inertiaKgM2"
    | "thrustMaxN"
    | "thrustTimeConstantS"
    | "torqueMaxNm"
    | "attitudeTimeConstantS"
    | "lateralAccelerationLimitMps2"
  >;
  gravityMps2: number;
  tickDurationS: number;
  targetCenterM?: [number, number];
  attitudeWxyz?: Quat;
  angularVelocityRadps?: Vec3;
}

/**
 * Generates a stopping-distance velocity envelope from an estimated altitude.
 * Returned values are negative (downward) and approach the requested capture speed.
 */
export const computeVerticalVelocityReference = (
  estimate: StateEstimate,
  capturePlaneZ: number,
  options: VerticalVelocityReferenceOptions = {}
): number => {
  const captureSpeed = Math.max(0, options.captureDescentSpeedMps ?? 6);
  const maximumSpeed = Math.max(captureSpeed, options.maximumDescentSpeedMps ?? 75);
  const brakingAcceleration = Math.max(1e-6, options.brakingAccelerationMps2 ?? 4);
  const altitudeAbovePlane = Math.max(0, estimate.positionM[2] - capturePlaneZ);
  const stoppingEnvelope = Math.sqrt(
    captureSpeed * captureSpeed + 2 * brakingAcceleration * altitudeAbovePlane
  );
  return -Math.min(maximumSpeed, stoppingEnvelope);
};

/**
 * Estimate-only forward rollout using the same velocity envelope, PD law,
 * acceleration limits and first-order thrust response as the local controller.
 * It deliberately remains a bounded proxy and never reads plant truth.
 */
export const predictGuidedCaptureIntersection = (
  estimate: StateEstimate,
  capturePlaneZ: number,
  options: GuidedCapturePredictionOptions
): GuidedCapturePrediction | null => {
  const { controller, rocket, gravityMps2, tickDurationS } = options;
  const stepS = controller.prediction.stepS;
  const maximumHorizonS = controller.prediction.maximumHorizonS;
  if (stepS <= 0 || maximumHorizonS <= 0 || gravityMps2 <= 0 || tickDurationS <= 0) {
    throw new RangeError("guided prediction settings must be physically positive");
  }
  if (estimate.positionM[2] <= capturePlaneZ && estimate.velocityMps[2] <= 0) {
    return null;
  }

  const targetCenter = options.targetCenterM ?? [0, 0];
  const position: Vec3 = [...estimate.positionM];
  const velocity: Vec3 = [...estimate.velocityMps];
  let appliedAcceleration: Vec3 = [...estimate.accelerationMps2];
  let attitudeWxyz: Quat = [...(options.attitudeWxyz ?? [1, 0, 0, 0])];
  let angularVelocityRadps: Vec3 = [...(options.angularVelocityRadps ?? [0, 0, 0])];
  let actualTorqueNm: Vec3 = [0, 0, 0];
  const maximumSteps = Math.max(1, Math.ceil(maximumHorizonS / stepS));
  const availableSpecificThrust = rocket.thrustMaxN / rocket.massKg;
  let actualThrustN = clamp(
    rocket.massKg * norm3([
      estimate.accelerationMps2[0],
      estimate.accelerationMps2[1],
      gravityMps2 + estimate.accelerationMps2[2]
    ]),
    0,
    rocket.thrustMaxN
  );
  const thrustResponseAlpha = 1 - Math.exp(-stepS / Math.max(1e-6, rocket.thrustTimeConstantS));
  const torqueResponseAlpha = 1 - Math.exp(-stepS / Math.max(1e-6, rocket.attitudeTimeConstantS));
  const rolloutController = new RocketController(controller, rocket, gravityMps2);

  for (let step = 1; step <= maximumSteps; step += 1) {
    const previousPosition: Vec3 = [...position];
    const previousVelocity: Vec3 = [...velocity];
    const verticalReference = computeVerticalVelocityReference(
      {
        ...estimate,
        positionM: [...position],
        velocityMps: [...velocity],
        accelerationMps2: [...appliedAcceleration]
      },
      capturePlaneZ,
      controller.guidance
    );
    const control = rolloutController.compute({
      estimate: {
        ...estimate,
        positionM: [...position],
        velocityMps: [...velocity],
        accelerationMps2: [...appliedAcceleration]
      },
      attitudeWxyz,
      angularVelocityRadps,
      targetPositionM: [targetCenter[0], targetCenter[1], capturePlaneZ],
      targetVelocityMps: [0, 0, verticalReference],
      verticalVelocityReferenceMps: verticalReference
    });
    actualThrustN += (control.desiredThrustN - actualThrustN) * thrustResponseAlpha;
    for (const axis of [0, 1, 2] as const) {
      actualTorqueNm[axis] +=
        (control.desiredTorqueNm[axis] - actualTorqueNm[axis]) * torqueResponseAlpha;
    }
    const thrustN = quatRotate(attitudeWxyz, [0, 0, actualThrustN]);
    appliedAcceleration = [
      thrustN[0] / rocket.massKg,
      thrustN[1] / rocket.massKg,
      thrustN[2] / rocket.massKg - gravityMps2
    ];
    for (const axis of [0, 1, 2] as const) {
      velocity[axis] += appliedAcceleration[axis] * stepS;
      position[axis] += velocity[axis] * stepS;
    }
    const angularMomentum: Vec3 = [
      rocket.inertiaKgM2[0] * angularVelocityRadps[0],
      rocket.inertiaKgM2[1] * angularVelocityRadps[1],
      rocket.inertiaKgM2[2] * angularVelocityRadps[2]
    ];
    const gyroscopicTorque = cross3(angularVelocityRadps, angularMomentum);
    for (const axis of [0, 1, 2] as const) {
      angularVelocityRadps[axis] +=
        (actualTorqueNm[axis] - gyroscopicTorque[axis]) /
        rocket.inertiaKgM2[axis] * stepS;
    }
    attitudeWxyz = integrateQuaternion(attitudeWxyz, angularVelocityRadps, stepS);

    if (previousPosition[2] > capturePlaneZ && position[2] <= capturePlaneZ) {
      const fraction = clamp(
        (previousPosition[2] - capturePlaneZ) /
          Math.max(1e-9, previousPosition[2] - position[2]),
        0,
        1
      );
      const time = (step - 1 + fraction) * stepS;
      const predictedPosition: Vec3 = [
        previousPosition[0] + (position[0] - previousPosition[0]) * fraction,
        previousPosition[1] + (position[1] - previousPosition[1]) * fraction,
        capturePlaneZ
      ];
      const predictedVelocity: Vec3 = [
        previousVelocity[0] + (velocity[0] - previousVelocity[0]) * fraction,
        previousVelocity[1] + (velocity[1] - previousVelocity[1]) * fraction,
        previousVelocity[2] + (velocity[2] - previousVelocity[2]) * fraction
      ];
      const timeSquared = time * time;
      const unmodelledAccelerationStd = 0.1;
      const accelerationVariance = (0.5 * timeSquared * unmodelledAccelerationStd) ** 2;
      const verticalVariance = Math.max(
        1e-12,
        estimate.covarianceDiagonal[2] +
          timeSquared * estimate.covarianceDiagonal[5] + accelerationVariance
      );
      const interceptTimeStdS = Math.sqrt(verticalVariance) /
        Math.max(0.25, Math.abs(predictedVelocity[2]));
      const timeVariance = interceptTimeStdS * interceptTimeStdS;
      const variance: Vec3 = [
        Math.max(1e-12, estimate.covarianceDiagonal[0] +
          timeSquared * estimate.covarianceDiagonal[3] + accelerationVariance +
          predictedVelocity[0] ** 2 * timeVariance),
        Math.max(1e-12, estimate.covarianceDiagonal[1] +
          timeSquared * estimate.covarianceDiagonal[4] + accelerationVariance +
          predictedVelocity[1] ** 2 * timeVariance),
        verticalVariance
      ];
      const sigma = controller.prediction.confidenceSigma;
      const uncertainty: Vec3 = variance.map((entry) => sigma * Math.sqrt(entry)) as Vec3;
      return {
        timeToInterceptS: time,
        predictedInterceptTick: estimate.tick + Math.max(0, Math.round(time / tickDurationS)),
        predictedInterceptPositionM: predictedPosition,
        predictedInterceptVelocityMps: predictedVelocity,
        horizontalVarianceM2: [variance[0], variance[1]],
        interceptTimeStdS,
        confidenceRadiusM: Math.hypot(uncertainty[0], uncertainty[1]),
        predictionUncertaintyM: uncertainty,
        controlAuthorityMarginMps2: Math.max(
          0,
          rocket.lateralAccelerationLimitMps2 -
            Math.hypot(control.desiredAccelerationMps2[0], control.desiredAccelerationMps2[1])
        ),
        rolloutSteps: step
      };
    }
  }
  return null;
};

type RocketControlLimits = Pick<
  RocketConfig,
  "massKg" | "thrustMaxN" | "torqueMaxNm" | "lateralAccelerationLimitMps2"
>;

/**
 * Estimate-only terminal controller. The desired acceleration is inertial;
 * thrust includes gravity compensation before magnitude saturation.
 */
export class RocketController {
  public constructor(
    private readonly config: ControllerConfig,
    private readonly limits: RocketControlLimits,
    private readonly gravityMps2: number
  ) {
    if (gravityMps2 <= 0 || limits.massKg <= 0 || limits.thrustMaxN < 0) {
      throw new RangeError("rocket controller limits must be physically positive");
    }
  }

  public compute(input: RocketControllerInput): ControlCommand {
    const engineEnabled = input.engineEnabled ?? true;
    const massKg = input.estimatedMassKg ?? this.limits.massKg;
    if (!Number.isFinite(massKg) || massKg <= 0) {
      throw new RangeError("estimatedMassKg must be finite and greater than zero");
    }

    const targetVelocity = input.targetVelocityMps ?? [0, 0, input.verticalVelocityReferenceMps];
    const lateral = clampMagnitude3(
      [
        this.config.rocketPositionKp * (input.targetPositionM[0] - input.estimate.positionM[0]) +
          this.config.rocketVelocityKd * (targetVelocity[0] - input.estimate.velocityMps[0]),
        this.config.rocketPositionKp * (input.targetPositionM[1] - input.estimate.positionM[1]) +
          this.config.rocketVelocityKd * (targetVelocity[1] - input.estimate.velocityMps[1]),
        0
      ],
      this.limits.lateralAccelerationLimitMps2
    );
    const verticalAcceleration = this.config.verticalVelocityKp *
      (input.verticalVelocityReferenceMps - input.estimate.velocityMps[2]);
    const availableSpecificThrust = this.limits.thrustMaxN / massKg;
    const requestedSpecificThrust: Vec3 = [
      lateral[0],
      lateral[1],
      Math.max(0, this.gravityMps2 + verticalAcceleration)
    ];
    const specificThrust = clampMagnitude3(requestedSpecificThrust, availableSpecificThrust);
    const desiredThrustN = engineEnabled ? massKg * norm3(specificThrust) : 0;
    const desiredAcceleration: Vec3 = engineEnabled
      ? [specificThrust[0], specificThrust[1], specificThrust[2] - this.gravityMps2]
      : [0, 0, -this.gravityMps2];

    const desiredAttitude = desiredThrustN > 1e-9
      ? quatFromTwoVectors([0, 0, 1], specificThrust)
      : ([1, 0, 0, 0] as Quat);
    const attitudeError = quatErrorVector(desiredAttitude, input.attitudeWxyz);
    const requestedTorque: Vec3 = [
      this.config.attitudeKp * attitudeError[0] -
        this.config.attitudeKd * input.angularVelocityRadps[0],
      this.config.attitudeKp * attitudeError[1] -
        this.config.attitudeKd * input.angularVelocityRadps[1],
      this.config.attitudeKp * attitudeError[2] -
        this.config.attitudeKd * input.angularVelocityRadps[2]
    ];
    const desiredTorque = engineEnabled
      ? clampMagnitude3(requestedTorque, this.limits.torqueMaxNm)
      : ([0, 0, 0] as Vec3);

    return {
      desiredThrustN,
      desiredTorqueNm: desiredTorque,
      desiredAccelerationMps2: desiredAcceleration,
      desiredAttitudeWxyz: desiredAttitude,
      engineEnabled
    };
  }
}

export type CaptureHandshakePhase = "IDLE" | "PREPARE" | "COMMIT" | "ABORT";

export interface CaptureVehicleObservation
  extends Pick<
    VehicleStatePayload,
    | "estimate"
    | "attitudeWxyz"
    | "angularVelocityRadps"
    | "rocketMode"
    | "captureReady"
    | "acknowledgedWindowId"
    | "acknowledgedPlanRevision"
    | "healthFlags"
  > {}

export interface NetControlFeedback {
  centerM: [number, number];
  centerVelocityMps: [number, number];
  halfSpacingM: [number, number];
  halfSpacingRateMps: [number, number];
  winchesReady: boolean;
  winchStatuses: Record<WinchNodeId, WinchStatusPayload | null>;
  anyWinchStuck: boolean;
  contactDetected: boolean;
  broken: boolean;
  secured: boolean;
  tensionsN?: [number, number, number, number];
}

export interface CaptureCoordinatorInput {
  tick: number;
  vehicleState: CaptureVehicleObservation | null;
  groundVehicleEstimate: StateEstimate;
  platformEstimate: StateEstimate;
  net: NetControlFeedback;
}

export interface CaptureCoordinatorOptions {
  tickDurationS: number;
  controller: ControllerConfig;
  net: NetConfig;
  rocket: RocketConfig;
  gravityMps2: number;
  capturePlaneZ: number;
  prepareLeadTimeS?: number;
  commitMarginS?: number;
  stableTrackSamples?: number;
  postContactTargetTensionN?: number;
  tensionRampS?: number;
  secureDwellS?: number;
  missedGraceS?: number;
  lateralAccelerationLimitMps2?: number;
}

export type WinchCommandMap = {
  "winch-x-negative": WinchCommandPayload;
  "winch-x-positive": WinchCommandPayload;
  "winch-y-negative": WinchCommandPayload;
  "winch-y-positive": WinchCommandPayload;
};

export interface CaptureCoordinatorOutput {
  state: SupervisorState;
  captureMode: CaptureMode;
  handshakePhase: CaptureHandshakePhase;
  plan: CapturePlanPayload | null;
  prediction: CapturePlanePrediction | null;
  desiredNetCenterM: [number, number];
  desiredHalfSpacingM: [number, number];
  winchCommands: WinchCommandMap;
  targetTotalTensionN: number;
  readiness: {
    vehicle: boolean;
    winches: Record<WinchNodeId, boolean>;
    all: boolean;
  };
  abortReason: string | null;
}

export interface MinimumJerkSample {
  position: number;
  velocity: number;
  acceleration: number;
}

export interface TensionControllerOutput {
  desiredDampingNspm: number;
  integralErrorNs: number;
  saturated: boolean;
}

/** Local per-winch PI loop whose actuator is bounded active rope damping. */
export class WinchTensionController {
  private integralErrorNs = 0;

  public constructor(
    private readonly tuning: ControllerConfig["tension"],
    private readonly net: NetConfig
  ) {}

  public reset(): void {
    this.integralErrorNs = 0;
  }

  public update(
    desiredTensionN: number,
    measuredTensionN: number,
    dtS: number
  ): TensionControllerOutput {
    if (![desiredTensionN, measuredTensionN, dtS].every(Number.isFinite) || dtS <= 0) {
      throw new RangeError("tension controller inputs must be finite and dtS must be positive");
    }
    const errorN = Math.max(0, desiredTensionN) - Math.max(0, measuredTensionN);
    const previousIntegral = this.integralErrorNs;
    this.integralErrorNs = clamp(
      this.integralErrorNs + errorN * dtS,
      -this.tuning.integralLimitNs,
      this.tuning.integralLimitNs
    );
    const unrestricted = this.net.activeDampingMinNspm +
      this.tuning.kp * errorN + this.tuning.ki * this.integralErrorNs;
    const desiredDampingNspm = clamp(
      unrestricted,
      this.net.activeDampingMinNspm,
      this.net.activeDampingMaxNspm
    );
    const saturated = desiredDampingNspm !== unrestricted;
    if (
      saturated &&
      ((unrestricted > desiredDampingNspm && errorN > 0) ||
        (unrestricted < desiredDampingNspm && errorN < 0))
    ) {
      this.integralErrorNs = previousIntegral;
    }
    return { desiredDampingNspm, integralErrorNs: this.integralErrorNs, saturated };
  }
}

/** Analytic minimum-jerk trajectory with zero endpoint velocity/acceleration. */
export const sampleMinimumJerk = (
  start: number,
  end: number,
  elapsedS: number,
  durationS: number
): MinimumJerkSample => {
  if (durationS <= 0) {
    return { position: end, velocity: 0, acceleration: 0 };
  }
  const u = clamp(elapsedS / durationS, 0, 1);
  if (u === 0) return { position: start, velocity: 0, acceleration: 0 };
  if (u === 1) return { position: end, velocity: 0, acceleration: 0 };
  const distance = end - start;
  const shape = minimumJerk(u);
  const velocityShape = 30 * u * u * (1 - u) * (1 - u);
  const accelerationShape = 60 * u * (1 - u) * (1 - 2 * u);
  return {
    position: start + distance * shape,
    velocity: distance * velocityShape / durationS,
    acceleration: distance * accelerationShape / (durationS * durationS)
  };
};

interface NetTrajectory {
  startTick: number;
  durationS: number;
  startCenterM: [number, number];
  startHalfSpacingM: [number, number];
  endCenterM: [number, number];
  endHalfSpacingM: [number, number];
}

const clampNetCenter = (value: number, limit: number): number => clamp(value, -limit, limit);

const captureModeForState = (state: SupervisorState): CaptureMode => {
  switch (state) {
    case "BOOT":
    case "SEARCH":
      return "open";
    case "TRACK":
    case "SYNC":
    case "ARMED":
      return "tracking";
    case "CLOSING":
      return "closing";
    case "CONTACT":
      return "latched";
    case "ARREST":
      return "arresting";
    case "SECURED":
      return "secured";
    case "MISSED":
      return "missed";
    case "BROKEN":
      return "broken";
    case "ABORT":
      return "aborted";
  }
};

const phaseForState = (state: SupervisorState): CaptureHandshakePhase => {
  if (state === "SYNC") return "PREPARE";
  if (["ARMED", "CLOSING", "CONTACT", "ARREST", "SECURED"].includes(state)) return "COMMIT";
  if (["ABORT", "MISSED", "BROKEN"].includes(state)) return "ABORT";
  return "IDLE";
};

const terminalState = (state: SupervisorState): boolean =>
  state === "SECURED" || state === "MISSED" || state === "BROKEN" || state === "ABORT";

const platformRelativeEstimate = (
  vehicle: StateEstimate,
  platform: StateEstimate
): StateEstimate => ({
  tick: vehicle.tick,
  positionM: [
    vehicle.positionM[0] - platform.positionM[0],
    vehicle.positionM[1] - platform.positionM[1],
    vehicle.positionM[2] - platform.positionM[2]
  ],
  velocityMps: [
    vehicle.velocityMps[0] - platform.velocityMps[0],
    vehicle.velocityMps[1] - platform.velocityMps[1],
    vehicle.velocityMps[2] - platform.velocityMps[2]
  ],
  accelerationMps2: [
    vehicle.accelerationMps2[0] - platform.accelerationMps2[0],
    vehicle.accelerationMps2[1] - platform.accelerationMps2[1],
    vehicle.accelerationMps2[2] - platform.accelerationMps2[2]
  ],
  covarianceDiagonal: [
    vehicle.covarianceDiagonal[0] + platform.covarianceDiagonal[0],
    vehicle.covarianceDiagonal[1] + platform.covarianceDiagonal[1],
    vehicle.covarianceDiagonal[2] + platform.covarianceDiagonal[2],
    vehicle.covarianceDiagonal[3] + platform.covarianceDiagonal[3],
    vehicle.covarianceDiagonal[4] + platform.covarianceDiagonal[4],
    vehicle.covarianceDiagonal[5] + platform.covarianceDiagonal[5]
  ],
  source: vehicle.source
});

const propagateEstimate = (
  estimate: StateEstimate,
  tick: number,
  tickDurationS: number
): StateEstimate => {
  if (tick <= estimate.tick) return estimate;
  const time = (tick - estimate.tick) * tickDurationS;
  const halfTimeSquared = 0.5 * time * time;
  const timeSquared = time * time;
  return {
    tick,
    positionM: [
      estimate.positionM[0] + estimate.velocityMps[0] * time + estimate.accelerationMps2[0] * halfTimeSquared,
      estimate.positionM[1] + estimate.velocityMps[1] * time + estimate.accelerationMps2[1] * halfTimeSquared,
      estimate.positionM[2] + estimate.velocityMps[2] * time + estimate.accelerationMps2[2] * halfTimeSquared
    ],
    velocityMps: [
      estimate.velocityMps[0] + estimate.accelerationMps2[0] * time,
      estimate.velocityMps[1] + estimate.accelerationMps2[1] * time,
      estimate.velocityMps[2] + estimate.accelerationMps2[2] * time
    ],
    accelerationMps2: [...estimate.accelerationMps2],
    covarianceDiagonal: [
      estimate.covarianceDiagonal[0] + timeSquared * estimate.covarianceDiagonal[3],
      estimate.covarianceDiagonal[1] + timeSquared * estimate.covarianceDiagonal[4],
      estimate.covarianceDiagonal[2] + timeSquared * estimate.covarianceDiagonal[5],
      estimate.covarianceDiagonal[3],
      estimate.covarianceDiagonal[4],
      estimate.covarianceDiagonal[5]
    ],
    source: estimate.source
  };
};

const addPlatformMotion = (
  relative: CapturePlanePrediction,
  platform: StateEstimate,
  capturePlaneOffsetZ: number
): CapturePlanePrediction => {
  const time = relative.timeToInterceptS;
  const halfTimeSquared = 0.5 * time * time;
  const platformPosition: Vec3 = [
    platform.positionM[0] + platform.velocityMps[0] * time + platform.accelerationMps2[0] * halfTimeSquared,
    platform.positionM[1] + platform.velocityMps[1] * time + platform.accelerationMps2[1] * halfTimeSquared,
    platform.positionM[2] + platform.velocityMps[2] * time + platform.accelerationMps2[2] * halfTimeSquared
  ];
  const platformVelocity: Vec3 = [
    platform.velocityMps[0] + platform.accelerationMps2[0] * time,
    platform.velocityMps[1] + platform.accelerationMps2[1] * time,
    platform.velocityMps[2] + platform.accelerationMps2[2] * time
  ];
  return {
    ...relative,
    predictedInterceptPositionM: [
      relative.predictedInterceptPositionM[0] + platformPosition[0],
      relative.predictedInterceptPositionM[1] + platformPosition[1],
      platformPosition[2] + capturePlaneOffsetZ
    ],
    predictedInterceptVelocityMps: [
      relative.predictedInterceptVelocityMps[0] + platformVelocity[0],
      relative.predictedInterceptVelocityMps[1] + platformVelocity[1],
      relative.predictedInterceptVelocityMps[2] + platformVelocity[2]
    ]
  };
};

/**
 * Coordinator owns the capture window and PREPARE/COMMIT handshake. It only
 * consumes delivered vehicle observations, a platform estimate and winch feedback.
 */
export class CaptureCoordinator {
  private readonly tickDurationS: number;
  private readonly controller: ControllerConfig;
  private readonly netConfig: NetConfig;
  private readonly rocketConfig: RocketConfig;
  private readonly gravityMps2: number;
  private readonly capturePlaneZ: number;
  private readonly prepareLeadTimeS: number;
  private readonly commitMarginS: number;
  private readonly stableTrackSamples: number;
  private readonly postContactTargetTensionN: number;
  private readonly tensionRampS: number;
  private readonly secureDwellS: number;
  private readonly missedGraceS: number;

  private supervisorState: SupervisorState = "BOOT";
  private latestVehicle: CaptureVehicleObservation | null = null;
  private latestPlan: CapturePlanPayload | null = null;
  private latestPrediction: CapturePlanePrediction | null = null;
  private latestRelativePrediction: CapturePlanePrediction | null = null;
  private committedPlan: CapturePlanPayload | null = null;
  private trajectory: NetTrajectory | null = null;
  private windowId = 0;
  private planRevision = 0;
  private lastRevisionTick = 0;
  private feasibleSamples = 0;
  private contactTick: number | null = null;
  private secureCandidateTick: number | null = null;
  private lastFineTargetM: [number, number] | null = null;
  private lastFineTargetTick: number | null = null;
  private fineTargetVelocityMps: [number, number] = [0, 0];
  private navigationBiasEstimateM: Vec3 = [0, 0, 0];
  private lastBiasObservationTick = -1;
  private cachedPredictionPair: {
    relative: CapturePlanePrediction;
    world: CapturePlanePrediction;
  } | null = null;
  private lastPredictionRolloutTick = -1;
  private abortReasonValue: string | null = null;

  public constructor(options: CaptureCoordinatorOptions) {
    if (!Number.isFinite(options.tickDurationS) || options.tickDurationS <= 0) {
      throw new RangeError("tickDurationS must be finite and greater than zero");
    }
    this.tickDurationS = options.tickDurationS;
    this.controller = options.controller;
    this.netConfig = options.net;
    this.rocketConfig = options.rocket;
    this.gravityMps2 = options.gravityMps2;
    this.capturePlaneZ = options.capturePlaneZ;
    this.prepareLeadTimeS = options.prepareLeadTimeS ?? options.net.closureDurationS + 2;
    this.commitMarginS = options.commitMarginS ?? 0.25;
    this.stableTrackSamples = Math.max(1, options.stableTrackSamples ?? 3);
    this.postContactTargetTensionN = Math.min(
      options.net.totalStrengthLimitN * 0.8,
      options.postContactTargetTensionN ?? options.net.totalStrengthLimitN * 0.62
    );
    this.tensionRampS = options.tensionRampS ?? 0.12;
    this.secureDwellS = options.secureDwellS ?? 0.5;
    this.missedGraceS = options.missedGraceS ?? 0.4;
  }

  public reset(): void {
    this.supervisorState = "BOOT";
    this.latestVehicle = null;
    this.latestPlan = null;
    this.latestPrediction = null;
    this.latestRelativePrediction = null;
    this.committedPlan = null;
    this.trajectory = null;
    this.windowId = 0;
    this.planRevision = 0;
    this.lastRevisionTick = 0;
    this.feasibleSamples = 0;
    this.contactTick = null;
    this.secureCandidateTick = null;
    this.lastFineTargetM = null;
    this.lastFineTargetTick = null;
    this.fineTargetVelocityMps = [0, 0];
    this.navigationBiasEstimateM = [0, 0, 0];
    this.lastBiasObservationTick = -1;
    this.cachedPredictionPair = null;
    this.lastPredictionRolloutTick = -1;
    this.abortReasonValue = null;
  }

  public get state(): SupervisorState {
    return this.supervisorState;
  }

  private abort(reason: string): void {
    if (terminalState(this.supervisorState)) return;
    this.supervisorState = "ABORT";
    this.abortReasonValue = reason;
  }

  private minimumTrajectoryDuration(
    startCenter: [number, number],
    startSpacing: [number, number],
    endCenter: [number, number],
    endSpacing: [number, number]
  ): number {
    const startPositions = [
      startCenter[0] - startSpacing[0],
      startCenter[0] + startSpacing[0],
      startCenter[1] - startSpacing[1],
      startCenter[1] + startSpacing[1]
    ];
    const endPositions = [
      endCenter[0] - endSpacing[0],
      endCenter[0] + endSpacing[0],
      endCenter[1] - endSpacing[1],
      endCenter[1] + endSpacing[1]
    ];
    const maximumTravel = Math.max(
      ...startPositions.map((start, index) => Math.abs((endPositions[index] ?? start) - start))
    );
    const velocityLimited = this.netConfig.winchMaxSpeedMps > 0
      ? 1.875 * maximumTravel / this.netConfig.winchMaxSpeedMps
      : Number.POSITIVE_INFINITY;
    const accelerationLimited = this.netConfig.winchMaxAccelerationMps2 > 0
      ? Math.sqrt(5.773503 * maximumTravel / this.netConfig.winchMaxAccelerationMps2)
      : Number.POSITIVE_INFINITY;
    return Math.max(this.netConfig.closureDurationS, velocityLimited, accelerationLimited);
  }

  private calculatePrediction(
    vehicle: CaptureVehicleObservation,
    groundVehicle: StateEstimate,
    platform: StateEstimate,
    tick: number
  ): { relative: CapturePlanePrediction; world: CapturePlanePrediction } | null {
    const rolloutIntervalTicks = Math.max(
      1,
      Math.round(this.controller.prediction.stepS / this.tickDurationS)
    );
    if (
      this.cachedPredictionPair !== null &&
      tick - this.lastPredictionRolloutTick < rolloutIntervalTicks
    ) {
      const elapsedS = (tick - this.lastPredictionRolloutTick) * this.tickDurationS;
      const age = (prediction: CapturePlanePrediction): CapturePlanePrediction => ({
        ...prediction,
        timeToInterceptS: Math.max(0, prediction.timeToInterceptS - elapsedS),
        predictedInterceptPositionM: [...prediction.predictedInterceptPositionM],
        predictedInterceptVelocityMps: [...prediction.predictedInterceptVelocityMps],
        horizontalVarianceM2: [...prediction.horizontalVarianceM2]
      });
      return {
        relative: age(this.cachedPredictionPair.relative),
        world: age(this.cachedPredictionPair.world)
      };
    }
    const vehicleAtTick = propagateEstimate(vehicle.estimate, tick, this.tickDurationS);
    const groundAtVehicleTick = propagateEstimate(
      groundVehicle,
      vehicleAtTick.tick,
      this.tickDurationS
    );
    if (vehicle.estimate.tick > this.lastBiasObservationTick) {
      const biasAlpha = this.lastBiasObservationTick < 0 ? 1 : 0.08;
      for (const axis of [0, 1, 2] as const) {
        const observedBiasM = vehicleAtTick.positionM[axis] -
          groundAtVehicleTick.positionM[axis];
        this.navigationBiasEstimateM[axis] += biasAlpha *
          (observedBiasM - this.navigationBiasEstimateM[axis]);
      }
      this.lastBiasObservationTick = vehicle.estimate.tick;
    }
    const correctedVehicleAtTick: StateEstimate = {
      ...vehicleAtTick,
      positionM: [
        vehicleAtTick.positionM[0] - this.navigationBiasEstimateM[0],
        vehicleAtTick.positionM[1] - this.navigationBiasEstimateM[1],
        vehicleAtTick.positionM[2] - this.navigationBiasEstimateM[2]
      ]
    };
    const platformAtTick = propagateEstimate(platform, tick, this.tickDurationS);
    const relativeEstimate = platformRelativeEstimate(correctedVehicleAtTick, platformAtTick);
    // The terminal guidance loop is actively changing lateral acceleration;
    // extrapolating one noisy Kalman acceleration sample for 5-10 s makes the
    // agreed net centre jump between travel limits. Use constant horizontal
    // velocity while retaining vertical acceleration for arrival-time/braking
    // prediction. This is still an explicit candidate model, not flight logic.
    const guidedPrediction = predictGuidedCaptureIntersection(
      relativeEstimate,
      this.capturePlaneZ,
      {
        controller: this.controller,
        rocket: this.rocketConfig,
        gravityMps2: this.gravityMps2,
        tickDurationS: this.tickDurationS,
        targetCenterM: this.committedPlan?.centerM ?? [0, 0],
        attitudeWxyz: vehicle.attitudeWxyz,
        angularVelocityRadps: vehicle.angularVelocityRadps
      }
    );
    if (guidedPrediction === null) return null;
    const relative: CapturePlanePrediction = guidedPrediction;
    const pair = {
      relative,
      world: addPlatformMotion(relative, platformAtTick, this.capturePlaneZ)
    };
    this.cachedPredictionPair = {
      relative: {
        ...pair.relative,
        predictedInterceptPositionM: [...pair.relative.predictedInterceptPositionM],
        predictedInterceptVelocityMps: [...pair.relative.predictedInterceptVelocityMps],
        horizontalVarianceM2: [...pair.relative.horizontalVarianceM2]
      },
      world: {
        ...pair.world,
        predictedInterceptPositionM: [...pair.world.predictedInterceptPositionM],
        predictedInterceptVelocityMps: [...pair.world.predictedInterceptVelocityMps],
        horizontalVarianceM2: [...pair.world.horizontalVarianceM2]
      }
    };
    this.lastPredictionRolloutTick = tick;
    return pair;
  }

  private buildPlan(
    relativePrediction: CapturePlanePrediction,
    worldPrediction: CapturePlanePrediction,
    tick: number
  ): CapturePlanPayload {
    const center: [number, number] = this.controller.algorithm === "fixed"
      ? [0, 0]
      : [
          clampNetCenter(
            relativePrediction.predictedInterceptPositionM[0],
            this.netConfig.centerTravelLimitM
          ),
          clampNetCenter(
            relativePrediction.predictedInterceptPositionM[1],
            this.netConfig.centerTravelLimitM
          )
        ];
    return {
      windowId: this.windowId,
      planRevision: this.planRevision,
      validFromTick: tick,
      validUntilTick: relativePrediction.predictedInterceptTick,
      commitDeadlineTick: Math.max(
        tick,
        relativePrediction.predictedInterceptTick -
          Math.ceil((this.netConfig.closureDurationS + this.commitMarginS) / this.tickDurationS)
      ),
      capturePlaneZ: worldPrediction.predictedInterceptPositionM[2],
      centerM: center,
      halfSpacingM: [this.netConfig.closedHalfSpacingM, this.netConfig.closedHalfSpacingM],
      predictedInterceptTick: relativePrediction.predictedInterceptTick,
      predictedInterceptPositionM: [...worldPrediction.predictedInterceptPositionM],
      predictedInterceptVelocityMps: [...worldPrediction.predictedInterceptVelocityMps],
      predictedRelativeInterceptVelocityMps: [...relativePrediction.predictedInterceptVelocityMps],
      predictionUncertaintyM: [
        Math.sqrt(relativePrediction.horizontalVarianceM2[0]) * this.controller.prediction.confidenceSigma,
        Math.sqrt(relativePrediction.horizontalVarianceM2[1]) * this.controller.prediction.confidenceSigma,
        relativePrediction.interceptTimeStdS * Math.max(
          0.25,
          Math.abs(relativePrediction.predictedInterceptVelocityMps[2])
        ) * this.controller.prediction.confidenceSigma
      ],
      confidenceRadiusM: relativePrediction.confidenceRadiusM,
      supervisorState: this.supervisorState
    };
  }

  private predictionIsFeasible(
    relativePrediction: CapturePlanePrediction,
    plan: CapturePlanPayload,
    vehicle: CaptureVehicleObservation
  ): boolean {
    const residualX = Math.abs(relativePrediction.predictedInterceptPositionM[0] - plan.centerM[0]);
    const residualY = Math.abs(relativePrediction.predictedInterceptPositionM[1] - plan.centerM[1]);
    const requiredMargin = relativePrediction.confidenceRadiusM +
      this.controller.requiredApertureMarginM;
    const apertureFeasible = residualX + requiredMargin <= this.netConfig.openHalfSpacingM &&
      residualY + requiredMargin <= this.netConfig.openHalfSpacingM;
    const relativeSpeed = norm3(relativePrediction.predictedInterceptVelocityMps);
    return apertureFeasible &&
      relativeSpeed <= this.controller.maxCaptureSpeedMps &&
      // PREPARE is a look-ahead gate, not the physical capture gate. Allow a
      // bounded attitude-recovery margin here; the plant still enforces the
      // exact capture tilt at plane crossing.
      tiltFromVertical(vehicle.attitudeWxyz) <= this.controller.maxCaptureTiltRad * 1.5 &&
      vehicle.healthFlags === 0 &&
      vehicle.rocketMode !== "DIVERT";
  }

  private startCommit(tick: number, net: NetControlFeedback): void {
    if (this.latestPlan === null) return;
    this.committedPlan = { ...this.latestPlan, supervisorState: "ARMED" };
    const endCenter: [number, number] = [...this.committedPlan.centerM];
    const endSpacing: [number, number] = [...this.committedPlan.halfSpacingM];
    this.trajectory = {
      startTick: tick,
      durationS: this.minimumTrajectoryDuration(
        net.centerM,
        net.halfSpacingM,
        endCenter,
        endSpacing
      ),
      startCenterM: [...net.centerM],
      startHalfSpacingM: [...net.halfSpacingM],
      endCenterM: endCenter,
      endHalfSpacingM: endSpacing
    };
    this.lastFineTargetM = [...endCenter];
    this.lastFineTargetTick = tick;
    this.fineTargetVelocityMps = [0, 0];
    this.supervisorState = "ARMED";
  }

  private endpointsReadyForLatestPlan(net: NetControlFeedback): boolean {
    if (this.latestPlan === null || this.latestVehicle === null || !net.winchesReady) return false;
    const vehicleReady = this.latestVehicle.captureReady &&
      this.latestVehicle.acknowledgedWindowId === this.latestPlan.windowId &&
      this.latestVehicle.acknowledgedPlanRevision === this.latestPlan.planRevision;
    const winchesReady = Object.values(net.winchStatuses).every((status) =>
      status !== null && status.ready &&
      status.readyWindowId === this.latestPlan?.windowId &&
      status.readyPlanRevision === this.latestPlan?.planRevision
    );
    return vehicleReady && winchesReady;
  }

  private readinessForLatestPlan(net: NetControlFeedback): CaptureCoordinatorOutput["readiness"] {
    const plan = this.latestPlan;
    const vehicle = plan !== null && this.latestVehicle !== null &&
      this.latestVehicle.captureReady &&
      this.latestVehicle.acknowledgedWindowId === plan.windowId &&
      this.latestVehicle.acknowledgedPlanRevision === plan.planRevision;
    const winches = Object.fromEntries(WINCH_IDS.map((node) => {
      const status = net.winchStatuses[node];
      return [node, plan !== null && status !== null && status.ready &&
        status.readyWindowId === plan.windowId &&
        status.readyPlanRevision === plan.planRevision];
    })) as Record<WinchNodeId, boolean>;
    return {
      vehicle,
      winches,
      all: vehicle && net.winchesReady && Object.values(winches).every(Boolean)
    };
  }

  private servoNetCenter(
    net: NetControlFeedback,
    targetCenter: [number, number],
    targetVelocity: [number, number]
  ): [number, number] {
    const actuatorHorizonS = Math.max(this.tickDurationS, this.netConfig.winchTimeConstantS);
    const commandedVelocity: [number, number] = [0, 0];
    for (const axis of [0, 1] as const) {
      const positionErrorM = targetCenter[axis] - net.centerM[axis];
      const pdVelocityMps = targetVelocity[axis] +
        this.controller.netCenterKp * positionErrorM +
        this.controller.netCenterKd * (targetVelocity[axis] - net.centerVelocityMps[axis]);
      const stoppingVelocityMps = Math.sqrt(
        2 * this.netConfig.winchMaxAccelerationMps2 * Math.abs(positionErrorM)
      );
      commandedVelocity[axis] = clamp(
        pdVelocityMps,
        -Math.min(this.netConfig.winchMaxSpeedMps, stoppingVelocityMps),
        Math.min(this.netConfig.winchMaxSpeedMps, stoppingVelocityMps)
      );
    }
    return [
      clampNetCenter(
        net.centerM[0] + commandedVelocity[0] * actuatorHorizonS,
        this.netConfig.centerTravelLimitM
      ),
      clampNetCenter(
        net.centerM[1] + commandedVelocity[1] * actuatorHorizonS,
        this.netConfig.centerTravelLimitM
      )
    ];
  }

  private desiredGeometry(net: NetControlFeedback, tick: number): {
    center: [number, number];
    spacing: [number, number];
  } {
    if (this.trajectory === null) {
      // Keep the aperture fully open while using the tracking interval to
      // pre-position its centre. Without this phase, a late COMMIT would ask
      // one winch to perform centre translation and 18 m closure in the same
      // minimum-jerk move, making an otherwise reachable window infeasible.
      if (
        this.latestPlan !== null &&
        (this.supervisorState === "TRACK" || this.supervisorState === "SYNC")
      ) {
        const targetCenter = [...this.latestPlan.centerM] as [number, number];
        return {
          center: this.servoNetCenter(net, targetCenter, [0, 0]),
          spacing: [this.netConfig.openHalfSpacingM, this.netConfig.openHalfSpacingM]
        };
      }
      return { center: [...net.centerM], spacing: [...net.halfSpacingM] };
    }
    const elapsedS = (tick - this.trajectory.startTick) * this.tickDurationS;
    const xCenterSample = sampleMinimumJerk(
          this.trajectory.startCenterM[0],
          this.trajectory.endCenterM[0],
          elapsedS,
          this.trajectory.durationS
        );
    const yCenterSample = sampleMinimumJerk(
          this.trajectory.startCenterM[1],
          this.trajectory.endCenterM[1],
          elapsedS,
          this.trajectory.durationS
        );
    const plannedCenter: [number, number] = [xCenterSample.position, yCenterSample.position];
    const plannedCenterVelocity: [number, number] = [xCenterSample.velocity, yCenterSample.velocity];
    if (
      this.latestRelativePrediction !== null &&
      (this.supervisorState === "ARMED" || this.supervisorState === "CLOSING")
    ) {
      // COMMIT freezes the negotiated window, but the local net servo keeps a
      // bounded fine-tracking authority inside that window. This mirrors the
      // separation between a reliable discrete handshake and continuous
      // disturbance rejection; it does not rewrite the agreed plan packet.
      const correctionLimitM = Math.min(4, this.netConfig.centerTravelLimitM);
      const committedCenter = this.committedPlan?.centerM ?? plannedCenter;
      plannedCenter[0] = clampNetCenter(
        plannedCenter[0] + clamp(
          this.latestRelativePrediction.predictedInterceptPositionM[0] - committedCenter[0],
          -correctionLimitM,
          correctionLimitM
        ),
        this.netConfig.centerTravelLimitM
      );
      plannedCenter[1] = clampNetCenter(
        plannedCenter[1] + clamp(
          this.latestRelativePrediction.predictedInterceptPositionM[1] - committedCenter[1],
          -correctionLimitM,
          correctionLimitM
        ),
        this.netConfig.centerTravelLimitM
      );
      if (this.lastFineTargetM !== null && this.lastFineTargetTick !== null) {
        const elapsedTargetS = Math.max(
          this.tickDurationS,
          (tick - this.lastFineTargetTick) * this.tickDurationS
        );
        for (const axis of [0, 1] as const) {
          const rawVelocityMps = clamp(
            (plannedCenter[axis] - this.lastFineTargetM[axis]) / elapsedTargetS,
            -this.netConfig.winchMaxSpeedMps,
            this.netConfig.winchMaxSpeedMps
          );
          this.fineTargetVelocityMps[axis] =
            0.75 * this.fineTargetVelocityMps[axis] + 0.25 * rawVelocityMps;
          plannedCenterVelocity[axis] += this.fineTargetVelocityMps[axis];
        }
      }
      this.lastFineTargetM = [...plannedCenter];
      this.lastFineTargetTick = tick;
    }
    return {
      center: this.servoNetCenter(net, plannedCenter, plannedCenterVelocity),
      spacing: [
        sampleMinimumJerk(
          this.trajectory.startHalfSpacingM[0],
          this.trajectory.endHalfSpacingM[0],
          elapsedS,
          this.trajectory.durationS
        ).position,
        sampleMinimumJerk(
          this.trajectory.startHalfSpacingM[1],
          this.trajectory.endHalfSpacingM[1],
          elapsedS,
          this.trajectory.durationS
        ).position
      ]
    };
  }

  private targetTension(tick: number): number {
    if (this.contactTick === null || !["CONTACT", "ARREST", "SECURED"].includes(this.supervisorState)) {
      return 0;
    }
    const elapsedS = (tick - this.contactTick + 1) * this.tickDurationS;
    return this.postContactTargetTensionN * minimumJerk(elapsedS / this.tensionRampS);
  }

  private winchCommands(
    center: [number, number],
    spacing: [number, number],
    targetTotalTensionN: number
  ): WinchCommandMap {
    const afterContact = ["CONTACT", "ARREST", "SECURED"].includes(this.supervisorState);
    const terminal = terminalState(this.supervisorState) && this.supervisorState !== "SECURED";
    const controlMode: WinchCommandPayload["controlMode"] = terminal
      ? "hold"
      : afterContact
        ? "tension"
        : "position";
    const perWinchTension = afterContact ? targetTotalTensionN / 4 : 0;
    const captureCenter = this.latestPlan?.centerM ?? center;
    const captureSpacing = this.latestPlan?.halfSpacingM ?? spacing;
    const captureTargets: [number, number, number, number] = [
      captureCenter[0] - captureSpacing[0],
      captureCenter[0] + captureSpacing[0],
      captureCenter[1] - captureSpacing[1],
      captureCenter[1] + captureSpacing[1]
    ];
    const command = (
      desiredPositionM: number,
      captureTargetPositionM: number
    ): WinchCommandPayload => ({
      windowId: this.windowId,
      planRevision: this.latestPlan?.planRevision ?? 0,
      commitDeadlineTick: this.latestPlan?.commitDeadlineTick ?? 0,
      captureTargetTick: this.latestPlan?.predictedInterceptTick ?? 0,
      captureTargetPositionM,
      desiredPositionM,
      desiredTensionN: perWinchTension,
      controlMode
    });
    return {
      "winch-x-negative": command(center[0] - spacing[0], captureTargets[0]),
      "winch-x-positive": command(center[0] + spacing[0], captureTargets[1]),
      "winch-y-negative": command(center[1] - spacing[1], captureTargets[2]),
      "winch-y-positive": command(center[1] + spacing[1], captureTargets[3])
    };
  }

  public step(input: CaptureCoordinatorInput): CaptureCoordinatorOutput {
    if (!Number.isInteger(input.tick) || input.tick < 0) {
      throw new RangeError("coordinator tick must be a non-negative integer");
    }
    if (
      input.vehicleState !== null &&
      (this.latestVehicle === null || input.vehicleState.estimate.tick >= this.latestVehicle.estimate.tick)
    ) {
      this.latestVehicle = input.vehicleState;
    }

    if (!terminalState(this.supervisorState) && input.net.broken) {
      this.supervisorState = "BROKEN";
      this.abortReasonValue = "rope strength limit exceeded or break detected";
    }
    if (
      !terminalState(this.supervisorState) &&
      input.net.anyWinchStuck &&
      this.supervisorState !== "BOOT" &&
      this.supervisorState !== "SEARCH"
    ) {
      this.abort("winch unavailable before capture completion");
    }

    if (this.latestVehicle !== null && !terminalState(this.supervisorState)) {
      const telemetryAgeS = (input.tick - this.latestVehicle.estimate.tick) * this.tickDurationS;
      if (
        telemetryAgeS > this.controller.staleTelemetryAbortS &&
        !["BOOT", "SEARCH"].includes(this.supervisorState)
      ) {
        this.abort("vehicle telemetry timeout");
      }
    }

    const predictionPair = this.latestVehicle === null
      ? null
      : this.calculatePrediction(
          this.latestVehicle,
          input.groundVehicleEstimate,
          input.platformEstimate,
          input.tick
        );
    if (predictionPair === null) {
      this.latestPrediction = null;
      this.latestRelativePrediction = null;
      this.feasibleSamples = 0;
    } else {
      this.latestPrediction = predictionPair.world;
      this.latestRelativePrediction = predictionPair.relative;
      if (this.committedPlan === null) {
        const candidate = this.buildPlan(predictionPair.relative, predictionPair.world, input.tick);
        candidate.windowId = this.windowId;
        let publishCandidate = true;
        if (this.supervisorState === "SYNC" && this.latestPlan !== null) {
          const centerShiftM = Math.hypot(
            candidate.centerM[0] - this.latestPlan.centerM[0],
            candidate.centerM[1] - this.latestPlan.centerM[1]
          );
          const interceptShiftS = Math.abs(
            candidate.predictedInterceptTick - this.latestPlan.predictedInterceptTick
          ) * this.tickDurationS;
          const uncertaintyShiftM = Math.abs(
            candidate.confidenceRadiusM - this.latestPlan.confidenceRadiusM
          );
          const materialChange = centerShiftM > 0.25 ||
            interceptShiftS > 0.1 || uncertaintyShiftM > 0.25;
          const minimumRevisionIntervalTicks = Math.max(
            1,
            Math.ceil(0.25 / this.tickDurationS)
          );
          const mayRevise = input.tick <= this.latestPlan.commitDeadlineTick &&
            input.tick - this.lastRevisionTick >= minimumRevisionIntervalTicks;
          if (materialChange && mayRevise) {
            this.planRevision += 1;
            this.lastRevisionTick = input.tick;
          } else {
            publishCandidate = false;
          }
        }
        candidate.planRevision = this.planRevision;
        const feasible = this.latestVehicle !== null &&
          this.predictionIsFeasible(predictionPair.relative, candidate, this.latestVehicle);
        this.feasibleSamples = feasible ? this.feasibleSamples + 1 : 0;
        if (publishCandidate) {
          this.latestPlan = { ...candidate, supervisorState: this.supervisorState };
        }
      } else {
        // COMMIT freezes the agreed capture window even while diagnostic prediction continues.
        this.latestPlan = { ...this.committedPlan, supervisorState: this.supervisorState };
      }
    }

    if (!terminalState(this.supervisorState)) {
      if (
        input.net.contactDetected &&
        ["ARMED", "CLOSING"].includes(this.supervisorState)
      ) {
        this.supervisorState = "CONTACT";
        this.contactTick = input.tick;
      } else {
        switch (this.supervisorState) {
          case "BOOT":
            this.supervisorState = "SEARCH";
            break;
          case "SEARCH":
            if (this.latestVehicle !== null) this.supervisorState = "TRACK";
            break;
          case "TRACK":
            if (
              this.latestPrediction !== null &&
              this.feasibleSamples >= this.stableTrackSamples &&
              this.latestPrediction.timeToInterceptS <= this.prepareLeadTimeS
            ) {
              this.windowId += 1;
              this.planRevision = 1;
              this.lastRevisionTick = input.tick;
              if (this.latestPlan !== null) {
                this.latestPlan.windowId = this.windowId;
                this.latestPlan.planRevision = this.planRevision;
              }
              this.supervisorState = "SYNC";
            }
            break;
          case "SYNC": {
            if (this.latestPlan === null || this.latestVehicle === null) {
              break;
            }
            const endpointsReady = this.endpointsReadyForLatestPlan(input.net);
            if (input.tick > this.latestPlan.commitDeadlineTick && !endpointsReady) {
              this.abort("PREPARE timed out before both endpoints were ready");
              break;
            }
            if (this.latestPrediction === null) break;
            const requiredDuration = this.minimumTrajectoryDuration(
              input.net.centerM,
              input.net.halfSpacingM,
              this.latestPlan.centerM,
              this.latestPlan.halfSpacingM
            );
            const remainingS = this.latestPrediction.timeToInterceptS;
            if (
              endpointsReady &&
              (
                remainingS <= requiredDuration + this.commitMarginS ||
                input.tick >= this.latestPlan.commitDeadlineTick
              )
            ) {
              this.startCommit(input.tick, input.net);
            }
            break;
          }
          case "ARMED":
            this.supervisorState = "CLOSING";
            break;
          case "CLOSING": {
            const interceptTick = this.committedPlan?.predictedInterceptTick ?? null;
            const graceTicks = Math.ceil(this.missedGraceS / this.tickDurationS);
            if (
              interceptTick !== null &&
              input.tick > interceptTick + graceTicks &&
              !input.net.contactDetected
            ) {
              this.supervisorState = "MISSED";
              this.abortReasonValue = "capture window passed without contact";
            }
            break;
          }
          case "CONTACT":
            this.supervisorState = "ARREST";
            break;
          case "ARREST": {
            const verticalSpeed = Math.abs(this.latestVehicle?.estimate.velocityMps[2] ?? Number.POSITIVE_INFINITY);
            const settled = input.net.secured || verticalSpeed < 0.35;
            if (settled) {
              this.secureCandidateTick ??= input.tick;
              if (
                input.net.secured ||
                (input.tick - this.secureCandidateTick) * this.tickDurationS >= this.secureDwellS
              ) {
                this.supervisorState = "SECURED";
              }
            } else {
              this.secureCandidateTick = null;
            }
            break;
          }
          case "SECURED":
          case "MISSED":
          case "BROKEN":
          case "ABORT":
            break;
        }
      }
    }

    if (this.latestPlan !== null) {
      this.latestPlan.supervisorState = this.supervisorState;
      this.latestPlan.windowId = this.windowId;
    }
    const geometry = this.desiredGeometry(input.net, input.tick);
    const targetTension = this.targetTension(input.tick);
    return {
      state: this.supervisorState,
      captureMode: captureModeForState(this.supervisorState),
      handshakePhase: phaseForState(this.supervisorState),
      plan: this.latestPlan === null
        ? null
        : {
            ...this.latestPlan,
            centerM: [...this.latestPlan.centerM],
            halfSpacingM: [...this.latestPlan.halfSpacingM],
            predictedInterceptPositionM: [...this.latestPlan.predictedInterceptPositionM],
            predictedInterceptVelocityMps: [...this.latestPlan.predictedInterceptVelocityMps]
          },
      prediction: this.latestPrediction === null
        ? null
        : {
            ...this.latestPrediction,
            predictedInterceptPositionM: [...this.latestPrediction.predictedInterceptPositionM],
            predictedInterceptVelocityMps: [...this.latestPrediction.predictedInterceptVelocityMps],
            horizontalVarianceM2: [...this.latestPrediction.horizontalVarianceM2]
          },
      desiredNetCenterM: geometry.center,
      desiredHalfSpacingM: geometry.spacing,
      winchCommands: this.winchCommands(geometry.center, geometry.spacing, targetTension),
      targetTotalTensionN: targetTension,
      readiness: this.readinessForLatestPlan(input.net),
      abortReason: this.abortReasonValue
    };
  }
}
