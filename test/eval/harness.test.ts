import { describe, expect, it } from "vitest";
import { runEval } from "../../src/eval/harness.js";

describe("compaction-recovery eval (M0 gate)", () => {
  it("C (push) beats B (pull) on solve rate and repeated failures", async () => {
    const report = await runEval({ suite: "compaction-recovery", arms: ["A", "B", "C"] });
    const a = report.arms.find((x) => x.arm === "A")!;
    const b = report.arms.find((x) => x.arm === "B")!;
    const c = report.arms.find((x) => x.arm === "C")!;

    expect(a.postCompactSolveRate).toBe(0); // no memory solves nothing
    expect(c.postCompactSolveRate).toBeGreaterThan(b.postCompactSolveRate);
    expect(c.repeatedFailedCommands).toBeLessThan(b.repeatedFailedCommands);
  }, 30000);

  it("N (negative-control): push delivers a fact present in NO repo file", async () => {
    const report = await runEval({ suite: "compaction-recovery", arms: ["N"] });
    const n = report.controls.find((c) => c.arm === "N")!;
    expect(n.repos).toBeGreaterThan(0);
    // every repo must deliver the memory-only fact AND have it absent from files
    expect(n.passed).toBe(n.repos);
  }, 30000);

  it("S (stale-fact): graphCTX suppresses an invalidated fact (I4)", async () => {
    const report = await runEval({ suite: "compaction-recovery", arms: ["S"] });
    const s = report.controls.find((c) => c.arm === "S")!;
    expect(s.repos).toBeGreaterThan(0);
    expect(s.passed).toBe(s.repos); // never inject the stale fact
  }, 30000);
});
