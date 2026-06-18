import type { Capsule, ConflictNote, InjectionContext, ScoredFact } from "../core/types.js";
import type { Fact } from "../core/types.js";
import type { Git } from "../git/git.js";
import { EMPTY_CAPSULE, renderCapsule } from "../render/capsule.js";
import { renderCard } from "../render/cards.js";
import {
  conflictDisplayObject,
  conflictIdForKey,
  conflictKey,
  conflictLabelForKey,
  resolveConflicts,
} from "../resolve/conflicts.js";
import { Retriever } from "../retrieve/retriever.js";
import type { VectorIndex } from "../retrieve/vectors.js";
import { safeForSend } from "../security/send-edge.js";
import type { EpisodesRepo } from "../store/episodes.repo.js";
import type { FactsRepo } from "../store/facts.repo.js";
import type { InjectionsRepo } from "../store/injections.repo.js";
import { type BudgetConfig, resolveBudget, selectByBudget } from "./budget.js";
import {
  type DriftSignal,
  type GateConfig,
  cosineDistance,
  shouldFire,
  taskCentroid,
} from "./gate.js";
import { Ledger } from "./ledger.js";
import { verifyBeforeInject } from "./staleness.js";

export interface PlanOptions {
  // Skip the relevance gate (used by the explicit `recall` pull path, which is
  // user-initiated and should always answer).
  bypassGate?: boolean;
}

export interface PlannerDeps {
  facts: FactsRepo;
  injections?: InjectionsRepo;
  episodes?: EpisodesRepo;
  git: Git | null;
  workspaceDir: string;
  gateConfig: GateConfig;
  budgetConfig: BudgetConfig;
  ledger?: Ledger;
  vectors?: VectorIndex | null;
}

// How many recent episodes form the rolling task centroid for drift detection.
const DRIFT_WINDOW = 8;

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

  async plan(ctx: InjectionContext, opts: PlanOptions = {}): Promise<Capsule> {
    const drift = this.computeDrift(ctx);
    if (!opts.bypassGate && !shouldFire(ctx, this.deps.gateConfig, drift)) return EMPTY_CAPSULE;

    const budget = resolveBudget(ctx.event, this.deps.budgetConfig, ctx.budget_tokens);
    const broad = ctx.event === "SessionStart" || ctx.event === "PostCompact";
    const scored = await this.retriever.retrieve(ctx, { includeAllActive: broad });

    // I4: verify perishable facts synchronously; drop those whose target is gone.
    const verified = scored.filter((s) => verifyBeforeInject(s.fact, this.deps.workspaceDir));

    // I3 + send-edge security guard: never inject secrets, credentials, or
    // unframed dangerous executable directives. Low-trust prose can still render
    // as a claim; high-trust-looking command payloads must be impact-blocked.
    const safe = verified.filter((s) => safeForSend(s.fact));

    // PreToolUse is an immediate guardrail surface before shell/edit actions.
    // It should carry only trusted operational memory; low-trust claims are
    // acceptable as historical context elsewhere, but not as live tool advice.
    const lifecycleSafe = safe.filter((s) => safeForLifecycle(s.fact, ctx.event));

    // anti-repetition (cross-channel idempotency within a session)
    const deduped = this.ledger.removeRecentlyInjected(lifecycleSafe, ctx.scope.session_id);

    // Resolve precedence before budget/redundancy. Otherwise a lower-precedence
    // card with a selection bonus (for example an old user profile) can consume
    // the subject/predicate slot before higher-precedence structured evidence is
    // allowed to win.
    const resolution = resolveConflicts(deduped, ctx.scope.session_id);

    const { selected, omitted } = selectByBudget(
      resolution.resolved,
      budget,
      ctx.event,
      this.deps.budgetConfig,
    );

    // M1 §7: on compaction recovery / session boot, active open loops are ALWAYS
    // handed back — they are the "what was I doing" thread. Force-include any
    // that survived verification/secret/dedupe but were crowded out by budget.
    if (ctx.event === "PostCompact" || ctx.event === "SessionStart") {
      const present = new Set(selected.map((s) => s.scored.fact.fact_id));
      for (const s of resolution.resolved) {
        if (s.fact.fact_kind === "open_loop" && !present.has(s.fact.fact_id)) {
          const card = renderCard(s.fact);
          selected.push({ scored: s, tokens: card.tokens, markdown: card.markdown });
          present.add(s.fact.fact_id);
        }
      }
    }

    if (selected.length === 0) return EMPTY_CAPSULE;

    const cards = selected.map((s) => renderCard(s.scored.fact));
    const conflicts =
      resolution.conflicts.length > 0
        ? resolution.conflicts
        : detectConflicts(selected.map((s) => s.scored));
    const capsule = renderCapsule(ctx.event, cards, conflicts, omitted);

    this.ledger.record(
      ctx.scope.session_id,
      selected.map((s) => s.scored),
      ctx.event,
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

  private computeDrift(ctx: InjectionContext): DriftSignal | undefined {
    return plannerComputeDrift(ctx, this.deps.vectors, this.deps.episodes);
  }
}

// Compute the topic-centroid drift signal for the relevance gate (M2, SPEC
// §5.2). Only meaningful for UserPromptSubmit; for other events the gate ignores
// it. Degrades to `undefined` (gate falls back to entity-change) when vectors or
// episode history are unavailable (I9).
function plannerComputeDrift(
  ctx: InjectionContext,
  vectors: VectorIndex | null | undefined,
  episodes: EpisodesRepo | undefined,
): DriftSignal | undefined {
  if (ctx.event !== "UserPromptSubmit") return undefined;
  const hasNewEntities =
    (ctx.current_files?.length ?? 0) + (ctx.mentioned_symbols?.length ?? 0) > 0;
  if (!vectors?.enabled || !episodes || !ctx.scope.session_id || !ctx.user_prompt) {
    return { hasNewEntities };
  }
  try {
    const recent = episodes
      .tail(ctx.scope.session_id, DRIFT_WINDOW)
      .map((e) => promptTextOf(e.payload))
      .filter((t): t is string => !!t && t.length > 1);
    if (recent.length === 0) return { hasNewEntities };
    const centroid = taskCentroid(recent.map((t) => vectors.embed(t)));
    if (!centroid) return { hasNewEntities };
    const cur = vectors.embed(ctx.user_prompt);
    return { centroidDistance: cosineDistance(centroid, cur), hasNewEntities };
  } catch {
    return { hasNewEntities };
  }
}

function promptTextOf(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const p = payload as Record<string, unknown>;
  for (const key of ["user_prompt", "prompt", "text", "transcript_tail"]) {
    const v = p[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

function safeForLifecycle(fact: Fact, event: InjectionContext["event"]): boolean {
  if (event === "PreToolUse" && fact.trust_tier === "low") return false;
  return true;
}

// Minimal conflict detection (M0): contradictory objects for the same
// (subject,predicate). Full precedence resolution is M1.
function detectConflicts(scored: ScoredFact[]): ConflictNote[] {
  const groups = new Map<string, ScoredFact[]>();
  for (const s of scored) {
    const key = conflictKey(s.fact);
    const arr = groups.get(key) ?? [];
    arr.push(s);
    groups.set(key, arr);
  }
  const notes: ConflictNote[] = [];
  for (const [key, arr] of groups) {
    const distinct = new Set(arr.map((s) => conflictDisplayObject(s.fact)));
    if (distinct.size > 1) {
      notes.push({
        conflict_id: conflictIdForKey(key),
        summary: `Conflicting values for ${conflictLabelForKey(key)}: ${[...distinct].map((value) => JSON.stringify(value)).join(" vs ")}. Higher-trust/structured evidence wins.`,
      });
    }
  }
  return notes;
}
