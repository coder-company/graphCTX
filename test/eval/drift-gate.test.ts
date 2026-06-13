import { describe, expect, it } from "vitest";
import { runDriftGateEval } from "../../src/eval/suites/drift-gate.js";

// M2 gate as a CI test: the relevance gate must be selective, never inject a
// secret, and never repeat a card across channels in a session.
describe("drift/gate + injection quality (M2 gate)", () => {
  it("PreToolUse is selective, zero harmful injections, no cross-channel dupes", async () => {
    const r = await runDriftGateEval();
    expect(r.repos).toBeGreaterThan(0);
    expect(r.harmfulInjections).toBe(0);
    expect(r.preToolFireRate).toBeLessThan(1); // selective, not on every call
    expect(r.preToolFired).toBeGreaterThan(0); // but it does fire when relevant
    expect(r.duplicateCards).toBe(0);
    expect(r.pass).toBe(true);
  }, 30000);
});
