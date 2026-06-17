import { describe, expect, it } from "vitest";
import { runTelemetryLearningEval } from "../../src/eval/suites/telemetry-learning.js";

describe("telemetry learning eval", () => {
  it("protects classifier accuracy, learned ranking, local-only recording, and ledger behavior", () => {
    const r = runTelemetryLearningEval();
    expect(r.classificationAccuracy).toBeGreaterThanOrEqual(r.classificationThreshold);
    expect(r.learnedMetric).toBeGreaterThan(r.baselineMetric);
    expect(r.networkCalls).toBe(0);
    expect(r.pass).toBe(true);
  });
});
