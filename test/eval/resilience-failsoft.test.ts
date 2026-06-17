import { describe, expect, it } from "vitest";
import { runResilienceFailsoftEval } from "../../src/eval/suites/resilience-failsoft.js";

describe("resilience fail-soft eval", () => {
  it("protects no-key, bad-store/config, hook, provider, and lifecycle degradation", async () => {
    const r = await runResilienceFailsoftEval();
    expect(r.cliFailures).toBe(0);
    expect(r.deterministicFactsAfterSessionStart).toBeGreaterThan(0);
    expect(r.pass).toBe(true);
  }, 60000);
});
