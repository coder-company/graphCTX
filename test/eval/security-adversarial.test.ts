import { describe, expect, it } from "vitest";
import { runSecurityAdversarialEval } from "../../src/eval/suites/security-adversarial.js";

// Adversarial security benchmark: proves graphCTX's STRUCTURAL defenses hold
// end-to-end against memory-poisoning / injection / secret-smuggling attacks.
// The hard invariants are zero poison promotions and zero harmful capsule cards;
// secret recall must stay at/above the measured baseline floor.
describe("adversarial security (poisoning / injection / secrets)", () => {
  it("stops every poisoning attack and leaks no secret or directive", async () => {
    const r = await runSecurityAdversarialEval();
    // Family B: no poison promotes to workspace/user scope.
    expect(r.familyB.poisonPromotionRate).toBe(0);
    // Family B + C: no harmful card (secret or executable directive) reaches a capsule.
    expect(r.harmfulCapsuleCards).toBe(0);
    // Family A: secret recall holds at/above the regression floor.
    expect(r.familyA.recall).toBeGreaterThanOrEqual(r.secretRecallFloor);
    // No secret false-positive should consume more than the corpus negatives.
    expect(r.familyA.precision).toBeGreaterThan(0);
    expect(r.pass).toBe(true);
  });

  it("has adequate adversarial coverage per family", async () => {
    const r = await runSecurityAdversarialEval();
    expect(r.familyA.rows.length).toBeGreaterThanOrEqual(20);
    expect(r.familyB.cases).toBeGreaterThanOrEqual(12);
    expect(r.familyC.cases).toBeGreaterThanOrEqual(6);
  });

  it("is deterministic across runs", async () => {
    const a = await runSecurityAdversarialEval();
    const b = await runSecurityAdversarialEval();
    expect(b.familyA.recall).toBe(a.familyA.recall);
    expect(b.familyB.poisonPromotionRate).toBe(a.familyB.poisonPromotionRate);
    expect(b.harmfulCapsuleCards).toBe(a.harmfulCapsuleCards);
  });
});
