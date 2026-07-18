import { describe, expect, it } from "vitest";
import { createNominalScenario } from "../src/config";
import {
  RocketController,
  computeVerticalVelocityReference,
  predictGuidedCaptureIntersection
} from "../src/control";
import { RecoveryPlant, createNeutralPlantInput } from "../src/plant";
import type { ControlCommand, StateEstimate } from "../src/contracts";

describe("guidance-aware capture prediction", () => {
  it("matches the same noiseless guidance plant within the v0.4 intercept tolerances", () => {
    const config = createNominalScenario();
    config.environment.airDensityKgpm3 = 0;
    config.environment.meanWindMps = [0, 0, 0];
    config.environment.gustSigmaMps = 0;
    config.platform.surgeAmplitudeM = 0;
    config.platform.swayAmplitudeM = 0;
    config.platform.heaveAmplitudeM = 0;
    config.platform.rollAmplitudeRad = 0;
    config.platform.pitchAmplitudeRad = 0;
    config.rocket.initialPositionM = [5, -3, 300];
    config.rocket.initialVelocityMps = [1, -0.5, -30];
    config.rocket.initialAngularVelocityRadps = [0, 0, 0];
    config.net.openHalfSpacingM = 50;

    const initialEstimate: StateEstimate = {
      tick: 0,
      positionM: [...config.rocket.initialPositionM],
      velocityMps: [...config.rocket.initialVelocityMps],
      accelerationMps2: [0, 0, -config.environment.gravityMps2],
      covarianceDiagonal: [0, 0, 0, 0, 0, 0],
      source: "ground-kalman"
    };
    const prediction = predictGuidedCaptureIntersection(
      initialEstimate,
      config.platform.capturePlaneZ,
      {
        controller: config.controller,
        rocket: config.rocket,
        gravityMps2: config.environment.gravityMps2,
        tickDurationS: config.physicsDtS,
        targetCenterM: [0, 0],
        attitudeWxyz: config.rocket.initialAttitudeWxyz,
        angularVelocityRadps: config.rocket.initialAngularVelocityRadps
      }
    );
    expect(prediction).not.toBeNull();

    const plant = new RecoveryPlant(config);
    const controller = new RocketController(
      config.controller,
      config.rocket,
      config.environment.gravityMps2
    );
    const input = createNeutralPlantInput(config);
    let command: ControlCommand = input.rocketControl;
    let before = plant.getState();
    let crossing = plant.getState();
    const controlIntervalTicks = Math.round(
      1 / (config.controller.controlRateHz * config.physicsDtS)
    );
    for (let tick = 0; tick < Math.round(20 / config.physicsDtS); tick += 1) {
      if (tick % controlIntervalTicks === 0) {
        const truth = before.rocket;
        const estimate: StateEstimate = {
          tick,
          positionM: [...truth.positionM],
          velocityMps: [...truth.velocityMps],
          accelerationMps2: [...before.forces.totalN].map(
            (force) => force / truth.massKg
          ) as [number, number, number],
          covarianceDiagonal: [0, 0, 0, 0, 0, 0],
          source: "ground-kalman"
        };
        const verticalReference = computeVerticalVelocityReference(
          estimate,
          config.platform.capturePlaneZ,
          config.controller.guidance
        );
        command = controller.compute({
          estimate,
          attitudeWxyz: truth.attitudeWxyz,
          angularVelocityRadps: truth.angularVelocityRadps,
          targetPositionM: [0, 0, config.platform.capturePlaneZ],
          targetVelocityMps: [0, 0, verticalReference],
          verticalVelocityReferenceMps: verticalReference
        });
      }
      input.rocketControl = command;
      const after = plant.step(input);
      if (
        before.rocket.positionM[2] > config.platform.capturePlaneZ &&
        after.rocket.positionM[2] <= config.platform.capturePlaneZ
      ) {
        crossing = after;
        break;
      }
      before = after;
    }

    expect(Math.abs((prediction?.predictedInterceptTick ?? 0) - crossing.tick) * config.physicsDtS)
      .toBeLessThan(0.2);
    expect(Math.hypot(
      (prediction?.predictedInterceptPositionM[0] ?? 0) - crossing.rocket.positionM[0],
      (prediction?.predictedInterceptPositionM[1] ?? 0) - crossing.rocket.positionM[1]
    )).toBeLessThan(0.5);
  });
});
