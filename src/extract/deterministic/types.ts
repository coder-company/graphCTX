import type { NewFact, Scope } from "../../core/types.js";

export interface ExtractContext {
  workspaceDir: string;
  scope: Scope; // user_id + workspace_id, no session
  repoId?: string;
  branch?: string;
  head?: string;
}

export interface Extractor {
  id: string;
  extract(ctx: ExtractContext): NewFact[];
}

// Helper to build a high-trust structured fact in active/workspace_active state.
// High-trust deterministic config is immediately promotable (SPEC §10.1, §12).
export function structuredFact(
  partial: Omit<NewFact, "trust_tier" | "status" | "promotion_state" | "source"> &
    Partial<Pick<NewFact, "source">> & { rawQuote?: string },
): NewFact {
  const { rawQuote, source, ...rest } = partial;
  return {
    ...rest,
    trust_tier: "high",
    status: "active",
    promotion_state: "workspace_active",
    sensitivity: partial.sensitivity ?? "public",
    confidence: partial.confidence ?? 0.9,
    source: source ?? { asserted_by: "deterministic_parser", event_ids: [], raw_quote: rawQuote },
  };
}

// Helper to build a low-trust prose fact (I2): candidate, never auto-promoted.
export function proseFact(
  partial: Omit<NewFact, "trust_tier" | "status" | "promotion_state" | "source"> &
    Partial<Pick<NewFact, "source">> & { rawQuote?: string },
): NewFact {
  const { rawQuote, source, ...rest } = partial;
  return {
    ...rest,
    trust_tier: "low",
    status: "candidate",
    promotion_state: "session_only",
    sensitivity: partial.sensitivity ?? "public",
    confidence: partial.confidence ?? 0.4,
    source: source ?? { asserted_by: "deterministic_parser", event_ids: [], raw_quote: rawQuote },
  };
}
