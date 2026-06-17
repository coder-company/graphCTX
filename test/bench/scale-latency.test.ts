import { describe, expect, it } from "vitest";
import {
  FOOTPRINT_HEAP_BUDGET_MB,
  FOOTPRINT_RSS_BUDGET_MB,
  FOOTPRINT_STARTUP_BUDGET_MS,
  SCALE_BUDGET_MS,
  measureFootprint,
  measureScalePoint,
} from "../../src/bench/scale.js";

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

  it("fails closed when the declared p95 budget is impossible", async () => {
    const p = await measureScalePoint(1000, { repeats: 1, budgetMs: 0.001 });
    expect(p.retrievalMs.p95).toBeGreaterThan(p.budgetMs);
    expect(p.pass).toBe(false);
  }, 30000);

  it("measures cold startup-to-first-result and process footprint", async () => {
    const r = await measureFootprint({ scaleFacts: 1000 });
    expect(r.startupMs).toBeGreaterThan(0);
    expect(r.firstResultMs.p95).toBeLessThan(FOOTPRINT_STARTUP_BUDGET_MS);
    expect(r.rssMb).toBeLessThan(FOOTPRINT_RSS_BUDGET_MB);
    expect(r.heapUsedMb).toBeLessThan(FOOTPRINT_HEAP_BUDGET_MB);
    expect(r.resultCount).toBeGreaterThan(0);
    expect(r.pass).toBe(true);
  }, 30000);
});
