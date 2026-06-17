import { describe, expect, it } from "vitest";
import { runParallelConflictEval } from "../../src/eval/suites/parallel-conflict.js";

// Comprehensive conflict & precedence regression gate (SPEC §14, M3). Proves the
// full precedence ladder, deterministic total ordering, resolveConflicts
// semantics, and the reconcileWrite matrix all hold — and that NO genuine
// contradiction is ever silently resolved (no last-writer-wins).
describe("parallel-conflict & precedence (comprehensive)", () => {
  it("passes the full gated verdict with zero silent wrong winners", () => {
    const r = runParallelConflictEval();
    expect(r.cases).toBeGreaterThan(0);
    expect(r.passed).toBe(r.cases);
    expect(r.silentWrongWinners).toBe(0);
    expect(r.pass).toBe(true);
  });

  it("verifies every ordered precedence-rank pair (full cross-product)", () => {
    const r = runParallelConflictEval();
    // 9 ranks → C(9,2) = 36 ordered (higher, lower) pairs.
    expect(r.ladder.pairs).toBe(36);
    expect(r.ladder.passed).toBe(r.ladder.pairs);
  });

  it("byPrecedence is a stable total order with deterministic contentKey tiebreak", () => {
    const r = runParallelConflictEval();
    expect(r.determinism.stable).toBe(true);
    expect(r.determinism.tiebreakByContentKey).toBe(true);
  });

  it("resolveConflicts semantics and reconcileWrite matrix fully pass", () => {
    const r = runParallelConflictEval();
    expect(r.resolve.passed).toBe(r.resolve.cases);
    expect(r.reconcile.passed).toBe(r.reconcile.cases);
  });

  it("is deterministic across runs", () => {
    const a = runParallelConflictEval();
    const b = runParallelConflictEval();
    expect(b.cases).toBe(a.cases);
    expect(b.passed).toBe(a.passed);
    expect(b.silentWrongWinners).toBe(a.silentWrongWinners);
  });
});
