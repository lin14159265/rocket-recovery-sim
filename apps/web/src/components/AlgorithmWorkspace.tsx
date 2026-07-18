import { useEffect, useMemo, useRef } from "react";
import type { SimulationRun, SimulationSnapshot, TelemetrySample } from "@recovery/sim-core";
import * as echarts from "echarts/core";
import type { EChartsCoreOption, EChartsType } from "echarts/core";
import { LineChart } from "echarts/charts";
import {
  AriaComponent,
  GridComponent,
  LegendComponent,
  MarkLineComponent,
  TitleComponent,
  TooltipComponent
} from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";

echarts.use([
  AriaComponent,
  GridComponent,
  LegendComponent,
  LineChart,
  MarkLineComponent,
  TitleComponent,
  TooltipComponent,
  CanvasRenderer
]);

export interface AlgorithmWorkspaceProps {
  run: SimulationRun | null;
  frame: SimulationSnapshot | null;
  currentTimeS: number;
}

type DataPoint = [number, number];

interface PreparedAlgorithmData {
  maxTimeS: number;
  predictionXErrorM: DataPoint[];
  predictionYErrorM: DataPoint[];
  confidenceRadiusM: DataPoint[];
  desiredNetX: DataPoint[];
  actualNetX: DataPoint[];
  desiredNetY: DataPoint[];
  actualNetY: DataPoint[];
  desiredHalfSpacing: DataPoint[];
  actualHalfSpacing: DataPoint[];
  desiredTensionsKn: DataPoint[][];
  actualTensionsKn: DataPoint[][];
}

const COLORS = {
  cyan: "#36d9ff",
  green: "#37e69a",
  violet: "#b77aff",
  amber: "#ffb34d",
  red: "#ff6477",
  muted: "#7f93a7",
  grid: "rgba(104, 132, 158, 0.14)"
};

const ROPE_COLORS = [COLORS.cyan, COLORS.green, COLORS.violet, COLORS.amber] as const;

const toData = (
  samples: readonly TelemetrySample[],
  selector: (sample: TelemetrySample) => number
): DataPoint[] => samples.map((sample) => [sample.timeS, selector(sample)]);

function prepareAlgorithmData(run: SimulationRun): PreparedAlgorithmData {
  const samples = run.telemetry;
  const frames = run.frames;
  return {
    maxTimeS: Math.max(run.config.durationS, samples.at(-1)?.timeS ?? 0.001),
    predictionXErrorM: toData(samples, (sample) => (
      sample.predictedInterceptM[0] - sample.desiredNetCenterM[0]
    )),
    predictionYErrorM: toData(samples, (sample) => (
      sample.predictedInterceptM[1] - sample.desiredNetCenterM[1]
    )),
    confidenceRadiusM: frames.map((snapshot) => [
      snapshot.timeS,
      snapshot.capturePlan?.confidenceRadiusM ?? 0
    ]),
    desiredNetX: toData(samples, (sample) => sample.desiredNetCenterM[0]),
    actualNetX: toData(samples, (sample) => sample.netCenterM[0]),
    desiredNetY: toData(samples, (sample) => sample.desiredNetCenterM[1]),
    actualNetY: toData(samples, (sample) => sample.netCenterM[1]),
    desiredHalfSpacing: frames.map((snapshot) => [
      snapshot.timeS,
      (snapshot.controlDiagnostics.desiredHalfSpacingM[0]
        + snapshot.controlDiagnostics.desiredHalfSpacingM[1]) / 2
    ]),
    actualHalfSpacing: toData(samples, (sample) => (
      sample.netHalfSpacingM[0] + sample.netHalfSpacingM[1]
    ) / 2),
    desiredTensionsKn: [0, 1, 2, 3].map((ropeIndex) => (
      toData(samples, (sample) => (sample.desiredRopeTensionsN[ropeIndex] ?? 0) / 1_000)
    )),
    actualTensionsKn: [0, 1, 2, 3].map((ropeIndex) => (
      toData(samples, (sample) => (sample.ropeTensionsN[ropeIndex] ?? 0) / 1_000)
    ))
  };
}

const baseAxis = (gridIndex: number, maxTimeS: number) => ({
  type: "value" as const,
  gridIndex,
  min: 0,
  max: maxTimeS,
  axisLine: { lineStyle: { color: "#50677c" } },
  axisTick: { show: false },
  axisLabel: { color: "#8da1b5", fontSize: 10, margin: 7 },
  splitLine: { lineStyle: { color: COLORS.grid } },
  name: "时间 / s",
  nameLocation: "middle" as const,
  nameGap: 24,
  nameTextStyle: { color: "#7d91a5", fontSize: 10 }
});

const valueAxis = (gridIndex: number, name: string, minimum?: number, maximum?: number) => ({
  type: "value" as const,
  gridIndex,
  min: minimum,
  max: maximum,
  name,
  nameLocation: "middle" as const,
  nameGap: 39,
  nameTextStyle: { color: "#8da1b5", fontSize: 10 },
  axisLine: { show: true, lineStyle: { color: "#50677c" } },
  axisTick: { show: false },
  axisLabel: { color: "#8da1b5", fontSize: 10 },
  splitLine: { lineStyle: { color: COLORS.grid } }
});

const lineSeries = (
  name: string,
  data: DataPoint[],
  gridIndex: number,
  color: string,
  dashed = false,
  width = 1.8,
  extra: Record<string, unknown> = {}
) => ({
  name,
  type: "line",
  data,
  xAxisIndex: gridIndex,
  yAxisIndex: gridIndex,
  showSymbol: false,
  animation: false,
  lineStyle: { color, width, type: dashed ? "dashed" : "solid" },
  itemStyle: { color },
  emphasis: { focus: "series" },
  ...extra
});

const currentTimeMark = (currentTimeS: number) => ({
  silent: true,
  symbol: "none",
  animation: false,
  label: {
    show: true,
    formatter: "当前",
    color: "#9fb3c5",
    fontSize: 9,
    position: "insideEndTop"
  },
  lineStyle: { color: "rgba(210, 229, 244, 0.55)", width: 1 },
  data: [{ xAxis: currentTimeS }]
});

function buildSeries(
  prepared: PreparedAlgorithmData,
  run: SimulationRun,
  frame: SimulationSnapshot | null,
  currentTimeS: number
) {
  const confidenceUpper = prepared.confidenceRadiusM;
  const confidenceLower = prepared.confidenceRadiusM.map(([timeS, radius]) => [timeS, -radius] as DataPoint);
  const commitDeadlineS = frame?.capturePlan === null || frame?.capturePlan === undefined
    ? null
    : frame.capturePlan.commitDeadlineTick * run.config.physicsDtS;
  const predictionMarks = currentTimeMark(currentTimeS);
  if (commitDeadlineS !== null) {
    predictionMarks.data.push({
      xAxis: commitDeadlineS,
      label: {
        show: true,
        formatter: "COMMIT 截止",
        color: COLORS.amber,
        fontSize: 9,
        position: "insideEndTop"
      },
      lineStyle: { color: COLORS.amber, type: "dashed", width: 1.2 }
    } as never);
  }

  const netSeries = [
    lineSeries("X 指令", prepared.desiredNetX, 1, COLORS.cyan, true, 1.4),
    lineSeries("X 实际", prepared.actualNetX, 1, COLORS.cyan, false, 2),
    lineSeries("Y 指令", prepared.desiredNetY, 1, COLORS.green, true, 1.4),
    lineSeries("Y 实际", prepared.actualNetY, 1, COLORS.green, false, 2),
    lineSeries("半间距指令", prepared.desiredHalfSpacing, 1, COLORS.amber, true, 1.4),
    lineSeries("半间距实际", prepared.actualHalfSpacing, 1, COLORS.amber, false, 2, {
      markLine: currentTimeMark(currentTimeS)
    })
  ];

  const tensionSeries = ROPE_COLORS.flatMap((color, ropeIndex) => [
    lineSeries(`W${ropeIndex + 1} 目标`, prepared.desiredTensionsKn[ropeIndex] ?? [], 2, color, true, 1.15),
    lineSeries(`W${ropeIndex + 1} 实际`, prepared.actualTensionsKn[ropeIndex] ?? [], 2, color, false, 1.8,
      ropeIndex === 0 ? {
        markLine: {
          ...currentTimeMark(currentTimeS),
          data: [
            { xAxis: currentTimeS },
            {
              yAxis: run.config.net.totalStrengthLimitN / 1_000,
              label: {
                show: true,
                formatter: `${(run.config.net.totalStrengthLimitN / 1_000_000).toFixed(2)} MN 代理强度上限`,
                color: "#b7c3ce",
                fontSize: 9,
                position: "insideEndTop"
              },
              lineStyle: { color: "rgba(222, 232, 240, 0.72)", type: "dashed", width: 1.1 }
            }
          ]
        }
      } : {})
  ]);

  return [
    lineSeries("X 预测误差", prepared.predictionXErrorM, 0, COLORS.cyan, true, 1.8, {
      markLine: predictionMarks
    }),
    lineSeries("Y 预测误差", prepared.predictionYErrorM, 0, COLORS.green, true, 1.8),
    lineSeries("+3σ 可达域", confidenceUpper, 0, "rgba(183, 122, 255, 0.62)", true, 1.1),
    lineSeries("-3σ 可达域", confidenceLower, 0, "rgba(183, 122, 255, 0.62)", true, 1.1),
    ...netSeries,
    ...tensionSeries
  ];
}

function buildOption(
  prepared: PreparedAlgorithmData,
  run: SimulationRun,
  frame: SimulationSnapshot | null,
  currentTimeS: number
): EChartsCoreOption {
  const predictionLimit = Math.max(
    2,
    ...prepared.confidenceRadiusM.map(([, radius]) => radius),
    ...prepared.predictionXErrorM.map(([, value]) => Math.abs(value)),
    ...prepared.predictionYErrorM.map(([, value]) => Math.abs(value))
  ) * 1.18;
  const netLimit = Math.max(run.config.net.openHalfSpacingM * 1.08, 6);
  const ropeLimitKn = Math.max(
    run.config.net.totalStrengthLimitN / 1_000 * 1.08,
    ...prepared.actualTensionsKn.flat().map(([, value]) => value)
  );

  return {
    backgroundColor: "transparent",
    animation: false,
    aria: {
      enabled: true,
      decal: { show: false },
      description: `当前回放时间 ${currentTimeS.toFixed(2)} 秒。依次显示交会预测误差、网中心与半间距闭环、四绳目标和实际张力。`
    },
    title: [
      { text: "交会预测与可达域", top: 3 },
      { text: "网中心与半间距闭环", top: "34.6%" },
      { text: "四绳目标 / 实际张力", top: "68.8%" }
    ].map((title) => ({
      ...title,
      left: 12,
      textStyle: { color: "#e4edf5", fontSize: 13, fontWeight: 650 }
    })),
    tooltip: {
      trigger: "axis",
      confine: true,
      backgroundColor: "rgba(6, 15, 24, 0.97)",
      borderColor: "#2b465d",
      textStyle: { color: "#eaf3fa", fontSize: 11 },
      axisPointer: { type: "line", lineStyle: { color: COLORS.cyan, width: 1 } }
    },
    legend: [
      { data: ["X 预测误差", "Y 预测误差", "+3σ 可达域"], top: 4 },
      { data: ["X 指令", "X 实际", "Y 指令", "Y 实际", "半间距实际"], top: "34.7%" },
      { data: ["W1 实际", "W2 实际", "W3 实际", "W4 实际"], top: "68.9%" }
    ].map((legend) => ({
      ...legend,
      right: 8,
      itemWidth: 15,
      itemHeight: 2,
      textStyle: { color: "#8fa4b8", fontSize: 9 }
    })),
    grid: [
      { left: 54, right: 18, top: 34, height: "21.2%" },
      { left: 54, right: 18, top: "40.3%", height: "20.5%" },
      { left: 54, right: 18, top: "74.6%", bottom: 31 }
    ],
    xAxis: [
      baseAxis(0, prepared.maxTimeS),
      baseAxis(1, prepared.maxTimeS),
      baseAxis(2, prepared.maxTimeS)
    ],
    yAxis: [
      valueAxis(0, "预测误差 / m", -predictionLimit, predictionLimit),
      valueAxis(1, "位置 / m", -netLimit, netLimit),
      valueAxis(2, "张力 / kN", 0, ropeLimitKn)
    ],
    series: buildSeries(prepared, run, frame, currentTimeS)
  };
}

const magnitude3 = ([x, y, z]: readonly number[]): number => Math.hypot(x ?? 0, y ?? 0, z ?? 0);

const formatMetric = (value: number | null, digits = 2): string => (
  value === null || !Number.isFinite(value) ? "—" : value.toFixed(digits)
);

function Pipeline({ frame, run }: { frame: SimulationSnapshot | null; run: SimulationRun | null }) {
  const algorithm = run?.config.controller.algorithm ?? "predictive";
  const radioHealthy = frame !== null && (
    frame.tick - frame.radioStats.lastValidDeliveryTick
  ) * (run?.config.physicsDtS ?? 0) <= (run?.config.controller.staleTelemetryAbortS ?? 0);
  const handshakeActive = frame !== null && ["SYNC", "ARMED", "CLOSING"].includes(frame.supervisorState);
  const stages = [
    { label: "传感器", tone: frame === null ? "idle" : "active" },
    { label: "无线链路", tone: frame === null ? "idle" : radioHealthy ? "ready" : "warning" },
    { label: "状态估计", tone: frame === null ? "idle" : "active" },
    { label: algorithm === "mpc" ? "约束 MPC" : algorithm === "predictive" ? "交会预测" : "基线控制", tone: frame === null ? "idle" : "active" },
    { label: "PREPARE / READY / COMMIT", tone: handshakeActive ? "ready" : frame === null ? "idle" : "warning" },
    { label: "火箭内环 + 四绞盘张力环", tone: frame === null ? "idle" : "active" },
    { label: "物理对象", tone: frame === null ? "idle" : "active" }
  ];

  return (
    <div className="control-pipeline" aria-label="控制算法闭环数据流">
      {stages.map((stage, index) => (
        <div key={`${stage.label}-${index}`} className={`pipeline-stage pipeline-stage--${stage.tone}`}>
          <i aria-hidden="true" />
          <span>{stage.label}</span>
        </div>
      ))}
    </div>
  );
}

export function AlgorithmWorkspace({ run, frame, currentTimeS }: AlgorithmWorkspaceProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<EChartsType | null>(null);
  const updateFrameRef = useRef<number | null>(null);
  const prepared = useMemo(() => run === null ? null : prepareAlgorithmData(run), [run]);
  const relativeInterceptSpeed = frame?.capturePlan === null || frame?.capturePlan === undefined
    ? null
    : magnitude3(frame.capturePlan.predictedRelativeInterceptVelocityMps);

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    const chart = echarts.init(host, undefined, { renderer: "canvas" });
    chartRef.current = chart;
    const observer = new ResizeObserver(() => chart.resize());
    observer.observe(host);
    return () => {
      observer.disconnect();
      if (updateFrameRef.current !== null) cancelAnimationFrame(updateFrameRef.current);
      chart.dispose();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    const chart = chartRef.current;
    if (chart === null) return;
    if (prepared === null || run === null) {
      chart.clear();
      return;
    }
    chart.setOption(buildOption(prepared, run, frame, currentTimeS), {
      notMerge: true,
      lazyUpdate: true,
      silent: true
    });
  }, [prepared, run]);

  useEffect(() => {
    if (prepared === null || run === null || chartRef.current === null) return;
    if (updateFrameRef.current !== null) cancelAnimationFrame(updateFrameRef.current);
    updateFrameRef.current = requestAnimationFrame(() => {
      chartRef.current?.setOption(
        { series: buildSeries(prepared, run, frame, currentTimeS) },
        { notMerge: false, lazyUpdate: true, silent: true }
      );
      updateFrameRef.current = null;
    });
    return () => {
      if (updateFrameRef.current !== null) {
        cancelAnimationFrame(updateFrameRef.current);
        updateFrameRef.current = null;
      }
    };
  }, [currentTimeS, frame, prepared, run]);

  return (
    <div className="algorithm-workspace">
      <Pipeline frame={frame} run={run} />
      <div className="algorithm-live-strip" aria-label="当前控制裕度">
        <div>
          <span>到达裕度</span>
          <strong>{formatMetric(frame?.controlDiagnostics.reachabilityMarginS ?? null)} <small>s</small></strong>
        </div>
        <div>
          <span>提交裕度</span>
          <strong className={(frame?.controlDiagnostics.commitMarginS ?? 0) < 0 ? "is-warning" : ""}>
            {formatMetric(frame?.controlDiagnostics.commitMarginS ?? null)} <small>s</small>
          </strong>
        </div>
        <div>
          <span>相对交会速度</span>
          <strong>{formatMetric(relativeInterceptSpeed)} <small>m/s</small></strong>
        </div>
        <div>
          <span>3σ 置信半径</span>
          <strong>{formatMetric(frame?.capturePlan?.confidenceRadiusM ?? null)} <small>m</small></strong>
        </div>
      </div>
      <div ref={hostRef} className="algorithm-chart-canvas" />
      {run === null ? (
        <div className="panel-empty" role="status">
          <strong>等待控制闭环数据</strong>
          <span>运行场景后显示交会预测、网中心响应与四绳张力</span>
        </div>
      ) : null}
    </div>
  );
}
