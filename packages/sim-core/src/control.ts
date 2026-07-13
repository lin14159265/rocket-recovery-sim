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
  WinchCommandPayload
} from "./contracts";
import {
  clamp,
  clampMagnitude3,
  minimumJerk,
  norm3,
  quatErrorVector,
  quatFromTwoVectors,
  tiltFromVertical
} from "./math";
import {
  predictCapturePlaneIntersection,
  type CapturePlanePrediction
} from "./estimation";

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
    "estimate" | "attitudeWxyz" | "rocketMode" | "captureReady" | "healthFlags"
  > {}

export interface NetControlFeedback {
  centerM: [number, number];
  halfSpacingM: [number, number];
  winchesReady: boolean;
  anyWinchStuck: boolean;
  contactDetected: boolean;
  broken: boolean;
  secured: boolean;
  tensionsN?: [number, number, number, number];
}

export interface CaptureCoordinatorInput {
  tick: number;
  vehicleState: CaptureVehicleObservation | null;
  platformEstimate: StateEstimate;
  net: NetControlFeedback;
}

export interface CaptureCoordinatorOptions {
  tickDurationS: number;
  controller: ControllerConfig;
  net: NetConfig;
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
  abortReason: string | null;
}

export interface MinimumJerkSample {
  position: number;
  velocity: number;
  acceleration: number;
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

interface LateralPrediction {
  positionM: [number, number];
  velocityMps: [number, number];
}

/**
 * Bounded rollout of the shared lateral PD guidance model. The coordinator
 * does not use truth; it projects the delivered estimate under the same
 * candidate control law instead of assuming a transient acceleration persists
 * unchanged for the whole approach.
 */
const rolloutLateralGuidance = (
  estimate: StateEstimate,
  horizonS: number,
  controller: ControllerConfig,
  accelerationLimitMps2: number,
  targetPositionM: [number, number]
): LateralPrediction => {
  if (horizonS <= 0) {
    return {
      positionM: [estimate.positionM[0], estimate.positionM[1]],
      velocityMps: [estimate.velocityMps[0], estimate.velocityMps[1]]
    };
  }
  const steps = Math.max(1, Math.min(128, Math.ceil(horizonS / 0.08)));
  const dt = horizonS / steps;
  const position: [number, number] = [estimate.positionM[0], estimate.positionM[1]];
  const velocity: [number, number] = [estimate.velocityMps[0], estimate.velocityMps[1]];
  for (let step = 0; step < steps; step += 1) {
    const rawAcceleration: [number, number] = [
      controller.rocketPositionKp * (targetPositionM[0] - position[0]) -
        controller.rocketVelocityKd * velocity[0],
      controller.rocketPositionKp * (targetPositionM[1] - position[1]) -
        controller.rocketVelocityKd * velocity[1]
    ];
    const magnitude = Math.hypot(...rawAcceleration);
    const scale = magnitude > accelerationLimitMps2 && magnitude > 0
      ? accelerationLimitMps2 / magnitude
      : 1;
    const acceleration: [number, number] = [
      rawAcceleration[0] * scale,
      rawAcceleration[1] * scale
    ];
    position[0] += velocity[0] * dt + 0.5 * acceleration[0] * dt * dt;
    position[1] += velocity[1] * dt + 0.5 * acceleration[1] * dt * dt;
    velocity[0] += acceleration[0] * dt;
    velocity[1] += acceleration[1] * dt;
  }
  return { positionM: position, velocityMps: velocity };
};

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
  private readonly capturePlaneZ: number;
  private readonly prepareLeadTimeS: number;
  private readonly commitMarginS: number;
  private readonly stableTrackSamples: number;
  private readonly postContactTargetTensionN: number;
  private readonly tensionRampS: number;
  private readonly secureDwellS: number;
  private readonly missedGraceS: number;
  private readonly lateralAccelerationLimitMps2: number;

  private supervisorState: SupervisorState = "BOOT";
  private latestVehicle: CaptureVehicleObservation | null = null;
  private latestPlan: CapturePlanPayload | null = null;
  private latestPrediction: CapturePlanePrediction | null = null;
  private latestRelativePrediction: CapturePlanePrediction | null = null;
  private committedPlan: CapturePlanPayload | null = null;
  private trajectory: NetTrajectory | null = null;
  private windowId = 0;
  private feasibleSamples = 0;
  private contactTick: number | null = null;
  private secureCandidateTick: number | null = null;
  private abortReasonValue: string | null = null;

  public constructor(options: CaptureCoordinatorOptions) {
    if (!Number.isFinite(options.tickDurationS) || options.tickDurationS <= 0) {
      throw new RangeError("tickDurationS must be finite and greater than zero");
    }
    this.tickDurationS = options.tickDurationS;
    this.controller = options.controller;
    this.netConfig = options.net;
    this.capturePlaneZ = options.capturePlaneZ;
    this.prepareLeadTimeS = options.prepareLeadTimeS ?? options.net.closureDurationS + 2;
    this.commitMarginS = options.commitMarginS ?? 0.25;
    this.stableTrackSamples = Math.max(1, options.stableTrackSamples ?? 3);
    this.postContactTargetTensionN = Math.min(
      options.net.totalStrengthLimitN * 0.8,
      options.postContactTargetTensionN ?? options.net.totalStrengthLimitN * 0.4
    );
    this.tensionRampS = options.tensionRampS ?? 0.35;
    this.secureDwellS = options.secureDwellS ?? 0.5;
    this.missedGraceS = options.missedGraceS ?? 0.4;
    this.lateralAccelerationLimitMps2 = Math.max(
      0.01,
      options.lateralAccelerationLimitMps2 ?? 3.5
    );
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
    this.feasibleSamples = 0;
    this.contactTick = null;
    this.secureCandidateTick = null;
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
    platform: StateEstimate,
    tick: number
  ): { relative: CapturePlanePrediction; world: CapturePlanePrediction } | null {
    const vehicleAtTick = propagateEstimate(vehicle.estimate, tick, this.tickDurationS);
    const platformAtTick = propagateEstimate(platform, tick, this.tickDurationS);
    const relativeEstimate = platformRelativeEstimate(vehicleAtTick, platformAtTick);
    // The terminal guidance loop is actively changing lateral acceleration;
    // extrapolating one noisy Kalman acceleration sample for 5-10 s makes the
    // agreed net centre jump between travel limits. Use constant horizontal
    // velocity while retaining vertical acceleration for arrival-time/braking
    // prediction. This is still an explicit candidate model, not flight logic.
    const interceptEstimate: StateEstimate = {
      ...relativeEstimate,
      accelerationMps2: [0, 0, relativeEstimate.accelerationMps2[2]]
    };
    const verticalPrediction = predictCapturePlaneIntersection(interceptEstimate, this.capturePlaneZ, {
      tickDurationS: this.tickDurationS,
      maximumLookaheadS: 60,
      confidenceSigma: 3
    });
    if (verticalPrediction === null) return null;
    const lateral = rolloutLateralGuidance(
      relativeEstimate,
      verticalPrediction.timeToInterceptS,
      this.controller,
      this.lateralAccelerationLimitMps2,
      this.committedPlan?.centerM ?? [0, 0]
    );
    const relative: CapturePlanePrediction = {
      ...verticalPrediction,
      predictedInterceptPositionM: [
        lateral.positionM[0],
        lateral.positionM[1],
        verticalPrediction.predictedInterceptPositionM[2]
      ],
      predictedInterceptVelocityMps: [
        lateral.velocityMps[0],
        lateral.velocityMps[1],
        verticalPrediction.predictedInterceptVelocityMps[2]
      ]
    };
    return {
      relative,
      world: addPlatformMotion(relative, platformAtTick, this.capturePlaneZ)
    };
  }

  private buildPlan(
    relativePrediction: CapturePlanePrediction,
    worldPrediction: CapturePlanePrediction
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
      capturePlaneZ: worldPrediction.predictedInterceptPositionM[2],
      centerM: center,
      halfSpacingM: [this.netConfig.closedHalfSpacingM, this.netConfig.closedHalfSpacingM],
      predictedInterceptTick: relativePrediction.predictedInterceptTick,
      predictedInterceptPositionM: [...worldPrediction.predictedInterceptPositionM],
      predictedInterceptVelocityMps: [...worldPrediction.predictedInterceptVelocityMps],
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
    this.supervisorState = "ARMED";
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
        return {
          center: [...this.latestPlan.centerM],
          spacing: [this.netConfig.openHalfSpacingM, this.netConfig.openHalfSpacingM]
        };
      }
      return { center: [...net.centerM], spacing: [...net.halfSpacingM] };
    }
    const elapsedS = (tick - this.trajectory.startTick) * this.tickDurationS;
    const plannedCenter: [number, number] = [
        sampleMinimumJerk(
          this.trajectory.startCenterM[0],
          this.trajectory.endCenterM[0],
          elapsedS,
          this.trajectory.durationS
        ).position,
        sampleMinimumJerk(
          this.trajectory.startCenterM[1],
          this.trajectory.endCenterM[1],
          elapsedS,
          this.trajectory.durationS
        ).position
      ];
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
    }
    return {
      center: plannedCenter,
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
    const command = (desiredPositionM: number): WinchCommandPayload => ({
      windowId: this.windowId,
      desiredPositionM,
      desiredTensionN: perWinchTension,
      controlMode
    });
    return {
      "winch-x-negative": command(center[0] - spacing[0]),
      "winch-x-positive": command(center[0] + spacing[0]),
      "winch-y-negative": command(center[1] - spacing[1]),
      "winch-y-positive": command(center[1] + spacing[1])
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
      : this.calculatePrediction(this.latestVehicle, input.platformEstimate, input.tick);
    if (predictionPair === null) {
      this.latestPrediction = null;
      this.latestRelativePrediction = null;
      this.feasibleSamples = 0;
    } else {
      this.latestPrediction = predictionPair.world;
      this.latestRelativePrediction = predictionPair.relative;
      if (this.committedPlan === null) {
        const candidate = this.buildPlan(predictionPair.relative, predictionPair.world);
        const feasible = this.latestVehicle !== null &&
          this.predictionIsFeasible(predictionPair.relative, candidate, this.latestVehicle);
        this.feasibleSamples = feasible ? this.feasibleSamples + 1 : 0;
        this.latestPlan = { ...candidate, supervisorState: this.supervisorState };
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
              if (this.latestPlan !== null) this.latestPlan.windowId = this.windowId;
              this.supervisorState = "SYNC";
            }
            break;
          case "SYNC": {
            if (this.latestPrediction === null || this.latestPlan === null || this.latestVehicle === null) {
              break;
            }
            const requiredDuration = this.minimumTrajectoryDuration(
              input.net.centerM,
              input.net.halfSpacingM,
              this.latestPlan.centerM,
              this.latestPlan.halfSpacingM
            );
            const remainingS = this.latestPrediction.timeToInterceptS;
            if (
              remainingS <= requiredDuration + this.commitMarginS &&
              this.latestVehicle.captureReady &&
              input.net.winchesReady
            ) {
              this.startCommit(input.tick, input.net);
            } else if (remainingS < requiredDuration &&
              (!this.latestVehicle.captureReady || !input.net.winchesReady)) {
              this.abort("PREPARE timed out before both endpoints were ready");
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
      abortReason: this.abortReasonValue
    };
  }
}
