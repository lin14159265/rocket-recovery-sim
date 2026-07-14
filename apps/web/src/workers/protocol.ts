import type {
  AlgorithmComparisonResult,
  ParameterTraceabilityResult,
  ScenarioConfig,
  SimulationRun,
  ValidationSuiteResult
} from "@recovery/sim-core";

export type WorkerTask = "comparison" | "validation" | "sensitivity";

export interface WorkerProgress {
  task: WorkerTask;
  completed: number;
  total: number;
  label: string;
}

export type SimulationWorkerRequest =
  | {
      requestId: number;
      kind: "run";
      config: ScenarioConfig;
    }
  | {
      requestId: number;
      kind: "comparison";
      config: ScenarioConfig;
      samplesPerVariant: number;
    }
  | {
      requestId: number;
      kind: "validation";
      config: ScenarioConfig;
    }
  | {
      requestId: number;
      kind: "sensitivity";
      config: ScenarioConfig;
    };

export type SimulationWorkerResponse =
  | {
      requestId: number;
      kind: "run-result";
      run: SimulationRun;
    }
  | {
      requestId: number;
      kind: "comparison-result";
      result: AlgorithmComparisonResult;
    }
  | {
      requestId: number;
      kind: "validation-result";
      result: ValidationSuiteResult;
    }
  | {
      requestId: number;
      kind: "sensitivity-result";
      result: ParameterTraceabilityResult;
    }
  | ({ requestId: number; kind: "progress" } & WorkerProgress)
  | {
      requestId: number;
      kind: "error";
      message: string;
    };
