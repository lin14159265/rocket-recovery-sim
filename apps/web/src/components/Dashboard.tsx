import { lazy, Suspense, useState } from "react";
import {
  fingerprintScenarioConfig,
  SIMULATION_MODEL_VERSION,
  type AlgorithmMode,
  type ParameterTraceabilityResult,
  type ScenarioConfig,
  type ScenarioFaultConfig,
  type SimulationRun,
  type SimulationSnapshot,
  type ValidationSuiteResult
} from "@recovery/sim-core";
import {
  Activity,
  BookOpen,
  BrainCircuit,
  Camera,
  CameraOff,
  FlaskConical,
  ListChecks,
  Radio,
  RotateCcw,
  X
} from "lucide-react";
import { displayedConfigFor } from "../app-state";
import { Inspector } from "./Inspector";
import { PlaybackBar } from "./PlaybackBar";
import "../dashboard.css";

const RecoveryScene = lazy(async () => {
  const module = await import("./RecoveryScene");
  return { default: module.RecoveryScene };
});

const TelemetryCharts = lazy(async () => {
  const module = await import("./TelemetryCharts");
  return { default: module.TelemetryCharts };
});

export type InspectorTab = "scenario" | "communications" | "algorithm" | "experiment" | "evidence";

export type DashboardPreset =
  | "nominal"
  | "late-close"
  | "low-damping"
  | "overload"
  | "radio-blackout";

export type DashboardParameterKey =
  | "rocket.massKg"
  | "rocket.initialVelocityMps.2"
  | "rocket.thrustMaxN"
  | "net.closureDurationS"
  | "net.totalStiffnessNpm"
  | "net.totalDampingNspm"
  | "net.totalStrengthLimitN"
  | "radio.baseLatencyMs"
  | "radio.jitterMs"
  | "radio.lossRate"
  | "radio.duplicateRate"
  | "radio.corruptionRate"
  | "fieldbus.baseLatencyMs"
  | "fieldbus.jitterMs"
  | "fieldbus.lossRate"
  | "fieldbus.duplicateRate"
  | "fieldbus.corruptionRate"
  | "controller.netCenterKp"
  | "controller.netCenterKd"
  | "controller.staleTelemetryAbortS"
  | "faults.radioBlackout.startTimeS"
  | "faults.radioBlackout.durationS"
  | "faults.winchStuck.startTimeS"
  | "faults.winchStuck.durationS"
  | "faults.sensorBiasStep.startTimeS"
  | "faults.sensorBiasStep.durationS"
  | "faults.sensorBiasStep.deltaM.0"
  | "faults.sensorBiasStep.deltaM.1"
  | "faults.sensorBiasStep.deltaM.2"
  | "faults.thrustScale.startTimeS"
  | "faults.thrustScale.durationS"
  | "faults.thrustScale.scale";

export interface MonteCarloVariantSummary {
  id: string;
  label: string;
  algorithm: AlgorithmMode | "open-loop";
  runs: number;
  captures: number;
  secured: number;
  captureRate: number;
  securedRate: number;
  meanPeakLoadKn: number;
  p95PeakLoadKn: number;
}

export interface MonteCarloSummary {
  sampleCount: number;
  variants: MonteCarloVariantSummary[];
}


export interface TaskProgress {
  task: "comparison" | "validation" | "sensitivity";
  completed: number;
  total: number;
  label: string;
}

export interface DashboardProps {
  run: SimulationRun | null;
  frame: SimulationSnapshot | null;
  currentTimeS: number;
  config: ScenarioConfig;
  busy: boolean;
  dirty: boolean;
  error: string | null;
  playing: boolean;
  speed: number;
  selectedInspectorTab: InspectorTab;
  onTogglePlaying: () => void;
  onReset: () => void;
  onStep: (direction: -1 | 1) => void;
  onSeek: (timeS: number) => void;
  onSpeedChange: (speed: number) => void;
  onInspectorTabChange: (tab: InspectorTab) => void;
  onParameterChange: (path: DashboardParameterKey, value: number) => void;
  onFaultConfigChange: (faults: ScenarioFaultConfig) => void;
  onAlgorithmChange: (algorithm: AlgorithmMode) => void;
  onPresetChange: (preset: DashboardPreset) => void;
  onSeedChange: (seed: number) => void;
  onImportScenario: (file: File) => void;
  importNotice?: string | null;
  onExportScenario: () => void;
  onExportRun: () => void;
  onRunMonteCarlo?: (count: number) => void;
  onRunValidation?: () => void;
  onRunSensitivity?: () => void;
  onCancelTask?: () => void;
  monteCarloSummary?: MonteCarloSummary | null;
  validationResult?: ValidationSuiteResult | null;
  traceabilityResult?: ParameterTraceabilityResult | null;
  activeTask?: TaskProgress["task"] | null;
  taskProgress?: TaskProgress | null;
}

const magnitude3 = ([x, y, z]: readonly number[]): number => Math.hypot(x ?? 0, y ?? 0, z ?? 0);

const formatMetric = (value: number | null, digits: number): string =>
  value === null || !Number.isFinite(value) ? "—" : value.toFixed(digits);

const STATE_LABELS: Record<string, string> = {
  BOOT: "启动",
  SEARCH: "搜索目标",
  TRACK: "稳定跟踪",
  SYNC: "协同同步",
  ARMED: "捕获就绪",
  CLOSING: "收网中",
  CONTACT: "发生接触",
  ARREST: "耗能制动",
  SECURED: "捕获完成",
  MISSED: "错过窗口",
  BROKEN: "网绳超限",
  ABORT: "任务中止"
};

const stateToneForFrame = (
  frame: SimulationSnapshot | null
): "idle" | "active" | "hot" | "success" | "danger" => {
  if (frame === null) return "idle";
  if (frame.supervisorState === "SECURED") return "success";
  if (["MISSED", "BROKEN", "ABORT"].includes(frame.supervisorState)) return "danger";
  if (["CONTACT", "ARREST"].includes(frame.supervisorState)) return "hot";
  return "active";
};

function MetricStrip({ frame, run }: { frame: SimulationSnapshot | null; run: SimulationRun | null }) {
  const speed = frame === null ? null : magnitude3(frame.rocket.velocityMps);
  const halfSpacing = frame === null
    ? null
    : (frame.net.halfSpacingM[0] + frame.net.halfSpacingM[1]) / 2;
  const load = frame === null
    ? null
    : run?.telemetry.findLast((sample) => sample.timeS <= frame.timeS)?.apparentLoadG ?? null;

  return (
    <div className="dashboard-metrics" aria-label="当前关键状态">
      <div className="dashboard-metric">
        <span>高度</span>
        <strong>{formatMetric(frame?.rocket.positionM[2] ?? null, 1)}</strong>
        <small>m</small>
      </div>
      <div className="dashboard-metric dashboard-metric--green">
        <span>速度</span>
        <strong>{formatMetric(speed, 1)}</strong>
        <small>m/s</small>
      </div>
      <div className="dashboard-metric">
        <span>半间距</span>
        <strong>{formatMetric(halfSpacing, 1)}</strong>
        <small>m</small>
      </div>
      <div className="dashboard-metric dashboard-metric--hot">
        <span>表观载荷</span>
        <strong>{formatMetric(load, 2)}</strong>
        <small>g</small>
      </div>
    </div>
  );
}

export function Dashboard({
  run,
  frame,
  currentTimeS,
  config,
  busy,
  dirty,
  error,
  playing,
  speed,
  selectedInspectorTab,
  onTogglePlaying,
  onReset,
  onStep,
  onSeek,
  onSpeedChange,
  onInspectorTabChange,
  onParameterChange,
  onFaultConfigChange,
  onAlgorithmChange,
  onPresetChange,
  onSeedChange,
  onImportScenario,
  importNotice = null,
  onExportScenario,
  onExportRun,
  onRunMonteCarlo,
  onRunValidation,
  onRunSensitivity,
  onCancelTask,
  monteCarloSummary = null,
  validationResult = null,
  traceabilityResult = null,
  activeTask = null,
  taskProgress = null
}: DashboardProps) {
  const [cameraFollow, setCameraFollow] = useState(true);
  const [cameraResetToken, setCameraResetToken] = useState(0);
  const [boundaryOpen, setBoundaryOpen] = useState(false);
  const durationS = run?.config.durationS ?? config.durationS;
  const displayedConfig = displayedConfigFor(run, config);
  const displayedFingerprint = run?.configFingerprint ?? fingerprintScenarioConfig(displayedConfig);
  const draftFingerprint = fingerprintScenarioConfig(config);
  const stateLabel = frame === null
    ? busy ? "仿真计算中" : "等待运行"
    : STATE_LABELS[frame.supervisorState] ?? frame.supervisorState;
  const stateTone = stateToneForFrame(frame);

  return (
    <main className="recovery-dashboard">
      <header className="dashboard-header">
        <div className="dashboard-brand">
          <h1>井字网系回收概念模拟器</h1>
          <p>公开机理代理模型 v{run?.modelVersion ?? SIMULATION_MODEL_VERSION} · 运行 seed {displayedConfig.seed} · cfg {displayedFingerprint}</p>
          {dirty ? <span className="dirty-indicator">草稿 seed {config.seed} · cfg {draftFingerprint}，点击“重启”应用</span> : null}
        </div>

        <MetricStrip frame={frame} run={run} />

        <div className="dashboard-camera-actions" aria-label="三维视图控制">
          <button
            className={cameraFollow ? "tool-button is-active" : "tool-button"}
            type="button"
            onClick={() => setCameraFollow((value) => !value)}
            aria-pressed={cameraFollow}
          >
            {cameraFollow ? <Camera size={17} /> : <CameraOff size={17} />}
            相机跟随
          </button>
          <button
            className="tool-button"
            type="button"
            onClick={() => setCameraResetToken((value) => value + 1)}
          >
            <RotateCcw size={16} />
            视角复位
          </button>
          <button
            className="tool-button"
            type="button"
            onClick={() => setBoundaryOpen(true)}
          >
            <BookOpen size={16} />
            模型边界
          </button>
        </div>
      </header>

      <section className="dashboard-workspace">
        <section className="scene-panel panel-shell" aria-label="火箭与海上回收平台三维视图">
          <div className="panel-corner-label">
            t = <strong>{formatMetric(frame?.timeS ?? null, 2)}</strong> s
          </div>
          <Suspense fallback={<div className="panel-loading">正在装载三维视图…</div>}>
            <RecoveryScene
              frame={frame}
              config={displayedConfig}
              cameraFollow={cameraFollow}
              resetToken={cameraResetToken}
            />
          </Suspense>
          {frame === null ? (
            <div className="panel-empty panel-empty--scene" role="status">
              <Activity size={23} />
              <strong>{busy ? "正在计算确定性轨迹" : "等待运行仿真"}</strong>
              <span>三维对象只显示实际快照，不注入演示数据</span>
            </div>
          ) : null}
          <div className="scene-legend" aria-hidden="true">
            <span><i className="legend-dot legend-dot--truth" />真实状态</span>
            <span><i className="legend-line legend-line--estimate" />地面估计</span>
            <span><i className="legend-line legend-line--plan" />预测交会</span>
          </div>
        </section>

        <section className="charts-panel panel-shell" aria-label="实时遥测曲线">
          <Suspense fallback={<div className="panel-loading">正在装载遥测图表…</div>}>
            <TelemetryCharts run={run} currentTimeS={currentTimeS} />
          </Suspense>
        </section>

        <aside className="inspector-panel panel-shell" aria-label="场景与算法检查器">
          <nav className="inspector-tabs" aria-label="检查器页面">
            <button
              type="button"
              className={selectedInspectorTab === "scenario" ? "is-active" : ""}
              onClick={() => onInspectorTabChange("scenario")}
            >
              <Activity size={16} />
              <span>场景</span>
            </button>
            <button
              type="button"
              className={selectedInspectorTab === "communications" ? "is-active" : ""}
              onClick={() => onInspectorTabChange("communications")}
            >
              <Radio size={16} />
              <span>通信</span>
            </button>
            <button
              type="button"
              className={selectedInspectorTab === "algorithm" ? "is-active" : ""}
              onClick={() => onInspectorTabChange("algorithm")}
            >
              <BrainCircuit size={16} />
              <span>算法</span>
            </button>
            <button
              type="button"
              className={selectedInspectorTab === "experiment" ? "is-active" : ""}
              onClick={() => onInspectorTabChange("experiment")}
            >
              <FlaskConical size={16} />
              <span>试验</span>
            </button>
            <button
              type="button"
              className={selectedInspectorTab === "evidence" ? "is-active" : ""}
              onClick={() => onInspectorTabChange("evidence")}
            >
              <ListChecks size={16} />
              <span>证据</span>
            </button>
          </nav>
          <Inspector
            tab={selectedInspectorTab}
            run={run}
            frame={frame}
            config={config}
            busy={busy}
            dirty={dirty}
            onParameterChange={onParameterChange}
            onFaultConfigChange={onFaultConfigChange}
            onAlgorithmChange={onAlgorithmChange}
            onPresetChange={onPresetChange}
            onSeedChange={onSeedChange}
            onRerun={onReset}
            onImportScenario={onImportScenario}
            importNotice={importNotice}
            onExportScenario={onExportScenario}
            onExportRun={onExportRun}
            onRunMonteCarlo={onRunMonteCarlo}
            onRunValidation={onRunValidation}
            onRunSensitivity={onRunSensitivity}
            onCancelTask={onCancelTask}
            monteCarloSummary={monteCarloSummary}
            validationResult={validationResult}
            traceabilityResult={traceabilityResult}
            activeTask={activeTask}
            taskProgress={taskProgress}
          />
        </aside>
      </section>

      <PlaybackBar
        currentTimeS={currentTimeS}
        durationS={durationS}
        busy={busy || activeTask !== null}
        playing={playing}
        speed={speed}
        stateLabel={activeTask !== null ? "分析任务计算中" : dirty ? "参数待应用" : stateLabel}
        stateTone={activeTask !== null ? "active" : dirty ? "hot" : stateTone}
        canPlay={run !== null && !dirty}
        onTogglePlaying={onTogglePlaying}
        onReset={onReset}
        onStep={onStep}
        onSeek={onSeek}
        onSpeedChange={onSpeedChange}
      />

      {error !== null ? <div className="dashboard-error" role="alert">{error}</div> : null}

      {boundaryOpen ? (
        <div className="boundary-backdrop" role="presentation" onMouseDown={() => setBoundaryOpen(false)}>
          <section
            className="boundary-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="boundary-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header>
              <div>
                <h2 id="boundary-title">模型适用边界</h2>
                <p>这里展示的是可审查的公开机理代理模型，不是型号数字孪生。</p>
              </div>
              <button type="button" aria-label="关闭模型边界说明" onClick={() => setBoundaryOpen(false)}><X size={20} /></button>
            </header>
            <div className="boundary-grid">
              <article><strong>可以用于</strong><p>验证通信—估计—控制—执行机构—接触动力学的闭环逻辑，比较候选算法在同一组有界扰动下的相对表现。</p></article>
              <article><strong>不能用于</strong><p>推断真实型号成功率、结构安全裕度、绞盘能力、制导律参数或工程验收结论。</p></article>
              <article><strong>参数来源</strong><p>界面将参数标为公开确认、公开估计、代理标定或研究假设；未公开参数不会伪装成官方数据。</p></article>
              <article><strong>可重复性</strong><p>同一配置、算法版本和 seed 产生确定性一致结果；Monte Carlo 使用成对扰动比较三种算法。</p></article>
              <article><strong>状态隔离</strong><p>控制器只消费显式传感器采样、估计结果和虚拟链路投递消息；真实状态仅进入被控对象、指标和只读记录器。</p></article>
              <article><strong>结果解释</strong><p>捕获、稳定、断绳和中止均由显式判据产生，并通过事件、遥测、链路统计和最终指标留痕。</p></article>
            </div>
          </section>
        </div>
      ) : null}
    </main>
  );
}

export default Dashboard;
