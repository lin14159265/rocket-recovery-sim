import {
  runAlgorithmComparison,
  runLocalSensitivity,
  runSimulation,
  runValidationSuite
} from "@recovery/sim-core";
import type {
  SimulationWorkerRequest,
  SimulationWorkerResponse,
  WorkerProgress,
  WorkerTask
} from "./protocol";

const worker = self as DedicatedWorkerGlobalScope;

const postProgress = (
  requestId: number,
  task: WorkerTask,
  progress: Omit<WorkerProgress, "task">
): void => {
  const response: SimulationWorkerResponse = {
    requestId,
    kind: "progress",
    task,
    ...progress
  };
  worker.postMessage(response);
};

worker.onmessage = (event: MessageEvent<SimulationWorkerRequest>) => {
  const request = event.data;
  try {
    if (request.kind === "run") {
      const response: SimulationWorkerResponse = {
        requestId: request.requestId,
        kind: "run-result",
        run: runSimulation(request.config, {
          frameRateHz: 30,
          stopOnTerminal: false
        })
      };
      worker.postMessage(response);
      return;
    }

    if (request.kind === "comparison") {
      const response: SimulationWorkerResponse = {
        requestId: request.requestId,
        kind: "comparison-result",
        result: runAlgorithmComparison(request.config, {
          samplesPerVariant: request.samplesPerVariant,
          seed: request.config.seed,
          simulationOptions: {
            frameRateHz: 1,
            stopOnTerminal: true
          },
          onProgress: (progress) => postProgress(request.requestId, "comparison", progress)
        })
      };
      worker.postMessage(response);
      return;
    }

    if (request.kind === "validation") {
      const response: SimulationWorkerResponse = {
        requestId: request.requestId,
        kind: "validation-result",
        result: runValidationSuite(request.config, {
          onProgress: (progress) => postProgress(request.requestId, "validation", progress)
        })
      };
      worker.postMessage(response);
      return;
    }

    const response: SimulationWorkerResponse = {
      requestId: request.requestId,
      kind: "sensitivity-result",
      result: runLocalSensitivity(request.config, (progress) =>
        postProgress(request.requestId, "sensitivity", progress)
      )
    };
    worker.postMessage(response);
  } catch (error) {
    const response: SimulationWorkerResponse = {
      requestId: request.requestId,
      kind: "error",
      message: error instanceof Error ? error.message : String(error)
    };
    worker.postMessage(response);
  }
};

export {};
