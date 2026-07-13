import { useMemo, useState } from "react";
import type {
  AlgorithmMode,
  NetworkStats,
  ParameterSource,
  ScenarioConfig,
  SimulationRun,
  SimulationSnapshot
} from "@recovery/sim-core";
import {
  AlertTriangle,
  Check,
  CircleGauge,
  Cpu,
  LoaderCircle,
  PlayCircle,
  ShieldCheck,
  Wifi
} from "lucide-react";
import type {
  DashboardParameterKey,
  DashboardPreset,
  InspectorTab,
  MonteCarloSummary
} from "./Dashboard";

export interface InspectorProps {
  tab: InspectorTab;
  run: SimulationRun | null;
  frame: SimulationSnapshot | null;
  config: ScenarioConfig;
  busy: boolean;
  onParameterChange: (path: DashboardParameterKey, value: number) => void;
  onAlgorithmChange: (algorithm: AlgorithmMode) => void;
  onPresetChange: (preset: DashboardPreset) => void;
  onRunMonteCarlo: ((count: number) => void) | undefined;
  monteCarloSummary: MonteCarloSummary | null;
  busyMonteCarlo: boolean;
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

function CommunicationsInspector({
  frame,
  config,
  busy,
  onParameterChange
}: Pick<InspectorProps, "frame" | "config" | "busy" | "onParameterChange">) {
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
        <div className="inspector-heading">
          <div>
            <h2>故障注入</h2>
            <p>参数变化由上层重跑场景后才会反映到统计。</p>
          </div>
        </div>
        <h3 className="subsection-label">无线代理链路</h3>
        <ParameterControl
          path="radio.baseLatencyMs"
          label="基础时延"
          unit="ms"
          rawValue={config.radio.baseLatencyMs}
          min={0}
          max={400}
          step={5}
          source={config.parameterSources.radio}
          disabled={busy}
          onChange={onParameterChange}
        />
        <ParameterControl
          path="radio.jitterMs"
          label="时延抖动"
          unit="ms"
          rawValue={config.radio.jitterMs}
          min={0}
          max={180}
          step={2}
          disabled={busy}
          onChange={onParameterChange}
        />
        <ParameterControl
          path="radio.lossRate"
          label="丢包率"
          unit="%"
          rawValue={config.radio.lossRate}
          min={0}
          max={60}
          step={0.5}
          toDisplay={(value) => value * 100}
          fromDisplay={(value) => value / 100}
          disabled={busy}
          onChange={onParameterChange}
        />
        <h3 className="subsection-label">现场总线代理</h3>
        <ParameterControl
          path="fieldbus.baseLatencyMs"
          label="基础时延"
          unit="ms"
          rawValue={config.fieldbus.baseLatencyMs}
          min={0}
          max={40}
          step={0.5}
          disabled={busy}
          onChange={onParameterChange}
        />
        <ParameterControl
          path="fieldbus.jitterMs"
          label="时延抖动"
          unit="ms"
          rawValue={config.fieldbus.jitterMs}
          min={0}
          max={20}
          step={0.5}
          disabled={busy}
          onChange={onParameterChange}
        />
        <ParameterControl
          path="fieldbus.lossRate"
          label="丢包率"
          unit="%"
          rawValue={config.fieldbus.lossRate}
          min={0}
          max={15}
          step={0.1}
          toDisplay={(value) => value * 100}
          fromDisplay={(value) => value / 100}
          disabled={busy}
          onChange={onParameterChange}
        />
      </section>
    </div>
  );
}

const ALGORITHMS: { id: AlgorithmMode; label: string; detail: string; cost: string }[] = [
  { id: "fixed", label: "固定网", detail: "不追踪预测，作为开环基线", cost: "O(1) / tick" },
  { id: "alpha-beta", label: "α-β 跟踪", detail: "常速度估计与误差反馈", cost: "O(1) / sample" },
  { id: "predictive", label: "预测协同", detail: "状态估计、交会预测与收网同步", cost: "O(1) / control tick" }
];

const SUPERVISOR_FLOW = ["SEARCH", "TRACK", "SYNC", "ARMED", "CLOSING", "CONTACT", "ARREST", "SECURED"];

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

  return (
    <div className="inspector-scroll">
      <section className="inspector-section">
        <div className="inspector-heading">
          <div>
            <h2>候选控制策略</h2>
            <p>三种模式使用同一物理内核，便于做闭环/基线对照。</p>
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
              <Cpu size={18} />
              <span><strong>{algorithm.label}</strong><small>{algorithm.detail}</small></span>
              <code>{algorithm.cost}</code>
            </button>
          ))}
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

function ExperimentInspector({
  run,
  busy,
  onRunMonteCarlo,
  monteCarloSummary,
  busyMonteCarlo
}: Pick<InspectorProps, "run" | "busy" | "onRunMonteCarlo" | "monteCarloSummary" | "busyMonteCarlo">) {
  const [sampleCount, setSampleCount] = useState(50);
  const maxLoad = useMemo(() => {
    if (monteCarloSummary === null || monteCarloSummary.variants.length === 0) return 1;
    return Math.max(1, ...monteCarloSummary.variants.map((variant) => variant.p95PeakLoadG));
  }, [monteCarloSummary]);

  return (
    <div className="inspector-scroll">
      <section className="inspector-section">
        <div className="inspector-heading">
          <div><h2>单场景结果</h2><p>取完整运行的最终指标，不用当前帧冒充结果。</p></div>
        </div>
        {run === null ? (
          <div className="inline-empty">尚未运行单场景</div>
        ) : (
          <>
            <OutcomeBadge run={run} />
            <div className="stat-grid experiment-stat-grid">
              <div><span>最小错位</span><strong>{formatNumber(run.metrics.missDistanceM, 2)} <small>m</small></strong></div>
              <div><span>捕获相对速度</span><strong>{formatNumber(run.metrics.captureRelativeSpeedMps, 2)} <small>m/s</small></strong></div>
              <div><span>峰值接触力</span><strong>{formatNumber(run.metrics.peakContactForceN / 1_000, 0)} <small>kN</small></strong></div>
              <div><span>峰值载荷</span><strong>{formatNumber(run.metrics.peakApparentLoadG, 2)} <small>g</small></strong></div>
              <div><span>峰值绳张力</span><strong>{formatNumber(run.metrics.peakRopeTensionN / 1_000, 0)} <small>kN</small></strong></div>
              <div><span>最大估计误差</span><strong>{formatNumber(run.metrics.maxEstimateErrorM, 2)} <small>m</small></strong></div>
            </div>
          </>
        )}
      </section>

      <section className="inspector-section">
        <div className="inspector-heading">
          <div><h2>Monte Carlo 对照</h2><p>比较固定网、α-β 与预测协同的捕获率和载荷代价。</p></div>
        </div>
        <div className="monte-carlo-controls">
          <label>
            <span>样本数</span>
            <select value={sampleCount} onChange={(event) => setSampleCount(Number(event.currentTarget.value))} disabled={busy || busyMonteCarlo}>
              <option value={20}>20</option>
              <option value={50}>50</option>
              <option value={100}>100</option>
              <option value={200}>200</option>
            </select>
          </label>
          <button
            type="button"
            disabled={onRunMonteCarlo === undefined || busy || busyMonteCarlo}
            onClick={() => onRunMonteCarlo?.(sampleCount)}
          >
            {busyMonteCarlo ? <LoaderCircle className="spin" size={17} /> : <PlayCircle size={17} />}
            {busyMonteCarlo ? "批量计算中" : "运行对照"}
          </button>
        </div>
        {monteCarloSummary === null ? (
          <div className="inline-empty">
            <strong>尚未运行</strong>
            <span>{onRunMonteCarlo === undefined ? "批量试验入口尚未接入" : "选择样本数后启动闭环模式对照"}</span>
          </div>
        ) : (
          <div className="comparison-list" aria-label={`${monteCarloSummary.sampleCount} 次 Monte Carlo 汇总`}>
            {monteCarloSummary.variants.map((variant) => (
              <article className="comparison-row" key={variant.id}>
                <div className="comparison-title">
                  <strong>{variant.label}</strong>
                  <span>{variant.captures}/{variant.runs} 捕获</span>
                </div>
                <div className="comparison-measure">
                  <span>捕获率</span>
                  <div><i style={{ width: `${Math.max(0, Math.min(100, variant.captureRate * 100))}%` }} /></div>
                  <strong>{(variant.captureRate * 100).toFixed(1)}%</strong>
                </div>
                <div className="comparison-measure comparison-measure--load">
                  <span>P95 载荷</span>
                  <div><i style={{ width: `${Math.max(0, Math.min(100, variant.p95PeakLoadG / maxLoad * 100))}%` }} /></div>
                  <strong>{variant.p95PeakLoadG.toFixed(2)} g</strong>
                </div>
                <small>均值 {variant.meanPeakLoadG.toFixed(2)} g · {variant.algorithm}</small>
              </article>
            ))}
          </div>
        )}
      </section>

      <section className="inspector-section">
        <div className="inspector-heading"><div><h2>事件证据</h2><p>最近的状态切换、接触与故障事件。</p></div></div>
        {run === null || run.events.length === 0 ? (
          <div className="inline-empty">暂无事件</div>
        ) : (
          <ol className="event-list">
            {run.events.slice(-8).map((event, index) => (
              <li key={`${event.tick}-${event.type}-${index}`} className={`event-${event.severity}`}>
                <time>{(event.tick * run.config.physicsDtS).toFixed(2)} s</time>
                <span><strong>{event.type}</strong>{event.message}</span>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}

export function Inspector(props: InspectorProps) {
  if (props.tab === "scenario") {
    return <ScenarioInspector {...props} />;
  }
  if (props.tab === "communications") {
    return <CommunicationsInspector {...props} />;
  }
  if (props.tab === "algorithm") {
    return <AlgorithmInspector {...props} />;
  }
  return <ExperimentInspector {...props} />;
}
