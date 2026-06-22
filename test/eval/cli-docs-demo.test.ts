import { describe, expect, it } from "vitest";
import { EVAL_GATE_SUITES } from "../../src/eval/registry.js";
import { runCliDocsDemoEval } from "../../src/eval/suites/cli-docs-demo.js";

describe("CLI/docs/demo parity eval", () => {
  it("protects help/docs drift, offline demo, doctor, MCP, and install UX", async () => {
    const r = await runCliDocsDemoEval();
    expect(r.commandCount).toBe(18);
    expect(r.testCount).toBeGreaterThanOrEqual(169);
    expect(r.suiteCount).toBe(EVAL_GATE_SUITES.length);
    expect(r.suiteCount).toBeGreaterThanOrEqual(18);
    expect(r.demoFacts).toBeGreaterThan(0);
    expect(r.mcpTools).toBe(8);
    expect(r.networkCalls).toBe(0);
    expect(r.pipeFailures).toBe(0);
    expect(r.argValidationFailures).toBe(0);
    expect(r.pass).toBe(true);
  }, 60000);
});
