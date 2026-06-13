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
});
