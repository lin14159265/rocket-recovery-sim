export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number];

export type ParameterStatus =
  | "official"
  | "public-estimate"
  | "assumed"
  | "calibrated";

export interface ParameterSource {
  status: ParameterStatus;
  source: string;
  note: string;
}

export type AlgorithmMode = "fixed" | "alpha-beta" | "predictive" | "mpc";
export type CaptureMode =
  | "open"
  | "tracking"
  | "closing"
  | "latched"
  | "arresting"
  | "secured"
  | "missed"
  | "broken"
  | "aborted";

export type SupervisorState =
  | "BOOT"
  | "SEARCH"
  | "TRACK"
  | "SYNC"
  | "ARMED"
  | "CLOSING"
  | "CONTACT"
  | "ARREST"
  | "SECURED"
  | "MISSED"
  | "BROKEN"
  | "ABORT";

export type RocketMode =
  | "DESCENT"
  | "APPROACH"
  | "TERMINAL"
  | "CAPTURE_READY"
  | "ENGINE_CUTOFF"
  | "CAPTURED"
  | "DIVERT";

export type NodeId =
  | "rocket"
  | "coordinator"
  | "winch-x-negative"
  | "winch-x-positive"
  | "winch-y-negative"
  | "winch-y-positive";

export type WinchNodeId = Exclude<NodeId, "rocket" | "coordinator">;

export const WINCH_IDS = [
  "winch-x-negative",
  "winch-x-positive",
  "winch-y-negative",
  "winch-y-positive"
] as const satisfies readonly NodeId[];

export type MessageType =
  | "HEARTBEAT"
  | "VEHICLE_STATE"
  | "CAPTURE_PLAN"
  | "CAPTURE_READY"
  | "COMMIT"
  | "ABORT"
  | "WINCH_COMMAND"
  | "WINCH_STATUS"
  | "TENSION_STATUS";

export interface PacketHeader {
  version: 1;
  source: NodeId;
  destination: NodeId;
  type: MessageType;
  sequence: number;
  producedTick: number;
  expiresTick: number;
}

export interface Packet<T = unknown> {
  header: PacketHeader;
  payload: T;
  crc32: number;
}

export interface LinkConfig {
  baseLatencyMs: number;
  jitterMs: number;
  lossRate: number;
  duplicateRate: number;
  corruptionRate: number;
  bandwidthPacketsPerSecond: number;
}

export interface RocketConfig {
  massKg: number;
  lengthM: number;
  radiusM: number;
  inertiaKgM2: Vec3;
  initialPositionM: Vec3;
  initialVelocityMps: Vec3;
  initialAttitudeWxyz: Quat;
  initialAngularVelocityRadps: Vec3;
  thrustMaxN: number;
  thrustTimeConstantS: number;
  torqueMaxNm: number;
  attitudeTimeConstantS: number;
  dragCoefficient: number;
  referenceAreaM2: number;
  lateralAccelerationLimitMps2: number;
}

export interface PlatformConfig {
  capturePlaneZ: number;
  frameHalfWidthM: number;
  frameHalfDepthM: number;
  frameHeightM: number;
  surgeAmplitudeM: number;
  swayAmplitudeM: number;
  heaveAmplitudeM: number;
  rollAmplitudeRad: number;
  pitchAmplitudeRad: number;
  wavePeriodS: number;
}

export interface NetConfig {
  openHalfSpacingM: number;
  closedHalfSpacingM: number;
  closureDurationS: number;
  centerTravelLimitM: number;
  totalStiffnessNpm: number;
  totalDampingNspm: number;
  lateralStiffnessNpm: number;
  lateralDampingNspm: number;
  totalStrengthLimitN: number;
  arrestDistanceM: number;
  winchMaxSpeedMps: number;
  winchMaxAccelerationMps2: number;
  winchTimeConstantS: number;
  /** Per-rope active damping proxy used by the local tension loops. */
  activeDampingMinNspm: number;
  activeDampingMaxNspm: number;
  activeDampingRateNspmPerS: number;
}

export interface EnvironmentConfig {
  gravityMps2: number;
  airDensityKgpm3: number;
  meanWindMps: Vec3;
  gustSigmaMps: number;
  gustTimeConstantS: number;
}

export interface SensorConfig {
  rocketPositionNoiseM: number;
  rocketVelocityNoiseMps: number;
  groundPositionNoiseM: number;
  groundVelocityNoiseMps: number;
  positionBiasM: Vec3;
  sensorRateHz: number;
}

export interface ControllerConfig {
  algorithm: AlgorithmMode;
  controlRateHz: number;
  telemetryRateHz: number;
  netControlRateHz: number;
  rocketPositionKp: number;
  rocketVelocityKd: number;
  verticalVelocityKp: number;
  attitudeKp: number;
  attitudeKd: number;
  netCenterKp: number;
  netCenterKd: number;
  maxCaptureSpeedMps: number;
  maxCaptureTiltRad: number;
  requiredApertureMarginM: number;
  staleTelemetryAbortS: number;
  prediction: {
    stepS: number;
    maximumHorizonS: number;
    confidenceSigma: number;
  };
  guidance: {
    captureDescentSpeedMps: number;
    maximumDescentSpeedMps: number;
    brakingAccelerationMps2: number;
    engineCutoffHeightM: number;
  };
  tension: {
    kp: number;
    ki: number;
    integralLimitNs: number;
  };
  mpc: {
    planRateHz: number;
    stepS: number;
    horizonSteps: number;
    maximumIterations: number;
    convergenceTolerance: number;
  };
}


export interface TimedFaultWindow {
  enabled: boolean;
  startTimeS: number;
  durationS: number;
}

export interface ScenarioFaultConfig {
  radioBlackout: TimedFaultWindow;
  winchStuck: TimedFaultWindow & { node: WinchNodeId };
  sensorBiasStep: TimedFaultWindow & { deltaM: Vec3 };
  thrustScale: TimedFaultWindow & { scale: number };
}

export interface ScenarioConfig {
  schemaVersion: 3;
  id: string;
  name: string;
  description: string;
  seed: number;
  durationS: number;
  physicsDtS: number;
  rocket: RocketConfig;
  platform: PlatformConfig;
  net: NetConfig;
  environment: EnvironmentConfig;
  sensors: SensorConfig;
  controller: ControllerConfig;
  radio: LinkConfig;
  fieldbus: LinkConfig;
  faults: ScenarioFaultConfig;
  parameterSources: Record<string, ParameterSource>;
}

export interface RocketTruthState {
  positionM: Vec3;
  velocityMps: Vec3;
  attitudeWxyz: Quat;
  angularVelocityRadps: Vec3;
  massKg: number;
  actualThrustN: number;
  actualTorqueNm: Vec3;
  mode: RocketMode;
}

export interface PlatformTruthState {
  positionM: Vec3;
  velocityMps: Vec3;
  rollRad: number;
  pitchRad: number;
}

export interface AxisActuatorState {
  positionM: number;
  velocityMps: number;
  desiredPositionM: number;
  appliedAccelerationMps2: number;
  stuck: boolean;
}

export interface NetTruthState {
  xNegative: AxisActuatorState;
  xPositive: AxisActuatorState;
  yNegative: AxisActuatorState;
  yPositive: AxisActuatorState;
  centerM: [number, number];
  halfSpacingM: [number, number];
  tensionsN: [number, number, number, number];
  totalContactForceN: Vec3;
  payoutM: number;
  payoutVelocityMps: number;
  targetTotalTensionN: number;
  desiredTensionsN: [number, number, number, number];
  activeDampingNspm: [number, number, number, number];
  tensionControllerSaturated: [boolean, boolean, boolean, boolean];
  mode: CaptureMode;
}

export interface StateEstimate {
  tick: number;
  positionM: Vec3;
  velocityMps: Vec3;
  accelerationMps2: Vec3;
  covarianceDiagonal: [number, number, number, number, number, number];
  source: "rocket-nav" | "ground-alpha-beta" | "ground-kalman";
}

export interface VehicleStatePayload {
  estimate: StateEstimate;
  attitudeWxyz: Quat;
  angularVelocityRadps: Vec3;
  rocketMode: RocketMode;
  captureReady: boolean;
  acknowledgedWindowId: number | null;
  acknowledgedPlanRevision: number | null;
  healthFlags: number;
}

export interface CapturePlanPayload {
  windowId: number;
  planRevision: number;
  validFromTick: number;
  validUntilTick: number;
  commitDeadlineTick: number;
  capturePlaneZ: number;
  centerM: [number, number];
  halfSpacingM: [number, number];
  predictedInterceptTick: number;
  predictedInterceptPositionM: Vec3;
  predictedInterceptVelocityMps: Vec3;
  predictedRelativeInterceptVelocityMps: Vec3;
  predictionUncertaintyM: Vec3;
  confidenceRadiusM: number;
  supervisorState: SupervisorState;
}

export type EndpointReadinessReason =
  | "ready"
  | "stale-plan"
  | "prediction-infeasible"
  | "speed-margin"
  | "attitude-margin"
  | "actuator-unavailable"
  | "deadline-unreachable";

export interface CaptureReadyPayload {
  windowId: number;
  planRevision: number;
  ready: boolean;
  reason: EndpointReadinessReason;
  evaluatedTick: number;
  positionMarginM: number;
  speedMarginMps: number;
  attitudeMarginRad: number;
  controlAuthorityMarginMps2: number;
}

export interface WinchCommandPayload {
  windowId: number;
  planRevision: number;
  commitDeadlineTick: number;
  captureTargetTick: number;
  captureTargetPositionM: number;
  desiredPositionM: number;
  desiredTensionN: number;
  controlMode: "position" | "tension" | "hold";
}

export interface WinchStatusPayload {
  positionM: number;
  velocityMps: number;
  tensionN: number;
  stuck: boolean;
  readyWindowId: number | null;
  readyPlanRevision: number | null;
  ready: boolean;
  estimatedArrivalTick: number | null;
  readinessReason: EndpointReadinessReason;
}

export interface ControlCommand {
  desiredThrustN: number;
  desiredTorqueNm: Vec3;
  desiredAccelerationMps2: Vec3;
  desiredAttitudeWxyz: Quat;
  engineEnabled: boolean;
}

export interface NetworkStats {
  sent: number;
  delivered: number;
  dropped: number;
  corrupted: number;
  duplicated: number;
  expired: number;
  rejectedDuplicate: number;
  latencySamplesMs: number[];
  lastValidDeliveryTick: number;
}

export interface RecoveryMetrics {
  captured: boolean;
  secured: boolean;
  failed: boolean;
  failureReason: string | null;
  captureTick: number | null;
  missDistanceM: number;
  captureRelativeSpeedMps: number;
  captureTiltRad: number;
  peakContactForceN: number;
  peakApparentLoadG: number;
  peakRopeTensionN: number;
  maxEstimateErrorM: number;
}

/** Physics-tick work and storage ledger for the contact phase. */
export interface SimulationEnergyLedger {
  contactDetected: boolean;
  startTick: number | null;
  startTimeS: number | null;
  endTick: number;
  endTimeS: number;
  physicsStepCount: number;
  initialTranslationalKineticJ: number;
  finalTranslationalKineticJ: number;
  initialRelativeKineticJ: number;
  finalRelativeKineticJ: number;
  initialRotationalKineticJ: number;
  finalRotationalKineticJ: number;
  initialGravitationalPotentialJ: number;
  finalGravitationalPotentialJ: number;
  gravityWorkJ: number;
  thrustWorkJ: number;
  aerodynamicWorkJ: number;
  contactWorkOnRocketJ: number;
  controlTorqueWorkJ: number;
  relativeContactWorkExtractedJ: number;
  platformBoundaryWorkJ: number;
  contactDampingDissipationJ: number;
  initialElasticStorageJ: number;
  finalElasticStorageJ: number;
}

export interface DomainEvent {
  tick: number;
  type: string;
  severity: "info" | "warning" | "error" | "success";
  message: string;
}

export interface TelemetrySample {
  tick: number;
  timeS: number;
  altitudeM: number;
  speedMps: number;
  verticalSpeedMps: number;
  lateralErrorM: number;
  estimateErrorM: number;
  netCenterM: [number, number];
  netHalfSpacingM: [number, number];
  predictedInterceptM: [number, number];
  contactForceN: number;
  apparentLoadG: number;
  ropeTensionsN: [number, number, number, number];
  radioAgeMs: number;
  supervisorState: SupervisorState;
}

export interface SimulationSnapshot {
  runId: string;
  tick: number;
  timeS: number;
  rocket: RocketTruthState;
  platform: PlatformTruthState;
  net: NetTruthState;
  rocketEstimate: StateEstimate;
  groundEstimate: StateEstimate;
  capturePlan: CapturePlanPayload | null;
  control: ControlCommand;
  supervisorState: SupervisorState;
  radioStats: NetworkStats;
  fieldbusStats: NetworkStats;
  metrics: RecoveryMetrics;
  latestEvents: DomainEvent[];
}

export interface SimulationRun {
  modelVersion: string;
  configFingerprint: string;
  config: ScenarioConfig;
  frames: SimulationSnapshot[];
  telemetry: TelemetrySample[];
  events: DomainEvent[];
  energyLedger: SimulationEnergyLedger;
  finalSnapshot: SimulationSnapshot;
  metrics: RecoveryMetrics;
}
