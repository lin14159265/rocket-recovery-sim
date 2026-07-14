import type { ScenarioConfig, SimulationRun, SimulationSnapshot } from "@recovery/sim-core";
import type { DashboardParameterKey } from "./components/Dashboard";

export const cloneConfig = (config: ScenarioConfig): ScenarioConfig => structuredClone(config);

export const frameAtTime = (
  frames: readonly SimulationSnapshot[],
  timeS: number
): SimulationSnapshot | null => {
  if (frames.length === 0) return null;
  let low = 0;
  let high = frames.length - 1;
  let match = 0;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const frame = frames[middle];
    if (frame === undefined) break;
    if (frame.timeS <= timeS) {
      match = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return frames[match] ?? null;
};

export const patchParameter = (
  source: ScenarioConfig,
  path: DashboardParameterKey,
  value: number
): ScenarioConfig => {
  const config = cloneConfig(source);
  switch (path) {
    case "rocket.massKg": config.rocket.massKg = value; break;
    case "rocket.initialVelocityMps.2": config.rocket.initialVelocityMps[2] = value; break;
    case "rocket.thrustMaxN": config.rocket.thrustMaxN = value; break;
    case "net.closureDurationS": config.net.closureDurationS = value; break;
    case "net.totalStiffnessNpm": config.net.totalStiffnessNpm = value; break;
    case "net.totalDampingNspm": config.net.totalDampingNspm = value; break;
    case "net.totalStrengthLimitN": config.net.totalStrengthLimitN = value; break;
    case "radio.baseLatencyMs": config.radio.baseLatencyMs = value; break;
    case "radio.jitterMs": config.radio.jitterMs = value; break;
    case "radio.lossRate": config.radio.lossRate = value; break;
    case "radio.duplicateRate": config.radio.duplicateRate = value; break;
    case "radio.corruptionRate": config.radio.corruptionRate = value; break;
    case "fieldbus.baseLatencyMs": config.fieldbus.baseLatencyMs = value; break;
    case "fieldbus.jitterMs": config.fieldbus.jitterMs = value; break;
    case "fieldbus.lossRate": config.fieldbus.lossRate = value; break;
    case "fieldbus.duplicateRate": config.fieldbus.duplicateRate = value; break;
    case "fieldbus.corruptionRate": config.fieldbus.corruptionRate = value; break;
    case "controller.netCenterKp": config.controller.netCenterKp = value; break;
    case "controller.netCenterKd": config.controller.netCenterKd = value; break;
    case "controller.staleTelemetryAbortS": config.controller.staleTelemetryAbortS = value; break;
    case "faults.radioBlackout.startTimeS": config.faults.radioBlackout.startTimeS = value; break;
    case "faults.radioBlackout.durationS": config.faults.radioBlackout.durationS = value; break;
    case "faults.winchStuck.startTimeS": config.faults.winchStuck.startTimeS = value; break;
    case "faults.winchStuck.durationS": config.faults.winchStuck.durationS = value; break;
    case "faults.sensorBiasStep.startTimeS": config.faults.sensorBiasStep.startTimeS = value; break;
    case "faults.sensorBiasStep.durationS": config.faults.sensorBiasStep.durationS = value; break;
    case "faults.sensorBiasStep.deltaM.0": config.faults.sensorBiasStep.deltaM[0] = value; break;
    case "faults.sensorBiasStep.deltaM.1": config.faults.sensorBiasStep.deltaM[1] = value; break;
    case "faults.sensorBiasStep.deltaM.2": config.faults.sensorBiasStep.deltaM[2] = value; break;
    case "faults.thrustScale.startTimeS": config.faults.thrustScale.startTimeS = value; break;
    case "faults.thrustScale.durationS": config.faults.thrustScale.durationS = value; break;
    case "faults.thrustScale.scale": config.faults.thrustScale.scale = value; break;
  }
  config.id = "custom";
  config.name = "自定义代理场景";
  config.parameterSources[path] = {
    status: "assumed",
    source: "用户界面覆盖",
    note: "本次自定义场景值；不代表公开或官方参数"
  };
  return config;
};

/** Runtime visuals must always use the exact config that produced the run. */
export const displayedConfigFor = (
  run: SimulationRun | null,
  draftConfig: ScenarioConfig
): ScenarioConfig => run?.config ?? draftConfig;
