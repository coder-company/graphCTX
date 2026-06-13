import type { NewFact } from "../../core/types.js";

// A labeled promotion case: a fact + whether it SHOULD be promoted to workspace.
// `shouldPromote=true` means a correct engine promotes it; precision counts how
// many of the engine's actual promotions were labeled shouldPromote=true.
export interface PromotionCase {
  label: string;
  fact: NewFact;
  shouldPromote: boolean;
  // Cross-session observation proxy (drives the "repeated" gate) when relevant.
  evidenceCount?: number;
}

const scope = { user_id: "eval-user", workspace_id: "ws-eval" } as const;

function f(over: Partial<NewFact>): NewFact {
  return {
    subject: "repo",
    predicate: "x",
    object: "y",
    fact_kind: "semantic",
    temporal_kind: "static",
    scope,
    trust_tier: "low",
    status: "candidate",
    promotion_state: "session_only",
    source: { asserted_by: "agent", event_ids: [] },
    ...over,
  };
}

// Labeled set spanning every gate + every rejection path. Designed so a correct
// hard-gated engine achieves high precision (promotes only the true positives)
// with ZERO secret/task_state leakage.
export const PROMOTION_CASES: PromotionCase[] = [
  // --- SHOULD promote (true positives) ---
  {
    label: "high-trust deterministic test_command",
    shouldPromote: true,
    fact: f({
      predicate: "test_command",
      object: "npm test",
      fact_kind: "procedural",
      trust_tier: "high",
      source: { asserted_by: "deterministic_parser", event_ids: [] },
    }),
  },
  {
    label: "high-trust deterministic package_manager",
    shouldPromote: true,
    fact: f({
      predicate: "package_manager",
      object: "pnpm",
      fact_kind: "constraint",
      trust_tier: "high",
      source: { asserted_by: "deterministic_parser", event_ids: [] },
    }),
  },
  {
    label: "user-explicit repo-scoped decision",
    shouldPromote: true,
    fact: f({
      predicate: "deploy_command",
      object: "./scripts/ship.sh",
      fact_kind: "decision",
      source: {
        asserted_by: "user",
        event_ids: [],
        raw_quote: "in this repo we deploy with ship.sh",
      },
    }),
  },
  {
    label: "verified procedure (>= successes handled via proc table; here user-stated)",
    shouldPromote: true,
    fact: f({
      predicate: "release_step",
      object: "bump version then tag",
      fact_kind: "decision",
      source: {
        asserted_by: "user",
        event_ids: [],
        raw_quote: "for this project, release by bump+tag",
      },
    }),
  },
  {
    label: "constraint repeated across sessions",
    shouldPromote: true,
    evidenceCount: 3,
    fact: f({
      subject: "repo",
      predicate: "max_line_length",
      object: 100,
      fact_kind: "constraint",
    }),
  },

  // --- SHOULD NOT promote (true negatives the engine must hold/reject) ---
  {
    label: "SECRET must never promote (I3)",
    shouldPromote: false,
    fact: f({
      predicate: "api_key",
      object: "sk-PLACEHOLDER",
      fact_kind: "semantic",
      sensitivity: "secret",
      source: {
        asserted_by: "user",
        event_ids: [],
        raw_quote: "in this repo the key is sk-PLACEHOLDER",
      },
    }),
  },
  {
    label: "task_state is session-local, must never promote",
    shouldPromote: false,
    fact: f({
      predicate: "current_task",
      object: "editing file X",
      fact_kind: "task_state",
      source: { asserted_by: "agent", event_ids: [] },
    }),
  },
  {
    label: "low-trust agent guess with no evidence",
    shouldPromote: false,
    fact: f({
      predicate: "maybe_command",
      object: "probably npm run deploy",
      fact_kind: "semantic",
      source: { asserted_by: "agent", event_ids: [] },
    }),
  },
  {
    label: "disputed fact must not promote",
    shouldPromote: false,
    fact: f({
      predicate: "test_command",
      object: "contested",
      fact_kind: "procedural",
      status: "disputed",
      trust_tier: "high",
      source: { asserted_by: "deterministic_parser", event_ids: [] },
    }),
  },
  {
    label: "single-occurrence failure (below repeat threshold)",
    shouldPromote: false,
    evidenceCount: 1,
    fact: f({
      predicate: "flaky_test",
      object: "sometimes fails",
      fact_kind: "failure",
      source: { asserted_by: "agent", event_ids: [] },
    }),
  },
];
