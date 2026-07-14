import { describe, expect, it } from "vitest";
import {
  createNominalScenario,
  createScenarioDocument,
  migrateScenarioDocument
} from "../src";

describe("scenario document migration", () => {
  it("round-trips the current envelope", () => {
    const config = createNominalScenario();
    const document = createScenarioDocument(config);
    const result = migrateScenarioDocument(document);
    expect(result.migrated).toBe(false);
    expect(result.config).toEqual(config);
  });

  it("migrates a legacy v1 raw config with faults disabled", () => {
    const legacy = structuredClone(createNominalScenario()) as unknown as Record<string, unknown>;
    legacy.schemaVersion = 1;
    delete legacy.faults;
    const result = migrateScenarioDocument(legacy);
    expect(result.migrated).toBe(true);
    expect(result.config.schemaVersion).toBe(2);
    expect(result.config.faults.radioBlackout.enabled).toBe(false);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("rejects a future schema", () => {
    expect(() => migrateScenarioDocument({ schemaVersion: 99 })).toThrow(/高于当前支持/);
  });

  it("rejects malformed fault vectors and unsupported winch nodes", () => {
    const malformedVector = createScenarioDocument(createNominalScenario()) as unknown as {
      config: { faults: { sensorBiasStep: { deltaM: unknown } } };
    };
    malformedVector.config.faults.sensorBiasStep.deltaM = [1, 2];
    expect(() => migrateScenarioDocument(malformedVector)).toThrow(/长度为 3/);

    const malformedNode = createScenarioDocument(createNominalScenario()) as unknown as {
      config: { faults: { winchStuck: { node: string } } };
    };
    malformedNode.config.faults.winchStuck.node = "unknown-winch";
    expect(() => migrateScenarioDocument(malformedNode)).toThrow(/绞盘节点/);
  });

  it("rejects contradictory geometry and invalid link probabilities", () => {
    const geometry = createNominalScenario();
    geometry.net.closedHalfSpacingM = geometry.net.openHalfSpacingM;
    expect(() => migrateScenarioDocument(geometry)).toThrow(/必须小于/);

    const link = createNominalScenario();
    link.radio.lossRate = 1.1;
    expect(() => migrateScenarioDocument(link)).toThrow(/\[0, 1\]/);
  });
  it("migrates the v0.2 envelope without an explicit document version", () => {
    const config = createNominalScenario();
    (config as unknown as { schemaVersion: number }).schemaVersion = 1;
    const legacyEnvelope = {
      format: "recovery-proxy-scenario",
      modelVersion: "0.2.0",
      config
    };
    const result = migrateScenarioDocument(legacyEnvelope);
    expect(result.sourceDocumentVersion).toBe(1);
    expect(result.targetDocumentVersion).toBe(2);
    expect(result.migrated).toBe(true);
    expect(result.warnings.join(" ")).toMatch(/documentVersion 2/);
  });

  it("rejects a future document version", () => {
    const document = createScenarioDocument(createNominalScenario()) as unknown as {
      documentVersion: number;
    };
    document.documentVersion = 99;
    expect(() => migrateScenarioDocument(document)).toThrow(/documentVersion=99/);
  });

});
