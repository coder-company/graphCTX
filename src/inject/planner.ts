import type { Capsule, ConflictNote, InjectionContext, ScoredFact } from "../core/types.js";
import type { Fact } from "../core/types.js";
import type { Git } from "../git/git.js";
import { EMPTY_CAPSULE, renderCapsule } from "../render/capsule.js";
import { renderCard } from "../render/cards.js";
import { Retriever } from "../retrieve/retriever.js";
import type { VectorIndex } from "../retrieve/vectors.js";
import { containsSecret } from "../security/secrets.js";
import type { FactsRepo } from "../store/facts.repo.js";
import type { InjectionsRepo } from "../store/injections.repo.js";
import { type BudgetConfig, resolveBudget, selectByBudget } from "./budget.js";
import { type GateConfig, shouldFire } from "./gate.js";
import { Ledger } from "./ledger.js";
import { verifyBeforeInject } from "./staleness.js";

export interface PlannerDeps {
  facts: FactsRepo;
  injections?: InjectionsRepo;
  git: Git | null;
  workspaceDir: string;
  gateConfig: GateConfig;
  budgetConfig: BudgetConfig;
  ledger?: Ledger;
  vectors?: VectorIndex | null;
}

// The core orchestration (SPEC §15). gate → retrieve → verify (I4) → dedupe →
// budget (I6) → render → log. Returns EMPTY_CAPSULE when the gate declines.
export class InjectionPlanner {
  private readonly deps: PlannerDeps;
  private readonly retriever: Retriever;
  private readonly ledger: Ledger;

  constructor(deps: PlannerDeps) {
    this.deps = deps;
    this.retriever = new Retriever(deps.facts, deps.git, deps.vectors ?? null);
    this.ledger = deps.ledger ?? new Ledger();
  }

  async plan(ctx: InjectionContext): Promise<Capsule> {
    if (!shouldFire(ctx, this.deps.gateConfig)) return EMPTY_CAPSULE;

    const budget = resolveBudget(ctx.event, this.deps.budgetConfig, ctx.budget_tokens);
    const broad = ctx.event === "SessionStart" || ctx.event === "PostCompact";
    const scored = await this.retriever.retrieve(ctx, { includeAllActive: broad });

    // I4: verify perishable facts synchronously; drop those whose target is gone.
    const verified = scored.filter((s) => verifyBeforeInject(s.fact, this.deps.workspaceDir));

    // I3: secret guard — never inject a fact classified as secret/credential or
    // whose rendered content trips the secret scanner (defense in depth pre-send).
    const safe = verified.filter((s) => !isSecretBearing(s.fact));

    // anti-repetition (cross-channel idempotency within a session)
    const deduped = this.ledger.removeRecentlyInjected(safe, ctx.scope.session_id);

    const { selected, omitted } = selectByBudget(
      deduped,
      budget,
      ctx.event,
      this.deps.budgetConfig,
    );

    // M1 §7: on compaction recovery / session boot, active open loops are ALWAYS
    // handed back — they are the "what was I doing" thread. Force-include any
    // that survived verification/secret/dedupe but were crowded out by budget.
    if (ctx.event === "PostCompact" || ctx.event === "SessionStart") {
      const present = new Set(selected.map((s) => s.scored.fact.fact_id));
      for (const s of deduped) {
        if (s.fact.fact_kind === "open_loop" && !present.has(s.fact.fact_id)) {
          const card = renderCard(s.fact);
          selected.push({ scored: s, tokens: card.tokens, markdown: card.markdown });
          present.add(s.fact.fact_id);
        }
      }
    }

    if (selected.length === 0) return EMPTY_CAPSULE;

    const cards = selected.map((s) => renderCard(s.scored.fact));
    const conflicts = detectConflicts(selected.map((s) => s.scored));
    const capsule = renderCapsule(ctx.event, cards, conflicts, omitted);

    this.ledger.record(
      ctx.scope.session_id,
      selected.map((s) => s.scored),
    );

    if (this.deps.injections) {
      this.deps.injections.log({
        session_id: ctx.scope.session_id ?? "unknown",
        event_type: ctx.event,
        selected_fact_ids: selected.map((s) => s.scored.fact.fact_id),
        rejected_fact_ids: omitted.map((o) => o.fact_id),
        token_count: capsule.token_count,
        git_head: ctx.git.head,
      });
    }

    return capsule;
  }
}

// I3 secret guard. A fact is secret-bearing if it is classified secret/credential
// or its rendered content trips the scanner (defense in depth at the send edge).
function isSecretBearing(fact: Fact): boolean {
  if (fact.sensitivity === "secret" || fact.sensitivity === "credential") return true;
  const obj = typeof fact.object === "string" ? fact.object : JSON.stringify(fact.object);
  return containsSecret(`${fact.subject} ${fact.predicate} ${obj} ${fact.source.raw_quote ?? ""}`);
}

// Minimal conflict detection (M0): contradictory objects for the same
// (subject,predicate). Full precedence resolution is M1.
function detectConflicts(scored: ScoredFact[]): ConflictNote[] {
  const groups = new Map<string, ScoredFact[]>();
  for (const s of scored) {
    const key = `${s.fact.subject}::${s.fact.predicate}`;
    const arr = groups.get(key) ?? [];
    arr.push(s);
    groups.set(key, arr);
  }
  const notes: ConflictNote[] = [];
  for (const [key, arr] of groups) {
    const distinct = new Set(
      arr.map((s) =>
        typeof s.fact.object === "string" ? s.fact.object : JSON.stringify(s.fact.object),
      ),
    );
    if (distinct.size > 1) {
      notes.push({
        conflict_id: key.slice(-8),
        summary: `Conflicting values for ${key.replace("::", " ")}: ${[...distinct].join(" vs ")}. Higher-trust/structured evidence wins.`,
      });
    }
  }
  return notes;
}
