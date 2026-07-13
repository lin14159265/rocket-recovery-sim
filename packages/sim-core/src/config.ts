import type { ParameterSource, ScenarioConfig } from "./contracts";

const source = (status: ParameterSource["status"], sourceText: string, note: string): ParameterSource => ({
  status,
  source: sourceText,
  note
});

export const createNominalScenario = (): ScenarioConfig => ({
  schemaVersion: 1,
  id: "nominal-cooperative",
  name: "标称协同捕获",
  description: "公开机理约束下的候选闭环；数值参数为截图标定或研究假设。",
  seed: 20260710,
  durationS: 27,
  physicsDtS: 0.002,
  rocket: {
    massKg: 40_000,
    lengthM: 43,
    radiusM: 2.5,
    inertiaKgM2: [6_226_000, 6_226_000, 125_000],
    initialPositionM: [7, -5, 891],
    initialVelocityMps: [1.4, -0.8, -58],
    initialAttitudeWxyz: [1, 0, 0, 0],
    initialAngularVelocityRadps: [0.004, -0.006, 0.002],
    thrustMaxN: 980_000,
    thrustTimeConstantS: 0.12,
    torqueMaxNm: 1_500_000,
    attitudeTimeConstantS: 0.08,
    dragCoefficient: 0.72,
    referenceAreaM2: 19.63,
    lateralAccelerationLimitMps2: 3.5
  },
  platform: {
    capturePlaneZ: 45,
    frameHalfWidthM: 28,
    frameHalfDepthM: 24,
    frameHeightM: 70,
    surgeAmplitudeM: 0.8,
    swayAmplitudeM: 0.55,
    heaveAmplitudeM: 0.3,
    rollAmplitudeRad: 0.018,
    pitchAmplitudeRad: 0.014,
    wavePeriodS: 8.5
  },
  net: {
    openHalfSpacingM: 21,
    closedHalfSpacingM: 3,
    closureDurationS: 5.5,
    centerTravelLimitM: 11,
    totalStiffnessNpm: 80_000,
    totalDampingNspm: 105_000,
    lateralStiffnessNpm: 38_000,
    lateralDampingNspm: 62_000,
    totalStrengthLimitN: 1_050_000,
    arrestDistanceM: 8,
    winchMaxSpeedMps: 6.2,
    winchMaxAccelerationMps2: 12,
    winchTimeConstantS: 0.08
  },
  environment: {
    gravityMps2: 9.80665,
    airDensityKgpm3: 1.12,
    meanWindMps: [3.5, -2.2, 0],
    gustSigmaMps: 1.8,
    gustTimeConstantS: 2.4
  },
  sensors: {
    rocketPositionNoiseM: 0.35,
    rocketVelocityNoiseMps: 0.12,
    groundPositionNoiseM: 0.75,
    groundVelocityNoiseMps: 0.25,
    positionBiasM: [0.15, -0.12, 0.08],
    sensorRateHz: 100
  },
  controller: {
    algorithm: "predictive",
    controlRateHz: 100,
    telemetryRateHz: 20,
    netControlRateHz: 100,
    rocketPositionKp: 0.19,
    rocketVelocityKd: 0.78,
    verticalVelocityKp: 0.85,
    attitudeKp: 6_000_000,
    attitudeKd: 10_000_000,
    netCenterKp: 1.8,
    netCenterKd: 1.2,
    maxCaptureSpeedMps: 15,
    maxCaptureTiltRad: 0.21,
    requiredApertureMarginM: 0.3,
    staleTelemetryAbortS: 0.8
  },
  radio: {
    baseLatencyMs: 45,
    jitterMs: 15,
    lossRate: 0.02,
    duplicateRate: 0.004,
    corruptionRate: 0.001,
    bandwidthPacketsPerSecond: 80
  },
  fieldbus: {
    baseLatencyMs: 2,
    jitterMs: 1,
    lossRate: 0.001,
    duplicateRate: 0.0005,
    corruptionRate: 0.0002,
    bandwidthPacketsPerSecond: 1_000
  },
  parameterSources: {
    "rocket.lengthM": source("public-estimate", "公开整箭长度约 63 m；一级长度未公开", "43 m 为终端代理模型尺寸"),
    "rocket.radiusM": source("official", "官方公开整箭直径 5 m", "代理模型半径取 2.5 m"),
    "rocket.massKg": source("calibrated", "用户截图的稳态约 400 kN 与约 1 g", "仅为等效回收质量，不是官方一级质量"),
    "net.openHalfSpacingM": source("calibrated", "用户截图", "不是官方网系尺寸"),
    "net.closedHalfSpacingM": source("calibrated", "用户截图", "不是官方捕获阈值"),
    "net.totalStiffnessNpm": source("calibrated", "用户截图与等效停止距离", "四绳总等效值"),
    "net.totalDampingNspm": source("calibrated", "约 9 m/s 捕获速度对应约 0.95 MN 阻尼峰值", "四绳总等效值"),
    "net.winchMaxSpeedMps": source("assumed", "真实绞盘运动能力未公开", "满足 21 m 到 3 m 的 5.5 s 最小加加速度轨迹"),
    "controller.attitudeGains": source("assumed", "真实姿态控制律与带宽未公开", "按代理刚体惯量调至阻尼充足且不超过力矩限幅"),
    "controller.requiredApertureMarginM": source("assumed", "真实挂索几何与允许偏差未公开", "等效刚体捕获判据的研究余量"),
    radio: source("assumed", "真实通信体制未公开", "用于压力测试的候选链路"),
    sensors: source("assumed", "真实传感器配置未公开", "用于候选估计算法比较")
  }
});

export const createPresetScenario = (
  preset: "nominal" | "late-close" | "low-damping" | "overload" | "radio-blackout"
): ScenarioConfig => {
  const config = structuredClone(createNominalScenario());
  if (preset === "late-close") {
    config.id = "late-close";
    config.name = "收网过晚";
    config.net.closureDurationS = 2.6;
    config.controller.algorithm = "fixed";
  } else if (preset === "low-damping") {
    config.id = "low-damping";
    config.name = "阻尼不足";
    config.net.totalDampingNspm = 24_000;
  } else if (preset === "overload") {
    config.id = "overload";
    config.name = "超载断绳";
    config.rocket.initialVelocityMps[2] = -70;
    config.net.totalStrengthLimitN = 720_000;
  } else if (preset === "radio-blackout") {
    config.id = "radio-blackout";
    config.name = "无线链路恶化";
    config.radio.lossRate = 0.38;
    config.radio.baseLatencyMs = 220;
    config.radio.jitterMs = 90;
  }
  return config;
};
