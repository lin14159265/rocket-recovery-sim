import { useMemo, useRef, useState } from "react";
import { buildParameterTraceability, WINCH_IDS } from "@recovery/sim-core";
import type {
  AlgorithmMode,
  NetworkStats,
  ParameterSource,
  ParameterTraceabilityResult,
  ScenarioConfig,
  ScenarioFaultConfig,
  SimulationRun,
  SimulationSnapshot,
  ValidationSuiteResult,
  WinchNodeId
} from "@recovery/sim-core";
import {
  AlertTriangle,
  Check,
  CircleGauge,
  LoaderCircle,
  Download,
  PlayCircle,
  Upload,
  RefreshCw,
  Square,
  ShieldCheck,
  Wifi
} from "lucide-react";
import type {
  DashboardParameterKey,
  DashboardPreset,
  InspectorTab,
  MonteCarloSummary,
  TaskProgress
} from "./Dashboard";

export interface InspectorProps {
  tab: InspectorTab;
  run: SimulationRun | null;
  frame: SimulationSnapshot | null;
  config: ScenarioConfig;
  busy: boolean;
  dirty: boolean;
  onParameterChange: (path: DashboardParameterKey, value: number) => void;
  onFaultConfigChange: (faults: ScenarioFaultConfig) => void;
  onAlgorithmChange: (algorithm: AlgorithmMode) => void;
  onPresetChange: (preset: DashboardPreset) => void;
  onSeedChange: (seed: number) => void;
  onRerun: () => void;
  onImportScenario: (file: File) => void;
  importNotice: string | null;
  onExportScenario: () => void;
  onExportRun: () => void;
  onRunMonteCarlo: ((count: number) => void) | undefined;
  onRunValidation: (() => void) | undefined;
  onRunSensitivity: (() => void) | undefined;
  onCancelTask: (() => void) | undefined;
  monteCarloSummary: MonteCarloSummary | null;
  validationResult: ValidationSuiteResult | null;
  traceabilityResult: ParameterTraceabilityResult | null;
  activeTask: TaskProgress["task"] | null;
  taskProgress: TaskProgress | null;
}

interface ParameterControlProps {
  path: DashboardParameterKey;
  label: string;
  unit: string;
  rawValue: number;
  min: number;
  max: number;
  step: number;
  toDisplay?: (value: number) => number;
  fromDisplay?: (value: number) => number;
  source?: ParameterSource | undefined;
  disabled: boolean;
  onChange: (path: DashboardParameterKey, value: number) => void;
}

const identity = (value: number): number => value;

function SourceTag({ source }: { source?: ParameterSource | undefined }) {
  if (source === undefined) return null;
  const labels: Record<ParameterSource["status"], string> = {
    official: "公开确认",
    "public-estimate": "公开估计",
    assumed: "研究假设",
    calibrated: "代理标定"
  };
  return (
    <span className={`source-tag source-tag--${source.status}`} title={`${source.source}；${source.note}`}>
      {labels[source.status]}
    </span>
  );
}

function ParameterControl({
  path,
  label,
  unit,
  rawValue,
  min,
  max,
  step,
  toDisplay = identity,
  fromDisplay = identity,
  source,
  disabled,
  onChange
}: ParameterControlProps) {
  const value = toDisplay(rawValue);
  const inputId = `parameter-${path.replaceAll(".", "-")}`;
  const update = (nextValue: number) => {
    if (Number.isFinite(nextValue)) onChange(path, fromDisplay(nextValue));
  };

  return (
    <div className="parameter-control">
      <div className="parameter-label-row">
        <label htmlFor={inputId}>{label}</label>
        <SourceTag source={source} />
      </div>
      <div className="parameter-input-row">
        <input
          id={inputId}
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          disabled={disabled}
          onChange={(event) => update(event.currentTarget.valueAsNumber)}
          aria-label={`${label}，单位 ${unit}`}
        />
        <label className="numeric-input">
          <span className="sr-only">{label}</span>
          <input
            type="number"
            min={min}
            max={max}
            step={step}
            value={Number.isInteger(step) ? value.toFixed(0) : value.toFixed(2)}
            disabled={disabled}
            onChange={(event) => update(event.currentTarget.valueAsNumber)}
          />
          <span>{unit}</span>
        </label>
      </div>
    </div>
  );
}

const PRESETS: { id: DashboardPreset; label: string; detail: string }[] = [
  { id: "nominal", label: "标称捕获", detail: "预测协同、标称链路" },
  { id: "late-close", label: "收网过晚", detail: "固定策略与短收网窗口" },
  { id: "low-damping", label: "阻尼不足", detail: "观察回弹和峰值载荷" },
  { id: "overload", label: "超载断绳", detail: "高速接触与强度上限" },
  { id: "radio-blackout", label: "链路恶化", detail: "高时延、抖动与丢包" }
];

function ScenarioInspector({
  config,
  busy,
  onParameterChange,
  onPresetChange
}: Pick<InspectorProps, "config" | "busy" | "onParameterChange" | "onPresetChange">) {
  const activePreset = config.id === "nominal-cooperative" ? "nominal" : config.id;
  return (
    <div className="inspector-scroll">
      <section className="inspector-section">
        <div className="inspector-heading">
          <div>
            <h2>场景预设</h2>
            <p>每次切换都应由上层重新运行确定性内核。</p>
          </div>
        </div>
        <div className="preset-list">
          {PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              className={activePreset === preset.id ? "preset-button is-active" : "preset-button"}
              disabled={busy}
              onClick={() => onPresetChange(preset.id)}
            >
              <span><strong>{preset.label}</strong><small>{preset.detail}</small></span>
              {activePreset === preset.id ? <Check size={17} /> : null}
            </button>
          ))}
        </div>
      </section>

      <section className="inspector-section">
        <div className="inspector-heading">
          <div>
            <h2>基础参数</h2>
            <p>数值来源标识来自场景配置，不把截图参数当作官方数据。</p>
          </div>
        </div>
        <ParameterControl
          path="rocket.massKg"
          label="等效质量"
          unit="t"
          rawValue={config.rocket.massKg}
          min={20}
          max={80}
          step={1}
          toDisplay={(value) => value / 1_000}
          fromDisplay={(value) => value * 1_000}
          source={config.parameterSources["rocket.massKg"]}
          disabled={busy}
          onChange={onParameterChange}
        />
        <ParameterControl
          path="rocket.initialVelocityMps.2"
          label="初始下降速度"
          unit="m/s"
          rawValue={config.rocket.initialVelocityMps[2]}
          min={35}
          max={85}
          step={1}
          toDisplay={(value) => Math.abs(value)}
          fromDisplay={(value) => -Math.abs(value)}
          disabled={busy}
          onChange={onParameterChange}
        />
        <ParameterControl
          path="rocket.thrustMaxN"
          label="最大推力"
          unit="kN"
          rawValue={config.rocket.thrustMaxN}
          min={400}
          max={1_400}
          step={10}
          toDisplay={(value) => value / 1_000}
          fromDisplay={(value) => value * 1_000}
          disabled={busy}
          onChange={onParameterChange}
        />
        <ParameterControl
          path="net.closureDurationS"
          label="收网持续"
          unit="s"
          rawValue={config.net.closureDurationS}
          min={1.5}
          max={9}
          step={0.1}
          disabled={busy}
          onChange={onParameterChange}
        />
        <ParameterControl
          path="net.totalStiffnessNpm"
          label="网绳等效刚度"
          unit="kN/m"
          rawValue={config.net.totalStiffnessNpm}
          min={20}
          max={160}
          step={2}
          toDisplay={(value) => value / 1_000}
          fromDisplay={(value) => value * 1_000}
          source={config.parameterSources["net.totalStiffnessNpm"]}
          disabled={busy}
          onChange={onParameterChange}
        />
        <ParameterControl
          path="net.totalDampingNspm"
          label="网绳等效阻尼"
          unit="kN·s/m"
          rawValue={config.net.totalDampingNspm}
          min={10}
          max={200}
          step={2}
          toDisplay={(value) => value / 1_000}
          fromDisplay={(value) => value * 1_000}
          source={config.parameterSources["net.totalDampingNspm"]}
          disabled={busy}
          onChange={onParameterChange}
        />
        <ParameterControl
          path="net.totalStrengthLimitN"
          label="总强度上限"
          unit="MN"
          rawValue={config.net.totalStrengthLimitN}
          min={0.5}
          max={1.8}
          step={0.01}
          toDisplay={(value) => value / 1_000_000}
          fromDisplay={(value) => value * 1_000_000}
          disabled={busy}
          onChange={onParameterChange}
        />
      </section>
    </div>
  );
}

function percentile(values: readonly number[], probability: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * probability) - 1));
  return sorted[index] ?? null;
}

const rate = (part: number, total: number): number | null => total === 0 ? null : part / total;

const formatNumber = (value: number | null, digits = 1): string =>
  value === null || !Number.isFinite(value) ? "—" : value.toFixed(digits);

function LinkSummary({ name, stats, tone }: { name: string; stats: NetworkStats | null; tone: "cyan" | "green" }) {
  const deliveryRate = stats === null ? null : rate(stats.delivered, stats.sent);
  const p95 = stats === null ? null : percentile(stats.latencySamplesMs, 0.95);
  return (
    <div className={`link-summary link-summary--${tone}`}>
      <div className="link-summary-title">
        <Wifi size={17} />
        <strong>{name}</strong>
        <span>{stats === null ? "等待数据" : "在线统计"}</span>
      </div>
      <div className="stat-grid">
        <div><span>投递率</span><strong>{deliveryRate === null ? "—" : `${(deliveryRate * 100).toFixed(1)}%`}</strong></div>
        <div><span>P95 时延</span><strong>{formatNumber(p95)} <small>ms</small></strong></div>
        <div><span>已发送</span><strong>{stats?.sent ?? "—"}</strong></div>
        <div><span>已投递</span><strong>{stats?.delivered ?? "—"}</strong></div>
        <div><span>丢包</span><strong>{stats?.dropped ?? "—"}</strong></div>
        <div><span>过期/拒重</span><strong>{stats === null ? "—" : stats.expired + stats.rejectedDuplicate}</strong></div>
      </div>
    </div>
  );
}

function FaultSwitch({
  title,
  detail,
  enabled,
  disabled,
  onChange
}: {
  title: string;
  detail: string;
  enabled: boolean;
  disabled: boolean;
  onChange: (enabled: boolean) => void;
}) {
  return (
    <label className={enabled ? "fault-switch is-enabled" : "fault-switch"}>
      <span><strong>{title}</strong><small>{detail}</small></span>
      <input
        type="checkbox"
        checked={enabled}
        disabled={disabled}
        onChange={(event) => onChange(event.currentTarget.checked)}
      />
    </label>
  );
}

function CommunicationsInspector({
  frame,
  config,
  busy,
  onParameterChange,
  onFaultConfigChange
}: Pick<InspectorProps, "frame" | "config" | "busy" | "onParameterChange" | "onFaultConfigChange">) {
  const updateFaults = (mutate: (faults: ScenarioFaultConfig) => void) => {
    const faults = structuredClone(config.faults);
    mutate(faults);
    onFaultConfigChange(faults);
  };
  return (
    <div className="inspector-scroll">
      <section className="inspector-section">
        <div className="inspector-heading">
          <div>
            <h2>链路健康</h2>
            <p>消息包含序号、产生/失效 tick 与 CRC；这里呈现内核实际统计。</p>
          </div>
        </div>
        <LinkSummary name="箭体 ↔ 协调器无线链路" stats={frame?.radioStats ?? null} tone="cyan" />
        <LinkSummary name="协调器 ↔ 四绞盘现场总线" stats={frame?.fieldbusStats ?? null} tone="green" />
      </section>

      <section className="inspector-section">
        <div className="inspector-heading"><div><h2>链路随机故障</h2><p>概率参数在每次重跑时按同一 seed 确定性复现。</p></div></div>
        <h3 className="subsection-label">无线代理链路</h3>
        <ParameterControl path="radio.baseLatencyMs" label="基础时延" unit="ms" rawValue={config.radio.baseLatencyMs} min={0} max={400} step={5} source={config.parameterSources.radio} disabled={busy} onChange={onParameterChange} />
        <ParameterControl path="radio.jitterMs" label="时延抖动" unit="ms" rawValue={config.radio.jitterMs} min={0} max={180} step={2} disabled={busy} onChange={onParameterChange} />
        <ParameterControl path="radio.lossRate" label="丢包率" unit="%" rawValue={config.radio.lossRate} min={0} max={60} step={0.5} toDisplay={(value) => value * 100} fromDisplay={(value) => value / 100} disabled={busy} onChange={onParameterChange} />
        <ParameterControl path="radio.duplicateRate" label="重复包率" unit="%" rawValue={config.radio.duplicateRate} min={0} max={20} step={0.1} toDisplay={(value) => value * 100} fromDisplay={(value) => value / 100} disabled={busy} onChange={onParameterChange} />
        <ParameterControl path="radio.corruptionRate" label="CRC 损坏率" unit="%" rawValue={config.radio.corruptionRate} min={0} max={10} step={0.1} toDisplay={(value) => value * 100} fromDisplay={(value) => value / 100} disabled={busy} onChange={onParameterChange} />
        <h3 className="subsection-label">现场总线代理</h3>
        <ParameterControl path="fieldbus.baseLatencyMs" label="基础时延" unit="ms" rawValue={config.fieldbus.baseLatencyMs} min={0} max={40} step={0.5} disabled={busy} onChange={onParameterChange} />
        <ParameterControl path="fieldbus.jitterMs" label="时延抖动" unit="ms" rawValue={config.fieldbus.jitterMs} min={0} max={20} step={0.5} disabled={busy} onChange={onParameterChange} />
        <ParameterControl path="fieldbus.lossRate" label="丢包率" unit="%" rawValue={config.fieldbus.lossRate} min={0} max={15} step={0.1} toDisplay={(value) => value * 100} fromDisplay={(value) => value / 100} disabled={busy} onChange={onParameterChange} />
        <ParameterControl path="fieldbus.duplicateRate" label="重复包率" unit="%" rawValue={config.fieldbus.duplicateRate} min={0} max={10} step={0.1} toDisplay={(value) => value * 100} fromDisplay={(value) => value / 100} disabled={busy} onChange={onParameterChange} />
        <ParameterControl path="fieldbus.corruptionRate" label="CRC 损坏率" unit="%" rawValue={config.fieldbus.corruptionRate} min={0} max={5} step={0.05} toDisplay={(value) => value * 100} fromDisplay={(value) => value / 100} disabled={busy} onChange={onParameterChange} />
      </section>

      <section className="inspector-section">
        <div className="inspector-heading"><div><h2>定时故障计划</h2><p>所有故障均写入场景配置和事件日志；默认关闭。</p></div></div>
        <div className="fault-plan-list">
          <article className="fault-plan-card">
            <FaultSwitch title="无线静默窗口" detail="窗口内抑制箭地双向发包" enabled={config.faults.radioBlackout.enabled} disabled={busy} onChange={(enabled) => updateFaults((faults) => { faults.radioBlackout.enabled = enabled; })} />
            <ParameterControl path="faults.radioBlackout.startTimeS" label="开始时刻" unit="s" rawValue={config.faults.radioBlackout.startTimeS} min={0} max={config.durationS} step={0.1} disabled={busy} onChange={onParameterChange} />
            <ParameterControl path="faults.radioBlackout.durationS" label="持续时间" unit="s" rawValue={config.faults.radioBlackout.durationS} min={0.1} max={10} step={0.1} disabled={busy} onChange={onParameterChange} />
          </article>
          <article className="fault-plan-card">
            <FaultSwitch title="单绞盘卡滞" detail="指定轴在窗口内保持当前位置" enabled={config.faults.winchStuck.enabled} disabled={busy} onChange={(enabled) => updateFaults((faults) => { faults.winchStuck.enabled = enabled; })} />
            <label className="fault-select"><span>故障节点</span><select value={config.faults.winchStuck.node} disabled={busy} onChange={(event) => updateFaults((faults) => { faults.winchStuck.node = event.currentTarget.value as WinchNodeId; })}><option value="winch-x-negative">X− 绞盘</option><option value="winch-x-positive">X+ 绞盘</option><option value="winch-y-negative">Y− 绞盘</option><option value="winch-y-positive">Y+ 绞盘</option></select></label>
            <ParameterControl path="faults.winchStuck.startTimeS" label="开始时刻" unit="s" rawValue={config.faults.winchStuck.startTimeS} min={0} max={config.durationS} step={0.1} disabled={busy} onChange={onParameterChange} />
            <ParameterControl path="faults.winchStuck.durationS" label="持续时间" unit="s" rawValue={config.faults.winchStuck.durationS} min={0.1} max={15} step={0.1} disabled={busy} onChange={onParameterChange} />
          </article>
          <article className="fault-plan-card">
            <FaultSwitch title="导航偏置阶跃" detail="箭上位置解算叠加可控偏置" enabled={config.faults.sensorBiasStep.enabled} disabled={busy} onChange={(enabled) => updateFaults((faults) => { faults.sensorBiasStep.enabled = enabled; })} />
            <ParameterControl path="faults.sensorBiasStep.startTimeS" label="开始时刻" unit="s" rawValue={config.faults.sensorBiasStep.startTimeS} min={0} max={config.durationS} step={0.1} disabled={busy} onChange={onParameterChange} />
            <ParameterControl path="faults.sensorBiasStep.durationS" label="持续时间" unit="s" rawValue={config.faults.sensorBiasStep.durationS} min={0.1} max={15} step={0.1} disabled={busy} onChange={onParameterChange} />
            <ParameterControl path="faults.sensorBiasStep.deltaM.0" label="X 偏置" unit="m" rawValue={config.faults.sensorBiasStep.deltaM[0]} min={-5} max={5} step={0.1} disabled={busy} onChange={onParameterChange} />
            <ParameterControl path="faults.sensorBiasStep.deltaM.1" label="Y 偏置" unit="m" rawValue={config.faults.sensorBiasStep.deltaM[1]} min={-5} max={5} step={0.1} disabled={busy} onChange={onParameterChange} />
            <ParameterControl path="faults.sensorBiasStep.deltaM.2" label="Z 偏置" unit="m" rawValue={config.faults.sensorBiasStep.deltaM[2]} min={-5} max={5} step={0.1} disabled={busy} onChange={onParameterChange} />
          </article>
          <article className="fault-plan-card">
            <FaultSwitch title="推力降额" detail="窗口内按比例缩放控制器推力指令" enabled={config.faults.thrustScale.enabled} disabled={busy} onChange={(enabled) => updateFaults((faults) => { faults.thrustScale.enabled = enabled; })} />
            <ParameterControl path="faults.thrustScale.startTimeS" label="开始时刻" unit="s" rawValue={config.faults.thrustScale.startTimeS} min={0} max={config.durationS} step={0.1} disabled={busy} onChange={onParameterChange} />
            <ParameterControl path="faults.thrustScale.durationS" label="持续时间" unit="s" rawValue={config.faults.thrustScale.durationS} min={0.1} max={15} step={0.1} disabled={busy} onChange={onParameterChange} />
            <ParameterControl path="faults.thrustScale.scale" label="剩余推力" unit="%" rawValue={config.faults.thrustScale.scale} min={0} max={100} step={1} toDisplay={(value) => value * 100} fromDisplay={(value) => value / 100} disabled={busy} onChange={onParameterChange} />
          </article>
        </div>
      </section>
    </div>
  );
}

const ALGORITHMS: { id: AlgorithmMode; label: string; detail: string; cost: string }[] = [
  { id: "fixed", label: "固定网", detail: "不追踪预测，作为开环基线", cost: "O(1)" },
  { id: "alpha-beta", label: "α–β 基线", detail: "常速度估计与误差反馈", cost: "O(1)" },
  { id: "predictive", label: "预测 PD", detail: "制导感知滚动预测与带限网中心 PD", cost: "O(N)" },
  { id: "mpc", label: "约束 MPC", detail: "分层约束优化；异常时回退预测 PD", cost: "O(H×I)" }
];

const SUPERVISOR_FLOW = ["SEARCH", "TRACK", "SYNC", "ARMED", "CLOSING", "CONTACT", "ARREST", "SECURED"];

const WINCH_LABELS: Record<WinchNodeId, string> = {
  "winch-x-negative": "W1",
  "winch-x-positive": "W2",
  "winch-y-negative": "W3",
  "winch-y-positive": "W4"
};

const CONSTRAINT_LABELS: Record<string, string> = {
  "rocket-trust-region": "火箭信赖域",
  "rocket-lateral-acceleration": "横向加速度",
  "net-trust-region": "网中心信赖域",
  "winch-speed": "绞盘限速",
  "net-center-travel": "网中心行程",
  "closure-trust-region": "闭合率信赖域",
  "half-spacing": "半间距"
};

const FALLBACK_LABELS: Record<string, string> = {
  "": "无",
  "stale-input": "输入过期",
  "strength-proxy": "强度代理约束",
  "non-finite": "结果非有限",
  "not-converged": "未收敛"
};

function AlgorithmInspector({
  run,
  frame,
  config,
  busy,
  onParameterChange,
  onAlgorithmChange
}: Pick<InspectorProps, "run" | "frame" | "config" | "busy" | "onParameterChange" | "onAlgorithmChange">) {
  const estimateError = frame === null ? null : Math.hypot(
    frame.groundEstimate.positionM[0] - frame.rocket.positionM[0],
    frame.groundEstimate.positionM[1] - frame.rocket.positionM[1],
    frame.groundEstimate.positionM[2] - frame.rocket.positionM[2]
  );
  const planLeadTime = frame?.capturePlan === null || frame?.capturePlan === undefined
    ? null
    : Math.max(0, (frame.capturePlan.predictedInterceptTick - frame.tick) * config.physicsDtS);
  const currentTelemetry = frame === null
    ? null
    : run?.telemetry.findLast((sample) => sample.timeS <= frame.timeS) ?? null;
  const maxTension = frame === null ? null : Math.max(...frame.net.tensionsN) / 1_000;
  const selectedAlgorithm = ALGORITHMS.find((algorithm) => algorithm.id === config.controller.algorithm)
    ?? ALGORITHMS[2]!;
  const diagnostics = frame?.controlDiagnostics ?? null;
  const mpc = diagnostics?.mpc ?? null;
  const planVersion = frame?.capturePlan === null || frame?.capturePlan === undefined
    ? "无有效窗口"
    : `W-${String(frame.capturePlan.windowId).padStart(2, "0")} / R${frame.capturePlan.planRevision}`;
  const gateHasCommitted = frame !== null
    && ["ARMED", "CLOSING", "CONTACT", "ARREST", "SECURED"].includes(frame.supervisorState)
    && (run?.events.some((entry) => entry.tick <= frame.tick && entry.type === "CAPTURE_READY") ?? false);
  const vehicleReady = (diagnostics?.readiness.vehicle ?? false) || gateHasCommitted;
  const winchReady = (nodeId: WinchNodeId): boolean =>
    (diagnostics?.readiness.winches[nodeId] ?? false) || gateHasCommitted;
  const readyCount = Number(vehicleReady) + WINCH_IDS.reduce(
    (count, nodeId) => count + Number(winchReady(nodeId)),
    0
  );

  return (
    <div className="inspector-scroll">
      <section className="inspector-section">
        <div className="inspector-heading">
          <div>
            <h2>算法选择与复杂度</h2>
            <p>四种模式共享物理内核、扰动与 seed，复杂度按单次调度表示。</p>
          </div>
        </div>
        <div className="algorithm-list">
          {ALGORITHMS.map((algorithm) => (
            <button
              key={algorithm.id}
              type="button"
              className={config.controller.algorithm === algorithm.id ? "algorithm-button is-active" : "algorithm-button"}
              disabled={busy}
              onClick={() => onAlgorithmChange(algorithm.id)}
            >
              <strong>{algorithm.label}</strong>
              <code>{algorithm.cost}</code>
            </button>
          ))}
        </div>
        <p className="algorithm-description">{selectedAlgorithm.detail}</p>
      </section>

      <section className="inspector-section inspector-section--compact">
        <div className="inspector-heading">
          <div>
            <h2>MPC 求解健康度</h2>
            <p>安全状态机独立于优化器；异常时回退预测 PD。</p>
          </div>
        </div>
        {config.controller.algorithm !== "mpc" ? (
          <div className="inline-empty">
            <strong>当前未选择 MPC</strong>
            <span>切换到“约束 MPC”后显示迭代、残差、约束和回退原因。</span>
          </div>
        ) : mpc === null ? (
          <div className="inline-empty">
            <strong>等待 MPC 计划窗口</strong>
            <span>当前由预测 PD 与安全状态机保持闭环。</span>
          </div>
        ) : (
          <>
            <div className="solver-health-grid">
              <div><span>迭代</span><strong>{mpc.iterations} / {config.controller.mpc.maximumIterations}</strong></div>
              <div><span>求解状态</span><strong className={mpc.converged ? "is-good" : "is-warning"}>{mpc.converged ? "已收敛" : "未收敛"}</strong></div>
              <div><span>目标函数</span><strong>{formatNumber(mpc.objective, 2)}</strong></div>
              <div><span>最优性残差</span><strong>{formatNumber(mpc.optimalityResidual, 4)}</strong></div>
              <div><span>预测峰值载荷</span><strong>{formatNumber(mpc.projectedPeakLoadN / 1_000, 0)} <small>kN</small></strong></div>
              <div><span>累计回退</span><strong>{diagnostics?.mpcFallbackCount ?? 0}</strong></div>
              <div><span>终端误差 基线</span><strong>{formatNumber(mpc.baselineTerminalErrorM, 2)} <small>m</small></strong></div>
              <div><span>终端误差 优化后</span><strong>{formatNumber(mpc.optimizedTerminalErrorM, 2)} <small>m</small></strong></div>
            </div>
            <div className="constraint-row">
              <span>激活约束</span>
              <div>
                {mpc.activeConstraints.length === 0
                  ? <em>无</em>
                  : mpc.activeConstraints.map((constraint) => (
                    <strong key={constraint}>{CONSTRAINT_LABELS[constraint] ?? constraint}</strong>
                  ))}
              </div>
            </div>
            <div className="fallback-row">
              <span>本次回退</span>
              <strong className={mpc.fallbackReason === "" ? "is-good" : "is-warning"}>
                {FALLBACK_LABELS[mpc.fallbackReason] ?? mpc.fallbackReason}
              </strong>
            </div>
          </>
        )}
      </section>

      <section className="inspector-section inspector-section--compact">
        <div className="inspector-heading">
          <div>
            <h2>同版本 READY 门控</h2>
            <p>{planVersion} · {gateHasCommitted
              ? "五方同版本确认已锁定，当前状态不再重复握手。"
              : "仅同一窗口与修订的五端确认允许 COMMIT。"}</p>
          </div>
          <strong className={readyCount === 5 ? "ready-count is-ready" : "ready-count"}>
            {readyCount} / 5
          </strong>
        </div>
        <div className="readiness-matrix" aria-label="火箭与四个绞盘就绪状态">
          <div className={vehicleReady ? "is-ready" : ""}>
            <i><Check size={12} /></i><strong>箭体</strong><span>{vehicleReady ? (gateHasCommitted ? "LOCK" : "READY") : "WAIT"}</span>
          </div>
          {WINCH_IDS.map((nodeId) => {
            const ready = winchReady(nodeId);
            return (
              <div key={nodeId} className={ready ? "is-ready" : ""}>
                <i><Check size={12} /></i><strong>{WINCH_LABELS[nodeId]}</strong><span>{ready ? (gateHasCommitted ? "LOCK" : "READY") : "WAIT"}</span>
              </div>
            );
          })}
        </div>
      </section>

      <section className="inspector-section">
        <div className="inspector-heading">
          <div>
            <h2>闭环观察</h2>
            <p>真值仅用于界面评估；控制器只接收传感器与链路后的估计。</p>
          </div>
        </div>
        <div className="algorithm-state-card">
          <div className="state-card-head">
            <span>监督状态机</span>
            <strong>{frame?.supervisorState ?? "等待运行"}</strong>
          </div>
          <div className="state-rail" aria-label="监督状态机进度">
            {SUPERVISOR_FLOW.map((state) => {
              const activeIndex = frame === null ? -1 : SUPERVISOR_FLOW.indexOf(frame.supervisorState);
              const stateIndex = SUPERVISOR_FLOW.indexOf(state);
              const className = state === frame?.supervisorState
                ? "is-current"
                : activeIndex >= 0 && stateIndex < activeIndex ? "is-past" : "";
              return <span key={state} className={className} title={state} />;
            })}
          </div>
          <div className="stat-grid stat-grid--algorithm">
            <div><span>估计源</span><strong>{frame?.groundEstimate.source ?? "—"}</strong></div>
            <div><span>估计误差</span><strong>{formatNumber(estimateError, 2)} <small>m</small></strong></div>
            <div><span>无线数据龄</span><strong>{formatNumber(currentTelemetry?.radioAgeMs ?? null, 0)} <small>ms</small></strong></div>
            <div><span>预测提前量</span><strong>{formatNumber(planLeadTime, 2)} <small>s</small></strong></div>
            <div><span>置信半径</span><strong>{formatNumber(frame?.capturePlan?.confidenceRadiusM ?? null, 2)} <small>m</small></strong></div>
            <div><span>最大单绳张力</span><strong>{formatNumber(maxTension, 1)} <small>kN</small></strong></div>
          </div>
        </div>
        <div className="command-compare">
          <div>
            <span>期望 / 实际推力</span>
            <strong>{formatNumber(frame === null ? null : frame.control.desiredThrustN / 1_000, 0)} / {formatNumber(frame === null ? null : frame.rocket.actualThrustN / 1_000, 0)} kN</strong>
          </div>
          <div>
            <span>目标 / 当前总张力</span>
            <strong>{formatNumber(frame === null ? null : frame.net.targetTotalTensionN / 1_000, 0)} / {formatNumber(frame === null ? null : frame.net.tensionsN.reduce((sum, value) => sum + value, 0) / 1_000, 0)} kN</strong>
          </div>
        </div>
      </section>

      <section className="inspector-section inspector-section--compact">
        <div className="inspector-heading">
          <div>
            <h2>四绳张力环诊断</h2>
            <p>实际 − 目标；主动阻尼是受限执行器状态。</p>
          </div>
        </div>
        <div className="tension-loop-list">
          {[0, 1, 2, 3].map((ropeIndex) => {
            const desired = diagnostics?.desiredTensionsN[ropeIndex] ?? 0;
            const actual = diagnostics?.actualTensionsN[ropeIndex] ?? 0;
            const error = diagnostics?.tensionErrorsN[ropeIndex] ?? 0;
            const errorPercent = Math.min(100, Math.abs(error) / Math.max(1, Math.abs(desired)) * 100);
            const saturated = diagnostics?.tensionSaturated[ropeIndex] ?? false;
            return (
              <div key={ropeIndex} className={saturated ? "tension-loop-row is-saturated" : "tension-loop-row"}>
                <strong>W{ropeIndex + 1}</strong>
                <div className="tension-error-track"><i style={{ width: `${errorPercent}%` }} /></div>
                <span>{formatNumber(desired / 1_000, 0)} / {formatNumber(actual / 1_000, 0)} kN</span>
                <small>Δ {formatNumber(error / 1_000, 1)} kN</small>
                <small>阻尼 {formatNumber((frame?.net.activeDampingNspm[ropeIndex] ?? 0) / 1_000, 1)} kN·s/m</small>
                <em>{saturated ? "饱和" : "正常"}</em>
              </div>
            );
          })}
        </div>
      </section>

      <section className="inspector-section">
        <div className="inspector-heading"><div><h2>控制参数</h2><p>位置环、阻尼项与遥测失效保护。</p></div></div>
        <ParameterControl
          path="controller.netCenterKp"
          label="网中心 Kp"
          unit=""
          rawValue={config.controller.netCenterKp}
          min={0.2}
          max={4}
          step={0.05}
          disabled={busy}
          onChange={onParameterChange}
        />
        <ParameterControl
          path="controller.netCenterKd"
          label="网中心 Kd"
          unit=""
          rawValue={config.controller.netCenterKd}
          min={0.1}
          max={3}
          step={0.05}
          disabled={busy}
          onChange={onParameterChange}
        />
        <ParameterControl
          path="controller.staleTelemetryAbortS"
          label="遥测超时中止"
          unit="s"
          rawValue={config.controller.staleTelemetryAbortS}
          min={0.1}
          max={2}
          step={0.05}
          disabled={busy}
          onChange={onParameterChange}
        />
      </section>
    </div>
  );
}

function OutcomeBadge({ run }: { run: SimulationRun }) {
  const metrics = run.metrics;
  if (metrics.secured) return <span className="outcome-badge outcome-badge--success"><ShieldCheck size={16} />捕获并稳定</span>;
  if (metrics.failed) return <span className="outcome-badge outcome-badge--danger"><AlertTriangle size={16} />{metrics.failureReason ?? "任务失败"}</span>;
  if (metrics.captured) return <span className="outcome-badge outcome-badge--warning"><CircleGauge size={16} />已接触，未稳定</span>;
  return <span className="outcome-badge"><CircleGauge size={16} />未发生捕获</span>;
}

function ProgressBlock({ progress, onCancel }: { progress: TaskProgress; onCancel?: (() => void) | undefined }) {
  const percent = progress.total <= 0 ? 0 : Math.min(100, progress.completed / progress.total * 100);
  return (
    <div className="task-progress" role="status" aria-live="polite">
      <div><strong>{progress.label}</strong><span>{progress.completed}/{progress.total}</span></div>
      <div className="task-progress-track"><i style={{ width: `${percent}%` }} /></div>
      {onCancel === undefined ? null : <button type="button" onClick={onCancel}><Square size={13} fill="currentColor" />取消</button>}
    </div>
  );
}

const qualityLabel = (quality: "good" | "caution" | "poor"): string =>
  quality === "good" ? "收敛良好" : quality === "caution" ? "需要谨慎" : "不满足定量使用";

function ExperimentInspector({
  run,
  config,
  busy,
  dirty,
  onSeedChange,
  onRerun,
  onImportScenario,
  importNotice,
  onExportScenario,
  onExportRun,
  onRunMonteCarlo,
  onRunValidation,
  onCancelTask,
  monteCarloSummary,
  validationResult,
  activeTask,
  taskProgress
}: Pick<
  InspectorProps,
  "run" | "config" | "busy" | "dirty" | "onSeedChange" | "onRerun" |
  "onImportScenario" | "importNotice" | "onExportScenario" | "onExportRun" |
  "onRunMonteCarlo" | "onRunValidation" | "onCancelTask" | "monteCarloSummary" |
  "validationResult" | "activeTask" | "taskProgress"
>) {
  const [sampleCount, setSampleCount] = useState(5);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const maxLoad = useMemo(() => {
    if (monteCarloSummary === null || monteCarloSummary.variants.length === 0) return 1;
    return Math.max(1, ...monteCarloSummary.variants.map((variant) => variant.p95PeakLoadKn));
  }, [monteCarloSummary]);
  const taskBusy = activeTask !== null;

  return (
    <div className="inspector-scroll">
      <section className="inspector-section">
        <div className="inspector-heading"><div><h2>可重复运行与场景文件</h2><p>同一配置、模型版本与 seed 应得到逐位一致的结果。</p></div></div>
        <div className="reproducibility-box">
          <label><span>实验 seed</span><input type="number" step={1} value={config.seed} disabled={busy || taskBusy} onChange={(event) => { const value = event.currentTarget.valueAsNumber; if (Number.isSafeInteger(value)) onSeedChange(value); }} /></label>
          <button type="button" disabled={busy || taskBusy} onClick={onRerun}>{busy ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />}{dirty ? "应用参数并重算" : "按相同配置重算"}</button>
        </div>
        <div className="export-actions export-actions--three">
          <input ref={fileInputRef} className="sr-only" type="file" accept="application/json,.json" onChange={(event) => { const file = event.currentTarget.files?.[0]; if (file !== undefined) onImportScenario(file); event.currentTarget.value = ""; }} />
          <button type="button" disabled={busy || taskBusy} onClick={() => fileInputRef.current?.click()}><Upload size={15} />导入场景</button>
          <button type="button" disabled={busy || taskBusy} onClick={onExportScenario}><Download size={15} />导出场景</button>
          <button type="button" disabled={busy || taskBusy || run === null} onClick={onExportRun}><Download size={15} />导出结果</button>
        </div>
        {importNotice === null ? null : <div className="inline-notice">{importNotice}</div>}
        <p className="reproducibility-note">导入器支持 v1 原始配置、v0.2 文档包和当前 v2 文档包；高于当前版本的文件会被拒绝。</p>
      </section>

      <section className="inspector-section">
        <div className="inspector-heading"><div><h2>单场景结果</h2><p>取完整运行的最终指标，不用当前帧冒充结果。</p></div></div>
        {dirty && run !== null ? <div className="inline-warning">当前显示的是上一次已运行配置的结果；应用参数并重算后才会更新。</div> : null}
        {run === null ? <div className="inline-empty">尚未运行单场景</div> : <><OutcomeBadge run={run} /><div className="stat-grid experiment-stat-grid"><div><span>最小错位</span><strong>{formatNumber(run.metrics.missDistanceM, 2)} <small>m</small></strong></div><div><span>捕获相对速度</span><strong>{formatNumber(run.metrics.captureRelativeSpeedMps, 2)} <small>m/s</small></strong></div><div><span>峰值接触力</span><strong>{formatNumber(run.metrics.peakContactForceN / 1_000, 0)} <small>kN</small></strong></div><div><span>峰值载荷</span><strong>{formatNumber(run.metrics.peakApparentLoadG, 2)} <small>g</small></strong></div><div><span>峰值绳张力</span><strong>{formatNumber(run.metrics.peakRopeTensionN / 1_000, 0)} <small>kN</small></strong></div><div><span>最大估计误差</span><strong>{formatNumber(run.metrics.maxEstimateErrorM, 2)} <small>m</small></strong></div></div></>}
      </section>

      <section className="inspector-section">
        <div className="inspector-heading"><div><h2>有界扰动对照</h2><p>每种算法使用同一组扰动；批量进度按每个实际运行回传。</p></div></div>
        <div className="monte-carlo-controls"><label><span>样本数</span><select value={sampleCount} onChange={(event) => setSampleCount(Number(event.currentTarget.value))} disabled={busy || taskBusy}><option value={3}>3</option><option value={5}>5</option><option value={10}>10</option><option value={20}>20</option></select></label><button type="button" className={activeTask === "comparison" ? "is-cancel" : ""} disabled={busy || (taskBusy && activeTask !== "comparison") || (activeTask === "comparison" ? onCancelTask === undefined : onRunMonteCarlo === undefined)} onClick={() => activeTask === "comparison" ? onCancelTask?.() : onRunMonteCarlo?.(sampleCount)}>{activeTask === "comparison" ? <Square size={15} fill="currentColor" /> : <PlayCircle size={17} />}{activeTask === "comparison" ? "取消对照" : "运行对照"}</button></div>
        {activeTask === "comparison" && taskProgress !== null ? <ProgressBlock progress={taskProgress} onCancel={onCancelTask} /> : null}
        {monteCarloSummary === null ? <div className="inline-empty"><strong>尚未运行</strong><span>选择样本数后启动成对扰动闭环模式对照</span></div> : <div className="comparison-list" aria-label={`${monteCarloSummary.sampleCount} 次 Monte Carlo 汇总`}>{monteCarloSummary.variants.map((variant) => <article className="comparison-row" key={variant.id}><div className="comparison-title"><strong>{variant.label}</strong><span>{variant.secured}/{variant.runs} 稳定 · {variant.captures} 捕获</span></div><div className="comparison-measure"><span>稳定率</span><div><i style={{ width: `${Math.max(0, Math.min(100, variant.securedRate * 100))}%` }} /></div><strong>{(variant.securedRate * 100).toFixed(1)}%</strong></div><div className="comparison-measure comparison-measure--load"><span>P95 接触力</span><div><i style={{ width: `${Math.max(0, Math.min(100, variant.p95PeakLoadKn / maxLoad * 100))}%` }} /></div><strong>{variant.p95PeakLoadKn.toFixed(0)} kN</strong></div><small>捕获率 {(variant.captureRate * 100).toFixed(1)}% · 接触力均值 {variant.meanPeakLoadKn.toFixed(0)} kN · {variant.algorithm}</small></article>)}</div>}
      </section>

      <section className="inspector-section">
        <div className="inspector-heading"><div><h2>数值验证</h2><p>关闭随机项后用 Δt、Δt/2、Δt/4 比较同一物理终止时刻，并检查物理 tick 能量账本。</p></div></div>
        <button className="wide-action" type="button" disabled={busy || (taskBusy && activeTask !== "validation") || onRunValidation === undefined} onClick={() => activeTask === "validation" ? onCancelTask?.() : onRunValidation?.()}>{activeTask === "validation" ? <Square size={15} fill="currentColor" /> : <PlayCircle size={17} />}{activeTask === "validation" ? "取消验证" : "运行收敛与能量验证"}</button>
        {activeTask === "validation" && taskProgress !== null ? <ProgressBlock progress={taskProgress} onCancel={onCancelTask} /> : null}
        {validationResult === null ? <div className="inline-empty">尚未运行数值验证</div> : <div className="validation-results"><article className={`quality-card quality-${validationResult.convergence.quality}`}><div><strong>步长收敛</strong><span>{qualityLabel(validationResult.convergence.quality)}</span></div><p>{validationResult.convergence.interpretation}</p>{validationResult.convergence.comparisons.map((comparison) => <small key={comparison.fineDtS}>{comparison.coarseDtS.toFixed(4)} → {comparison.fineDtS.toFixed(4)} s：最大归一差 {(comparison.maximumNormalizedDifference * 100).toFixed(2)}%，终态{comparison.categoricalAgreement ? "一致" : "不一致"}</small>)}</article><article className={`quality-card quality-${validationResult.energy.quality}`}><div><strong>接触能量账本</strong><span>{qualityLabel(validationResult.energy.quality)}</span></div><p>{validationResult.energy.interpretation}</p><small>最大闭合残差 {(validationResult.energy.normalizedResidual * 100).toFixed(1)}% · 平动 {(validationResult.energy.normalizedTranslationalResidual * 100).toFixed(1)}% · 转动 {(validationResult.energy.normalizedRotationalResidual * 100).toFixed(1)}% · 接触分区 {(validationResult.energy.normalizedContactPartitionResidual * 100).toFixed(1)}% · {validationResult.energy.physicsStepCount} 个物理 tick</small></article></div>}
      </section>

      <section className="inspector-section"><div className="inspector-heading"><div><h2>事件证据</h2><p>最近的状态切换、接触与故障启停事件。</p></div></div>{run === null || run.events.length === 0 ? <div className="inline-empty">暂无事件</div> : <ol className="event-list">{run.events.slice(-12).map((event, index) => <li key={`${event.tick}-${event.type}-${index}`} className={`event-${event.severity}`}><time>{(event.tick * run.config.physicsDtS).toFixed(2)} s</time><span><strong>{event.type}</strong>{event.message}</span></li>)}</ol>}</section>
    </div>
  );
}

function EvidenceInspector({
  config,
  busy,
  onRunSensitivity,
  onCancelTask,
  traceabilityResult,
  activeTask,
  taskProgress
}: Pick<InspectorProps, "config" | "busy" | "onRunSensitivity" | "onCancelTask" | "traceabilityResult" | "activeTask" | "taskProgress">) {
  const rows = useMemo(
    () => traceabilityResult?.rows ?? buildParameterTraceability(config),
    [config, traceabilityResult]
  );
  return (
    <div className="inspector-scroll">
      <section className="inspector-section">
        <div className="inspector-heading"><div><h2>参数—证据—敏感性</h2><p>参数来源来自场景元数据；敏感性采用同 seed 的上下双侧扰动，并单独标识终态模式边界。</p></div></div>
        <button className="wide-action" type="button" disabled={busy || (activeTask !== null && activeTask !== "sensitivity") || onRunSensitivity === undefined} onClick={() => activeTask === "sensitivity" ? onCancelTask?.() : onRunSensitivity?.()}>{activeTask === "sensitivity" ? <Square size={15} fill="currentColor" /> : <PlayCircle size={17} />}{activeTask === "sensitivity" ? "取消敏感性计算" : "计算局部敏感性"}</button>
        {activeTask === "sensitivity" && taskProgress !== null ? <ProgressBlock progress={taskProgress} onCancel={onCancelTask} /> : null}
        {traceabilityResult === null ? <div className="inline-empty"><strong>证据表已内置</strong><span>点击计算后追加模型内局部敏感性分级</span></div> : <p className="reproducibility-note">{traceabilityResult.notice}</p>}
      </section>
      <section className="inspector-section traceability-section">
        <div className="traceability-table" role="table" aria-label="参数证据敏感性追溯表">
          {rows.map((row) => <article className="traceability-row" key={row.path}><div className="traceability-row-head"><strong>{row.label}</strong><SourceTag source={row.source} /></div><code>{row.path}</code><div className="traceability-value"><span>{`${row.value.toLocaleString("zh-CN", { maximumFractionDigits: 4 })} ${row.unit}`}</span><span>{row.modeTransition ? <b className="sensitivity-boundary">模式边界</b> : row.sensitivityLevel === null ? "敏感性待计算" : <b className={`sensitivity-${row.sensitivityLevel}`}>{row.sensitivityLevel === "high" ? "高" : row.sensitivityLevel === "medium" ? "中" : "低"} · 系数 {(row.sensitivityScore ?? 0).toFixed(2)}</b>}</span></div><p><strong>证据：</strong>{row.source.source}。{row.source.note}</p>{row.modeTransition ? <small>双侧扰动导致终态类别变化：{row.lowerOutcome} ← {row.baselineOutcome} → {row.upperOutcome}；连续敏感性系数无效。</small> : row.dominantEffect === null ? null : <small>{row.perturbationMode === "relative" ? `双侧 ±${row.perturbationPercent}%` : `双侧绝对扰动 ±${row.perturbationAbsolute.toPrecision(3)} ${row.unit}`} 时，主导指标“{row.dominantEffect}”最大变化 {(row.dominantEffectChangePercent ?? 0).toFixed(1)}%</small>}</article>)}
        </div>
      </section>
    </div>
  );
}

export function Inspector(props: InspectorProps) {
  const controlsBusy = props.busy || props.activeTask !== null;
  if (props.tab === "scenario") return <ScenarioInspector {...props} busy={controlsBusy} />;
  if (props.tab === "communications") return <CommunicationsInspector {...props} busy={controlsBusy} />;
  if (props.tab === "algorithm") return <AlgorithmInspector {...props} busy={controlsBusy} />;
  if (props.tab === "evidence") return <EvidenceInspector {...props} busy={props.busy} />;
  return <ExperimentInspector {...props} />;
}
