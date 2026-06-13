import { EpisodeLog } from "./capture/episode-log.js";
import { type LoadedConfig, loadConfig } from "./config/config.js";
import { type Clock, systemClock } from "./core/clock.js";
import { workspaceIdFromPath } from "./core/ids.js";
import type { Event, InjectionContext, Scope } from "./core/types.js";
import { runDeterministicExtraction } from "./extract/pipeline.js";
import { Git } from "./git/git.js";
import type { BudgetConfig } from "./inject/budget.js";
import type { GateConfig } from "./inject/gate.js";
import { Ledger } from "./inject/ledger.js";
import { InjectionPlanner } from "./inject/planner.js";
import { Invalidator } from "./invalidate/invalidator.js";
import { Probation } from "./promote/probation.js";
import { type WhyReport, why } from "./provenance/why.js";
import { VectorIndex } from "./retrieve/vectors.js";
import { type DB, openDb } from "./store/db.js";
import { EdgesRepo } from "./store/edges.repo.js";
import { EpisodesRepo } from "./store/episodes.repo.js";
import { FactsRepo } from "./store/facts.repo.js";
import { InjectionsRepo } from "./store/injections.repo.js";
import { PromotionsRepo } from "./store/promotions.repo.js";

export interface RuntimeOptions {
  workspaceDir?: string;
  userId?: string;
  clock?: Clock;
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
  private readonly clock: Clock;

  constructor(opts: RuntimeOptions = {}) {
    this.clock = opts.clock ?? systemClock;
    this.loaded = loadConfig({ workspaceDir: opts.workspaceDir });
    this.workspaceDir = this.loaded.workspaceDir;
    this.userId = opts.userId ?? process.env.GRAPHCTX_USER_ID ?? "local-user";
    this.workspaceId = workspaceIdFromPath(this.workspaceDir);
    this.db = openDb(this.loaded.paths.workspaceDb);
    this.facts = new FactsRepo(this.db, this.clock);
    this.vectors = new VectorIndex(this.db);
    this.facts.attachVectorIndex(this.vectors);
    this.episodes = new EpisodesRepo(this.db, this.clock);
    this.injections = new InjectionsRepo(this.db, this.clock);
    this.edges = new EdgesRepo(this.db, this.clock);
    this.promotions = new PromotionsRepo(this.db, this.clock);
    this.episodeLog = new EpisodeLog(this.episodes, this.loaded.paths.episodes, this.clock);
    this.git = new Git(this.workspaceDir);
    this.ledger = new Ledger();
  }

  scope(sessionId?: string): Scope {
    return { user_id: this.userId, workspace_id: this.workspaceId, session_id: sessionId };
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
      git: this.git,
      workspaceDir: this.workspaceDir,
      gateConfig: this.gateConfig(),
      budgetConfig: this.budgetConfig(),
      ledger: this.ledger,
      vectors: this.vectors,
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
    return new Invalidator({
      facts: this.facts,
      edges: this.edges,
      episodes: this.episodes,
      workspaceDir: this.workspaceDir,
      currentBranch: branch,
      currentHead: head,
    });
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
    });
  }

  // Run the promotion sweep for a session (called on SessionEnd + by the worker).
  async runPromotionSweep(
    sessionId?: string,
  ): Promise<ReturnType<Probation["sweepSessionToWorkspace"]>> {
    let git: { repoId: string; head: string; branch: string } | undefined;
    if (await this.git.isRepo()) {
      try {
        git = {
          repoId: await this.git.repoId(),
          head: await this.git.head(),
          branch: await this.git.branch(),
        };
      } catch {
        // degrade: promote without anchors
      }
    }
    return this.probation(git).sweepSessionToWorkspace({
      user_id: this.userId,
      workspace_id: this.workspaceId,
      session_id: sessionId,
    });
  }

  // Record a durable open loop (M1 §7) — an unfinished thread to resurface at
  // PostCompact/SessionStart. Session-scoped by default.
  noteOpenLoop(description: string, sessionId?: string): ReturnType<FactsRepo["insert"]> {
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

  // Resolve an open loop so it stops resurfacing (links SUPERSEDED_BY, M1 §7).
  async resolveOpenLoop(loopFactId: string, byFactId?: string): Promise<void> {
    const inv = await this.invalidator();
    inv.resolve(loopFactId, byFactId ?? loopFactId);
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
    let dirty: string[] = [];
    if (await this.git.isRepo()) {
      try {
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
      git: { repo_id: this.workspaceId, head, branch, dirty_files: dirty },
      ...extra,
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
