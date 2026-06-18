import { EpisodeLog } from "./capture/episode-log.js";
import { type LoadedConfig, loadConfig } from "./config/config.js";
import { type Clock, systemClock } from "./core/clock.js";
import { workspaceIdFromPath } from "./core/ids.js";
import type { Event, Fact, FactKind, GitAnchor, InjectionContext, Scope } from "./core/types.js";
import { extractFactsFromEpisodes } from "./extract/llm/fact-extractor.js";
import { mineProcedures } from "./extract/llm/procedure-miner.js";
import { runDeterministicExtraction } from "./extract/pipeline.js";
import { type DagEvent, detectEvent, revalidateOnRevert } from "./git/dag.js";
import { Git } from "./git/git.js";
import type { BudgetConfig } from "./inject/budget.js";
import type { GateConfig } from "./inject/gate.js";
import { Ledger } from "./inject/ledger.js";
import { InjectionPlanner } from "./inject/planner.js";
import { Invalidator } from "./invalidate/invalidator.js";
import { createLlmInvalidationAgent } from "./invalidate/llm-agent.js";
import {
  type LlmProvider,
  type ProviderConfig,
  nullProvider,
  resolveProvider,
} from "./llm/provider.js";
import { Probation } from "./promote/probation.js";
import { type WhyReport, why } from "./provenance/why.js";
import { VectorIndex } from "./retrieve/vectors.js";
import { assertSafeExplicitMemoryWrite } from "./security/intake.js";
import { sanitizeInjectionContextExtra } from "./security/retrieval-context.js";
import { type DB, openDb } from "./store/db.js";
import { EdgesRepo } from "./store/edges.repo.js";
import { EpisodesRepo } from "./store/episodes.repo.js";
import { FactsRepo } from "./store/facts.repo.js";
import { InjectionsRepo } from "./store/injections.repo.js";
import { assertWorkspaceLocalStorePath } from "./store/path-safety.js";
import { ProceduresRepo } from "./store/procedures.repo.js";
import { PromotionsRepo } from "./store/promotions.repo.js";

export interface RuntimeOptions {
  workspaceDir?: string;
  userId?: string;
  clock?: Clock;
}

export interface RememberFactInput {
  text: string;
  subject?: string;
  predicate?: string;
  kind?: FactKind;
  sessionId?: string;
  tags?: string[];
}

// Central wiring: opens stores, git, repos, planner. Used by CLI + adapters +
// eval. Holds the workspace DB (session + workspace scopes); user.db optional.
export class Runtime {
  readonly loaded: LoadedConfig;
  readonly workspaceDir: string;
  readonly userId: string;
  readonly workspaceId: string;
  readonly db: DB;
  readonly facts: FactsRepo;
  readonly episodes: EpisodesRepo;
  readonly injections: InjectionsRepo;
  readonly edges: EdgesRepo;
  readonly promotions: PromotionsRepo;
  readonly episodeLog: EpisodeLog;
  readonly git: Git;
  readonly ledger: Ledger;
  readonly vectors: VectorIndex;
  readonly procedures: ProceduresRepo;
  readonly clock: Clock;
  private resolvedProvider?: LlmProvider;

  constructor(opts: RuntimeOptions = {}) {
    this.clock = opts.clock ?? systemClock;
    this.loaded = loadConfig({ workspaceDir: opts.workspaceDir });
    this.workspaceDir = this.loaded.workspaceDir;
    this.userId = opts.userId ?? process.env.GRAPHCTX_USER_ID ?? "local-user";
    this.workspaceId = workspaceIdFromPath(this.workspaceDir);
    assertWorkspaceLocalStorePath(
      this.loaded.paths.workspaceDb,
      this.workspaceDir,
      "workspace database",
    );
    assertWorkspaceLocalStorePath(
      this.loaded.paths.episodes,
      this.workspaceDir,
      "episode JSONL mirror",
    );
    this.db = openDb(this.loaded.paths.workspaceDb);
    this.facts = new FactsRepo(this.db, this.clock);
    this.vectors = new VectorIndex(this.db, undefined, this.clock);
    this.facts.attachVectorIndex(this.vectors);
    this.episodes = new EpisodesRepo(this.db, this.clock);
    this.injections = new InjectionsRepo(this.db, this.clock);
    this.edges = new EdgesRepo(this.db, this.clock);
    this.promotions = new PromotionsRepo(this.db, this.clock);
    this.episodeLog = new EpisodeLog(this.episodes, this.loaded.paths.episodes, this.clock);
    this.git = new Git(this.workspaceDir);
    this.ledger = new Ledger(this.db, undefined, this.clock);
    this.procedures = new ProceduresRepo(this.db, this.clock);
  }

  private providerConfig(): ProviderConfig {
    const l = this.loaded.config.llm;
    return {
      provider: l.provider,
      chatModel: l.chat_model,
      embedModel: l.embed_model,
      apiKeyEnv: l.api_key_env,
      baseUrl: l.base_url || undefined,
      timeoutMs: l.timeout_ms,
    };
  }

  // Resolve the configured LLM provider lazily + fail-soft. With no key/base_url
  // this returns the null provider → DETERMINISTIC-ONLY mode (I9). Cached.
  async provider(): Promise<LlmProvider> {
    if (this.resolvedProvider) return this.resolvedProvider;
    try {
      this.resolvedProvider = await resolveProvider(this.providerConfig());
    } catch {
      this.resolvedProvider = nullProvider;
    }
    return this.resolvedProvider;
  }

  scope(sessionId?: string): Scope {
    return { user_id: this.userId, workspace_id: this.workspaceId, session_id: sessionId };
  }

  resolveFactId(fullOrSuffix: string): string | null {
    if (this.facts.get(fullOrSuffix)) return fullOrSuffix;
    const match = this.facts
      .all({ user_id: this.userId, workspace_id: this.workspaceId })
      .find((f) => f.fact_id.endsWith(fullOrSuffix));
    return match?.fact_id ?? null;
  }

  gateConfig(): GateConfig {
    return {
      enabledEvents: this.loaded.config.inject.enabled_events,
      driftThreshold: this.loaded.config.inject.gate_drift_threshold,
    };
  }

  budgetConfig(): BudgetConfig {
    const c = this.loaded.config.inject;
    return {
      totalBudgetTokens: c.total_budget_tokens,
      maxCards: c.max_cards,
      maxCardsPretool: c.max_cards_pretool,
      budgetFraction: c.budget_fraction,
    };
  }

  planner(): InjectionPlanner {
    return new InjectionPlanner({
      facts: this.facts,
      injections: this.injections,
      episodes: this.episodes,
      git: this.git,
      workspaceDir: this.workspaceDir,
      gateConfig: this.gateConfig(),
      budgetConfig: this.budgetConfig(),
      ledger: this.ledger,
      vectors: this.vectors,
      clock: this.clock,
    });
  }

  // Invalidation engine (M1 §2). Resolves git context lazily where supplied.
  async invalidator(): Promise<Invalidator> {
    let branch: string | undefined;
    let head: string | undefined;
    if (await this.git.isRepo()) {
      try {
        branch = await this.git.branch();
        head = await this.git.head();
      } catch {
        // degrade
      }
    }
    // Provider-backed LLM agent only when a key is configured; otherwise the
    // deterministic-only null agent (the invalidator still enforces the
    // cited-evidence post-check regardless).
    const provider = await this.provider();
    const llm = provider.available ? createLlmInvalidationAgent({ provider }) : undefined;
    return new Invalidator({
      facts: this.facts,
      edges: this.edges,
      episodes: this.episodes,
      llm,
      workspaceDir: this.workspaceDir,
      currentBranch: branch,
      currentHead: head,
    });
  }

  // LLM consolidation worker (SPEC §10.2). ASYNC, OFF the hot path: mines durable
  // facts + procedures from recent session episodes, runs invalidation on each,
  // and persists procedures (descriptive-only, D10). Fail-soft: with no provider
  // this is a no-op (deterministic extraction already ran on the hot path).
  async consolidate(
    sessionId?: string,
    opts: { limit?: number } = {},
  ): Promise<{ factsLearned: number; proceduresMined: number }> {
    const provider = await this.provider();
    if (!provider.available) return { factsLearned: 0, proceduresMined: 0 };
    if (!sessionId) return { factsLearned: 0, proceduresMined: 0 };
    const scope = this.scope(sessionId);
    let episodes: ReturnType<EpisodesRepo["tail"]>;
    try {
      episodes = this.episodes.tail(sessionId, opts.limit ?? 50);
    } catch {
      return { factsLearned: 0, proceduresMined: 0 };
    }
    if (episodes.length === 0) return { factsLearned: 0, proceduresMined: 0 };

    let factsLearned = 0;
    let proceduresMined = 0;
    try {
      const newFacts = await extractFactsFromEpisodes(episodes, { provider, scope });
      for (const nf of newFacts) {
        await this.learn(nf);
        factsLearned++;
      }
    } catch {
      // never break consolidation (I9)
    }
    try {
      const mined = await mineProcedures(episodes, { provider, scope });
      for (const p of mined) {
        const fact = this.facts.insert({
          subject: "workflow",
          predicate: "procedure",
          object: p.name,
          fact_kind: "procedural",
          temporal_kind: "static",
          scope,
          trust_tier: "low",
          confidence: p.confidence,
          status: "candidate",
          promotion_state: "session_only",
          source: { asserted_by: "llm_extractor", event_ids: p.evidence_ids },
          tags: ["llm_extracted", "procedure"],
        });
        this.procedures.insert({
          fact_id: fact.fact_id,
          name: p.name,
          steps: p.steps,
          verifier: p.verifier,
        });
        proceduresMined++;
      }
    } catch {
      // never break consolidation (I9)
    }
    return { factsLearned, proceduresMined };
  }

  // Insert a fact AND run invalidation against existing memory (M1). Returns the
  // inserted fact; invalidation effects (supersede/expire/dispute) are applied
  // as a side effect and never throw out to the caller (I9).
  async learn(input: Parameters<FactsRepo["insert"]>[0]): Promise<ReturnType<FactsRepo["insert"]>> {
    const fact = this.facts.insert(input);
    try {
      const inv = await this.invalidator();
      await inv.processIncomingFact(fact);
    } catch {
      // invalidation must never break a write (I9)
    }
    return this.facts.get(fact.fact_id) ?? fact;
  }

  // Promotion engine (M1 §3). Hard-gated session→workspace probation sweep.
  probation(git?: { repoId: string; head: string; branch: string }): Probation {
    const c = this.loaded.config.promote;
    return new Probation({
      facts: this.facts,
      edges: this.edges,
      promotions: this.promotions,
      workspaceDir: this.workspaceDir,
      minProcedureSuccesses: c.min_procedure_successes,
      minFailureRepeats: c.min_failure_repeats,
      procSuccesses: (factId) => this.procedureSuccesses(factId),
      git,
      clock: this.clock,
    });
  }

  // Run the promotion sweep for a session (called on SessionEnd + by the worker).
  async runPromotionSweep(
    sessionId?: string,
  ): Promise<ReturnType<Probation["sweepSessionToWorkspace"]>> {
    const git = await this.currentGitContext();
    return this.probation(git).sweepSessionToWorkspace({
      user_id: this.userId,
      workspace_id: this.workspaceId,
      session_id: sessionId,
    });
  }

  async reviewFactForWorkspace(
    factId: string,
  ): Promise<ReturnType<Probation["reviewFactForWorkspace"]>> {
    const git = await this.currentGitContext();
    return this.probation(git).reviewFactForWorkspace(factId);
  }

  // Record a durable open loop (M1 §7) — an unfinished thread to resurface at
  // PostCompact/SessionStart. Session-scoped by default.
  noteOpenLoop(description: string, sessionId?: string): ReturnType<FactsRepo["insert"]> {
    assertSafeExplicitMemoryWrite({
      text: description,
      subject: "session",
      predicate: "open_loop",
      kind: "open_loop",
      session_id: sessionId,
    });
    return this.facts.insert({
      subject: "session",
      predicate: "open_loop",
      object: description,
      fact_kind: "open_loop",
      temporal_kind: "dynamic",
      scope: { user_id: this.userId, workspace_id: this.workspaceId, session_id: sessionId },
      trust_tier: "high",
      status: "active",
      promotion_state: "session_only",
      source: { asserted_by: "user", event_ids: [], raw_quote: description },
      tags: ["open_loop"],
    });
  }

  // Store explicit user memory with the same lifecycle as CLI/MCP/TUI remember:
  // safe intake, current git anchoring, active trust, and invalidation.
  async rememberFact(input: RememberFactInput): Promise<Fact> {
    const subject = input.subject ?? "repo";
    const predicate = input.predicate ?? "note";
    const kind = input.kind ?? "decision";
    assertSafeExplicitMemoryWrite({
      text: input.text,
      subject,
      predicate,
      kind,
      session_id: input.sessionId,
    });
    return await this.learn({
      subject,
      predicate,
      object: input.text,
      fact_kind: kind,
      temporal_kind: kind === "task_state" || kind === "open_loop" ? "dynamic" : "static",
      scope: this.scope(input.sessionId),
      trust_tier: "high",
      status: "active",
      promotion_state: input.sessionId ? "session_only" : "workspace_active",
      source: { asserted_by: "user", event_ids: [], raw_quote: `user said: ${input.text}` },
      git: await this.currentGitAnchor(),
      tags: input.tags ?? ["user_explicit"],
    });
  }

  // Resolve an open loop so it stops resurfacing (M1 §7).
  async resolveOpenLoop(loopFactId: string, byFactId?: string): Promise<void> {
    const inv = await this.invalidator();
    inv.resolve(loopFactId, byFactId);
  }

  // User-facing forget: close the fact's temporal validity window so it stops
  // being recalled/injected while remaining explainable through `why`.
  async forgetFact(factId: string): Promise<void> {
    const head = await this.currentGitHead();
    this.facts.expire(factId, factId, head);
  }

  // Handle a HEAD move (BranchSwitch / FileChanged after commit). Classifies the
  // transition and, on a REVERT, restores facts whose invalidating commit was
  // undone (SPEC §8). Fail-soft: returns a noop event off-repo or on error (I9).
  async onHeadMove(
    from: string,
    to: string,
    fromBranch?: string,
    toBranch?: string,
  ): Promise<DagEvent> {
    try {
      if (!(await this.git.isRepo())) return { kind: "noop", from, to, fromBranch, toBranch };
      const ev = await detectEvent(this.git, from, to, fromBranch, toBranch);
      if (ev.kind === "revert") {
        await revalidateOnRevert(this.git, this.facts, to, toBranch ?? (await this.git.branch()));
      }
      return ev;
    } catch {
      return { kind: "noop", from, to, fromBranch, toBranch };
    }
  }

  // Provenance reader (M1 §5): full evidence chain for a fact.
  why(factId: string): WhyReport | null {
    return why(factId, {
      facts: this.facts,
      episodes: this.episodes,
      edges: this.edges,
      promotions: this.promotions,
    });
  }

  private procedureSuccesses(factId: string): number {
    try {
      const row = this.db
        .prepare("SELECT success_count FROM procedures WHERE fact_id = ?")
        .get(factId) as { success_count: number } | undefined;
      return row?.success_count ?? 0;
    } catch {
      return 0;
    }
  }

  private async currentGitHead(): Promise<string | undefined> {
    if (!(await this.git.isRepo())) return undefined;
    try {
      return await this.git.head();
    } catch {
      return undefined;
    }
  }

  private async currentGitAnchor(): Promise<GitAnchor | undefined> {
    const git = await this.currentGitContext();
    if (!git) return undefined;
    return {
      repo_id: git.repoId,
      branch: git.branch,
      valid_from_commit: git.head,
      introduced_by_commit: git.head,
    };
  }

  private async currentGitContext(): Promise<
    { repoId: string; head: string; branch: string } | undefined
  > {
    if (!(await this.git.isRepo())) return undefined;
    try {
      return {
        repoId: await this.git.repoId(),
        head: await this.git.head(),
        branch: await this.git.branch(),
      };
    } catch {
      return undefined;
    }
  }

  // Run the six deterministic extractors against the current workspace state.
  async extract(): Promise<ReturnType<typeof runDeterministicExtraction>> {
    let repoId: string | undefined;
    let branch: string | undefined;
    let head: string | undefined;
    if (await this.git.isRepo()) {
      try {
        repoId = await this.git.repoId();
        branch = await this.git.branch();
        head = await this.git.head();
      } catch {
        // degrade: extract without anchors
      }
    }
    return runDeterministicExtraction(this.facts, {
      workspaceDir: this.workspaceDir,
      scope: { user_id: this.userId, workspace_id: this.workspaceId },
      repoId,
      branch,
      head,
    });
  }

  // Build an InjectionContext from current git state for a given event.
  async injectionContext(
    event: Event,
    sessionId: string,
    extra: Partial<InjectionContext> = {},
  ): Promise<InjectionContext> {
    let head = "";
    let branch = "";
    let repoId = this.workspaceId;
    let dirty: string[] = [];
    if (await this.git.isRepo()) {
      try {
        repoId = await this.git.repoId();
        head = await this.git.head();
        branch = await this.git.branch();
        dirty = await this.git.dirtyFiles();
      } catch {
        // degrade
      }
    }
    return {
      event,
      scope: this.scope(sessionId),
      git: { repo_id: repoId, head, branch, dirty_files: dirty },
      ...sanitizeInjectionContextExtra(extra),
    };
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      // ignore
    }
  }
}
