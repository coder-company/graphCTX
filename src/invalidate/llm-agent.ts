import type { Fact } from "../core/types.js";
import type { Relation } from "./relation.js";

// The LLM invalidation fallback (SPEC §11). It is consulted ONLY when the
// deterministic classifier abstains. Two hard rules, enforced by the caller
// (invalidator.ts), not merely by the prompt:
//   1. It MUST cite evidence IDs (event_ids) that actually exist.
//   2. It MAY NOT invalidate from world knowledge — every `invalidates`/`conflicts`
//      verdict must be backed by cited evidence present in the store.
export interface LlmRelationVerdict {
  relation: Relation;
  cited_evidence_ids: string[];
  rationale: string;
}

export interface LlmInvalidationAgent {
  classify(incoming: Fact, existing: Fact): Promise<LlmRelationVerdict | null>;
}

// M1 ships NO networked LLM (that is M3). This null agent always abstains, so
// the engine relies entirely on deterministic rules unless a real agent is
// injected (e.g. in tests or a future milestone). Keeping the seam here lets us
// unit-test the cited-evidence post-check without a network.
export const nullLlmAgent: LlmInvalidationAgent = {
  async classify() {
    return null;
  },
};
