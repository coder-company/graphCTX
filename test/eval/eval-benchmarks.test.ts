import { describe, expect, it } from "vitest";
import { EVAL_GATE_SUITES } from "../../src/eval/registry.js";
import { runEvalBenchmarksEval } from "../../src/eval/suites/eval-benchmarks.js";

describe("eval harness and benchmarks", () => {
  it("protects registry completeness, ablation, offline compare, scale, and no-network guards", async () => {
    const r = await runEvalBenchmarksEval();
    expect(r.suiteCount).toBe(EVAL_GATE_SUITES.length);
    expect(r.suiteCount).toBeGreaterThanOrEqual(17);
    expect(r.ablation.pushSolveRate).toBeGreaterThan(r.ablation.pullSolveRate);
    expect(r.ablation.negativeControlsPassed).toBe(r.ablation.controlRepos);
    expect(r.ablation.staleControlsPassed).toBe(r.ablation.controlRepos);
    expect(r.scorecardAxes).toBeGreaterThanOrEqual(8);
    expect(r.deepLocalRecall).toBe(1);
    expect(r.deepLocalProbeCount).toBeGreaterThanOrEqual(15);
    expect(r.deepLocalP95).toBeLessThan(150);
    expect(r.temporalCurrentRecall).toBe(1);
    expect(r.temporalStaleSuppression).toBe(1);
    expect(r.temporalProbeCount).toBeGreaterThanOrEqual(6);
    expect(r.temporalP95).toBeLessThan(150);
    expect(r.scaleSizes).toEqual([1000, 10000]);
    expect(r.scaleP95.every((p95) => p95 < 150)).toBe(true);
    expect(r.networkCalls).toBe(0);
    expect(r.pass).toBe(true);
  }, 60000);
});
