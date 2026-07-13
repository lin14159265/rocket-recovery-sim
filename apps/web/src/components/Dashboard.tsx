import { useState } from "react";
import type {
  AlgorithmMode,
  ScenarioConfig,
  SimulationRun,
  SimulationSnapshot
} from "@recovery/sim-core";
import {
  Activity,
  BrainCircuit,
  Camera,
  CameraOff,
  FlaskConical,
  Radio,
  RotateCcw
} from "lucide-react";
import { RecoveryScene } from "./RecoveryScene";
import { TelemetryCharts } from "./TelemetryCharts";
import { Inspector } from "./Inspector";
import { PlaybackBar } from "./PlaybackBar";
import "../dashboard.css";

export type InspectorTab = "scenario" | "communications" | "algorithm" | "experiment";

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
  | "fieldbus.baseLatencyMs"
  | "fieldbus.jitterMs"
  | "fieldbus.lossRate"
  | "controller.netCenterKp"
  | "controller.netCenterKd"
  | "controller.staleTelemetryAbortS";

export interface MonteCarloVariantSummary {
  id: string;
  label: string;
  algorithm: AlgorithmMode | "open-loop";
  runs: number;
  captures: number;
  captureRate: number;
  meanPeakLoadG: number;
  p95PeakLoadG: number;
}

export interface MonteCarloSummary {
  sampleCount: number;
  variants: MonteCarloVariantSummary[];
}

export interface DashboardProps {
  run: SimulationRun | null;
  frame: SimulationSnapshot | null;
  currentTimeS: number;
  config: ScenarioConfig;
  busy: boolean;
  playing: boolean;
  speed: number;
  selectedInspectorTab: InspectorTab;
  onTogglePlaying: () => void;
  onReset: () => void;
  onSeek: (timeS: number) => void;
  onSpeedChange: (speed: number) => void;
  onInspectorTabChange: (tab: InspectorTab) => void;
  onParameterChange: (path: DashboardParameterKey, value: number) => void;
  onAlgorithmChange: (algorithm: AlgorithmMode) => void;
  onPresetChange: (preset: DashboardPreset) => void;
  onRunMonteCarlo?: (count: number) => void;
  monteCarloSummary?: MonteCarloSummary | null;
  busyMonteCarlo?: boolean;
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
  playing,
  speed,
  selectedInspectorTab,
  onTogglePlaying,
  onReset,
  onSeek,
  onSpeedChange,
  onInspectorTabChange,
  onParameterChange,
  onAlgorithmChange,
  onPresetChange,
  onRunMonteCarlo,
  monteCarloSummary = null,
  busyMonteCarlo = false
}: DashboardProps) {
  const [cameraFollow, setCameraFollow] = useState(true);
  const [cameraResetToken, setCameraResetToken] = useState(0);
  const durationS = run?.config.durationS ?? config.durationS;
  const stateLabel = frame === null
    ? busy ? "仿真计算中" : "等待运行"
    : STATE_LABELS[frame.supervisorState] ?? frame.supervisorState;
  const stateTone = stateToneForFrame(frame);

  return (
    <main className="recovery-dashboard">
      <header className="dashboard-header">
        <div className="dashboard-brand">
          <h1>井字网系回收概念模拟器</h1>
          <p>公开机理约束下的候选协同算法 · 非官方型号复现</p>
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
        </div>
      </header>

      <section className="dashboard-workspace">
        <section className="scene-panel panel-shell" aria-label="火箭与海上回收平台三维视图">
          <div className="panel-corner-label">
            t = <strong>{formatMetric(frame?.timeS ?? null, 2)}</strong> s
          </div>
          <RecoveryScene
            frame={frame}
            config={config}
            cameraFollow={cameraFollow}
            resetToken={cameraResetToken}
          />
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
          <TelemetryCharts run={run} currentTimeS={currentTimeS} />
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
          </nav>
          <Inspector
            tab={selectedInspectorTab}
            run={run}
            frame={frame}
            config={config}
            busy={busy}
            onParameterChange={onParameterChange}
            onAlgorithmChange={onAlgorithmChange}
            onPresetChange={onPresetChange}
            onRunMonteCarlo={onRunMonteCarlo}
            monteCarloSummary={monteCarloSummary}
            busyMonteCarlo={busyMonteCarlo}
          />
        </aside>
      </section>

      <PlaybackBar
        currentTimeS={currentTimeS}
        durationS={durationS}
        busy={busy}
        playing={playing}
        speed={speed}
        stateLabel={stateLabel}
        stateTone={stateTone}
        canPlay={run !== null}
        onTogglePlaying={onTogglePlaying}
        onReset={onReset}
        onSeek={onSeek}
        onSpeedChange={onSpeedChange}
      />
    </main>
  );
}

export default Dashboard;
