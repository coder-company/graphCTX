import { describe, expect, it } from "vitest";
import { runCoreMemoryLifecycleEval } from "../../src/eval/suites/core-memory-lifecycle.js";

describe("core memory lifecycle (CLI gate)", () => {
  it("protects remember -> recall -> why and open-loop resolution", () => {
    const r = runCoreMemoryLifecycleEval();
    expect(r.cliFailures).toBe(0);
    expect(r.openLoopLeaksAfterResolve).toBe(0);
    expect(r.pass).toBe(true);
  }, 60000);
});
