import type {
  CaptureReadyPayload,
  CapturePlanPayload,
  ControlCommand,
  DomainEvent,
  GuidanceUpdatePayload,
  NodeId,
  Packet,
  RocketMode,
  ScenarioConfig,
  SensorConfig,
  SimulationEnergyLedger,
  SimulationRun,
  SimulationSnapshot,
  StateEstimate,
  SupervisorState,
  TelemetrySample,
  VehicleStatePayload,
  Vec3,
  WinchCommandPayload,
  WinchStatusPayload
} from "./contracts";
import { WINCH_IDS } from "./contracts";
import { fingerprintScenarioConfig } from "./config";
import {
  CaptureCoordinator,
  RocketController,
  WinchTensionController,
  computeVerticalVelocityReference,
  type CaptureCoordinatorOutput,
  type NetControlFeedback
} from "./control";
import { AlphaBetaEstimator, ConstantAccelerationKalman } from "./estimation";
import { DeterministicRng } from "./engine/rng";
import { norm3, sub3 } from "./math";
import { RecoveryMetricsAccumulator } from "./metrics";
import {
  RecoveryPlant,
  createNeutralPlantInput,
  type PlantStepInput,
  type PlantStepResult,
  type PreContactNetMode,
  type WinchAxisValues
} from "./plant";
import { sampleGroundTracking, sampleRocketNavigation } from "./sensors";
import { VirtualNetwork } from "./comms/network";
import { createPacket } from "./comms/protocol";

type WinchNodeId = (typeof WINCH_IDS)[number];

export interface TimedWinchFault {
  node: WinchNodeId;
  startTimeS: number;
  endTimeS?: number;
}

export interface TimedRadioBlackout {
  startTimeS: number;
  endTimeS: number;
}

export interface SimulationFaultPlan {
  winchStuck?: TimedWinchFault[];
  radioBlackouts?: TimedRadioBlackout[];
}

export interface SimulationOptions {
  frameRateHz?: number;
  stopOnTerminal?: boolean;
  faults?: SimulationFaultPlan;
  guidance?: {
    captureDescentSpeedMps?: number;
    maximumDescentSpeedMps?: number;
    brakingAccelerationMps2?: number;
    engineCutoffHeightM?: number;
  };
}

interface WinchWireCommand extends WinchCommandPayload {
  requestedMode: PreContactNetMode;
}

interface WinchWireStatus extends WinchStatusPayload {
  sampledTick: number;
}

interface TensionWireStatus {
  sampledTick: number;
  tensionsN: [number, number, number, number];
  payoutM: number;
  payoutVelocityMps: number;
  contactDetected: boolean;
  broken: boolean;
  secured: boolean;
}

interface Received<T> {
  payload: T;
  receivedTick: number;
}

interface AttitudeSensorFrame {
  attitudeWxyz: [number, number, number, number];
  angularVelocityRadps: Vec3;
}

interface EstimatorLike {
  readonly initialized: boolean;
  update(measurement: Parameters<AlphaBetaEstimator["update"]>[0]): StateEstimate;
  snapshot(): StateEstimate | null;
}

export const SIMULATION_MODEL_VERSION = "0.3.1";

const MPC_ACTIVE_DAMPING_SCALE = 0.99;

const terminalSupervisorStates = new Set<SupervisorState>([
  "SECURED",
  "MISSED",
  "BROKEN",
  "ABORT"
]);

const winchAxisIndex: Record<WinchNodeId, 0 | 1 | 2 | 3> = {
  "winch-x-negative": 0,
  "winch-x-positive": 1,
  "winch-y-negative": 2,
  "winch-y-positive": 3
};

const axisStateFor = (step: PlantStepResult, node: WinchNodeId) => {
  switch (node) {
    case "winch-x-negative": return step.net.xNegative;
    case "winch-x-positive": return step.net.xPositive;
    case "winch-y-negative": return step.net.yNegative;
    case "winch-y-positive": return step.net.yPositive;
  }
};

const intervalTicks = (rateHz: number, physicsDtS: number, label: string): number => {
  if (!Number.isFinite(rateHz) || rateHz <= 0) {
    throw new RangeError(`${label} must be finite and greater than zero`);
  }
  const raw = 1 / (rateHz * physicsDtS);
  const rounded = Math.round(raw);
  if (rounded < 1 || Math.abs(raw - rounded) > 1e-8) {
    throw new RangeError(`${label} must be an integer divisor of the physics tick rate`);
  }
  return rounded;
};

const cloneEstimate = (estimate: StateEstimate, source = estimate.source): StateEstimate => ({
  ...estimate,
  positionM: [...estimate.positionM],
  velocityMps: [...estimate.velocityMps],
  accelerationMps2: [...estimate.accelerationMps2],
  covarianceDiagonal: [...estimate.covarianceDiagonal],
  source
});

const sampleAttitudeSensors = (step: PlantStepResult): AttitudeSensorFrame => ({
  // The public parameter set contains no attitude-sensor noise. Keeping this
  // explicit sampling boundary prevents the controller from accepting TruthState.
  attitudeWxyz: [...step.rocket.attitudeWxyz],
  angularVelocityRadps: [...step.rocket.angularVelocityRadps]
});

const netModeForSupervisor = (state: SupervisorState): PreContactNetMode => {
  if (state === "BOOT" || state === "SEARCH") return "open";
  if (state === "CLOSING" || state === "CONTACT" || state === "ARREST" || state === "SECURED") {
    return "closing";
  }
  return "tracking";
};

const axisPositionsFromCommands = (
  commands: Record<WinchNodeId, WinchWireCommand>
): WinchAxisValues<number> => [
  commands["winch-x-negative"].desiredPositionM,
  commands["winch-x-positive"].desiredPositionM,
  commands["winch-y-negative"].desiredPositionM,
  commands["winch-y-positive"].desiredPositionM
];

const makeInitialWinchCommands = (config: ScenarioConfig): Record<WinchNodeId, WinchWireCommand> => ({
  "winch-x-negative": {
    windowId: 0,
    planRevision: 0,
    commitDeadlineTick: 0,
    captureTargetTick: 0,
    captureTargetPositionM: -config.net.closedHalfSpacingM,
    desiredPositionM: -config.net.openHalfSpacingM,
    desiredTensionN: 0,
    controlMode: "position",
    requestedMode: "open"
  },
  "winch-x-positive": {
    windowId: 0,
    planRevision: 0,
    commitDeadlineTick: 0,
    captureTargetTick: 0,
    captureTargetPositionM: config.net.closedHalfSpacingM,
    desiredPositionM: config.net.openHalfSpacingM,
    desiredTensionN: 0,
    controlMode: "position",
    requestedMode: "open"
  },
  "winch-y-negative": {
    windowId: 0,
    planRevision: 0,
    commitDeadlineTick: 0,
    captureTargetTick: 0,
    captureTargetPositionM: -config.net.closedHalfSpacingM,
    desiredPositionM: -config.net.openHalfSpacingM,
    desiredTensionN: 0,
    controlMode: "position",
    requestedMode: "open"
  },
  "winch-y-positive": {
    windowId: 0,
    planRevision: 0,
    commitDeadlineTick: 0,
    captureTargetTick: 0,
    captureTargetPositionM: config.net.closedHalfSpacingM,
    desiredPositionM: config.net.openHalfSpacingM,
    desiredTensionN: 0,
    controlMode: "position",
    requestedMode: "open"
  }
});

const windowActive = (timeS: number, fault: { enabled: boolean; startTimeS: number; durationS: number }): boolean =>
  fault.enabled && timeS >= fault.startTimeS && timeS < fault.startTimeS + fault.durationS;

const simulationFaultsFor = (config: ScenarioConfig, options?: SimulationFaultPlan): SimulationFaultPlan => ({
  radioBlackouts: [
    ...(options?.radioBlackouts ?? []),
    ...(config.faults.radioBlackout.enabled
      ? [{
          startTimeS: config.faults.radioBlackout.startTimeS,
          endTimeS: config.faults.radioBlackout.startTimeS + config.faults.radioBlackout.durationS
        }]
      : [])
  ],
  winchStuck: [
    ...(options?.winchStuck ?? []),
    ...(config.faults.winchStuck.enabled
      ? [{
          node: config.faults.winchStuck.node,
          startTimeS: config.faults.winchStuck.startTimeS,
          endTimeS: config.faults.winchStuck.startTimeS + config.faults.winchStuck.durationS
        }]
      : [])
  ]
});

const sensorConfigAt = (config: ScenarioConfig, timeS: number): SensorConfig => {
  if (!windowActive(timeS, config.faults.sensorBiasStep)) return config.sensors;
  return {
    ...config.sensors,
    positionBiasM: [
      config.sensors.positionBiasM[0] + config.faults.sensorBiasStep.deltaM[0],
      config.sensors.positionBiasM[1] + config.faults.sensorBiasStep.deltaM[1],
      config.sensors.positionBiasM[2] + config.faults.sensorBiasStep.deltaM[2]
    ]
  };
};

const blackoutActive = (tick: number, dtS: number, faults?: SimulationFaultPlan): boolean => {
  const timeS = tick * dtS;
  return faults?.radioBlackouts?.some(
    (fault) => timeS >= fault.startTimeS && timeS < fault.endTimeS
  ) ?? false;
};

const activeWinchFaults = (
  tick: number,
  dtS: number,
  faults?: SimulationFaultPlan
): WinchAxisValues<boolean> => {
  const timeS = tick * dtS;
  const values: WinchAxisValues<boolean> = [false, false, false, false];
  for (const fault of faults?.winchStuck ?? []) {
    if (timeS >= fault.startTimeS && (fault.endTimeS === undefined || timeS < fault.endTimeS)) {
      values[winchAxisIndex[fault.node]] = true;
    }
  }
  return values;
};

const makeGroundEstimator = (config: ScenarioConfig): EstimatorLike => {
  const common = {
    tickDurationS: config.physicsDtS,
    positionMeasurementVarianceM2: config.sensors.groundPositionNoiseM ** 2,
    velocityMeasurementVarianceM2ps2: config.sensors.groundVelocityNoiseMps ** 2
  };
  return config.controller.algorithm === "predictive" || config.controller.algorithm === "mpc"
    ? new ConstantAccelerationKalman({ ...common, jerkProcessNoiseM2ps5: 0.22 })
    : new AlphaBetaEstimator({ ...common, alpha: 0.82, beta: 0.12 });
};

const makeRocketEstimator = (config: ScenarioConfig): EstimatorLike => {
  const common = {
    tickDurationS: config.physicsDtS,
    positionMeasurementVarianceM2: config.sensors.rocketPositionNoiseM ** 2,
    velocityMeasurementVarianceM2ps2: config.sensors.rocketVelocityNoiseMps ** 2
  };
  return config.controller.algorithm === "predictive" || config.controller.algorithm === "mpc"
    ? new ConstantAccelerationKalman({ ...common, jerkProcessNoiseM2ps5: 0.18 })
    : new AlphaBetaEstimator({ ...common, alpha: 0.82, beta: 0.12 });
};

const makePlatformEstimator = (config: ScenarioConfig): ConstantAccelerationKalman =>
  new ConstantAccelerationKalman({
    tickDurationS: config.physicsDtS,
    positionMeasurementVarianceM2: config.sensors.groundPositionNoiseM ** 2,
    velocityMeasurementVarianceM2ps2: config.sensors.groundVelocityNoiseMps ** 2,
    // The deck motion is smooth and low-frequency. A low jerk noise avoids
    // projecting raw 100 Hz position noise into an impossible future plane.
    jerkProcessNoiseM2ps5: 0.01
  });

const sequenceSource = () => {
  const values = new Map<NodeId, number>();
  return (source: NodeId): number => {
    const next = values.get(source) ?? 0;
    values.set(source, next + 1);
    return next;
  };
};

const send = <T>(
  network: VirtualNetwork,
  nextSequence: (source: NodeId) => number,
  source: NodeId,
  destination: NodeId,
  type: Packet<T>["header"]["type"],
  tick: number,
  ttlTicks: number,
  payload: T
): void => {
  network.send(createPacket({
    source,
    destination,
    type,
    sequence: nextSequence(source),
    producedTick: tick,
    expiresTick: tick + ttlTicks
  }, payload), tick);
};

const receivedWinchFeedback = (
  tick: number,
  config: ScenarioConfig,
  statuses: Partial<Record<WinchNodeId, Received<WinchWireStatus>>>,
  tension: Received<TensionWireStatus> | null
): NetControlFeedback => {
  const timeoutTicks = Math.ceil(0.12 / config.physicsDtS);
  const current = WINCH_IDS.map((node) => statuses[node]);
  const fresh = current.every(
    (received) => received !== undefined && tick - received.receivedTick <= timeoutTicks
  );
  const position = (node: WinchNodeId, fallback: number): number =>
    statuses[node]?.payload.positionM ?? fallback;
  const velocity = (node: WinchNodeId): number => statuses[node]?.payload.velocityMps ?? 0;
  const negativeX = position("winch-x-negative", -config.net.openHalfSpacingM);
  const positiveX = position("winch-x-positive", config.net.openHalfSpacingM);
  const negativeY = position("winch-y-negative", -config.net.openHalfSpacingM);
  const positiveY = position("winch-y-positive", config.net.openHalfSpacingM);
  const tensionFresh = tension !== null && tick - tension.receivedTick <= timeoutTicks;
  return {
    centerM: [(negativeX + positiveX) / 2, (negativeY + positiveY) / 2],
    centerVelocityMps: [
      (velocity("winch-x-negative") + velocity("winch-x-positive")) / 2,
      (velocity("winch-y-negative") + velocity("winch-y-positive")) / 2
    ],
    halfSpacingM: [
      Math.max(0, (positiveX - negativeX) / 2),
      Math.max(0, (positiveY - negativeY) / 2)
    ],
    halfSpacingRateMps: [
      (velocity("winch-x-positive") - velocity("winch-x-negative")) / 2,
      (velocity("winch-y-positive") - velocity("winch-y-negative")) / 2
    ],
    winchesReady: fresh,
    winchStatuses: {
      "winch-x-negative": statuses["winch-x-negative"]?.payload ?? null,
      "winch-x-positive": statuses["winch-x-positive"]?.payload ?? null,
      "winch-y-negative": statuses["winch-y-negative"]?.payload ?? null,
      "winch-y-positive": statuses["winch-y-positive"]?.payload ?? null
    },
    anyWinchStuck: current.some((received) => received?.payload.stuck === true),
    contactDetected: tensionFresh ? tension.payload.contactDetected : false,
    broken: tensionFresh ? tension.payload.broken : false,
    secured: tensionFresh ? tension.payload.secured : false,
    tensionsN: tensionFresh ? [...tension.payload.tensionsN] : [0, 0, 0, 0],
    payoutM: tensionFresh ? tension.payload.payoutM : 0,
    payoutVelocityMps: tensionFresh ? tension.payload.payoutVelocityMps : 0
  };
};

const rocketModeFor = (
  altitudeAbovePlaneM: number,
  captureReady: boolean,
  engineCutoff: boolean,
  abortReceived: boolean,
  supervisorState: SupervisorState
): RocketMode => {
  if (abortReceived || supervisorState === "ABORT" || supervisorState === "BROKEN") return "DIVERT";
  if (["CONTACT", "ARREST", "SECURED"].includes(supervisorState)) return "CAPTURED";
  if (engineCutoff) return "ENGINE_CUTOFF";
  if (captureReady) return "CAPTURE_READY";
  if (altitudeAbovePlaneM < 120) return "TERMINAL";
  if (altitudeAbovePlaneM < 350) return "APPROACH";
  return "DESCENT";
};

const currentMetrics = (
  accumulator: RecoveryMetricsAccumulator,
  coordinator: CaptureCoordinatorOutput | null
) => {
  const metrics = accumulator.snapshot();
  if (coordinator !== null) {
    metrics.mpcFallbackCount = coordinator.mpcFallbackCount;
    metrics.mpcFallbackReasons = { ...coordinator.mpcFallbackReasons };
  }
  if (coordinator !== null && ["ABORT", "MISSED", "BROKEN"].includes(coordinator.state)) {
    metrics.failed = true;
    metrics.failureReason = coordinator.abortReason ?? metrics.failureReason ??
      coordinator.state.toLowerCase();
  }
  return metrics;
};

const boundedNetworkStats = (network: VirtualNetwork, maximumLatencySamples = 512) => {
  const stats = network.getStats();
  if (stats.latencySamplesMs.length > maximumLatencySamples) {
    stats.latencySamplesMs = stats.latencySamplesMs.slice(-maximumLatencySamples);
  }
  return stats;
};

const createEmptyEnergyLedger = (): SimulationEnergyLedger => ({
  contactDetected: false,
  startTick: null,
  startTimeS: null,
  endTick: 0,
  endTimeS: 0,
  physicsStepCount: 0,
  initialTranslationalKineticJ: 0,
  finalTranslationalKineticJ: 0,
  initialRelativeKineticJ: 0,
  finalRelativeKineticJ: 0,
  initialRotationalKineticJ: 0,
  finalRotationalKineticJ: 0,
  initialGravitationalPotentialJ: 0,
  finalGravitationalPotentialJ: 0,
  gravityWorkJ: 0,
  thrustWorkJ: 0,
  aerodynamicWorkJ: 0,
  contactWorkOnRocketJ: 0,
  controlTorqueWorkJ: 0,
  relativeContactWorkExtractedJ: 0,
  platformBoundaryWorkJ: 0,
  contactDampingDissipationJ: 0,
  initialElasticStorageJ: 0,
  finalElasticStorageJ: 0
});

const accumulateContactEnergy = (
  ledger: SimulationEnergyLedger,
  step: PlantStepResult,
  dtS: number
): void => {
  if (!ledger.contactDetected && !step.energy.contactActive) return;
  if (!ledger.contactDetected) {
    ledger.contactDetected = true;
    ledger.startTick = Math.max(0, step.tick - 1);
    ledger.startTimeS = Math.max(0, step.timeS - dtS);
    ledger.initialTranslationalKineticJ = step.energy.translationalKineticBeforeJ;
    ledger.initialRelativeKineticJ = step.energy.relativeKineticBeforeJ;
    ledger.initialRotationalKineticJ = step.energy.rotationalKineticBeforeJ;
    ledger.initialGravitationalPotentialJ = step.energy.gravitationalPotentialBeforeJ;
    ledger.initialElasticStorageJ = step.energy.elasticStorageBeforeJ;
  }
  ledger.endTick = step.tick;
  ledger.endTimeS = step.timeS;
  ledger.physicsStepCount += 1;
  ledger.finalTranslationalKineticJ = step.energy.translationalKineticAfterJ;
  ledger.finalRelativeKineticJ = step.energy.relativeKineticAfterJ;
  ledger.finalRotationalKineticJ = step.energy.rotationalKineticAfterJ;
  ledger.finalGravitationalPotentialJ = step.energy.gravitationalPotentialAfterJ;
  ledger.gravityWorkJ += step.energy.gravityWorkJ;
  ledger.thrustWorkJ += step.energy.thrustWorkJ;
  ledger.aerodynamicWorkJ += step.energy.aerodynamicWorkJ;
  ledger.contactWorkOnRocketJ += step.energy.contactWorkOnRocketJ;
  ledger.controlTorqueWorkJ += step.energy.controlTorqueWorkJ;
  ledger.relativeContactWorkExtractedJ += step.energy.relativeContactWorkExtractedJ;
  ledger.platformBoundaryWorkJ += step.energy.platformBoundaryWorkJ;
  ledger.contactDampingDissipationJ += step.energy.contactDampingDissipationJ;
  ledger.finalElasticStorageJ = step.energy.elasticStorageAfterJ;
};

const telemetryFor = (
  step: PlantStepResult,
  estimate: StateEstimate,
  plan: CapturePlanPayload | null,
  supervisorState: SupervisorState,
  radioAgeMs: number,
  gravityMps2: number,
  coordinator: CaptureCoordinatorOutput | null
): TelemetrySample => {
  const relativePosition = sub3(step.rocket.positionM, step.platform.positionM);
  const relativeVelocity = sub3(step.rocket.velocityMps, step.platform.velocityMps);
  const lateralErrorM = Math.hypot(
    relativePosition[0] - step.net.centerM[0],
    relativePosition[1] - step.net.centerM[1]
  );
  const nonGravityForceN = sub3(step.forces.totalN, step.forces.gravityN);
  return {
    tick: step.tick,
    timeS: step.timeS,
    altitudeM: relativePosition[2],
    speedMps: norm3(relativeVelocity),
    verticalSpeedMps: relativeVelocity[2],
    lateralErrorM,
    estimateErrorM: norm3(sub3(estimate.positionM, step.rocket.positionM)),
    netCenterM: [...step.net.centerM],
    netHalfSpacingM: [...step.net.halfSpacingM],
    predictedInterceptM: plan === null
      ? [0, 0]
      : [plan.predictedInterceptPositionM[0], plan.predictedInterceptPositionM[1]],
    contactForceN: norm3(step.forces.contactN),
    apparentLoadG: norm3(nonGravityForceN) / (step.rocket.massKg * gravityMps2),
    ropeTensionsN: [...step.net.tensionsN],
    desiredRopeTensionsN: [...step.net.desiredTensionsN],
    activeDampingNspm: [...step.net.activeDampingNspm],
    desiredNetCenterM: coordinator?.desiredNetCenterM ?? [...step.net.centerM],
    predictionTimeToGoS: plan === null ? 0 : (plan.predictedInterceptTick - step.tick) * step.timeS / Math.max(1, step.tick),
    commitMarginS: plan === null ? 0 : (plan.commitDeadlineTick - step.tick) * step.timeS / Math.max(1, step.tick),
    tensionErrorsN: step.net.desiredTensionsN.map(
      (desired, index) => desired - (step.net.tensionsN[index] ?? 0)
    ) as [number, number, number, number],
    saturationCount: step.net.tensionControllerSaturated.filter(Boolean).length,
    mpcIterations: coordinator?.mpcDiagnostics?.iterations ?? 0,
    mpcFallback: coordinator?.mpcDiagnostics?.converged === false,
    radioAgeMs,
    supervisorState
  };
};

/**
 * Runs a deterministic, multi-rate closed loop. Truth enters only the plant,
 * explicit sensor samplers and the read-only recorder/metrics path. Controllers
 * consume estimates and packets delivered by the virtual links.
 */
export const runSimulation = (
  inputConfig: ScenarioConfig,
  options: SimulationOptions = {}
): SimulationRun => {
  const config = structuredClone(inputConfig);
  const dtS = config.physicsDtS;
  const simulationFaults = simulationFaultsFor(config, options.faults);
  const sensorTicks = intervalTicks(config.sensors.sensorRateHz, dtS, "sensorRateHz");
  const controlTicks = intervalTicks(config.controller.controlRateHz, dtS, "controlRateHz");
  const telemetryTicks = intervalTicks(config.controller.telemetryRateHz, dtS, "telemetryRateHz");
  const netControlTicks = intervalTicks(config.controller.netControlRateHz, dtS, "netControlRateHz");
  const frameRateHz = options.frameRateHz ?? 30;
  if (!Number.isFinite(frameRateHz) || frameRateHz <= 0) {
    throw new RangeError("frameRateHz must be finite and greater than zero");
  }
  const maximumTick = Math.round(config.durationS / dtS);
  const radioTtlTicks = Math.ceil(0.5 / dtS);
  const fieldbusTtlTicks = Math.ceil(0.08 / dtS);

  // Independent streams prevent a changed packet-loss decision from changing
  // the physical gust or sensor-noise sequence.
  const plantRng = new DeterministicRng(config.seed ^ 0x1357_9bdf);
  const rocketSensorRng = new DeterministicRng(config.seed ^ 0x2468_ace0);
  const groundSensorRng = new DeterministicRng(config.seed ^ 0x55aa_33cc);
  const platformSensorRng = new DeterministicRng(config.seed ^ 0x0f0f_f0f0);
  const radioRng = new DeterministicRng(config.seed ^ 0x6c8e_9cf5);
  const fieldbusRng = new DeterministicRng(config.seed ^ 0xa511_e9b3);

  const plant = new RecoveryPlant(config, plantRng);
  const radio = new VirtualNetwork(config.radio, dtS * 1_000, radioRng);
  const fieldbus = new VirtualNetwork(config.fieldbus, dtS * 1_000, fieldbusRng);
  const radioSequence = sequenceSource();
  const fieldbusSequence = sequenceSource();
  const rocketEstimator = makeRocketEstimator(config);
  const groundEstimator = makeGroundEstimator(config);
  const platformEstimator = makePlatformEstimator(config);
  const rocketController = new RocketController(
    config.controller,
    config.rocket,
    config.environment.gravityMps2
  );
  const coordinator = new CaptureCoordinator({
    tickDurationS: dtS,
    controller: config.controller,
    net: config.net,
    rocket: config.rocket,
    gravityMps2: config.environment.gravityMps2,
    radio: config.radio,
    capturePlaneZ: config.platform.capturePlaneZ,
    lateralAccelerationLimitMps2: config.rocket.lateralAccelerationLimitMps2,
    // Hold the physical window through modest arrival-time model error. The
    // plant's actual plane crossing remains the authoritative capture event.
    missedGraceS: 1.5,
    // Reserve one full wireless request/ack exchange plus prediction jitter
    // before the minimum winch trajectory becomes infeasible.
    commitMarginS: Math.max(
      0.75,
      2 * (config.radio.baseLatencyMs + config.radio.jitterMs) / 1_000 + 0.25
    )
  });
  const metricsAccumulator = new RecoveryMetricsAccumulator();
  const energyLedger = createEmptyEnergyLedger();

  const frames: SimulationSnapshot[] = [];
  const telemetry: TelemetrySample[] = [];
  const events: DomainEvent[] = [];
  const configFingerprint = fingerprintScenarioConfig(config);
  const runId = `${config.id}-${config.controller.algorithm}-seed-${config.seed}-cfg-${configFingerprint}`;
  const event = (
    tick: number,
    type: string,
    severity: DomainEvent["severity"],
    message: string
  ): void => {
    events.push({ tick, type, severity, message });
  };
  event(0, "SIMULATION_STARTED", "info", `场景“${config.name}”开始，seed=${config.seed}`);

  let plantState = plant.getState();
  let attitudeFrame = sampleAttitudeSensors(plantState);
  let rocketEstimate: StateEstimate | null = null;
  let groundEstimate: StateEstimate | null = null;
  let platformEstimate: StateEstimate | null = null;
  let latestVehicleAtCoordinator: VehicleStatePayload | null = null;
  let latestVehicleDeliveryTick = -1;
  let planAtRocket: CapturePlanPayload | null = null;
  let abortReceivedAtRocket = false;
  let mpcGuidanceAtRocket: [number, number] = [0, 0];
  let readyAnnouncedPlanKey = "";
  let coordinatorReadyPlanKey = "";
  let coordinatorOutput: CaptureCoordinatorOutput | null = null;
  let prepareStartedTick: number | null = null;
  let allReadyTick: number | null = null;
  let predictionTimeErrorS = 0;
  let capturePlaneCenterErrorM = 0;
  let tensionErrorSquaredSum = 0;
  let tensionErrorSampleCount = 0;
  let constraintActivationCount = 0;
  let observedMpcSolveCount = 0;
  let previousSupervisorState: SupervisorState = "BOOT";
  let previousHandshake = "IDLE";
  let receivedTension: Received<TensionWireStatus> | null = null;
  const receivedStatuses: Partial<Record<WinchNodeId, Received<WinchWireStatus>>> = {};
  const deliveredWinchCommands = makeInitialWinchCommands(config);
  const tensionControllers = Object.fromEntries(
    WINCH_IDS.map((node) => [
      node,
      new WinchTensionController(config.controller.tension, config.net)
    ])
  ) as Record<WinchNodeId, WinchTensionController>;
  const standbyActiveDampingNspm = Math.min(
    config.net.activeDampingMaxNspm,
    Math.max(config.net.activeDampingMinNspm, config.net.totalDampingNspm / 5)
  ) * (config.controller.algorithm === "mpc" ? MPC_ACTIVE_DAMPING_SCALE : 1);
  let tensionControllerOutputs = WINCH_IDS.map(() => ({
    desiredDampingNspm: standbyActiveDampingNspm,
    integralErrorNs: 0,
    saturated: false
  }));
  let heldPlantInput: PlantStepInput = createNeutralPlantInput(config);
  let nextFrameTimeS = 0;
  let finalSnapshot: SimulationSnapshot | null = null;
  const previousFaultState = new Map<string, boolean>();
  const reportFaultTransition = (
    tick: number,
    key: string,
    active: boolean,
    label: string
  ): void => {
    const previous = previousFaultState.get(key) ?? false;
    if (active === previous) return;
    previousFaultState.set(key, active);
    event(
      tick,
      active ? "FAULT_INJECTED" : "FAULT_CLEARED",
      active ? "warning" : "info",
      `${label}${active ? "开始" : "结束"}`
    );
  };

  const snapshotForCurrentStep = (
    snapshotMetrics: ReturnType<typeof currentMetrics>
  ): SimulationSnapshot => {
    if (rocketEstimate === null || groundEstimate === null) {
      throw new Error("cannot record a snapshot before estimators initialize");
    }
    return {
      runId,
      tick: plantState.tick,
      timeS: plantState.timeS,
      rocket: structuredClone(plantState.rocket),
      platform: structuredClone(plantState.platform),
      net: structuredClone(plantState.net),
      rocketEstimate: cloneEstimate(rocketEstimate, "rocket-nav"),
      groundEstimate: cloneEstimate(groundEstimate),
      capturePlan: coordinatorOutput?.plan === null || coordinatorOutput === null
        ? null
        : structuredClone(coordinatorOutput.plan),
      control: structuredClone(heldPlantInput.rocketControl),
      controlDiagnostics: {
        desiredNetCenterM: coordinatorOutput?.desiredNetCenterM ?? [...plantState.net.centerM],
        desiredHalfSpacingM: coordinatorOutput?.desiredHalfSpacingM ?? [...plantState.net.halfSpacingM],
        reachabilityMarginS: coordinatorOutput?.reachabilityMarginS ?? 0,
        commitMarginS: coordinatorOutput?.plan === null || coordinatorOutput === null
          ? 0
          : (coordinatorOutput.plan.commitDeadlineTick - plantState.tick) * dtS,
        readiness: coordinatorOutput?.readiness ?? {
          vehicle: false,
          winches: Object.fromEntries(WINCH_IDS.map((node) => [node, false])) as Record<WinchNodeId, boolean>,
          all: false
        },
        desiredTensionsN: [...plantState.net.desiredTensionsN],
        actualTensionsN: [...plantState.net.tensionsN],
        tensionErrorsN: plantState.net.desiredTensionsN.map(
          (desired, index) => desired - (plantState.net.tensionsN[index] ?? 0)
        ) as [number, number, number, number],
        tensionIntegralErrorsNs: tensionControllerOutputs.map(
          (output) => output.integralErrorNs
        ) as [number, number, number, number],
        tensionSaturated: tensionControllerOutputs.map(
          (output) => output.saturated
        ) as [boolean, boolean, boolean, boolean],
        mpc: coordinatorOutput?.mpcDiagnostics ?? null,
        mpcFallbackCount: coordinatorOutput?.mpcFallbackCount ?? 0,
        mpcFallbackReasons: coordinatorOutput?.mpcFallbackReasons ?? {
          "stale-input": 0,
          "strength-proxy": 0,
          "non-finite": 0,
          "not-converged": 0
        }
      },
      supervisorState: coordinatorOutput?.state ?? "BOOT",
      radioStats: boundedNetworkStats(radio),
      fieldbusStats: boundedNetworkStats(fieldbus),
      metrics: snapshotMetrics,
      latestEvents: events.slice(-8).map((entry) => ({ ...entry }))
    };
  };

  for (let tick = 0; tick < maximumTick; tick += 1) {
    const timeS = tick * dtS;
    reportFaultTransition(tick, "radio", windowActive(timeS, config.faults.radioBlackout), "无线静默窗口");
    reportFaultTransition(tick, "winch", windowActive(timeS, config.faults.winchStuck), `${config.faults.winchStuck.node} 卡滞`);
    reportFaultTransition(tick, "sensor", windowActive(timeS, config.faults.sensorBiasStep), "箭上导航偏置阶跃");
    reportFaultTransition(tick, "thrust", windowActive(timeS, config.faults.thrustScale), "推力降额");
    if (tick % sensorTicks === 0) {
      const activeSensorConfig = sensorConfigAt(config, timeS);
      rocketEstimate = cloneEstimate(
        rocketEstimator.update(sampleRocketNavigation(tick, plantState.rocket, activeSensorConfig, rocketSensorRng)),
        "rocket-nav"
      );
      groundEstimate = groundEstimator.update(
        sampleGroundTracking(tick, plantState.rocket, activeSensorConfig, groundSensorRng)
      );
      platformEstimate = platformEstimator.update(
        sampleGroundTracking(tick, plantState.platform, activeSensorConfig, platformSensorRng)
      );
      attitudeFrame = sampleAttitudeSensors(plantState);
    }
    if (rocketEstimate === null || groundEstimate === null || platformEstimate === null) {
      throw new Error("estimators were not initialized at tick zero");
    }

    for (const packet of radio.advanceTo(tick)) {
      if (packet.header.destination === "coordinator") {
        if (packet.header.type === "VEHICLE_STATE") {
          latestVehicleAtCoordinator = structuredClone(packet.payload as VehicleStatePayload);
          latestVehicleDeliveryTick = tick;
        } else if (packet.header.type === "CAPTURE_READY" && latestVehicleAtCoordinator !== null) {
          const readiness = packet.payload as CaptureReadyPayload;
          latestVehicleAtCoordinator.captureReady = readiness.ready;
          latestVehicleAtCoordinator.acknowledgedWindowId = readiness.windowId;
          latestVehicleAtCoordinator.acknowledgedPlanRevision = readiness.planRevision;
          latestVehicleDeliveryTick = tick;
        }
      } else if (packet.header.destination === "rocket") {
        if (packet.header.type === "CAPTURE_PLAN" || packet.header.type === "COMMIT") {
          planAtRocket = structuredClone(packet.payload as CapturePlanPayload);
          mpcGuidanceAtRocket = [...planAtRocket.rocketLateralAccelerationReferenceMps2];
          abortReceivedAtRocket = false;
        } else if (packet.header.type === "GUIDANCE_UPDATE") {
          const update = packet.payload as GuidanceUpdatePayload;
          if (
            planAtRocket !== null &&
            update.windowId === planAtRocket.windowId &&
            update.planRevision === planAtRocket.planRevision &&
            tick <= update.validUntilTick
          ) {
            mpcGuidanceAtRocket = [...update.lateralAccelerationReferenceMps2];
          }
        } else if (packet.header.type === "ABORT") {
          abortReceivedAtRocket = true;
        }
      }
    }

    for (const packet of fieldbus.advanceTo(tick)) {
      if (packet.header.destination === "coordinator") {
        if (packet.header.type === "WINCH_STATUS" && WINCH_IDS.includes(packet.header.source as WinchNodeId)) {
          receivedStatuses[packet.header.source as WinchNodeId] = {
            payload: structuredClone(packet.payload as WinchWireStatus),
            receivedTick: tick
          };
        } else if (packet.header.type === "TENSION_STATUS") {
          receivedTension = {
            payload: structuredClone(packet.payload as TensionWireStatus),
            receivedTick: tick
          };
        }
      } else if (
        packet.header.source === "coordinator" &&
        WINCH_IDS.includes(packet.header.destination as WinchNodeId) &&
        packet.header.type === "WINCH_COMMAND"
      ) {
        deliveredWinchCommands[packet.header.destination as WinchNodeId] =
          structuredClone(packet.payload as WinchWireCommand);
      }
    }

    const agreedPlanAtRocket = planAtRocket !== null &&
      tick >= planAtRocket.validFromTick &&
      tick <= planAtRocket.validUntilTick &&
      ["SYNC", "ARMED", "CLOSING", "CONTACT", "ARREST", "SECURED"].includes(
        planAtRocket.supervisorState
      )
      ? planAtRocket
      : null;
    // Before PREPARE the plan is only a diagnostic extrapolation and can be
    // noisy. It must not move the flight target. The mission-frame deck plane
    // is known a priori; an agreed plan may then refine its predicted height.
    const capturePlaneWorldZ = agreedPlanAtRocket?.capturePlaneZ ??
      config.platform.capturePlaneZ;
    const captureReady = agreedPlanAtRocket !== null &&
      !abortReceivedAtRocket &&
      norm3(agreedPlanAtRocket.predictedRelativeInterceptVelocityMps) <=
        config.controller.maxCaptureSpeedMps &&
      agreedPlanAtRocket.confidenceRadiusM + config.controller.requiredApertureMarginM <
        config.net.openHalfSpacingM - config.rocket.radiusM;

    const radioSuppressed = blackoutActive(tick, dtS, simulationFaults);
    if (tick % telemetryTicks === 0 && !radioSuppressed) {
      const rocketMode = rocketModeFor(
        rocketEstimate.positionM[2] - capturePlaneWorldZ,
        captureReady,
        false,
        abortReceivedAtRocket,
        coordinatorOutput?.state ?? "BOOT"
      );
      const vehiclePayload: VehicleStatePayload = {
        estimate: cloneEstimate(rocketEstimate, "rocket-nav"),
        attitudeWxyz: [...attitudeFrame.attitudeWxyz],
        angularVelocityRadps: [...attitudeFrame.angularVelocityRadps],
        rocketMode,
        captureReady,
        acknowledgedWindowId: captureReady ? agreedPlanAtRocket?.windowId ?? null : null,
        acknowledgedPlanRevision: captureReady ? agreedPlanAtRocket?.planRevision ?? null : null,
        healthFlags: 0
      };
      send(
        radio,
        radioSequence,
        "rocket",
        "coordinator",
        "VEHICLE_STATE",
        tick,
        radioTtlTicks,
        vehiclePayload
      );
    }
    if (
      captureReady &&
      agreedPlanAtRocket !== null &&
      readyAnnouncedPlanKey !== `${agreedPlanAtRocket.windowId}:${agreedPlanAtRocket.planRevision}` &&
      !radioSuppressed
    ) {
      const positionMarginM = config.net.openHalfSpacingM - config.rocket.radiusM -
        config.controller.requiredApertureMarginM - agreedPlanAtRocket.confidenceRadiusM;
      const speedMarginMps = config.controller.maxCaptureSpeedMps -
        norm3(agreedPlanAtRocket.predictedRelativeInterceptVelocityMps);
      const attitudeMarginRad = config.controller.maxCaptureTiltRad -
        Math.hypot(attitudeFrame.attitudeWxyz[1], attitudeFrame.attitudeWxyz[2]) * 2;
      const readyPayload: CaptureReadyPayload = {
        windowId: agreedPlanAtRocket.windowId,
        planRevision: agreedPlanAtRocket.planRevision,
        ready: true,
        reason: "ready",
        evaluatedTick: tick,
        positionMarginM,
        speedMarginMps,
        attitudeMarginRad,
        controlAuthorityMarginMps2: config.rocket.lateralAccelerationLimitMps2
      };
      send(
        radio,
        radioSequence,
        "rocket",
        "coordinator",
        "CAPTURE_READY",
        tick,
        radioTtlTicks,
        readyPayload
      );
      readyAnnouncedPlanKey = `${agreedPlanAtRocket.windowId}:${agreedPlanAtRocket.planRevision}`;
      event(
        tick,
        "CAPTURE_READY",
        "info",
        `火箭确认窗口 ${readyAnnouncedPlanKey}，速度裕度 ${speedMarginMps.toFixed(2)} m/s`
      );
    }

    if (tick % netControlTicks === 0) {
      for (const node of WINCH_IDS) {
        const axis = axisStateFor(plantState, node);
        const acknowledgedCommand = deliveredWinchCommands[node];
        const remainingTravelM = Math.abs(
          acknowledgedCommand.captureTargetPositionM - axis.positionM
        );
        const arrivalDurationS = Math.max(
          remainingTravelM / Math.max(1e-9, config.net.winchMaxSpeedMps),
          Math.sqrt(2 * remainingTravelM / Math.max(1e-9, config.net.winchMaxAccelerationMps2))
        );
        const estimatedArrivalTick = tick + Math.ceil(arrivalDurationS / dtS);
        const planKnown = acknowledgedCommand.windowId > 0;
        const deadlineReachable = planKnown && tick <= acknowledgedCommand.commitDeadlineTick &&
          estimatedArrivalTick <= acknowledgedCommand.captureTargetTick;
        const winchReady = planKnown && !axis.stuck && deadlineReachable;
        const status: WinchWireStatus = {
          sampledTick: tick,
          positionM: axis.positionM,
          velocityMps: axis.velocityMps,
          tensionN: plantState.net.tensionsN[winchAxisIndex[node]],
          stuck: axis.stuck,
          readyWindowId: planKnown ? acknowledgedCommand.windowId : null,
          readyPlanRevision: planKnown ? acknowledgedCommand.planRevision : null,
          ready: winchReady,
          estimatedArrivalTick: planKnown ? estimatedArrivalTick : null,
          readinessReason: axis.stuck
            ? "actuator-unavailable"
            : deadlineReachable
              ? "ready"
              : "deadline-unreachable"
        };
        send(
          fieldbus,
          fieldbusSequence,
          node,
          "coordinator",
          "WINCH_STATUS",
          tick,
          fieldbusTtlTicks,
          status
        );
      }
      const tensionStatus: TensionWireStatus = {
        sampledTick: tick,
        tensionsN: [...plantState.net.tensionsN],
        payoutM: plantState.net.payoutM,
        payoutVelocityMps: plantState.net.payoutVelocityMps,
        contactDetected: ["latched", "arresting", "secured"].includes(plantState.net.mode),
        broken: plantState.net.mode === "broken",
        secured: plantState.net.mode === "secured"
      };
      send(
        fieldbus,
        fieldbusSequence,
        "winch-x-negative",
        "coordinator",
        "TENSION_STATUS",
        tick,
        fieldbusTtlTicks,
        tensionStatus
      );

      coordinatorOutput = coordinator.step({
        tick,
        vehicleState: latestVehicleAtCoordinator,
        groundVehicleEstimate: groundEstimate,
        platformEstimate,
        net: receivedWinchFeedback(tick, config, receivedStatuses, receivedTension)
      });
      const currentPlanKey = coordinatorOutput.plan === null
        ? ""
        : `${coordinatorOutput.plan.windowId}:${coordinatorOutput.plan.planRevision}`;
      if (coordinatorOutput.readiness.all && currentPlanKey !== coordinatorReadyPlanKey) {
        coordinatorReadyPlanKey = currentPlanKey;
        event(tick, "CAPTURE_READY", "info", `协调器收齐窗口 ${currentPlanKey} 的五方就绪确认`);
        allReadyTick ??= tick;
      }
      if (coordinatorOutput.mpcSolveCount > observedMpcSolveCount) {
        observedMpcSolveCount = coordinatorOutput.mpcSolveCount;
        constraintActivationCount +=
          coordinatorOutput.mpcDiagnostics?.constraintActivations ?? 0;
      }
      if (coordinatorOutput.state !== previousSupervisorState) {
        const severity: DomainEvent["severity"] = coordinatorOutput.state === "SECURED"
          ? "success"
          : ["ABORT", "MISSED", "BROKEN"].includes(coordinatorOutput.state)
            ? "error"
            : "info";
        event(
          tick,
          "SUPERVISOR_TRANSITION",
          severity,
          `${previousSupervisorState} → ${coordinatorOutput.state}`
        );
        previousSupervisorState = coordinatorOutput.state;
        if (coordinatorOutput.state === "SYNC") prepareStartedTick = tick;
      }

      const requestedMode = netModeForSupervisor(coordinatorOutput.state);
      for (const node of WINCH_IDS) {
        const wireCommand: WinchWireCommand = {
          ...coordinatorOutput.winchCommands[node],
          requestedMode
        };
        send(
          fieldbus,
          fieldbusSequence,
          "coordinator",
          node,
          "WINCH_COMMAND",
          tick,
          fieldbusTtlTicks,
          wireCommand
        );
      }

      const handshakeChanged = coordinatorOutput.handshakePhase !== previousHandshake;
      if (
        coordinatorOutput.plan !== null &&
        !radioSuppressed &&
        (tick % telemetryTicks === 0 || handshakeChanged)
      ) {
        const type = coordinatorOutput.handshakePhase === "COMMIT"
          ? "COMMIT"
          : coordinatorOutput.handshakePhase === "ABORT"
            ? "ABORT"
            : "CAPTURE_PLAN";
        send(
          radio,
          radioSequence,
          "coordinator",
          "rocket",
          type,
          tick,
          radioTtlTicks,
          coordinatorOutput.plan
        );
      }
      if (
        config.controller.algorithm === "mpc" &&
        coordinatorOutput.plan !== null &&
        coordinatorOutput.handshakePhase === "COMMIT" &&
        tick % telemetryTicks === 0 &&
        !radioSuppressed
      ) {
        const guidanceUpdate: GuidanceUpdatePayload = {
          windowId: coordinatorOutput.plan.windowId,
          planRevision: coordinatorOutput.plan.planRevision,
          producedTick: tick,
          validUntilTick: tick + radioTtlTicks,
          lateralAccelerationReferenceMps2:
            [...coordinatorOutput.mpcRocketAccelerationReferenceMps2]
        };
        send(
          radio,
          radioSequence,
          "coordinator",
          "rocket",
          "GUIDANCE_UPDATE",
          tick,
          radioTtlTicks,
          guidanceUpdate
        );
      }
      previousHandshake = coordinatorOutput.handshakePhase;
    }

    if (tick % controlTicks === 0) {
      const altitudeAbovePlaneM = rocketEstimate.positionM[2] - capturePlaneWorldZ;
      const verticalVelocityReferenceMps = computeVerticalVelocityReference(
        rocketEstimate,
        capturePlaneWorldZ,
        {
          captureDescentSpeedMps: options.guidance?.captureDescentSpeedMps ??
            config.controller.guidance.captureDescentSpeedMps,
          maximumDescentSpeedMps: options.guidance?.maximumDescentSpeedMps ??
            config.controller.guidance.maximumDescentSpeedMps,
          // Chosen so the calibrated 891 m / -58 m/s case reaches roughly
          // 6 m/s at the capture plane; it is a study setting, not flight data.
          brakingAccelerationMps2: options.guidance?.brakingAccelerationMps2 ??
            config.controller.guidance.brakingAccelerationMps2
        }
      );
      const engineCutoffHeightM = options.guidance?.engineCutoffHeightM ??
        config.controller.guidance.engineCutoffHeightM;
      const committed = coordinatorOutput?.handshakePhase === "COMMIT";
      const engineCutoff = committed && altitudeAbovePlaneM <= engineCutoffHeightM;
      const engineEnabled = !engineCutoff &&
        !["CONTACT", "ARREST", "SECURED"].includes(coordinatorOutput?.state ?? "BOOT");
      // Both endpoints converge on the frozen relative capture centre after
      // PREPARE. Before that, the rocket follows the nominal mission-frame
      // deck centre while the coordinator only observes and predicts.
      const targetPositionM: Vec3 = agreedPlanAtRocket === null
        ? [0, 0, capturePlaneWorldZ]
        : [agreedPlanAtRocket.centerM[0], agreedPlanAtRocket.centerM[1], capturePlaneWorldZ];
      const targetVelocityMps: Vec3 = [
        platformEstimate.velocityMps[0],
        platformEstimate.velocityMps[1],
        verticalVelocityReferenceMps
      ];
      const command: ControlCommand = rocketController.compute({
        estimate: rocketEstimate,
        attitudeWxyz: attitudeFrame.attitudeWxyz,
        angularVelocityRadps: attitudeFrame.angularVelocityRadps,
        targetPositionM,
        targetVelocityMps,
        verticalVelocityReferenceMps,
        lateralAccelerationFeedforwardMps2:
          config.controller.algorithm === "mpc" && agreedPlanAtRocket !== null
            ? mpcGuidanceAtRocket
            : [0, 0],
        engineEnabled
      });
      if (windowActive(timeS, config.faults.thrustScale)) {
        command.desiredThrustN *= config.faults.thrustScale.scale;
      }
      const requestedRocketMode = rocketModeFor(
        altitudeAbovePlaneM,
        captureReady,
        engineCutoff,
        abortReceivedAtRocket,
        coordinatorOutput?.state ?? "BOOT"
      );
      tensionControllerOutputs = WINCH_IDS.map((node, index) => {
        const wireCommand = deliveredWinchCommands[node];
        const controller = tensionControllers[node];
        if (
          wireCommand.controlMode === "tension" &&
          plantState.net.mode !== "broken" &&
          plantState.net.mode !== "missed"
        ) {
          return controller.update(
            wireCommand.desiredTensionN,
            plantState.net.tensionsN[index] ?? 0,
            1 / config.controller.controlRateHz,
            standbyActiveDampingNspm
          );
        }
        controller.reset();
        return {
          desiredDampingNspm: standbyActiveDampingNspm,
          integralErrorNs: 0,
          saturated: false
        };
      });
      heldPlantInput = {
        rocketControl: command,
        netCommand: {
          desiredAxisPositionsM: axisPositionsFromCommands(deliveredWinchCommands),
          targetTotalTensionN: WINCH_IDS.reduce(
            (sum, node) => sum + deliveredWinchCommands[node].desiredTensionN,
            0
          ),
          desiredTensionsN: WINCH_IDS.map(
            (node) => deliveredWinchCommands[node].desiredTensionN
          ) as WinchAxisValues<number>,
          desiredActiveDampingNspm: tensionControllerOutputs.map(
            (output) => output.desiredDampingNspm
          ) as WinchAxisValues<number>,
          tensionControllerSaturated: tensionControllerOutputs.map(
            (output) => output.saturated
          ) as WinchAxisValues<boolean>,
          requestedMode: deliveredWinchCommands["winch-x-negative"].requestedMode
        },
        requestedRocketMode
      };
    }
    heldPlantInput.winchStuck = activeWinchFaults(tick, dtS, simulationFaults);

    plantState = plant.step(heldPlantInput);
    if (["latched", "arresting", "secured"].includes(plantState.net.mode)) {
      for (let index = 0; index < plantState.net.tensionsN.length; index += 1) {
        const errorN = (plantState.net.desiredTensionsN[index] ?? 0) -
          (plantState.net.tensionsN[index] ?? 0);
        tensionErrorSquaredSum += errorN * errorN;
        tensionErrorSampleCount += 1;
      }
    }
    accumulateContactEnergy(energyLedger, plantState, dtS);
    const metrics = metricsAccumulator.update(
      plantState,
      rocketEstimate,
      config.environment.gravityMps2
    );
    if (plantState.capturedThisStep) {
      predictionTimeErrorS = coordinatorOutput?.plan === null || coordinatorOutput === null
        ? 0
        : (coordinatorOutput.plan.predictedInterceptTick - plantState.tick) * dtS;
      capturePlaneCenterErrorM = Math.hypot(...plantState.capture.centerOffsetM);
      event(plantState.tick, "CAPTURE", "success", "等效挂索点进入闭合网口并建立接触");
    }
    if (plantState.missedThisStep) {
      event(
        plantState.tick,
        "CAPTURE_MISSED",
        "error",
        `捕获失败：${plantState.capture.rejectionReason ?? "unknown"}`
      );
    }
    if (plantState.ropeBrokenThisStep) {
      event(
        plantState.tick,
        "ROPE_BROKEN",
        "error",
        `等效绳失效：${plantState.failureReason ?? "unknown"}`
      );
    }
    if (plantState.securedThisStep) {
      event(plantState.tick, "SECURED", "success", "等效载荷进入稳定驻留判据");
    }

    const radioAgeMs = latestVehicleDeliveryTick < 0
      ? Number.POSITIVE_INFINITY
      : (tick - latestVehicleDeliveryTick) * dtS * 1_000;
    if (plantState.tick % telemetryTicks === 0 || plantState.tick === 1) {
      telemetry.push(telemetryFor(
        plantState,
        rocketEstimate,
        coordinatorOutput?.plan ?? null,
        coordinatorOutput?.state ?? "BOOT",
        radioAgeMs,
        config.environment.gravityMps2,
        coordinatorOutput
      ));
    }

    if (plantState.timeS + 1e-12 >= nextFrameTimeS) {
      const snapshot = snapshotForCurrentStep(currentMetrics(metricsAccumulator, coordinatorOutput));
      frames.push(snapshot);
      finalSnapshot = snapshot;
      nextFrameTimeS += 1 / frameRateHz;
    }

    const supervisorTerminal = coordinatorOutput !== null &&
      terminalSupervisorStates.has(coordinatorOutput.state);
    const physicalTerminalReady = coordinatorOutput?.state !== "SECURED" || metrics.secured;
    if (options.stopOnTerminal === true && supervisorTerminal && physicalTerminalReady) {
      const terminalSnapshot = snapshotForCurrentStep(currentMetrics(metricsAccumulator, coordinatorOutput));
      if (frames.at(-1)?.tick === terminalSnapshot.tick) {
        frames[frames.length - 1] = terminalSnapshot;
      } else {
        frames.push(terminalSnapshot);
      }
      finalSnapshot = terminalSnapshot;
      break;
    }
    void metrics;
  }

  if (finalSnapshot === null) {
    throw new Error("simulation produced no snapshots");
  }
  const finalMetrics = currentMetrics(metricsAccumulator, coordinatorOutput);
  finalMetrics.predictionTimeErrorS = predictionTimeErrorS;
  finalMetrics.capturePlaneCenterErrorM = capturePlaneCenterErrorM;
  finalMetrics.readyRoundTripS = prepareStartedTick === null || allReadyTick === null
    ? 0
    : (allReadyTick - prepareStartedTick) * dtS;
  finalMetrics.tensionRmsErrorN = tensionErrorSampleCount === 0
    ? 0
    : Math.sqrt(tensionErrorSquaredSum / tensionErrorSampleCount);
  finalMetrics.constraintActivationCount = constraintActivationCount;
  finalMetrics.mpcFallbackCount = coordinatorOutput?.mpcFallbackCount ?? 0;
  finalMetrics.mpcFallbackReasons = coordinatorOutput?.mpcFallbackReasons === undefined
    ? { "stale-input": 0, "strength-proxy": 0, "non-finite": 0, "not-converged": 0 }
    : { ...coordinatorOutput.mpcFallbackReasons };
  const exactFinalSnapshot: SimulationSnapshot = {
    runId,
    tick: plantState.tick,
    timeS: plantState.timeS,
    rocket: structuredClone(plantState.rocket),
    platform: structuredClone(plantState.platform),
    net: structuredClone(plantState.net),
    rocketEstimate: cloneEstimate(rocketEstimate!, "rocket-nav"),
    groundEstimate: cloneEstimate(groundEstimate!),
    capturePlan: coordinatorOutput?.plan === null || coordinatorOutput === null
      ? null
      : structuredClone(coordinatorOutput.plan),
    control: structuredClone(heldPlantInput.rocketControl),
    controlDiagnostics: snapshotForCurrentStep(finalMetrics).controlDiagnostics,
    supervisorState: coordinatorOutput?.state ?? "BOOT",
    radioStats: radio.getStats(),
    fieldbusStats: fieldbus.getStats(),
    metrics: finalMetrics,
    latestEvents: events.slice(-8).map((entry) => ({ ...entry }))
  };
  finalSnapshot = exactFinalSnapshot;
  if (frames.at(-1)?.tick === exactFinalSnapshot.tick) {
    frames[frames.length - 1] = exactFinalSnapshot;
  } else {
    frames.push(exactFinalSnapshot);
  }
  event(
    finalSnapshot.tick,
    "SIMULATION_FINISHED",
    finalMetrics.secured ? "success" : finalMetrics.failed ? "error" : "warning",
    finalMetrics.secured
      ? "仿真结束：已捕获并稳定"
      : `仿真结束：${finalMetrics.failureReason ?? "未在时限内稳定"}`
  );
  finalSnapshot = {
    ...finalSnapshot,
    latestEvents: events.slice(-8).map((entry) => ({ ...entry }))
  };
  frames[frames.length - 1] = finalSnapshot;

  if (!energyLedger.contactDetected) {
    energyLedger.endTick = finalSnapshot.tick;
    energyLedger.endTimeS = finalSnapshot.timeS;
  }

  return {
    modelVersion: SIMULATION_MODEL_VERSION,
    configFingerprint,
    config,
    frames,
    telemetry,
    events,
    energyLedger: structuredClone(energyLedger),
    finalSnapshot,
    metrics: finalMetrics
  };
};
