import { describe, expect, it } from "vitest";
import { runProvenanceWhyEval } from "../../src/eval/suites/provenance-why.js";

describe("provenance why eval", () => {
  it("protects why() completeness, suffix lookup, surfaces, and fail-soft UX", () => {
    const r = runProvenanceWhyEval();
    expect(r.cliFailures).toBe(0);
    expect(r.completeChains).toBeGreaterThanOrEqual(2);
    expect(r.incompleteChains).toBeGreaterThanOrEqual(1);
    expect(r.pass).toBe(true);
  });
});
