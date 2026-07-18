import type { ParameterSource, ScenarioConfig } from "./contracts";
import { createNominalScenario, fingerprintScenarioConfig } from "./config";
import { SIMULATION_MODEL_VERSION } from "./simulation";

export const CURRENT_SCENARIO_SCHEMA_VERSION = 3 as const;
export const SCENARIO_DOCUMENT_FORMAT = "recovery-proxy-scenario" as const;

export interface ScenarioDocument {
  format: typeof SCENARIO_DOCUMENT_FORMAT;
  documentVersion: 3;
  modelVersion: string;
  configFingerprint: string;
  notice: string;
  config: ScenarioConfig;
}

export interface ScenarioMigrationResult {
  config: ScenarioConfig;
  sourceDocumentVersion: number | null;
  targetDocumentVersion: ScenarioDocument["documentVersion"];
  sourceSchemaVersion: number;
  targetSchemaVersion: typeof CURRENT_SCENARIO_SCHEMA_VERSION;
  migrated: boolean;
  warnings: string[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const finite = (value: unknown, label: string): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${label} 必须是有限数值`);
  }
  return value;
};

const positive = (value: unknown, label: string): number => {
  const result = finite(value, label);
  if (result <= 0) throw new RangeError(`${label} 必须大于 0`);
  return result;
};

const nonNegative = (value: unknown, label: string): number => {
  const result = finite(value, label);
  if (result < 0) throw new RangeError(`${label} 不得小于 0`);
  return result;
};

const probability = (value: unknown, label: string): number => {
  const result = finite(value, label);
  if (result < 0 || result > 1) throw new RangeError(`${label} 必须位于 [0, 1]`);
  return result;
};

const ensureBoolean = (value: unknown, label: string): boolean => {
  if (typeof value !== "boolean") throw new TypeError(`${label} 必须是布尔值`);
  return value;
};

const ensureString = (value: unknown, label: string, allowEmpty = false): string => {
  if (typeof value !== "string" || (!allowEmpty && value.trim().length === 0)) {
    throw new TypeError(`${label} 必须是${allowEmpty ? "" : "非空"}字符串`);
  }
  return value;
};

const mergeRecord = <T extends Record<string, unknown>>(baseline: T, value: unknown): T => {
  if (!isRecord(value)) return structuredClone(baseline);
  const output = structuredClone(baseline);
  for (const [key, incoming] of Object.entries(value)) {
    const current = output[key];
    if (isRecord(current) && isRecord(incoming)) {
      output[key as keyof T] = mergeRecord(current, incoming) as T[keyof T];
    } else {
      output[key as keyof T] = structuredClone(incoming) as T[keyof T];
    }
  }
  return output;
};

const assertParameterSources = (value: unknown, label: string): void => {
  if (!isRecord(value)) throw new TypeError(`${label} 必须是对象`);
  for (const [path, rawSource] of Object.entries(value)) {
    if (path.trim().length === 0) throw new TypeError(`${label} 不得包含空路径`);
    if (!isRecord(rawSource)) throw new TypeError(`${label}.${path} 必须是对象`);
    if (!["official", "public-estimate", "assumed", "calibrated"].includes(
      String(rawSource.status)
    )) {
      throw new RangeError(`${label}.${path}.status 不是受支持的来源等级`);
    }
    ensureString(rawSource.source, `${label}.${path}.source`);
    ensureString(rawSource.note, `${label}.${path}.note`, true);
    const allowed = new Set(["status", "source", "note"]);
    for (const key of Object.keys(rawSource)) {
      if (!allowed.has(key)) throw new TypeError(`${label}.${path} 包含未知字段 ${key}`);
    }
  }
};

/**
 * Enforces the complete schema shape for current-version documents. Legacy
 * documents are upgraded first, then pass through the same strict check.
 */
const assertCompleteShape = (value: unknown, baseline: unknown, label: string): void => {
  if (label === "config.parameterSources") {
    assertParameterSources(value, label);
    return;
  }
  if (Array.isArray(baseline)) {
    if (!Array.isArray(value) || value.length !== baseline.length) {
      throw new TypeError(`${label} 必须是长度为 ${baseline.length} 的数组`);
    }
    for (let index = 0; index < baseline.length; index += 1) {
      assertCompleteShape(value[index], baseline[index], `${label}[${index}]`);
    }
    return;
  }
  if (isRecord(baseline)) {
    if (!isRecord(value)) throw new TypeError(`${label} 必须是对象`);
    const required = new Set(Object.keys(baseline));
    for (const key of required) {
      if (!(key in value)) throw new TypeError(`${label} 缺少必填字段 ${key}`);
      assertCompleteShape(value[key], baseline[key], `${label}.${key}`);
    }
    for (const key of Object.keys(value)) {
      if (!required.has(key)) throw new TypeError(`${label} 包含未知字段 ${key}`);
    }
    return;
  }
  if (typeof baseline === "number") {
    finite(value, label);
  } else if (typeof baseline === "string") {
    ensureString(value, label, label.endsWith(".description") || label.endsWith(".note"));
  } else if (typeof baseline === "boolean") {
    ensureBoolean(value, label);
  } else if (value !== baseline) {
    throw new TypeError(`${label} 类型不正确`);
  }
};

interface ExtractedScenario {
  candidate: Record<string, unknown>;
  sourceDocumentVersion: number | null;
  sourceFingerprint: string | null;
}

const extractConfigCandidate = (input: unknown): ExtractedScenario => {
  if (!isRecord(input)) throw new TypeError("场景 JSON 顶层必须是对象");
  if ("config" in input) {
    if (input.format !== SCENARIO_DOCUMENT_FORMAT) {
      throw new TypeError("无法识别的场景文档格式");
    }
    const sourceDocumentVersion = input.documentVersion === undefined
      ? 1
      : finite(input.documentVersion, "documentVersion");
    if (!Number.isSafeInteger(sourceDocumentVersion) || sourceDocumentVersion < 1) {
      throw new RangeError("无法识别的 documentVersion");
    }
    if (sourceDocumentVersion > 3) {
      throw new RangeError(`场景 documentVersion=${sourceDocumentVersion} 高于当前支持的 3`);
    }
    if (!isRecord(input.config)) throw new TypeError("场景文档缺少 config 对象");
    const sourceFingerprint = input.configFingerprint === undefined
      ? null
      : ensureString(input.configFingerprint, "configFingerprint");
    return { candidate: input.config, sourceDocumentVersion, sourceFingerprint };
  }
  return { candidate: input, sourceDocumentVersion: null, sourceFingerprint: null };
};

const finiteVector3 = (value: unknown, label: string): [number, number, number] => {
  if (!Array.isArray(value) || value.length !== 3) {
    throw new TypeError(`${label} 必须是长度为 3 的数值数组`);
  }
  return [
    finite(value[0], `${label}[0]`),
    finite(value[1], `${label}[1]`),
    finite(value[2], `${label}[2]`)
  ];
};

const finiteQuaternion = (value: unknown, label: string): [number, number, number, number] => {
  if (!Array.isArray(value) || value.length !== 4) {
    throw new TypeError(`${label} 必须是长度为 4 的数值数组`);
  }
  const result: [number, number, number, number] = [
    finite(value[0], `${label}[0]`),
    finite(value[1], `${label}[1]`),
    finite(value[2], `${label}[2]`),
    finite(value[3], `${label}[3]`)
  ];
  const magnitude = Math.hypot(...result);
  if (magnitude < 1e-9) throw new RangeError(`${label} 不得为零四元数`);
  if (Math.abs(magnitude - 1) > 1e-3) throw new RangeError(`${label} 必须归一化`);
  return result;
};

const validateLink = (link: ScenarioConfig["radio"], label: string): void => {
  nonNegative(link.baseLatencyMs, `${label}.baseLatencyMs`);
  nonNegative(link.jitterMs, `${label}.jitterMs`);
  probability(link.lossRate, `${label}.lossRate`);
  probability(link.duplicateRate, `${label}.duplicateRate`);
  probability(link.corruptionRate, `${label}.corruptionRate`);
  positive(link.bandwidthPacketsPerSecond, `${label}.bandwidthPacketsPerSecond`);
};

const validateRate = (rateHz: number, physicsDtS: number, label: string): void => {
  positive(rateHz, label);
  const rawTicks = 1 / (rateHz * physicsDtS);
  const roundedTicks = Math.round(rawTicks);
  if (roundedTicks < 1 || Math.abs(rawTicks - roundedTicks) > 1e-8) {
    throw new RangeError(`${label} 必须整除物理 tick 频率`);
  }
};

export const validateScenarioConfig = (config: ScenarioConfig): void => {
  const baseline = createNominalScenario();
  assertCompleteShape(config, baseline, "config");

  if (config.schemaVersion !== CURRENT_SCENARIO_SCHEMA_VERSION) {
    throw new RangeError(`schemaVersion 必须为 ${CURRENT_SCENARIO_SCHEMA_VERSION}`);
  }
  ensureString(config.id, "id");
  ensureString(config.name, "name");
  ensureString(config.description, "description", true);
  if (!Number.isSafeInteger(config.seed)) throw new RangeError("seed 必须是安全整数");
  positive(config.durationS, "durationS");
  positive(config.physicsDtS, "physicsDtS");
  if (config.physicsDtS > config.durationS) throw new RangeError("physicsDtS 不得大于 durationS");
  const durationTicks = config.durationS / config.physicsDtS;
  if (Math.abs(durationTicks - Math.round(durationTicks)) > 1e-8) {
    throw new RangeError("durationS 必须由整数个 physicsDtS 组成");
  }

  positive(config.rocket.massKg, "rocket.massKg");
  positive(config.rocket.lengthM, "rocket.lengthM");
  positive(config.rocket.radiusM, "rocket.radiusM");
  finiteVector3(config.rocket.inertiaKgM2, "rocket.inertiaKgM2").forEach((entry, index) =>
    positive(entry, `rocket.inertiaKgM2[${index}]`)
  );
  finiteVector3(config.rocket.initialPositionM, "rocket.initialPositionM");
  finiteVector3(config.rocket.initialVelocityMps, "rocket.initialVelocityMps");
  finiteQuaternion(config.rocket.initialAttitudeWxyz, "rocket.initialAttitudeWxyz");
  finiteVector3(config.rocket.initialAngularVelocityRadps, "rocket.initialAngularVelocityRadps");
  nonNegative(config.rocket.thrustMaxN, "rocket.thrustMaxN");
  positive(config.rocket.thrustTimeConstantS, "rocket.thrustTimeConstantS");
  nonNegative(config.rocket.torqueMaxNm, "rocket.torqueMaxNm");
  positive(config.rocket.attitudeTimeConstantS, "rocket.attitudeTimeConstantS");
  nonNegative(config.rocket.dragCoefficient, "rocket.dragCoefficient");
  positive(config.rocket.referenceAreaM2, "rocket.referenceAreaM2");
  positive(config.rocket.lateralAccelerationLimitMps2, "rocket.lateralAccelerationLimitMps2");

  finite(config.platform.capturePlaneZ, "platform.capturePlaneZ");
  positive(config.platform.frameHalfWidthM, "platform.frameHalfWidthM");
  positive(config.platform.frameHalfDepthM, "platform.frameHalfDepthM");
  positive(config.platform.frameHeightM, "platform.frameHeightM");
  nonNegative(config.platform.surgeAmplitudeM, "platform.surgeAmplitudeM");
  nonNegative(config.platform.swayAmplitudeM, "platform.swayAmplitudeM");
  nonNegative(config.platform.heaveAmplitudeM, "platform.heaveAmplitudeM");
  nonNegative(config.platform.rollAmplitudeRad, "platform.rollAmplitudeRad");
  nonNegative(config.platform.pitchAmplitudeRad, "platform.pitchAmplitudeRad");
  positive(config.platform.wavePeriodS, "platform.wavePeriodS");

  positive(config.net.openHalfSpacingM, "net.openHalfSpacingM");
  nonNegative(config.net.closedHalfSpacingM, "net.closedHalfSpacingM");
  if (config.net.closedHalfSpacingM >= config.net.openHalfSpacingM) {
    throw new RangeError("net.closedHalfSpacingM 必须小于 net.openHalfSpacingM");
  }
  positive(config.net.closureDurationS, "net.closureDurationS");
  nonNegative(config.net.centerTravelLimitM, "net.centerTravelLimitM");
  positive(config.net.totalStiffnessNpm, "net.totalStiffnessNpm");
  positive(config.net.totalDampingNspm, "net.totalDampingNspm");
  positive(config.net.lateralStiffnessNpm, "net.lateralStiffnessNpm");
  positive(config.net.lateralDampingNspm, "net.lateralDampingNspm");
  positive(config.net.totalStrengthLimitN, "net.totalStrengthLimitN");
  positive(config.net.arrestDistanceM, "net.arrestDistanceM");
  positive(config.net.winchMaxSpeedMps, "net.winchMaxSpeedMps");
  positive(config.net.winchMaxAccelerationMps2, "net.winchMaxAccelerationMps2");
  positive(config.net.winchTimeConstantS, "net.winchTimeConstantS");
  nonNegative(config.net.activeDampingMinNspm, "net.activeDampingMinNspm");
  positive(config.net.activeDampingMaxNspm, "net.activeDampingMaxNspm");
  if (config.net.activeDampingMaxNspm < config.net.activeDampingMinNspm) {
    throw new RangeError("net.activeDampingMaxNspm 不得小于 activeDampingMinNspm");
  }
  positive(config.net.activeDampingRateNspmPerS, "net.activeDampingRateNspmPerS");

  positive(config.environment.gravityMps2, "environment.gravityMps2");
  nonNegative(config.environment.airDensityKgpm3, "environment.airDensityKgpm3");
  finiteVector3(config.environment.meanWindMps, "environment.meanWindMps");
  nonNegative(config.environment.gustSigmaMps, "environment.gustSigmaMps");
  nonNegative(config.environment.gustTimeConstantS, "environment.gustTimeConstantS");

  nonNegative(config.sensors.rocketPositionNoiseM, "sensors.rocketPositionNoiseM");
  nonNegative(config.sensors.rocketVelocityNoiseMps, "sensors.rocketVelocityNoiseMps");
  nonNegative(config.sensors.groundPositionNoiseM, "sensors.groundPositionNoiseM");
  nonNegative(config.sensors.groundVelocityNoiseMps, "sensors.groundVelocityNoiseMps");
  finiteVector3(config.sensors.positionBiasM, "sensors.positionBiasM");
  validateRate(config.sensors.sensorRateHz, config.physicsDtS, "sensors.sensorRateHz");

  if (!["fixed", "alpha-beta", "predictive", "mpc"].includes(config.controller.algorithm)) {
    throw new RangeError("controller.algorithm 不是受支持的算法模式");
  }
  validateRate(config.controller.controlRateHz, config.physicsDtS, "controller.controlRateHz");
  validateRate(config.controller.telemetryRateHz, config.physicsDtS, "controller.telemetryRateHz");
  validateRate(config.controller.netControlRateHz, config.physicsDtS, "controller.netControlRateHz");
  nonNegative(config.controller.rocketPositionKp, "controller.rocketPositionKp");
  nonNegative(config.controller.rocketVelocityKd, "controller.rocketVelocityKd");
  nonNegative(config.controller.verticalVelocityKp, "controller.verticalVelocityKp");
  nonNegative(config.controller.attitudeKp, "controller.attitudeKp");
  nonNegative(config.controller.attitudeKd, "controller.attitudeKd");
  nonNegative(config.controller.netCenterKp, "controller.netCenterKp");
  nonNegative(config.controller.netCenterKd, "controller.netCenterKd");
  positive(config.controller.maxCaptureSpeedMps, "controller.maxCaptureSpeedMps");
  const maximumTilt = nonNegative(config.controller.maxCaptureTiltRad, "controller.maxCaptureTiltRad");
  if (maximumTilt > Math.PI / 2) throw new RangeError("controller.maxCaptureTiltRad 不得超过 π/2");
  nonNegative(config.controller.requiredApertureMarginM, "controller.requiredApertureMarginM");
  positive(config.controller.staleTelemetryAbortS, "controller.staleTelemetryAbortS");
  positive(config.controller.prediction.stepS, "controller.prediction.stepS");
  positive(config.controller.prediction.maximumHorizonS, "controller.prediction.maximumHorizonS");
  if (config.controller.prediction.stepS > config.controller.prediction.maximumHorizonS) {
    throw new RangeError("controller.prediction.stepS 不得大于 maximumHorizonS");
  }
  positive(config.controller.prediction.confidenceSigma, "controller.prediction.confidenceSigma");
  nonNegative(config.controller.guidance.captureDescentSpeedMps, "controller.guidance.captureDescentSpeedMps");
  positive(config.controller.guidance.maximumDescentSpeedMps, "controller.guidance.maximumDescentSpeedMps");
  if (config.controller.guidance.maximumDescentSpeedMps < config.controller.guidance.captureDescentSpeedMps) {
    throw new RangeError("controller.guidance.maximumDescentSpeedMps 不得小于捕获下降速度");
  }
  positive(config.controller.guidance.brakingAccelerationMps2, "controller.guidance.brakingAccelerationMps2");
  nonNegative(config.controller.guidance.engineCutoffHeightM, "controller.guidance.engineCutoffHeightM");
  nonNegative(config.controller.tension.kp, "controller.tension.kp");
  nonNegative(config.controller.tension.ki, "controller.tension.ki");
  positive(config.controller.tension.integralLimitNs, "controller.tension.integralLimitNs");
  validateRate(config.controller.mpc.planRateHz, config.physicsDtS, "controller.mpc.planRateHz");
  positive(config.controller.mpc.stepS, "controller.mpc.stepS");
  if (!Number.isSafeInteger(config.controller.mpc.horizonSteps) || config.controller.mpc.horizonSteps <= 0) {
    throw new RangeError("controller.mpc.horizonSteps 必须是正整数");
  }
  if (!Number.isSafeInteger(config.controller.mpc.maximumIterations) || config.controller.mpc.maximumIterations <= 0) {
    throw new RangeError("controller.mpc.maximumIterations 必须是正整数");
  }
  positive(config.controller.mpc.convergenceTolerance, "controller.mpc.convergenceTolerance");

  validateLink(config.radio, "radio");
  validateLink(config.fieldbus, "fieldbus");

  const faultEntries = Object.entries(config.faults) as Array<
    [keyof ScenarioConfig["faults"], ScenarioConfig["faults"][keyof ScenarioConfig["faults"]]]
  >;
  for (const [label, fault] of faultEntries) {
    ensureBoolean(fault.enabled, `faults.${label}.enabled`);
    nonNegative(fault.startTimeS, `faults.${label}.startTimeS`);
    positive(fault.durationS, `faults.${label}.durationS`);
  }
  if (!["winch-x-negative", "winch-x-positive", "winch-y-negative", "winch-y-positive"].includes(
    config.faults.winchStuck.node
  )) {
    throw new RangeError("faults.winchStuck.node 不是受支持的绞盘节点");
  }
  finiteVector3(config.faults.sensorBiasStep.deltaM, "faults.sensorBiasStep.deltaM");
  probability(config.faults.thrustScale.scale, "faults.thrustScale.scale");
  assertParameterSources(config.parameterSources, "parameterSources");
};

/** Creates the stable, versioned interchange envelope used by the browser. */
export const createScenarioDocument = (config: ScenarioConfig): ScenarioDocument => {
  validateScenarioConfig(config);
  return {
    format: SCENARIO_DOCUMENT_FORMAT,
    documentVersion: 3,
    modelVersion: SIMULATION_MODEL_VERSION,
    configFingerprint: fingerprintScenarioConfig(config),
    notice: "公开机理代理模型场景，不是官方型号参数",
    config: structuredClone(config)
  };
};

/** Accepts v1/v2 configs and envelopes, then upgrades them to strict v3. */
export const migrateScenarioDocument = (input: unknown): ScenarioMigrationResult => {
  const { candidate, sourceDocumentVersion, sourceFingerprint } = extractConfigCandidate(input);
  const sourceSchemaVersion = candidate.schemaVersion === undefined
    ? 1
    : finite(candidate.schemaVersion, "schemaVersion");
  if (!Number.isSafeInteger(sourceSchemaVersion) || sourceSchemaVersion < 1) {
    throw new RangeError("无法识别的 schemaVersion");
  }
  if (sourceSchemaVersion > CURRENT_SCENARIO_SCHEMA_VERSION) {
    throw new RangeError(
      `场景 schemaVersion=${sourceSchemaVersion} 高于当前支持的 ${CURRENT_SCENARIO_SCHEMA_VERSION}`
    );
  }
  if (sourceDocumentVersion === 2 && sourceSchemaVersion !== 2) {
    throw new RangeError("documentVersion 2 必须使用 schemaVersion 2");
  }
  if (sourceDocumentVersion === 3 && sourceSchemaVersion !== CURRENT_SCENARIO_SCHEMA_VERSION) {
    throw new RangeError("documentVersion 3 必须使用 schemaVersion 3");
  }
  if (sourceDocumentVersion === 3) {
    validateScenarioConfig(candidate as unknown as ScenarioConfig);
  }
  if (sourceDocumentVersion !== null && sourceDocumentVersion >= 2) {
    if (sourceFingerprint === null) {
      throw new TypeError(`当前 v${sourceDocumentVersion} 场景文档缺少 configFingerprint`);
    }
    const incomingFingerprint = fingerprintScenarioConfig(candidate as unknown as ScenarioConfig);
    if (sourceFingerprint !== incomingFingerprint) {
      throw new RangeError(
        `configFingerprint 不匹配：文件声明 ${sourceFingerprint}，实际为 ${incomingFingerprint}`
      );
    }
  }

  const isLegacy = sourceSchemaVersion < CURRENT_SCENARIO_SCHEMA_VERSION || sourceDocumentVersion === 1;
  const baseline = createNominalScenario() as unknown as Record<string, unknown>;
  const config = (isLegacy
    ? mergeRecord(baseline, candidate)
    : structuredClone(candidate)) as unknown as ScenarioConfig;
  config.schemaVersion = CURRENT_SCENARIO_SCHEMA_VERSION;

  const warnings: string[] = [];
  if (sourceDocumentVersion === 1) {
    warnings.push("已将 v0.2 交换文档补齐为 documentVersion 3");
  }
  if (sourceSchemaVersion < 2) {
    warnings.push("已从 schema v1 补入显式故障计划；所有新增故障默认关闭");
  }
  if (sourceSchemaVersion < 3) {
    warnings.push("已从 schema v2 补入制导预测、主动张力和 MPC 研究参数");
  }
  if (isLegacy && !("parameterSources" in candidate)) {
    warnings.push("原文件缺少参数来源，已用标称代理场景的来源说明补齐");
  }

  validateScenarioConfig(config);

  return {
    config,
    sourceDocumentVersion,
    targetDocumentVersion: 3,
    sourceSchemaVersion,
    targetSchemaVersion: CURRENT_SCENARIO_SCHEMA_VERSION,
    migrated: isLegacy,
    warnings
  };
};
