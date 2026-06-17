import { describe, expect, it } from "vitest";
import { runRetrievalQualityEval } from "../../src/eval/suites/retrieval-quality.js";

// Retrieval-quality benchmark: recall@k + MRR over a labeled (query → gold fact)
// set, plus semantic no-overlap and MMR diversity probes.
describe("retrieval quality (recall@k + MRR)", () => {
  it("meets ranking floors and semantic/MMR parity probes", async () => {
    const r = await runRetrievalQualityEval();
    expect(r.queries).toBeGreaterThan(0);
    expect(r.recallAt10).toBeGreaterThanOrEqual(r.floor);
    expect(r.recallAt5).toBeGreaterThanOrEqual(r.recallAt5Floor);
    expect(r.mrr).toBeGreaterThanOrEqual(r.mrrFloor);
    expect(r.semanticProbe.queryObjectOverlap).toBe(false);
    expect(r.semanticProbe.firstRank).toBeGreaterThan(0);
    expect(r.semanticProbe.firstRank).toBeLessThanOrEqual(10);
    expect(r.diversityProbe.distinctFamiliesTop5).toBeGreaterThanOrEqual(3);
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
