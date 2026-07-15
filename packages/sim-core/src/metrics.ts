import type { RecoveryMetrics, StateEstimate } from "./contracts";
import { norm3, sub3 } from "./math";
import type { PlantStepResult } from "./plant";

const createInitialMetrics = (): RecoveryMetrics => ({
  captured: false,
  secured: false,
  failed: false,
  failureReason: null,
  captureTick: null,
  missDistanceM: 0,
  captureRelativeSpeedMps: 0,
  captureTiltRad: 0,
  peakContactForceN: 0,
  peakApparentLoadG: 0,
  peakRopeTensionN: 0,
  maxEstimateErrorM: 0,
  predictionTimeErrorS: 0,
  capturePlaneCenterErrorM: 0,
  readyRoundTripS: 0,
  tensionRmsErrorN: 0,
  constraintActivationCount: 0,
  mpcFallbackCount: 0
});

/** Accumulates run-level recovery outcomes and model-derived peak values. */
export class RecoveryMetricsAccumulator {
  private readonly metrics = createInitialMetrics();
  private captureEvaluationRecorded = false;

  /**
   * Incorporates one plant tick and the state estimate available at that tick.
   *
   * `peakApparentLoadG` is a proper-acceleration proxy computed from the
   * magnitude of the modelled non-gravity resultant, `|F_total - F_gravity| /
   * (m g)`.  Thus ideal free fall reads 0 g and ideal hover reads 1 g.  It is
   * neither a measured structural load nor a qualification-level load case.
   */
  public update(
    step: PlantStepResult,
    estimate: StateEstimate,
    gravityMps2: number
  ): RecoveryMetrics {
    if (!Number.isFinite(gravityMps2) || gravityMps2 <= 0) {
      throw new RangeError("gravityMps2 must be positive and finite");
    }
    if (!Number.isFinite(step.rocket.massKg) || step.rocket.massKg <= 0) {
      throw new RangeError("rocket mass must be positive and finite");
    }

    this.updatePeaks(step, estimate, gravityMps2);

    if (step.capture.attempted && !this.captureEvaluationRecorded) {
      this.captureEvaluationRecorded = true;
      this.metrics.missDistanceM = step.capture.missDistanceM;
      this.metrics.captureRelativeSpeedMps = step.capture.relativeSpeedMps;
      this.metrics.captureTiltRad = step.capture.tiltRad;
    }

    if (step.capturedThisStep && !this.metrics.captured) {
      this.metrics.captured = true;
      this.metrics.captureTick = step.tick;
    }
    if (step.securedThisStep) this.metrics.secured = true;

    if (!this.metrics.failed) {
      const failureReason = this.failureReasonFor(step);
      if (failureReason !== null) {
        this.metrics.failed = true;
        this.metrics.failureReason = failureReason;
      }
    }

    return this.snapshot();
  }

  /** Returns a copy so callers cannot mutate the accumulator's state. */
  public snapshot(): RecoveryMetrics {
    return { ...this.metrics };
  }

  private updatePeaks(
    step: PlantStepResult,
    estimate: StateEstimate,
    gravityMps2: number
  ): void {
    this.metrics.peakContactForceN = Math.max(
      this.metrics.peakContactForceN,
      norm3(step.forces.contactN)
    );

    const nonGravityForceN = sub3(step.forces.totalN, step.forces.gravityN);
    const apparentLoadG =
      norm3(nonGravityForceN) / (step.rocket.massKg * gravityMps2);
    this.metrics.peakApparentLoadG = Math.max(
      this.metrics.peakApparentLoadG,
      apparentLoadG
    );

    this.metrics.peakRopeTensionN = Math.max(
      this.metrics.peakRopeTensionN,
      0,
      ...step.net.tensionsN
    );

    const estimateErrorM = norm3(sub3(estimate.positionM, step.rocket.positionM));
    this.metrics.maxEstimateErrorM = Math.max(
      this.metrics.maxEstimateErrorM,
      estimateErrorM
    );
  }

  private failureReasonFor(step: PlantStepResult): string | null {
    if (step.ropeBrokenThisStep || step.net.mode === "broken") {
      return step.failureReason ?? "rope-broken";
    }
    if (step.missedThisStep || step.net.mode === "missed") {
      return step.capture.rejectionReason ?? "capture-missed";
    }
    if (step.net.mode === "aborted") return "aborted";
    return null;
  }
}
