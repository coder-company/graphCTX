import { describe, expect, it } from "vitest";
import { runGatePrecisionEval } from "../../src/eval/suites/gate-precision.js";

// Gate-precision benchmark: precision/recall/F1 of the relevance gate's firing
// decisions over a labeled set spanning every branch. Establishes a regression
// floor for shouldFire() so we can later improve PreToolUse selectivity without
// silently regressing recall (surface relevance != utility; recall first).
describe("gate precision/recall (firing-decision accuracy)", () => {
  it("meets the recall and precision floors over the labeled benchmark", () => {
    const r = runGatePrecisionEval();
    expect(r.cases).toBeGreaterThan(0);
    expect(r.recall).toBeGreaterThanOrEqual(r.recallFloor);
    expect(r.precision).toBeGreaterThanOrEqual(r.precisionFloor);
    expect(r.tp).toBeGreaterThan(0);
    expect(r.pass).toBe(true);
  });

  it("is deterministic across runs", () => {
    const a = runGatePrecisionEval();
    const b = runGatePrecisionEval();
    expect(b.precision).toBe(a.precision);
    expect(b.recall).toBe(a.recall);
    expect(b.f1).toBe(a.f1);
    expect(b.accuracy).toBe(a.accuracy);
  });
});
