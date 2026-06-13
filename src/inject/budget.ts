import type { Event, ScoredFact } from "../core/types.js";
import { renderCard } from "../render/cards.js";

export interface BudgetConfig {
  totalBudgetTokens: number;
  maxCards: number;
  maxCardsPretool: number;
  budgetFraction: number;
  ctxWindow?: number;
}

// Per-event token caps (SPEC §9 / GAMEPLAN §5.5).
const EVENT_CAPS: Partial<Record<Event, number>> = {
  SessionStart: 2000,
  UserPromptSubmit: 1800,
  PreToolUse: 450,
  PostToolUse: 700,
  PostCompact: 3500,
};

export function resolveBudget(event: Event, cfg: BudgetConfig, override?: number): number {
  if (override && override > 0) return override;
  const eventCap = EVENT_CAPS[event] ?? cfg.totalBudgetTokens;
  const fractionCap = cfg.ctxWindow
    ? Math.floor(cfg.budgetFraction * cfg.ctxWindow)
    : Number.POSITIVE_INFINITY;
  return Math.min(eventCap, cfg.totalBudgetTokens, fractionCap);
}

export interface SelectResult {
  selected: Array<{ scored: ScoredFact; tokens: number; markdown: string }>;
  omitted: Array<{ fact_id: string; reason: string }>;
  totalTokens: number;
}

// Greedy selection by utility/token with a redundancy penalty (I6, SPEC §15).
export function selectByBudget(
  scored: ScoredFact[],
  budgetTokens: number,
  event: Event,
  cfg: BudgetConfig,
): SelectResult {
  const maxCards = event === "PreToolUse" ? cfg.maxCardsPretool : cfg.maxCards;

  const rendered = scored.map((s) => {
    const card = renderCard(s.fact);
    return { scored: s, tokens: card.tokens, markdown: card.markdown };
  });

  // Rank by the deterministic raw score (NOT score/tokens): the rendered token
  // count includes a random ULID provenance suffix, so a density ranking would
  // flip near-tied facts run-to-run. Tokens are used only for the knapsack fit
  // below. Content-key breaks exact ties (fact_id is a random ULID).
  const keyOf = (f: { subject: string; predicate: string; object: unknown }) =>
    `${f.subject}::${f.predicate}::${typeof f.object === "string" ? f.object : JSON.stringify(f.object)}`;
  rendered.sort((a, b) => {
    if (b.scored.score !== a.scored.score) return b.scored.score - a.scored.score;
    const ka = keyOf(a.scored.fact);
    const kb = keyOf(b.scored.fact);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });

  const selected: SelectResult["selected"] = [];
  const omitted: SelectResult["omitted"] = [];
  const seenPredicates = new Set<string>();
  let used = 0;

  for (const r of rendered) {
    if (selected.length >= maxCards) {
      omitted.push({ fact_id: r.scored.fact.fact_id, reason: "max_cards" });
      continue;
    }
    if (used + r.tokens > budgetTokens) {
      omitted.push({ fact_id: r.scored.fact.fact_id, reason: "budget" });
      continue;
    }
    // redundancy penalty: skip a 2nd fact with the same predicate+subject
    const key = `${r.scored.fact.subject}::${r.scored.fact.predicate}`;
    if (seenPredicates.has(key)) {
      omitted.push({ fact_id: r.scored.fact.fact_id, reason: "redundant" });
      continue;
    }
    seenPredicates.add(key);
    selected.push(r);
    used += r.tokens;
  }

  return { selected, omitted, totalTokens: used };
}
