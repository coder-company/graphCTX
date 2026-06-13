import { describe, expect, it } from "vitest";
import { runPromotionEval } from "../../src/eval/promotion-eval.js";

describe("workspace-promotion precision (M1 exit gate)", () => {
  it("achieves >= 90% precision with zero secret/task_state leakage", async () => {
    const r = await runPromotionEval();
    expect(r.precision).toBeGreaterThanOrEqual(0.9);
    expect(r.secretLeaks).toBe(0);
    expect(r.taskStateLeaks).toBe(0);
    expect(r.pass).toBe(true);
  }, 20000);
});
