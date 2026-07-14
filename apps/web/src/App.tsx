import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createNominalScenario,
  createPresetScenario,
  createScenarioDocument,
  migrateScenarioDocument,
  type AlgorithmMode,
  type ParameterTraceabilityResult,
  type ScenarioConfig,
  type ScenarioFaultConfig,
  type SimulationRun,
  type SimulationSnapshot,
  type ValidationSuiteResult
} from "@recovery/sim-core";
import {
  Dashboard,
  type DashboardParameterKey,
  type DashboardPreset,
  type InspectorTab,
  type MonteCarloSummary,
  type TaskProgress
} from "./components/Dashboard";
import type {
  SimulationWorkerRequest,
  SimulationWorkerResponse,
  WorkerTask
} from "./workers/protocol";

type AnalysisWorkerRequest = Exclude<SimulationWorkerRequest, { kind: "run" }>;
type WithoutRequestId<T> = T extends unknown ? Omit<T, "requestId"> : never;

const cloneConfig = (config: ScenarioConfig): ScenarioConfig => structuredClone(config);

const frameAtTime = (
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

const patchParameter = (
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

const algorithmLabel = (algorithm: AlgorithmMode): string => {
  if (algorithm === "fixed") return "固定网";
  if (algorithm === "alpha-beta") return "α–β 协同";
  return "预测协同";
};

const toMonteCarloSummary = (
  result: Extract<SimulationWorkerResponse, { kind: "comparison-result" }>["result"]
): MonteCarloSummary => ({
  sampleCount: result.samplesPerVariant,
  variants: result.variants.map((variant) => ({
    id: variant.algorithm,
    label: algorithmLabel(variant.algorithm),
    algorithm: variant.algorithm,
    runs: variant.runs,
    captures: variant.captures,
    secured: variant.secured,
    captureRate: variant.captureRate,
    securedRate: variant.securedRate,
    meanPeakLoadKn: variant.meanPeakLoadN / 1_000,
    p95PeakLoadKn: variant.p95PeakLoadN / 1_000
  }))
});

const downloadJson = (filename: string, payload: unknown): void => {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
};

export function App() {
  const [config, setConfig] = useState<ScenarioConfig>(() => createNominalScenario());
  const [run, setRun] = useState<SimulationRun | null>(null);
  const [currentTimeS, setCurrentTimeS] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedInspectorTab, setSelectedInspectorTab] = useState<InspectorTab>("scenario");
  const [monteCarloSummary, setMonteCarloSummary] = useState<MonteCarloSummary | null>(null);
  const [validationResult, setValidationResult] = useState<ValidationSuiteResult | null>(null);
  const [traceabilityResult, setTraceabilityResult] = useState<ParameterTraceabilityResult | null>(null);
  const [activeTask, setActiveTask] = useState<WorkerTask | null>(null);
  const [taskProgress, setTaskProgress] = useState<TaskProgress | null>(null);
  const [importNotice, setImportNotice] = useState<string | null>(null);

  const runWorkerRef = useRef<Worker | null>(null);
  const analysisWorkerRef = useRef<Worker | null>(null);
  const runRequestIdRef = useRef(0);
  const analysisRequestIdRef = useRef(0);

  const clearDerivedResults = useCallback(() => {
    setMonteCarloSummary(null);
    setValidationResult(null);
    setTraceabilityResult(null);
  }, []);

  const runScenario = useCallback((nextConfig: ScenarioConfig) => {
    runWorkerRef.current?.terminate();
    const requestId = runRequestIdRef.current + 1;
    runRequestIdRef.current = requestId;
    const worker = new Worker(new URL("./workers/simulation.worker.ts", import.meta.url), {
      type: "module"
    });
    runWorkerRef.current = worker;
    setBusy(true);
    setPlaying(false);
    setError(null);

    worker.onmessage = (event: MessageEvent<SimulationWorkerResponse>) => {
      const response = event.data;
      if (response.requestId !== runRequestIdRef.current) return;
      if (response.kind === "error") {
        setError(`单场景仿真失败：${response.message}`);
        setBusy(false);
        worker.terminate();
        if (runWorkerRef.current === worker) runWorkerRef.current = null;
        return;
      }
      if (response.kind !== "run-result") return;
      setRun(response.run);
      setConfig(response.run.config);
      setCurrentTimeS(0);
      setDirty(false);
      setBusy(false);
      setPlaying(true);
      worker.terminate();
      if (runWorkerRef.current === worker) runWorkerRef.current = null;
    };

    worker.onerror = (event) => {
      if (requestId !== runRequestIdRef.current) return;
      setError(`仿真 Worker 异常：${event.message || "未知错误"}`);
      setBusy(false);
      worker.terminate();
      if (runWorkerRef.current === worker) runWorkerRef.current = null;
    };

    const request: SimulationWorkerRequest = {
      requestId,
      kind: "run",
      config: cloneConfig(nextConfig)
    };
    worker.postMessage(request);
  }, []);

  useEffect(() => {
    runScenario(createNominalScenario());
    return () => {
      runWorkerRef.current?.terminate();
      analysisWorkerRef.current?.terminate();
    };
  }, [runScenario]);

  useEffect(() => {
    if (!playing || run === null || dirty) return undefined;
    let animationFrame = 0;
    let previous = performance.now();
    const durationS = run.finalSnapshot.timeS;
    const advance = (now: number) => {
      const elapsedS = Math.min(0.1, Math.max(0, (now - previous) / 1_000));
      previous = now;
      setCurrentTimeS((current) => {
        const next = current + elapsedS * speed;
        if (next >= durationS) {
          setPlaying(false);
          return durationS;
        }
        return next;
      });
      animationFrame = requestAnimationFrame(advance);
    };
    animationFrame = requestAnimationFrame(advance);
    return () => cancelAnimationFrame(animationFrame);
  }, [dirty, playing, run, speed]);

  const frame = useMemo(
    () => run === null ? null : frameAtTime(run.frames, currentTimeS),
    [currentTimeS, run]
  );

  const markConfigDirty = useCallback((next: ScenarioConfig) => {
    setConfig(next);
    setDirty(true);
    setPlaying(false);
    clearDerivedResults();
  }, [clearDerivedResults]);

  const handleParameterChange = useCallback((path: DashboardParameterKey, value: number) => {
    setConfig((current) => patchParameter(current, path, value));
    setDirty(true);
    setPlaying(false);
    clearDerivedResults();
  }, [clearDerivedResults]);

  const handleFaultConfigChange = useCallback((faults: ScenarioFaultConfig) => {
    const next = cloneConfig(config);
    next.faults = structuredClone(faults);
    next.id = "custom-fault-injection";
    next.name = "自定义故障注入场景";
    next.parameterSources.faults = {
      status: "assumed",
      source: "用户界面故障注入",
      note: "故障类型、时刻与幅值仅用于代理模型压力试验"
    };
    markConfigDirty(next);
  }, [config, markConfigDirty]);

  const handleAlgorithmChange = useCallback((algorithm: AlgorithmMode) => {
    const next = cloneConfig(config);
    next.controller.algorithm = algorithm;
    setConfig(next);
    clearDerivedResults();
    runScenario(next);
  }, [clearDerivedResults, config, runScenario]);

  const handlePresetChange = useCallback((preset: DashboardPreset) => {
    const next = createPresetScenario(preset);
    setConfig(next);
    setImportNotice(null);
    clearDerivedResults();
    runScenario(next);
  }, [clearDerivedResults, runScenario]);

  const handleSeedChange = useCallback((seed: number) => {
    if (!Number.isSafeInteger(seed)) return;
    const next = cloneConfig(config);
    next.seed = seed;
    markConfigDirty(next);
  }, [config, markConfigDirty]);

  const startAnalysis = useCallback((request: WithoutRequestId<AnalysisWorkerRequest>) => {
    analysisWorkerRef.current?.terminate();
    const requestId = analysisRequestIdRef.current + 1;
    analysisRequestIdRef.current = requestId;
    const worker = new Worker(new URL("./workers/simulation.worker.ts", import.meta.url), {
      type: "module"
    });
    analysisWorkerRef.current = worker;
    setActiveTask(request.kind);
    setTaskProgress({ task: request.kind, completed: 0, total: 1, label: "准备计算" });
    setError(null);

    worker.onmessage = (event: MessageEvent<SimulationWorkerResponse>) => {
      const response = event.data;
      if (response.requestId !== analysisRequestIdRef.current) return;
      if (response.kind === "progress") {
        setTaskProgress({
          task: response.task,
          completed: response.completed,
          total: response.total,
          label: response.label
        });
        return;
      }
      if (response.kind === "error") {
        setError(`分析任务失败：${response.message}`);
      } else if (response.kind === "comparison-result") {
        setMonteCarloSummary(toMonteCarloSummary(response.result));
      } else if (response.kind === "validation-result") {
        setValidationResult(response.result);
      } else if (response.kind === "sensitivity-result") {
        setTraceabilityResult(response.result);
      } else {
        return;
      }
      setActiveTask(null);
      setTaskProgress(null);
      worker.terminate();
      if (analysisWorkerRef.current === worker) analysisWorkerRef.current = null;
    };

    worker.onerror = (event) => {
      if (requestId !== analysisRequestIdRef.current) return;
      setError(`分析 Worker 异常：${event.message || "未知错误"}`);
      setActiveTask(null);
      setTaskProgress(null);
      worker.terminate();
      if (analysisWorkerRef.current === worker) analysisWorkerRef.current = null;
    };

    worker.postMessage({ ...request, requestId } as AnalysisWorkerRequest);
  }, []);

  const cancelAnalysis = useCallback(() => {
    analysisRequestIdRef.current += 1;
    analysisWorkerRef.current?.terminate();
    analysisWorkerRef.current = null;
    setActiveTask(null);
    setTaskProgress(null);
  }, []);

  const handleImportScenario = useCallback(async (file: File) => {
    try {
      const parsed = JSON.parse(await file.text()) as unknown;
      const result = migrateScenarioDocument(parsed);
      markConfigDirty(result.config);
      setSelectedInspectorTab("scenario");
      setImportNotice(result.migrated
        ? `已迁移到文档 v${result.targetDocumentVersion} / schema v${result.targetSchemaVersion}。${result.warnings.join("；")}`
        : `已载入 schema v${result.targetSchemaVersion} 场景；点击“应用参数并重算”执行。`
      );
      setError(null);
    } catch (cause) {
      setError(`场景导入失败：${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }, [markConfigDirty]);

  const handleTogglePlaying = useCallback(() => {
    if (run === null || dirty) return;
    const durationS = run.finalSnapshot.timeS;
    if (!playing && currentTimeS >= durationS - 1e-6) {
      setCurrentTimeS(0);
      setPlaying(true);
      return;
    }
    setPlaying((value) => !value);
  }, [currentTimeS, dirty, playing, run]);

  const handleStep = useCallback((direction: -1 | 1) => {
    if (run === null || dirty) return;
    setPlaying(false);
    if (run.frames.length === 0) return;
    const currentIndex = run.frames.findLastIndex(
      (candidate) => candidate.timeS <= currentTimeS + 1e-9
    );
    const targetIndex = Math.max(0, Math.min(run.frames.length - 1, currentIndex + direction));
    setCurrentTimeS(run.frames[targetIndex]?.timeS ?? currentTimeS);
  }, [currentTimeS, dirty, run]);

  const handleSeek = useCallback((timeS: number) => {
    const maximum = run?.finalSnapshot.timeS ?? config.durationS;
    setCurrentTimeS(Math.max(0, Math.min(maximum, timeS)));
  }, [config.durationS, run]);

  return (
    <Dashboard
      run={run}
      frame={frame}
      currentTimeS={currentTimeS}
      config={config}
      busy={busy}
      dirty={dirty}
      error={error}
      playing={playing}
      speed={speed}
      selectedInspectorTab={selectedInspectorTab}
      onTogglePlaying={handleTogglePlaying}
      onReset={() => runScenario(config)}
      onStep={handleStep}
      onSeek={handleSeek}
      onSpeedChange={setSpeed}
      onInspectorTabChange={setSelectedInspectorTab}
      onParameterChange={handleParameterChange}
      onFaultConfigChange={handleFaultConfigChange}
      onAlgorithmChange={handleAlgorithmChange}
      onPresetChange={handlePresetChange}
      onSeedChange={handleSeedChange}
      onImportScenario={handleImportScenario}
      importNotice={importNotice}
      onExportScenario={() => downloadJson(
        `recovery-scenario-${config.id}-seed-${config.seed}.json`,
        createScenarioDocument(config)
      )}
      onExportRun={() => {
        if (run !== null) {
          downloadJson(
            `recovery-run-${run.config.id}-seed-${run.config.seed}.json`,
            {
              format: "recovery-proxy-run",
              documentVersion: 2,
              modelVersion: run.modelVersion,
              configFingerprint: run.configFingerprint,
              notice: "公开机理代理模型运行结果，不是实际型号试验结论",
              run
            }
          );
        }
      }}
      onRunMonteCarlo={(samplesPerVariant) => startAnalysis({
        kind: "comparison",
        config: cloneConfig(config),
        samplesPerVariant
      })}
      onRunValidation={() => startAnalysis({ kind: "validation", config: cloneConfig(config) })}
      onRunSensitivity={() => startAnalysis({ kind: "sensitivity", config: cloneConfig(config) })}
      onCancelTask={cancelAnalysis}
      monteCarloSummary={monteCarloSummary}
      validationResult={validationResult}
      traceabilityResult={traceabilityResult}
      activeTask={activeTask}
      taskProgress={taskProgress}
    />
  );
}
