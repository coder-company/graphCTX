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
import { type DB, openDb } from "./store/db.js";
import { EpisodesRepo } from "./store/episodes.repo.js";
import { FactsRepo } from "./store/facts.repo.js";
import { InjectionsRepo } from "./store/injections.repo.js";

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
  readonly episodeLog: EpisodeLog;
  readonly git: Git;
  readonly ledger: Ledger;
  private readonly clock: Clock;

  constructor(opts: RuntimeOptions = {}) {
    this.clock = opts.clock ?? systemClock;
    this.loaded = loadConfig({ workspaceDir: opts.workspaceDir });
    this.workspaceDir = this.loaded.workspaceDir;
    this.userId = opts.userId ?? process.env.GRAPHCTX_USER_ID ?? "local-user";
    this.workspaceId = workspaceIdFromPath(this.workspaceDir);
    this.db = openDb(this.loaded.paths.workspaceDb);
    this.facts = new FactsRepo(this.db, this.clock);
    this.episodes = new EpisodesRepo(this.db, this.clock);
    this.injections = new InjectionsRepo(this.db, this.clock);
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
    });
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
