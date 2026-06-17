import { describe, expect, it } from "vitest";
import { EVAL_GATE_SUITES } from "../../src/eval/registry.js";
import { runCodeQualityEval } from "../../src/eval/suites/code-quality.js";

describe("code quality eval", () => {
  it("protects lint debt, command reachability, README drift, and eval-suite coverage", () => {
    const r = runCodeQualityEval();
    expect(r.fullBiomeExit).toBe(0);
    expect(r.commandCount).toBe(17);
    expect(r.evalSuiteCount).toBe(EVAL_GATE_SUITES.length);
    expect(r.evalSuiteCount).toBeGreaterThanOrEqual(19);
    expect(r.coveredEvalSuites).toBe(r.evalSuiteCount);
    expect(r.staleReadmeCommands).toEqual([]);
    expect(r.unexpectedCommands).toEqual([]);
    expect(r.pass).toBe(true);
  }, 30000);
});
