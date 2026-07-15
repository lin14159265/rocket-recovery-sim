import type { ParameterSource, ScenarioConfig } from "./contracts";
import { crc32, stableStringify } from "./comms/protocol";

const source = (status: ParameterSource["status"], sourceText: string, note: string): ParameterSource => ({
  status,
  source: sourceText,
  note
});

export const fingerprintScenarioConfig = (config: ScenarioConfig): string =>
  crc32(stableStringify(config)).toString(16).padStart(8, "0");

export const createNominalScenario = (): ScenarioConfig => ({
  schemaVersion: 3,
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
    winchTimeConstantS: 0.08,
    activeDampingMinNspm: 12_000,
    activeDampingMaxNspm: 60_000,
    activeDampingRateNspmPerS: 100_000
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
    netCenterKp: 3.2,
    netCenterKd: 1.6,
    maxCaptureSpeedMps: 15,
    maxCaptureTiltRad: 0.21,
    requiredApertureMarginM: 0.3,
    staleTelemetryAbortS: 0.8,
    prediction: {
      stepS: 0.05,
      maximumHorizonS: 30,
      confidenceSigma: 3
    },
    guidance: {
      captureDescentSpeedMps: 6,
      maximumDescentSpeedMps: 75,
      brakingAccelerationMps2: 1.95,
      engineCutoffHeightM: 0.7
    },
    tension: {
      kp: 0.25,
      ki: 1.25,
      integralLimitNs: 250_000
    },
    mpc: {
      planRateHz: 20,
      stepS: 0.2,
      horizonSteps: 40,
      maximumIterations: 40,
      convergenceTolerance: 0.02
    }
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
  faults: {
    radioBlackout: { enabled: false, startTimeS: 10, durationS: 2 },
    winchStuck: {
      enabled: false,
      node: "winch-x-positive",
      startTimeS: 14,
      durationS: 8
    },
    sensorBiasStep: {
      enabled: false,
      startTimeS: 8,
      durationS: 6,
      deltaM: [1, -0.6, 0.3]
    },
    thrustScale: {
      enabled: false,
      startTimeS: 10,
      durationS: 6,
      scale: 0.65
    }
  },
  parameterSources: {
    "rocket.lengthM": source("public-estimate", "公开整箭长度约 63 m；一级长度未公开", "43 m 为终端代理模型尺寸"),
    "rocket.radiusM": source("official", "官方公开整箭直径 5 m", "代理模型半径取 2.5 m"),
    "rocket.massKg": source("calibrated", "用户截图的稳态约 400 kN 与约 1 g", "仅为等效回收质量，不是官方一级质量"),
    "rocket.initialVelocityMps.2": source("assumed", "公开报道未披露入网垂向速度", "-58 m/s 为终端下降代理初值；敏感性分析按幅值扰动"),
    "net.openHalfSpacingM": source("calibrated", "用户截图", "不是官方网系尺寸"),
    "net.closedHalfSpacingM": source("calibrated", "用户截图", "不是官方捕获阈值"),
    "net.totalStiffnessNpm": source("calibrated", "用户截图与等效停止距离", "四绳总等效值"),
    "net.totalDampingNspm": source("calibrated", "约 9 m/s 捕获速度对应约 0.95 MN 阻尼峰值", "四绳总等效值"),
    "net.totalStrengthLimitN": source("assumed", "真实网系极限载荷未公开", "仅作为代理断绳状态阈值，不是结构许用载荷"),
    "net.winchMaxSpeedMps": source("assumed", "真实绞盘运动能力未公开", "满足 21 m 到 3 m 的 5.5 s 最小加加速度轨迹"),
    "net.activeDamping": source("assumed", "真实缓冲阻拦索和制动器参数未公开", "四节点主动阻尼代理范围，仅用于候选张力闭环"),
    "controller.attitudeGains": source("assumed", "真实姿态控制律与带宽未公开", "按代理刚体惯量调至阻尼充足且不超过力矩限幅"),
    "controller.requiredApertureMarginM": source("assumed", "真实挂索几何与允许偏差未公开", "等效刚体捕获判据的研究余量"),
    "radio.baseLatencyMs": source("assumed", "真实无线链路时延未公开", "45 ms 为闭环压力测试的代理基线"),
    "radio.lossRate": source("assumed", "真实无线链路可靠性未公开", "2% 为随机丢包代理基线"),
    "sensors.rocketPositionNoiseM": source("assumed", "真实箭上导航精度未公开", "0.35 m 为估计器对照所用噪声标准差"),
    "controller.netCenterKp": source("calibrated", "依据当前代理平台与绞盘响应整定", "仅保证本模型闭环阻尼与限幅行为"),
    "controller.staleTelemetryAbortS": source("assumed", "真实失联处置门限未公开", "0.8 s 为代理监督状态机中止阈值"),
    "controller.prediction": source("assumed", "真实交会预测器未公开", "50 ms 制导感知滚动、30 s 上限和 3σ 包络为研究设置"),
    "controller.guidance": source("calibrated", "公开资料未披露终端制导包络", "按当前代理初态整定的速度包络和关机高度"),
    "controller.tension": source("calibrated", "依据当前四绳等效模型局部整定", "PI 参数仅保证代理执行器限幅和抗积分饱和行为"),
    "controller.mpc": source("assumed", "真实协同优化器未公开", "确定性投影梯度 QP 的研究预算"),
    radio: source("assumed", "真实通信体制未公开", "用于压力测试的候选链路"),
    sensors: source("assumed", "真实传感器配置未公开", "用于候选估计算法比较"),
    faults: source("assumed", "故障时序与幅值未公开", "仅用于闭环鲁棒性压力试验")
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
