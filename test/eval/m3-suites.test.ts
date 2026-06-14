import { describe, expect, it } from "vitest";
import { runBranchTruthEval } from "../../src/eval/suites/branch-truth.js";
import { runParallelConflictEval } from "../../src/eval/suites/parallel-conflict.js";
import { runProcedureMemoryEval } from "../../src/eval/suites/procedure-memory.js";

describe("M3 gate suites", () => {
  it("branch-truth: no cross-branch leakage, revert restores truth", () => {
    const r = runBranchTruthEval();
    expect(r.leaks).toBe(0);
    expect(r.pass).toBe(true);
  });

  it("parallel-conflict: no silent last-writer-wins", () => {
    const r = runParallelConflictEval();
    expect(r.silentWrongWinners).toBe(0);
    expect(r.pass).toBe(true);
  });

  it("procedure-memory: safe + precise LLM extraction, descriptive procedures", async () => {
    const r = await runProcedureMemoryEval();
    expect(r.secretsLeaked).toBe(0);
    expect(r.highTrustLlmFacts).toBe(0);
    expect(r.hallucinatedEvidence).toBe(0);
    expect(r.pass).toBe(true);
  });
});
