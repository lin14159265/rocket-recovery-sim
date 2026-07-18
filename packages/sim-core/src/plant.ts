import type {
  AxisActuatorState,
  CaptureMode,
  ControlCommand,
  NetTruthState,
  PlatformTruthState,
  RocketMode,
  RocketTruthState,
  ScenarioConfig,
  Vec3
} from "./contracts";
import { DeterministicRng } from "./engine/rng";
import {
  add3,
  clamp,
  clampMagnitude3,
  cross3,
  dot3,
  integrateQuaternion,
  norm3,
  quatRotate,
  scale3,
  sub3,
  tiltFromVertical
} from "./math";

export type WinchAxisValues<T> = [T, T, T, T];

export const WINCH_AXIS_ORDER = [
  "xNegative",
  "xPositive",
  "yNegative",
  "yPositive"
] as const;

export type PreContactNetMode = Extract<CaptureMode, "open" | "tracking" | "closing">;

/** Commands delivered to the four physical winch actuators for one physics tick. */
export interface PlantNetCommand {
  /** Absolute positions in platform coordinates, ordered per {@link WINCH_AXIS_ORDER}. */
  desiredAxisPositionsM: WinchAxisValues<number>;
  /** Total demand retained for supervisory diagnostics. */
  targetTotalTensionN: number;
  /** Per-rope demand tracked by the local tension loops. */
  desiredTensionsN: WinchAxisValues<number>;
  /** Per-rope active damping commands; the plant rate-limits these actuator states. */
  desiredActiveDampingNspm: WinchAxisValues<number>;
  tensionControllerSaturated: WinchAxisValues<boolean>;
  requestedMode: PreContactNetMode;
}

/** Inputs held constant for exactly one fixed-size physics tick. */
export interface PlantStepInput {
  rocketControl: ControlCommand;
  netCommand: PlantNetCommand;
  /** A true entry freezes that winch in place.  Omitted entries retain their previous fault state. */
  winchStuck?: WinchAxisValues<boolean>;
  /** Optional supervisory label; capture and break transitions still take precedence. */
  requestedRocketMode?: RocketMode;
}

export type CaptureRejectionReason =
  | "net-not-closing"
  | "net-not-closed"
  | "outside-aperture"
  | "relative-speed-too-high"
  | "tilt-too-high";

export interface CaptureEvaluation {
  attempted: boolean;
  captured: boolean;
  rejectionReason: CaptureRejectionReason | null;
  centerOffsetM: [number, number];
  missDistanceM: number;
  relativeSpeedMps: number;
  tiltRad: number;
}

export interface PlantAppliedForces {
  gravityN: Vec3;
  thrustN: Vec3;
  aerodynamicDragN: Vec3;
  contactN: Vec3;
  totalN: Vec3;
}

/** Per-physics-tick work terms used to build the validation ledger. */
export interface PlantStepEnergy {
  contactActive: boolean;
  translationalKineticBeforeJ: number;
  translationalKineticAfterJ: number;
  relativeKineticBeforeJ: number;
  relativeKineticAfterJ: number;
  rotationalKineticBeforeJ: number;
  rotationalKineticAfterJ: number;
  gravitationalPotentialBeforeJ: number;
  gravitationalPotentialAfterJ: number;
  gravityWorkJ: number;
  thrustWorkJ: number;
  aerodynamicWorkJ: number;
  contactWorkOnRocketJ: number;
  controlTorqueWorkJ: number;
  relativeContactWorkExtractedJ: number;
  platformBoundaryWorkJ: number;
  contactDampingDissipationJ: number;
  elasticStorageBeforeJ: number;
  elasticStorageAfterJ: number;
}

/** Truth and transition information after one fixed-size physics tick. */
export interface PlantStepResult {
  tick: number;
  timeS: number;
  rocket: RocketTruthState;
  platform: PlatformTruthState;
  net: NetTruthState;
  gustMps: Vec3;
  windMps: Vec3;
  forces: PlantAppliedForces;
  energy: PlantStepEnergy;
  capture: CaptureEvaluation;
  capturedThisStep: boolean;
  missedThisStep: boolean;
  ropeBrokenThisStep: boolean;
  securedThisStep: boolean;
  failureReason: "strength-limit-exceeded" | "arrest-distance-exceeded" | null;
}

interface PlatformMotion extends PlatformTruthState {
  rollRateRadps: number;
  pitchRateRadps: number;
}

interface LocalKinematics {
  positionM: Vec3;
  velocityMps: Vec3;
}

interface ContactComputation {
  forceLocalN: Vec3;
  forceWorldN: Vec3;
  tensionsN: WinchAxisValues<number>;
  payoutM: number;
  payoutVelocityMps: number;
  totalTensionN: number;
  overtravel: boolean;
}

const NO_CAPTURE: CaptureEvaluation = {
  attempted: false,
  captured: false,
  rejectionReason: null,
  centerOffsetM: [0, 0],
  missDistanceM: 0,
  relativeSpeedMps: 0,
  tiltRad: 0
};

const ZERO_FORCES: PlantAppliedForces = {
  gravityN: [0, 0, 0],
  thrustN: [0, 0, 0],
  aerodynamicDragN: [0, 0, 0],
  contactN: [0, 0, 0],
  totalN: [0, 0, 0]
};

const ZERO_ENERGY: PlantStepEnergy = {
  contactActive: false,
  translationalKineticBeforeJ: 0,
  translationalKineticAfterJ: 0,
  relativeKineticBeforeJ: 0,
  relativeKineticAfterJ: 0,
  rotationalKineticBeforeJ: 0,
  rotationalKineticAfterJ: 0,
  gravitationalPotentialBeforeJ: 0,
  gravitationalPotentialAfterJ: 0,
  gravityWorkJ: 0,
  thrustWorkJ: 0,
  aerodynamicWorkJ: 0,
  contactWorkOnRocketJ: 0,
  controlTorqueWorkJ: 0,
  relativeContactWorkExtractedJ: 0,
  platformBoundaryWorkJ: 0,
  contactDampingDissipationJ: 0,
  elasticStorageBeforeJ: 0,
  elasticStorageAfterJ: 0
};

const cloneAxis = (axis: AxisActuatorState): AxisActuatorState => ({ ...axis });

const cloneRocket = (rocket: RocketTruthState): RocketTruthState => ({
  ...rocket,
  positionM: [...rocket.positionM],
  velocityMps: [...rocket.velocityMps],
  attitudeWxyz: [...rocket.attitudeWxyz],
  angularVelocityRadps: [...rocket.angularVelocityRadps],
  actualTorqueNm: [...rocket.actualTorqueNm]
});

const clonePlatform = (platform: PlatformTruthState): PlatformTruthState => ({
  ...platform,
  positionM: [...platform.positionM],
  velocityMps: [...platform.velocityMps]
});

const cloneNet = (net: NetTruthState): NetTruthState => ({
  ...net,
  xNegative: cloneAxis(net.xNegative),
  xPositive: cloneAxis(net.xPositive),
  yNegative: cloneAxis(net.yNegative),
  yPositive: cloneAxis(net.yPositive),
  centerM: [...net.centerM],
  halfSpacingM: [...net.halfSpacingM],
  tensionsN: [...net.tensionsN],
  totalContactForceN: [...net.totalContactForceN],
  desiredTensionsN: [...net.desiredTensionsN],
  activeDampingNspm: [...net.activeDampingNspm],
  tensionControllerSaturated: [...net.tensionControllerSaturated]
});

const cloneCapture = (capture: CaptureEvaluation): CaptureEvaluation => ({
  ...capture,
  centerOffsetM: [...capture.centerOffsetM]
});

const cloneForces = (forces: PlantAppliedForces): PlantAppliedForces => ({
  gravityN: [...forces.gravityN],
  thrustN: [...forces.thrustN],
  aerodynamicDragN: [...forces.aerodynamicDragN],
  contactN: [...forces.contactN],
  totalN: [...forces.totalN]
});

const firstOrder = (current: number, target: number, timeConstantS: number, dtS: number): number => {
  if (timeConstantS <= 0) return target;
  return current + (target - current) * (1 - Math.exp(-dtS / timeConstantS));
};

const finiteVector = (name: string, value: readonly number[]): void => {
  if (value.some((entry) => !Number.isFinite(entry))) {
    throw new RangeError(`${name} must contain only finite values`);
  }
};

const rotatePlatformToWorld = (value: Vec3, rollRad: number, pitchRad: number): Vec3 => {
  const cosineRoll = Math.cos(rollRad);
  const sineRoll = Math.sin(rollRad);
  const cosinePitch = Math.cos(pitchRad);
  const sinePitch = Math.sin(pitchRad);

  const afterRoll: Vec3 = [
    value[0],
    cosineRoll * value[1] - sineRoll * value[2],
    sineRoll * value[1] + cosineRoll * value[2]
  ];
  return [
    cosinePitch * afterRoll[0] + sinePitch * afterRoll[2],
    afterRoll[1],
    -sinePitch * afterRoll[0] + cosinePitch * afterRoll[2]
  ];
};

const rotateWorldToPlatform = (value: Vec3, rollRad: number, pitchRad: number): Vec3 => {
  const cosineRoll = Math.cos(rollRad);
  const sineRoll = Math.sin(rollRad);
  const cosinePitch = Math.cos(pitchRad);
  const sinePitch = Math.sin(pitchRad);

  const afterPitchInverse: Vec3 = [
    cosinePitch * value[0] - sinePitch * value[2],
    value[1],
    sinePitch * value[0] + cosinePitch * value[2]
  ];
  return [
    afterPitchInverse[0],
    cosineRoll * afterPitchInverse[1] + sineRoll * afterPitchInverse[2],
    -sineRoll * afterPitchInverse[1] + cosineRoll * afterPitchInverse[2]
  ];
};

const makeAxis = (positionM: number): AxisActuatorState => ({
  positionM,
  velocityMps: 0,
  desiredPositionM: positionM,
  appliedAccelerationMps2: 0,
  stuck: false
});

const zeroContact = (): ContactComputation => ({
  forceLocalN: [0, 0, 0],
  forceWorldN: [0, 0, 0],
  tensionsN: [0, 0, 0, 0],
  payoutM: 0,
  payoutVelocityMps: 0,
  totalTensionN: 0,
  overtravel: false
});

/**
 * Deterministic physical plant for the terminal recovery experiment.
 *
 * World +z is upward.  Platform-local x/y follow the deck and the capture
 * plane is `platform.capturePlaneZ` above the platform origin.  The rocket
 * position is both the rigid-body centre and the equivalent capture point in
 * this first-order proxy model.
 */
export class RecoveryPlant {
  private readonly config: ScenarioConfig;
  private readonly rng: DeterministicRng;
  private tick = 0;
  private rocket: RocketTruthState;
  private platform: PlatformMotion;
  private net: NetTruthState;
  private gustMps: Vec3 = [0, 0, 0];
  private settledTicks = 0;
  private lastResult: PlantStepResult;

  public constructor(config: ScenarioConfig, rng = new DeterministicRng(config.seed)) {
    if (!Number.isFinite(config.physicsDtS) || config.physicsDtS <= 0) {
      throw new RangeError("physicsDtS must be positive and finite");
    }
    if (!Number.isFinite(config.rocket.massKg) || config.rocket.massKg <= 0) {
      throw new RangeError("rocket mass must be positive and finite");
    }
    if (config.rocket.inertiaKgM2.some((entry) => !Number.isFinite(entry) || entry <= 0)) {
      throw new RangeError("rocket inertia components must be positive and finite");
    }
    if (!Number.isFinite(config.platform.wavePeriodS) || config.platform.wavePeriodS <= 0) {
      throw new RangeError("wave period must be positive and finite");
    }

    this.config = structuredClone(config);
    this.rng = rng;
    this.rocket = {
      positionM: [...config.rocket.initialPositionM],
      velocityMps: [...config.rocket.initialVelocityMps],
      attitudeWxyz: [...config.rocket.initialAttitudeWxyz],
      angularVelocityRadps: [...config.rocket.initialAngularVelocityRadps],
      massKg: config.rocket.massKg,
      actualThrustN: 0,
      actualTorqueNm: [0, 0, 0],
      mode: "DESCENT"
    };
    this.platform = this.evaluatePlatform(0);

    const spacing = config.net.openHalfSpacingM;
    const passivePerRopeDamping = clamp(
      config.net.totalDampingNspm / 4,
      config.net.activeDampingMinNspm,
      config.net.activeDampingMaxNspm
    );
    this.net = {
      xNegative: makeAxis(-spacing),
      xPositive: makeAxis(spacing),
      yNegative: makeAxis(-spacing),
      yPositive: makeAxis(spacing),
      centerM: [0, 0],
      halfSpacingM: [spacing, spacing],
      tensionsN: [0, 0, 0, 0],
      totalContactForceN: [0, 0, 0],
      payoutM: 0,
      payoutVelocityMps: 0,
      targetTotalTensionN: 0,
      desiredTensionsN: [0, 0, 0, 0],
      activeDampingNspm: [
        passivePerRopeDamping,
        passivePerRopeDamping,
        passivePerRopeDamping,
        passivePerRopeDamping
      ],
      tensionControllerSaturated: [false, false, false, false],
      mode: "open"
    };

    this.lastResult = this.makeResult(
      NO_CAPTURE,
      ZERO_FORCES,
      ZERO_ENERGY,
      false,
      false,
      false,
      false,
      null
    );
  }

  public get currentTick(): number {
    return this.tick;
  }

  public get currentTimeS(): number {
    return this.tick * this.config.physicsDtS;
  }

  /** Returns a defensive copy of the latest plant result. */
  public getState(): PlantStepResult {
    return this.cloneResult(this.lastResult);
  }

  public step(input: PlantStepInput): PlantStepResult {
    this.validateInput(input);
    const dtS = this.config.physicsDtS;

    this.applyRequestedModes(input);
    this.updateGust(dtS);
    this.updateRocketActuators(input.rocketControl, dtS);
    this.updateWinchActuators(input, dtS);

    const rocketBefore = cloneRocket(this.rocket);
    const platformBefore = { ...clonePlatform(this.platform),
      rollRateRadps: this.platform.rollRateRadps,
      pitchRateRadps: this.platform.pitchRateRadps
    };
    const localBefore = this.toPlatformKinematics(this.rocket, this.platform);
    const contact = this.hasIntactCapture() ? this.computeContact(localBefore) : zeroContact();
    let ropeBrokenThisStep = false;
    let failureReason: PlantStepResult["failureReason"] = null;

    if (this.hasIntactCapture()) {
      if (contact.totalTensionN > this.config.net.totalStrengthLimitN) {
        ropeBrokenThisStep = true;
        failureReason = "strength-limit-exceeded";
      } else if (contact.overtravel) {
        ropeBrokenThisStep = true;
        failureReason = "arrest-distance-exceeded";
      }

      if (ropeBrokenThisStep) {
        this.net.mode = "broken";
        this.rocket.mode = "DIVERT";
        this.settledTicks = 0;
      }
    }

    this.applyContactToNet(contact);
    const forces = this.computeForces(input.rocketControl, contact.forceWorldN);
    const accelerationMps2 = scale3(forces.totalN, 1 / this.rocket.massKg);
    this.integrateRigidBody(accelerationMps2, dtS);

    this.tick += 1;
    const nextPlatform = this.evaluatePlatform(this.currentTimeS);
    const localAfter = this.toPlatformKinematics(this.rocket, nextPlatform);
    const energy = this.computeStepEnergy(
      rocketBefore,
      this.rocket,
      platformBefore,
      nextPlatform,
      localBefore,
      localAfter,
      contact,
      forces,
      dtS
    );

    let capture = NO_CAPTURE;
    let capturedThisStep = false;
    let missedThisStep = false;
    if (this.canAttemptCapture() && this.crossedCapturePlane(localBefore, localAfter)) {
      capture = this.evaluateCapture(localAfter);
      capturedThisStep = capture.captured;
      missedThisStep = !capture.captured;
      if (capturedThisStep) {
        this.net.mode = "latched";
        this.rocket.mode = "CAPTURED";
        this.net.payoutM = 0;
        this.net.payoutVelocityMps = Math.max(0, -localAfter.velocityMps[2]);
      } else {
        this.net.mode = "missed";
      }
    }

    let securedThisStep = false;
    if (!capturedThisStep && this.hasIntactCapture()) {
      if (this.net.mode === "latched") this.net.mode = "arresting";
      securedThisStep = this.updateSteadyState(localAfter, contact, accelerationMps2);
    } else if (!this.hasIntactCapture()) {
      this.settledTicks = 0;
    }

    this.platform = nextPlatform;
    this.lastResult = this.makeResult(
      capture,
      forces,
      energy,
      capturedThisStep,
      missedThisStep,
      ropeBrokenThisStep,
      securedThisStep,
      failureReason
    );
    return this.cloneResult(this.lastResult);
  }

  private computeStepEnergy(
    before: RocketTruthState,
    after: RocketTruthState,
    platformBefore: PlatformMotion,
    platformAfter: PlatformMotion,
    localBefore: LocalKinematics,
    localAfter: LocalKinematics,
    contact: ContactComputation,
    forces: PlantAppliedForces,
    dtS: number
  ): PlantStepEnergy {
    const averageVelocityMps: Vec3 = [
      (before.velocityMps[0] + after.velocityMps[0]) / 2,
      (before.velocityMps[1] + after.velocityMps[1]) / 2,
      (before.velocityMps[2] + after.velocityMps[2]) / 2
    ];
    const averageAngularVelocityRadps: Vec3 = [
      (before.angularVelocityRadps[0] + after.angularVelocityRadps[0]) / 2,
      (before.angularVelocityRadps[1] + after.angularVelocityRadps[1]) / 2,
      (before.angularVelocityRadps[2] + after.angularVelocityRadps[2]) / 2
    ];
    const averageLocalVelocityMps: Vec3 = [
      (localBefore.velocityMps[0] + localAfter.velocityMps[0]) / 2,
      (localBefore.velocityMps[1] + localAfter.velocityMps[1]) / 2,
      (localBefore.velocityMps[2] + localAfter.velocityMps[2]) / 2
    ];
    const translationalKinetic = (rocket: RocketTruthState): number =>
      0.5 * rocket.massKg * dot3(rocket.velocityMps, rocket.velocityMps);
    const rotationalKinetic = (rocket: RocketTruthState): number =>
      0.5 * (
        this.config.rocket.inertiaKgM2[0] * rocket.angularVelocityRadps[0] ** 2 +
        this.config.rocket.inertiaKgM2[1] * rocket.angularVelocityRadps[1] ** 2 +
        this.config.rocket.inertiaKgM2[2] * rocket.angularVelocityRadps[2] ** 2
      );
    const elasticStorage = (local: LocalKinematics): number => {
      const payoutM = Math.max(0, this.config.platform.capturePlaneZ - local.positionM[2]);
      const lateralX = local.positionM[0] - this.net.centerM[0];
      const lateralY = local.positionM[1] - this.net.centerM[1];
      return 0.5 * this.config.net.totalStiffnessNpm * payoutM ** 2 +
        0.5 * this.config.net.lateralStiffnessNpm * (lateralX ** 2 + lateralY ** 2);
    };
    const contactActive = norm3(contact.forceWorldN) > 1e-9 || this.hasIntactCapture();
    const relativeContactWorkExtractedJ = contactActive
      ? -dot3(contact.forceLocalN, averageLocalVelocityMps) * dtS
      : 0;
    const activeVerticalDampingNspm = this.net.activeDampingNspm.reduce(
      (sum, value) => sum + value,
      0
    );
    const verticalDampingJ = contact.forceLocalN[2] > 0
      ? activeVerticalDampingNspm * contact.payoutVelocityMps ** 2 * dtS
      : 0;
    const lateralDampingJ = contactActive
      ? this.config.net.lateralDampingNspm * (
          averageLocalVelocityMps[0] ** 2 + averageLocalVelocityMps[1] ** 2
        ) * dtS
      : 0;
    const contactWorkOnRocketJ = dot3(forces.contactN, averageVelocityMps) * dtS;
    return {
      contactActive,
      translationalKineticBeforeJ: translationalKinetic(before),
      translationalKineticAfterJ: translationalKinetic(after),
      relativeKineticBeforeJ: 0.5 * before.massKg * dot3(localBefore.velocityMps, localBefore.velocityMps),
      relativeKineticAfterJ: 0.5 * after.massKg * dot3(localAfter.velocityMps, localAfter.velocityMps),
      rotationalKineticBeforeJ: rotationalKinetic(before),
      rotationalKineticAfterJ: rotationalKinetic(after),
      gravitationalPotentialBeforeJ:
        before.massKg * this.config.environment.gravityMps2 * before.positionM[2],
      gravitationalPotentialAfterJ:
        after.massKg * this.config.environment.gravityMps2 * after.positionM[2],
      gravityWorkJ: dot3(forces.gravityN, averageVelocityMps) * dtS,
      thrustWorkJ: dot3(forces.thrustN, averageVelocityMps) * dtS,
      aerodynamicWorkJ: dot3(forces.aerodynamicDragN, averageVelocityMps) * dtS,
      contactWorkOnRocketJ,
      controlTorqueWorkJ: dot3(after.actualTorqueNm, averageAngularVelocityRadps) * dtS,
      relativeContactWorkExtractedJ,
      platformBoundaryWorkJ: contactWorkOnRocketJ + relativeContactWorkExtractedJ,
      contactDampingDissipationJ: verticalDampingJ + lateralDampingJ,
      elasticStorageBeforeJ: contactActive ? elasticStorage(localBefore) : 0,
      elasticStorageAfterJ: contactActive ? elasticStorage(localAfter) : 0
    };
  }

  private validateInput(input: PlantStepInput): void {
    finiteVector("desiredAxisPositionsM", input.netCommand.desiredAxisPositionsM);
    finiteVector("desiredTensionsN", input.netCommand.desiredTensionsN);
    finiteVector("desiredActiveDampingNspm", input.netCommand.desiredActiveDampingNspm);
    finiteVector("desiredTorqueNm", input.rocketControl.desiredTorqueNm);
    finiteVector("desiredAccelerationMps2", input.rocketControl.desiredAccelerationMps2);
    finiteVector("desiredAttitudeWxyz", input.rocketControl.desiredAttitudeWxyz);
    if (!Number.isFinite(input.rocketControl.desiredThrustN)) {
      throw new RangeError("desiredThrustN must be finite");
    }
    if (!Number.isFinite(input.netCommand.targetTotalTensionN)) {
      throw new RangeError("targetTotalTensionN must be finite");
    }
  }

  private applyRequestedModes(input: PlantStepInput): void {
    if (this.canAttemptCapture()) this.net.mode = input.netCommand.requestedMode;
    if (input.requestedRocketMode !== undefined && this.canAttemptCapture()) {
      this.rocket.mode = input.requestedRocketMode;
    } else if (!input.rocketControl.engineEnabled && this.canAttemptCapture()) {
      this.rocket.mode = "ENGINE_CUTOFF";
    }
  }

  private updateGust(dtS: number): void {
    const sigma = Math.max(0, this.config.environment.gustSigmaMps);
    const timeConstantS = this.config.environment.gustTimeConstantS;
    if (sigma === 0) {
      this.gustMps = [0, 0, 0];
      return;
    }

    if (timeConstantS <= 0) {
      this.gustMps = [
        this.rng.normal(0, sigma),
        this.rng.normal(0, sigma),
        this.rng.normal(0, sigma * 0.25)
      ];
      return;
    }

    // Exact discrete Ornstein-Uhlenbeck transition.  `sigma` is the stationary
    // standard deviation, so changing the physics step does not change it.
    const decay = Math.exp(-dtS / timeConstantS);
    const innovationScale = Math.sqrt(Math.max(0, 1 - decay * decay));
    this.gustMps = [
      decay * this.gustMps[0] + sigma * innovationScale * this.rng.normal(),
      decay * this.gustMps[1] + sigma * innovationScale * this.rng.normal(),
      decay * this.gustMps[2] + sigma * 0.25 * innovationScale * this.rng.normal()
    ];
  }

  private updateRocketActuators(control: ControlCommand, dtS: number): void {
    const desiredThrustN = control.engineEnabled
      ? clamp(control.desiredThrustN, 0, this.config.rocket.thrustMaxN)
      : 0;
    this.rocket.actualThrustN = firstOrder(
      this.rocket.actualThrustN,
      desiredThrustN,
      this.config.rocket.thrustTimeConstantS,
      dtS
    );

    const desiredTorqueNm = clampMagnitude3(
      control.desiredTorqueNm,
      Math.max(0, this.config.rocket.torqueMaxNm)
    );
    this.rocket.actualTorqueNm = [
      firstOrder(
        this.rocket.actualTorqueNm[0],
        desiredTorqueNm[0],
        this.config.rocket.attitudeTimeConstantS,
        dtS
      ),
      firstOrder(
        this.rocket.actualTorqueNm[1],
        desiredTorqueNm[1],
        this.config.rocket.attitudeTimeConstantS,
        dtS
      ),
      firstOrder(
        this.rocket.actualTorqueNm[2],
        desiredTorqueNm[2],
        this.config.rocket.attitudeTimeConstantS,
        dtS
      )
    ];
  }

  private updateWinchActuators(input: PlantStepInput, dtS: number): void {
    const desired = this.normalizeNetTargets(input.netCommand.desiredAxisPositionsM);
    const axes = this.axes();
    for (let index = 0; index < axes.length; index += 1) {
      const axis = axes[index];
      const target = desired[index];
      if (axis === undefined || target === undefined) continue;
      if (input.winchStuck !== undefined) axis.stuck = input.winchStuck[index] ?? axis.stuck;
      this.updateAxis(axis, target, dtS);
    }

    this.net.centerM = [
      (this.net.xNegative.positionM + this.net.xPositive.positionM) / 2,
      (this.net.yNegative.positionM + this.net.yPositive.positionM) / 2
    ];
    this.net.halfSpacingM = [
      Math.max(0, (this.net.xPositive.positionM - this.net.xNegative.positionM) / 2),
      Math.max(0, (this.net.yPositive.positionM - this.net.yNegative.positionM) / 2)
    ];
    this.net.targetTotalTensionN = Math.max(0, input.netCommand.targetTotalTensionN);
    this.net.desiredTensionsN = input.netCommand.desiredTensionsN.map(
      (value) => Math.max(0, value)
    ) as WinchAxisValues<number>;
    const maximumDampingStep = this.config.net.activeDampingRateNspmPerS * dtS;
    for (let index = 0; index < this.net.activeDampingNspm.length; index += 1) {
      const current = this.net.activeDampingNspm[index] ?? 0;
      const target = clamp(
        input.netCommand.desiredActiveDampingNspm[index] ?? current,
        this.config.net.activeDampingMinNspm,
        this.config.net.activeDampingMaxNspm
      );
      this.net.activeDampingNspm[index] = current + clamp(
        target - current,
        -maximumDampingStep,
        maximumDampingStep
      );
      this.net.tensionControllerSaturated[index] =
        input.netCommand.tensionControllerSaturated[index] ?? false;
    }
  }

  private updateAxis(axis: AxisActuatorState, desiredPositionM: number, dtS: number): void {
    axis.desiredPositionM = desiredPositionM;
    if (axis.stuck) {
      axis.velocityMps = 0;
      axis.appliedAccelerationMps2 = 0;
      return;
    }

    const maximumSpeedMps = Math.max(0, this.config.net.winchMaxSpeedMps);
    const maximumAccelerationMps2 = Math.max(0, this.config.net.winchMaxAccelerationMps2);
    const timeConstantS = Math.max(this.config.net.winchTimeConstantS, dtS);
    const desiredVelocityMps = clamp(
      (desiredPositionM - axis.positionM) / timeConstantS,
      -maximumSpeedMps,
      maximumSpeedMps
    );
    const requestedAccelerationMps2 = (desiredVelocityMps - axis.velocityMps) / timeConstantS;
    const accelerationMps2 = clamp(
      requestedAccelerationMps2,
      -maximumAccelerationMps2,
      maximumAccelerationMps2
    );
    let nextVelocityMps = clamp(
      axis.velocityMps + accelerationMps2 * dtS,
      -maximumSpeedMps,
      maximumSpeedMps
    );
    let nextPositionM = axis.positionM + nextVelocityMps * dtS;

    const beforeError = desiredPositionM - axis.positionM;
    const afterError = desiredPositionM - nextPositionM;
    if (beforeError !== 0 && Math.sign(beforeError) !== Math.sign(afterError)) {
      nextPositionM = desiredPositionM;
      nextVelocityMps = 0;
    }

    axis.positionM = nextPositionM;
    axis.velocityMps = nextVelocityMps;
    axis.appliedAccelerationMps2 = accelerationMps2;
  }

  private normalizeNetTargets(raw: WinchAxisValues<number>): WinchAxisValues<number> {
    const normalizePair = (negative: number, positive: number): [number, number] => {
      const centreM = clamp(
        (negative + positive) / 2,
        -this.config.net.centerTravelLimitM,
        this.config.net.centerTravelLimitM
      );
      const halfSpacingM = clamp(
        Math.abs(positive - negative) / 2,
        this.config.net.closedHalfSpacingM,
        this.config.net.openHalfSpacingM
      );
      return [centreM - halfSpacingM, centreM + halfSpacingM];
    };

    const x = normalizePair(raw[0], raw[1]);
    const y = normalizePair(raw[2], raw[3]);
    return [x[0], x[1], y[0], y[1]];
  }

  private computeForces(control: ControlCommand, contactForceN: Vec3): PlantAppliedForces {
    const gravityN: Vec3 = [0, 0, -this.rocket.massKg * this.config.environment.gravityMps2];
    const thrustN = quatRotate(this.rocket.attitudeWxyz, [0, 0, this.rocket.actualThrustN]);
    const windMps = add3(this.config.environment.meanWindMps, this.gustMps);
    const relativeAirVelocityMps = sub3(this.rocket.velocityMps, windMps);
    const relativeAirSpeedMps = norm3(relativeAirVelocityMps);
    const dragScale =
      -0.5 *
      this.config.environment.airDensityKgpm3 *
      this.config.rocket.dragCoefficient *
      this.config.rocket.referenceAreaM2 *
      relativeAirSpeedMps;
    const aerodynamicDragN = scale3(relativeAirVelocityMps, dragScale);
    const totalN = add3(add3(gravityN, thrustN), add3(aerodynamicDragN, contactForceN));
    void control;
    return {
      gravityN,
      thrustN,
      aerodynamicDragN,
      contactN: [...contactForceN],
      totalN
    };
  }

  private integrateRigidBody(accelerationMps2: Vec3, dtS: number): void {
    // Semi-implicit Euler: update generalized velocities first, then position
    // and attitude.  It is considerably more robust than explicit Euler for
    // the damped contact oscillator used here.
    this.rocket.velocityMps = add3(this.rocket.velocityMps, scale3(accelerationMps2, dtS));
    this.rocket.positionM = add3(this.rocket.positionM, scale3(this.rocket.velocityMps, dtS));

    const inertia = this.config.rocket.inertiaKgM2;
    const angularMomentum: Vec3 = [
      inertia[0] * this.rocket.angularVelocityRadps[0],
      inertia[1] * this.rocket.angularVelocityRadps[1],
      inertia[2] * this.rocket.angularVelocityRadps[2]
    ];
    const gyroscopicTorque = cross3(this.rocket.angularVelocityRadps, angularMomentum);
    const netTorqueNm = sub3(this.rocket.actualTorqueNm, gyroscopicTorque);
    const angularAccelerationRadps2: Vec3 = [
      netTorqueNm[0] / inertia[0],
      netTorqueNm[1] / inertia[1],
      netTorqueNm[2] / inertia[2]
    ];
    this.rocket.angularVelocityRadps = add3(
      this.rocket.angularVelocityRadps,
      scale3(angularAccelerationRadps2, dtS)
    );
    this.rocket.attitudeWxyz = integrateQuaternion(
      this.rocket.attitudeWxyz,
      this.rocket.angularVelocityRadps,
      dtS
    );
  }

  private evaluatePlatform(timeS: number): PlatformMotion {
    const angularFrequency = (2 * Math.PI) / this.config.platform.wavePeriodS;
    const phase = angularFrequency * timeS;
    const swayPhase = phase + (2 * Math.PI) / 3;
    const heavePhase = phase + (4 * Math.PI) / 3;
    const rollPhase = phase + Math.PI / 4;
    const pitchPhase = phase + (5 * Math.PI) / 4;

    return {
      positionM: [
        this.config.platform.surgeAmplitudeM * Math.sin(phase),
        this.config.platform.swayAmplitudeM * Math.sin(swayPhase),
        this.config.platform.heaveAmplitudeM * Math.sin(heavePhase)
      ],
      velocityMps: [
        this.config.platform.surgeAmplitudeM * angularFrequency * Math.cos(phase),
        this.config.platform.swayAmplitudeM * angularFrequency * Math.cos(swayPhase),
        this.config.platform.heaveAmplitudeM * angularFrequency * Math.cos(heavePhase)
      ],
      rollRad: this.config.platform.rollAmplitudeRad * Math.sin(rollPhase),
      pitchRad: this.config.platform.pitchAmplitudeRad * Math.sin(pitchPhase),
      rollRateRadps:
        this.config.platform.rollAmplitudeRad * angularFrequency * Math.cos(rollPhase),
      pitchRateRadps:
        this.config.platform.pitchAmplitudeRad * angularFrequency * Math.cos(pitchPhase)
    };
  }

  private toPlatformKinematics(
    rocket: RocketTruthState,
    platform: PlatformMotion
  ): LocalKinematics {
    const positionM = rotateWorldToPlatform(
      sub3(rocket.positionM, platform.positionM),
      platform.rollRad,
      platform.pitchRad
    );
    const translatingRelativeVelocityMps = rotateWorldToPlatform(
      sub3(rocket.velocityMps, platform.velocityMps),
      platform.rollRad,
      platform.pitchRad
    );
    const angularVelocityLocalRadps: Vec3 = [
      platform.rollRateRadps,
      platform.pitchRateRadps,
      0
    ];
    const velocityMps = sub3(
      translatingRelativeVelocityMps,
      cross3(angularVelocityLocalRadps, positionM)
    );
    return { positionM, velocityMps };
  }

  private computeContact(local: LocalKinematics): ContactComputation {
    const capturePlaneZ = this.config.platform.capturePlaneZ;
    const payoutM = Math.max(0, capturePlaneZ - local.positionM[2]);
    const payoutVelocityMps = -local.velocityMps[2];
    const verticalForceN = Math.max(
      0,
      this.config.net.totalStiffnessNpm * payoutM +
        this.net.activeDampingNspm.reduce((sum, value) => sum + value, 0) * payoutVelocityMps
    );

    const lateralOffsetM: [number, number] = [
      local.positionM[0] - this.net.centerM[0],
      local.positionM[1] - this.net.centerM[1]
    ];
    const lateralVelocityMps: [number, number] = [
      local.velocityMps[0] -
        (this.net.xNegative.velocityMps + this.net.xPositive.velocityMps) / 2,
      local.velocityMps[1] -
        (this.net.yNegative.velocityMps + this.net.yPositive.velocityMps) / 2
    ];
    const forceLocalN: Vec3 = [
      -this.config.net.lateralStiffnessNpm * lateralOffsetM[0] -
        this.config.net.lateralDampingNspm * lateralVelocityMps[0],
      -this.config.net.lateralStiffnessNpm * lateralOffsetM[1] -
        this.config.net.lateralDampingNspm * lateralVelocityMps[1],
      verticalForceN
    ];
    const totalTensionN = norm3(forceLocalN);

    const xBias = clamp(
      lateralOffsetM[0] / Math.max(this.net.halfSpacingM[0], 1e-9),
      -1,
      1
    );
    const yBias = clamp(
      lateralOffsetM[1] / Math.max(this.net.halfSpacingM[1], 1e-9),
      -1,
      1
    );
    const tensionsN: WinchAxisValues<number> = [
      (totalTensionN * (1 + xBias)) / 4,
      (totalTensionN * (1 - xBias)) / 4,
      (totalTensionN * (1 + yBias)) / 4,
      (totalTensionN * (1 - yBias)) / 4
    ];
    const forceWorldN = rotatePlatformToWorld(
      forceLocalN,
      this.platform.rollRad,
      this.platform.pitchRad
    );
    return {
      forceLocalN,
      forceWorldN,
      tensionsN,
      payoutM,
      payoutVelocityMps,
      totalTensionN,
      overtravel: payoutM > this.config.net.arrestDistanceM
    };
  }

  private applyContactToNet(contact: ContactComputation): void {
    this.net.tensionsN = [...contact.tensionsN];
    this.net.totalContactForceN = [...contact.forceWorldN];
    this.net.payoutM = contact.payoutM;
    this.net.payoutVelocityMps = contact.payoutVelocityMps;
  }

  private crossedCapturePlane(before: LocalKinematics, after: LocalKinematics): boolean {
    const planeZ = this.config.platform.capturePlaneZ;
    return (
      before.positionM[2] > planeZ &&
      after.positionM[2] <= planeZ &&
      after.velocityMps[2] < 0
    );
  }

  private evaluateCapture(local: LocalKinematics): CaptureEvaluation {
    const offset: [number, number] = [
      local.positionM[0] - this.net.centerM[0],
      local.positionM[1] - this.net.centerM[1]
    ];
    const requiredRadiusM =
      this.config.rocket.radiusM + this.config.controller.requiredApertureMarginM;
    const usableHalfWidthM = this.net.halfSpacingM[0] - requiredRadiusM;
    const usableHalfDepthM = this.net.halfSpacingM[1] - requiredRadiusM;
    const outsideX = Math.max(0, Math.abs(offset[0]) - usableHalfWidthM);
    const outsideY = Math.max(0, Math.abs(offset[1]) - usableHalfDepthM);
    const missDistanceM = Math.hypot(outsideX, outsideY);
    const relativeSpeedMps = norm3(local.velocityMps);
    const tiltRad = tiltFromVertical(this.rocket.attitudeWxyz);
    const closeToleranceM = Math.max(
      0.05,
      this.config.net.winchMaxSpeedMps * this.config.physicsDtS * 1.5
    );

    let rejectionReason: CaptureRejectionReason | null = null;
    if (this.net.mode !== "closing") {
      rejectionReason = "net-not-closing";
    } else if (
      this.net.halfSpacingM[0] > this.config.net.closedHalfSpacingM + closeToleranceM ||
      this.net.halfSpacingM[1] > this.config.net.closedHalfSpacingM + closeToleranceM
    ) {
      rejectionReason = "net-not-closed";
    } else if (missDistanceM > 0) {
      rejectionReason = "outside-aperture";
    } else if (relativeSpeedMps > this.config.controller.maxCaptureSpeedMps) {
      rejectionReason = "relative-speed-too-high";
    } else if (tiltRad > this.config.controller.maxCaptureTiltRad) {
      rejectionReason = "tilt-too-high";
    }

    return {
      attempted: true,
      captured: rejectionReason === null,
      rejectionReason,
      centerOffsetM: offset,
      missDistanceM,
      relativeSpeedMps,
      tiltRad
    };
  }

  private updateSteadyState(
    local: LocalKinematics,
    contact: ContactComputation,
    accelerationMps2: Vec3
  ): boolean {
    if (this.net.mode === "secured") return false;

    const lateralOffsetM = Math.hypot(
      local.positionM[0] - this.net.centerM[0],
      local.positionM[1] - this.net.centerM[1]
    );
    const supportedWeightN = this.rocket.massKg * this.config.environment.gravityMps2;
    const forceToleranceN = Math.max(1, supportedWeightN * 0.12);
    const waveAngularFrequency = (2 * Math.PI) / this.config.platform.wavePeriodS;
    const deckLateralSpeedMps = Math.hypot(
      this.config.platform.surgeAmplitudeM * waveAngularFrequency,
      this.config.platform.swayAmplitudeM * waveAngularFrequency
    );
    // A captured body follows a moving deck and does not converge to an
    // inertial zero-velocity point. These wave-aware limits define bounded
    // retention, not millimetre-static equilibrium or a structural criterion.
    const lateralOffsetLimitM = Math.max(
      0.25,
      Math.min(
        this.config.net.closedHalfSpacingM * 0.65,
        this.config.rocket.radiusM * 0.8
      )
    );
    const lateralVelocityLimitMps = Math.max(0.25, deckLateralSpeedMps * 1.6);
    const accelerationLimitMps2 = 0.75;
    const stable =
      contact.payoutM > 0 &&
      contact.payoutM <= this.config.net.arrestDistanceM &&
      Math.abs(local.velocityMps[2]) < 0.25 &&
      Math.hypot(local.velocityMps[0], local.velocityMps[1]) < lateralVelocityLimitMps &&
      lateralOffsetM < lateralOffsetLimitM &&
      norm3(accelerationMps2) < accelerationLimitMps2 &&
      Math.abs(contact.forceLocalN[2] - supportedWeightN) <= forceToleranceN;
    this.settledTicks = stable ? this.settledTicks + 1 : 0;

    const requiredTicks = Math.max(1, Math.ceil(0.5 / this.config.physicsDtS));
    if (this.settledTicks < requiredTicks) return false;
    this.net.mode = "secured";
    this.rocket.mode = "CAPTURED";
    return true;
  }

  private canAttemptCapture(): boolean {
    return (
      this.net.mode === "open" ||
      this.net.mode === "tracking" ||
      this.net.mode === "closing"
    );
  }

  private hasIntactCapture(): boolean {
    return (
      this.net.mode === "latched" ||
      this.net.mode === "arresting" ||
      this.net.mode === "secured"
    );
  }

  private axes(): WinchAxisValues<AxisActuatorState> {
    return [
      this.net.xNegative,
      this.net.xPositive,
      this.net.yNegative,
      this.net.yPositive
    ];
  }

  private makeResult(
    capture: CaptureEvaluation,
    forces: PlantAppliedForces,
    energy: PlantStepEnergy,
    capturedThisStep: boolean,
    missedThisStep: boolean,
    ropeBrokenThisStep: boolean,
    securedThisStep: boolean,
    failureReason: PlantStepResult["failureReason"]
  ): PlantStepResult {
    const windMps = add3(this.config.environment.meanWindMps, this.gustMps);
    return {
      tick: this.tick,
      timeS: this.currentTimeS,
      rocket: cloneRocket(this.rocket),
      platform: clonePlatform(this.platform),
      net: cloneNet(this.net),
      gustMps: [...this.gustMps],
      windMps,
      forces: cloneForces(forces),
      energy: { ...energy },
      capture: cloneCapture(capture),
      capturedThisStep,
      missedThisStep,
      ropeBrokenThisStep,
      securedThisStep,
      failureReason
    };
  }

  private cloneResult(result: PlantStepResult): PlantStepResult {
    return {
      ...result,
      rocket: cloneRocket(result.rocket),
      platform: clonePlatform(result.platform),
      net: cloneNet(result.net),
      gustMps: [...result.gustMps],
      windMps: [...result.windMps],
      forces: cloneForces(result.forces),
      energy: { ...result.energy },
      capture: cloneCapture(result.capture)
    };
  }
}

/** A neutral command useful for initialization and open-loop experiments. */
export const createNeutralPlantInput = (config: ScenarioConfig): PlantStepInput => ({
  rocketControl: {
    desiredThrustN: 0,
    desiredTorqueNm: [0, 0, 0],
    desiredAccelerationMps2: [0, 0, 0],
    desiredAttitudeWxyz: [1, 0, 0, 0],
    engineEnabled: false
  },
  netCommand: {
    desiredAxisPositionsM: [
      -config.net.openHalfSpacingM,
      config.net.openHalfSpacingM,
      -config.net.openHalfSpacingM,
      config.net.openHalfSpacingM
    ],
    targetTotalTensionN: 0,
    desiredTensionsN: [0, 0, 0, 0],
    desiredActiveDampingNspm: [
      config.net.activeDampingMinNspm,
      config.net.activeDampingMinNspm,
      config.net.activeDampingMinNspm,
      config.net.activeDampingMinNspm
    ],
    tensionControllerSaturated: [false, false, false, false],
    requestedMode: "open"
  }
});
