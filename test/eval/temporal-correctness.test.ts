import { describe, expect, it } from "vitest";
import { runTemporalCorrectnessEval } from "../../src/eval/suites/temporal-correctness.js";

// Temporal-correctness suite: real-git commit-valid memory (SPEC §8). Unlike
// branch-truth (which uses a hardcoded ancestry oracle), this drives REAL git
// repos through fast-forward / branch / revert / merge / rebase / cherry-pick
// and asserts point-in-time fact validity + detectEvent classification.
describe("temporal correctness (real-git)", () => {
  it("passes the gated verdict over real git repos", async () => {
    const r = await runTemporalCorrectnessEval();
    expect(r.gatedTotal).toBeGreaterThan(0);
    expect(r.gatedPassed).toBe(r.gatedTotal);
    expect(r.pass).toBe(true);
  }, 60_000);

  it("recognizes a cherry-picked change as the same patch across SHAs", async () => {
    const r = await runTemporalCorrectnessEval();
    // Pure git capability — must hold regardless of validity wiring.
    expect(r.patchIdEqual).toBe(true);
  }, 60_000);

  it("classifies every detectEvent kind correctly", async () => {
    const r = await runTemporalCorrectnessEval();
    for (const row of r.classification) {
      expect(row.ok, `${row.kind} classified as ${row.got}`).toBe(true);
    }
  }, 60_000);
});
