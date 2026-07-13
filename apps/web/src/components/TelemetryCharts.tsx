import { useEffect, useMemo, useRef } from "react";
import type { SimulationRun, TelemetrySample } from "@recovery/sim-core";
import * as echarts from "echarts/core";
import type { EChartsCoreOption, EChartsType } from "echarts/core";
import { LineChart, ScatterChart } from "echarts/charts";
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
  ScatterChart,
  TitleComponent,
  TooltipComponent,
  CanvasRenderer
]);

export interface TelemetryChartsProps {
  run: SimulationRun | null;
  currentTimeS: number;
}

interface PreparedTelemetry {
  run: SimulationRun;
  maxTime: number;
  spacing: DataPoint[];
  speed: DataPoint[];
  vertical: DataPoint[];
  force: DataPoint[];
  load: DataPoint[];
  futureForceMax: number;
  loadMax: number;
}

type DataPoint = [number, number];
type NullablePoint = [number, number | null];

const HISTORY_COLORS = {
  cyan: "#3cbcff",
  green: "#40d7a0",
  orange: "#ff9447",
  violet: "#aa82ff",
  hot: "#ff6948"
};

const FUTURE_COLOR = "rgba(126, 147, 169, 0.31)";

function splitAtTime(data: DataPoint[], currentTimeS: number): {
  history: NullablePoint[];
  future: NullablePoint[];
  current: DataPoint[];
} {
  if (data.length === 0) return { history: [], future: [], current: [] };
  let boundary = -1;
  for (let index = 0; index < data.length; index += 1) {
    const point = data[index];
    if (point !== undefined && point[0] <= currentTimeS) boundary = index;
    else break;
  }
  const currentIndex = Math.max(0, boundary);
  return {
    history: data.map(([time, value], index) => [time, index <= boundary ? value : null]),
    future: data.map(([time, value], index) => [time, index >= currentIndex ? value : null]),
    current: boundary < 0 ? [] : [data[boundary] as DataPoint]
  };
}

const toData = (
  samples: readonly TelemetrySample[],
  selector: (sample: TelemetrySample) => number
): DataPoint[] => samples.map((sample) => [sample.timeS, selector(sample)]);

const baseAxis = (gridIndex: number, maxTime: number) => ({
  type: "value" as const,
  gridIndex,
  min: 0,
  max: maxTime,
  axisLine: { lineStyle: { color: "#5d7187" } },
  axisTick: { show: false },
  axisLabel: { color: "#8ea1b5", fontSize: 10, margin: 7 },
  splitLine: { lineStyle: { color: "rgba(104, 132, 158, 0.13)" } },
  name: "时间 / s",
  nameLocation: "middle" as const,
  nameGap: 24,
  nameTextStyle: { color: "#8195a9", fontSize: 10 }
});

const yAxis = (gridIndex: number, name: string, max?: number) => ({
  type: "value" as const,
  gridIndex,
  min: 0,
  max,
  name,
  nameLocation: "middle" as const,
  nameGap: 38,
  nameTextStyle: { color: "#8ea1b5", fontSize: 10 },
  axisLine: { show: true, lineStyle: { color: "#5d7187" } },
  axisTick: { show: false },
  axisLabel: { color: "#8ea1b5", fontSize: 10 },
  splitLine: { lineStyle: { color: "rgba(104, 132, 158, 0.13)" } }
});

const lineSeries = (
  name: string,
  data: NullablePoint[],
  xAxisIndex: number,
  yAxisIndex: number,
  color: string,
  width: number,
  extra: Record<string, unknown> = {}
) => ({
  name,
  type: "line",
  data,
  xAxisIndex,
  yAxisIndex,
  showSymbol: false,
  connectNulls: false,
  animation: false,
  silent: color === FUTURE_COLOR,
  lineStyle: { color, width },
  itemStyle: { color },
  emphasis: { disabled: color === FUTURE_COLOR },
  ...extra
});

const pointSeries = (
  data: DataPoint[],
  xAxisIndex: number,
  yAxisIndex: number,
  color: string
) => ({
  type: "scatter",
  data,
  xAxisIndex,
  yAxisIndex,
  symbolSize: 8,
  silent: true,
  animation: false,
  itemStyle: {
    color,
    borderColor: "#eaf6ff",
    borderWidth: 1.4,
    shadowBlur: 8,
    shadowColor: color
  },
  z: 8
});

function prepareTelemetry(run: SimulationRun): PreparedTelemetry {
  const samples = run.telemetry;
  return {
    run,
    maxTime: Math.max(run.config.durationS, samples.at(-1)?.timeS ?? 0.001),
    spacing: toData(samples, (sample) => (
      sample.netHalfSpacingM[0] + sample.netHalfSpacingM[1]
    ) / 2),
    speed: toData(samples, (sample) => sample.speedMps),
    vertical: toData(samples, (sample) => Math.abs(sample.verticalSpeedMps)),
    force: toData(samples, (sample) => sample.contactForceN / 1_000),
    load: toData(samples, (sample) => sample.apparentLoadG),
    futureForceMax: Math.max(100, run.config.net.totalStrengthLimitN / 1_000 * 1.08),
    loadMax: Math.max(3, run.metrics.peakApparentLoadG * 1.15)
  };
}

function buildSeries(prepared: PreparedTelemetry, currentTimeS: number) {
  const { run } = prepared;
  const spacing = splitAtTime(prepared.spacing, currentTimeS);
  const speed = splitAtTime(prepared.speed, currentTimeS);
  const vertical = splitAtTime(prepared.vertical, currentTimeS);
  const force = splitAtTime(prepared.force, currentTimeS);
  const load = splitAtTime(prepared.load, currentTimeS);
  return [
    lineSeries("半间距未来", spacing.future, 0, 0, FUTURE_COLOR, 1.5),
    lineSeries("半间距", spacing.history, 0, 0, HISTORY_COLORS.cyan, 2.2, {
      markLine: {
        silent: true,
        symbol: "none",
        label: {
          show: true,
          formatter: `${run.config.net.closedHalfSpacingM.toFixed(1)} m 目标`,
          color: HISTORY_COLORS.hot,
          fontSize: 9,
          position: "insideEndTop"
        },
        lineStyle: { color: HISTORY_COLORS.hot, type: "dashed", width: 1.2 },
        data: [{ yAxis: run.config.net.closedHalfSpacingM }]
      }
    }),
    pointSeries(spacing.current, 0, 0, HISTORY_COLORS.cyan),

    lineSeries("速度未来", speed.future, 1, 1, FUTURE_COLOR, 1.4),
    lineSeries("垂向速度未来", vertical.future, 1, 1, FUTURE_COLOR, 1.1),
    lineSeries("合速度", speed.history, 1, 1, HISTORY_COLORS.green, 2.1),
    lineSeries("垂向速度", vertical.history, 1, 1, HISTORY_COLORS.orange, 1.8),
    pointSeries(speed.current, 1, 1, HISTORY_COLORS.green),

    lineSeries("接触力未来", force.future, 2, 2, FUTURE_COLOR, 1.4),
    lineSeries("载荷未来", load.future, 2, 3, FUTURE_COLOR, 1.1),
    lineSeries("接触力", force.history, 2, 2, HISTORY_COLORS.violet, 2.1),
    lineSeries("表观载荷", load.history, 2, 3, HISTORY_COLORS.hot, 1.9),
    pointSeries(force.current, 2, 2, HISTORY_COLORS.violet),
    pointSeries(load.current, 2, 3, HISTORY_COLORS.hot)
  ];
}

function buildOption(prepared: PreparedTelemetry, currentTimeS: number): EChartsCoreOption {
  const { run, maxTime, futureForceMax, loadMax } = prepared;

  return {
    backgroundColor: "transparent",
    animation: false,
    aria: {
      enabled: true,
      decal: { show: false },
      description: `当前回放时间 ${currentTimeS.toFixed(2)} 秒。三幅图依次显示网绳半间距、速度、接触力与表观载荷。`
    },
    title: [
      { text: "井字网绳半间距", left: 10, top: 2 },
      { text: "速度与垂向速度", left: 10, top: "34.2%" },
      { text: "网绳接触力与竖直表观载荷", left: 10, top: "68.6%" }
    ].map((title) => ({
      ...title,
      textStyle: { color: "#dce6ef", fontSize: 13, fontWeight: 650 }
    })),
    tooltip: {
      trigger: "axis",
      confine: true,
      backgroundColor: "rgba(7, 16, 26, 0.96)",
      borderColor: "#2a435b",
      textStyle: { color: "#e8f2fb", fontSize: 11 },
      axisPointer: { type: "line", lineStyle: { color: "#4ebeff", width: 1 } }
    },
    legend: [
      { data: ["半间距"], top: 3, right: 8 },
      { data: ["合速度", "垂向速度"], top: "34.2%", right: 8 },
      { data: ["接触力", "表观载荷"], top: "68.6%", right: 8 }
    ].map((legend) => ({
      ...legend,
      itemWidth: 15,
      itemHeight: 2,
      textStyle: { color: "#8fa4b8", fontSize: 9 }
    })),
    grid: [
      { left: 52, right: 17, top: 30, height: "21.5%", containLabel: false },
      { left: 52, right: 17, top: "39%", height: "20.5%", containLabel: false },
      { left: 52, right: 48, top: "74%", bottom: 31, containLabel: false }
    ],
    xAxis: [baseAxis(0, maxTime), baseAxis(1, maxTime), baseAxis(2, maxTime)],
    yAxis: [
      yAxis(0, "m", Math.max(run.config.net.openHalfSpacingM * 1.15, 5)),
      yAxis(1, "m/s"),
      {
        ...yAxis(2, "接触力 / kN", futureForceMax),
        axisLine: { show: true, lineStyle: { color: HISTORY_COLORS.violet } },
        nameTextStyle: { color: HISTORY_COLORS.violet, fontSize: 10 }
      },
      {
        ...yAxis(2, "载荷 / g", loadMax),
        position: "right",
        nameGap: 35,
        axisLine: { show: true, lineStyle: { color: HISTORY_COLORS.hot } },
        nameTextStyle: { color: HISTORY_COLORS.hot, fontSize: 10 },
        splitLine: { show: false }
      }
    ],
    series: buildSeries(prepared, currentTimeS)
  };
}

export function TelemetryCharts({ run, currentTimeS }: TelemetryChartsProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<EChartsType | null>(null);
  const updateFrameRef = useRef<number | null>(null);
  const prepared = useMemo(() => run === null ? null : prepareTelemetry(run), [run]);

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
    if (prepared === null) {
      chart.clear();
      return;
    }
    chart.setOption(buildOption(prepared, currentTimeS), {
      notMerge: true,
      lazyUpdate: true,
      silent: true
    });
  }, [prepared]);

  useEffect(() => {
    if (prepared === null || chartRef.current === null) return;
    if (updateFrameRef.current !== null) cancelAnimationFrame(updateFrameRef.current);
    updateFrameRef.current = requestAnimationFrame(() => {
      chartRef.current?.setOption(
        { series: buildSeries(prepared, currentTimeS) },
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
  }, [currentTimeS, prepared]);

  return (
    <div className="telemetry-charts">
      <div ref={hostRef} className="telemetry-chart-canvas" />
      {run === null ? (
        <div className="panel-empty" role="status">
          <strong>等待遥测数据</strong>
          <span>运行场景后显示完整未来轨迹与当前历史片段</span>
        </div>
      ) : null}
    </div>
  );
}
