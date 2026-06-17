import { describe, expect, it } from "vitest";
import { SCALE_BUDGET_MS, measureScalePoint } from "../../src/bench/scale.js";

// Regression gate (SPEC §24): the hot path (indexed BM25 + bounded semantic
// re-rank, k-limited) must hold p95 < 150ms even at scale. We probe 10k facts —
// large enough to catch a super-linear regression, small enough to ingest in
// well under the CI budget — and assert the SPEC budget (generous headroom over
// the observed ~40ms p95 keeps this from flaking).
describe("scale latency budget (SPEC §24)", () => {
  it("hot-path retrieval p95 < 150ms at 10k facts", async () => {
    const p = await measureScalePoint(10000, { repeats: 25 });
    expect(p.scaleFacts).toBe(10000);
    expect(p.retrievalMs.p95).toBeLessThan(SCALE_BUDGET_MS);
    expect(p.pass).toBe(true);
  }, 90000);
});
