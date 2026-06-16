import { describe, expect, it } from "vitest";
import { runRetrievalQualityEval } from "../../src/eval/suites/retrieval-quality.js";

// Retrieval-quality benchmark: recall@k + MRR over a labeled (query → gold fact)
// set. Establishes a regression floor for the Retriever so we can later A/B test
// fusion strategies (weighted-average vs Reciprocal Rank Fusion).
describe("retrieval quality (recall@k + MRR)", () => {
  it("meets the recall@10 floor over the labeled benchmark", async () => {
    const r = await runRetrievalQualityEval();
    expect(r.queries).toBeGreaterThan(0);
    expect(r.recallAt10).toBeGreaterThanOrEqual(r.floor);
    expect(r.pass).toBe(true);
  }, 30000);

  it("is deterministic across runs", async () => {
    const a = await runRetrievalQualityEval();
    const b = await runRetrievalQualityEval();
    expect(b.recallAt1).toBe(a.recallAt1);
    expect(b.recallAt5).toBe(a.recallAt5);
    expect(b.recallAt10).toBe(a.recallAt10);
    expect(b.mrr).toBe(a.mrr);
  }, 30000);
});
