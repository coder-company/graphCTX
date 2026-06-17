import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixedClock } from "../../core/clock.js";
import type { NewFact } from "../../core/types.js";
import { Retriever } from "../../retrieve/retriever.js";
import { Runtime } from "../../runtime.js";

// A single labeled fact spec. `gold` facts ARE relevant to the case query;
// distractors share a subject/predicate but a different object so ranking — not
// mere presence — decides the score.
export interface FactSpec {
  subject: string;
  predicate: string;
  object: unknown;
  fact_kind?: NewFact["fact_kind"];
  raw_quote?: string;
  tags?: string[];
}

// A labeled retrieval case: a natural-language query plus its gold facts and
// plausible distractors. `files`/`symbols` drive the entity signal for path /
// symbol queries.
export interface RetrievalCase {
  label: string;
  kind: "keyword" | "paraphrase" | "entity" | "mixed";
  query: string;
  gold: FactSpec[];
  distractors: FactSpec[];
  files?: string[];
  symbols?: string[];
}

// Labeled benchmark spanning four query archetypes (SPEC §13 retrieval):
//   keyword    — BM25-friendly: query terms appear in the fact text.
//   paraphrase — the answer object shares no query keywords; relevance is
//                carried by the predicate / provenance quote (hybrid recall).
//   entity     — path / symbol queries driven by the entity signal.
//   mixed      — both lexical and entity overlap.
// Distractors share the subject (often the predicate) but differ in object, so a
// correct ranker must place the gold fact above its near-neighbours.
export const RETRIEVAL_CASES: RetrievalCase[] = [
  {
    label: "test command (keyword)",
    kind: "keyword",
    query: "what command runs the unit test suite",
    gold: [
      {
        subject: "repo",
        predicate: "test_command",
        object: "vitest run",
        fact_kind: "procedural",
        raw_quote: "run the unit test suite with vitest run",
      },
    ],
    distractors: [
      {
        subject: "repo",
        predicate: "build_command",
        object: "tsc -p tsconfig.json",
        fact_kind: "procedural",
        raw_quote: "build the project with tsc",
      },
      {
        subject: "repo",
        predicate: "lint_command",
        object: "biome check src",
        fact_kind: "procedural",
        raw_quote: "lint the source with biome",
      },
    ],
  },
  {
    label: "build command (keyword)",
    kind: "keyword",
    query: "how do I build and compile the project",
    gold: [
      {
        subject: "service",
        predicate: "build_command",
        object: "npm run build:prod",
        fact_kind: "procedural",
        raw_quote: "build and compile the project with npm run build:prod",
      },
    ],
    distractors: [
      {
        subject: "service",
        predicate: "start_command",
        object: "npm run start:dev",
        fact_kind: "procedural",
        raw_quote: "start the dev server with npm run start:dev",
      },
      {
        subject: "service",
        predicate: "deploy_command",
        object: "fly deploy --remote-only",
        fact_kind: "procedural",
        raw_quote: "deploy with fly to production",
      },
    ],
  },
  {
    label: "package manager (paraphrase)",
    kind: "paraphrase",
    query: "which package manager does this repo use",
    gold: [
      {
        subject: "repo",
        predicate: "package_manager",
        object: "pnpm",
        fact_kind: "constraint",
        raw_quote: "this repo uses the pnpm package manager, never npm",
      },
    ],
    distractors: [
      {
        subject: "repo",
        predicate: "runtime",
        object: "node 22",
        fact_kind: "constraint",
        raw_quote: "the repo runtime is node 22",
      },
      {
        subject: "repo",
        predicate: "language",
        object: "typescript esm",
        fact_kind: "constraint",
        raw_quote: "the repo language is typescript with esm modules",
      },
    ],
  },
  {
    label: "module bundler (paraphrase)",
    kind: "paraphrase",
    query: "what tool bundles the frontend assets",
    gold: [
      {
        subject: "frontend",
        predicate: "bundler",
        object: "vite",
        fact_kind: "constraint",
        raw_quote: "the frontend bundles its assets with the vite bundler",
      },
    ],
    distractors: [
      {
        subject: "frontend",
        predicate: "framework",
        object: "react 18",
        fact_kind: "constraint",
        raw_quote: "the frontend framework is react 18",
      },
      {
        subject: "frontend",
        predicate: "css",
        object: "tailwind",
        fact_kind: "constraint",
        raw_quote: "the frontend styles assets with tailwind css",
      },
    ],
  },
  {
    label: "auth login path (entity)",
    kind: "entity",
    query: "where is the login handler implemented",
    files: ["src/auth/login.ts"],
    gold: [
      {
        subject: "src/auth/login.ts",
        predicate: "owns",
        object: "login handler authenticateUser",
        fact_kind: "semantic",
        raw_quote: "the login handler authenticateUser lives in src/auth/login.ts",
        tags: ["auth"],
      },
    ],
    distractors: [
      {
        subject: "src/auth/logout.ts",
        predicate: "owns",
        object: "logout handler revokeSession",
        fact_kind: "semantic",
        raw_quote: "the logout handler revokeSession lives in src/auth/logout.ts",
        tags: ["auth"],
      },
      {
        subject: "src/auth/session.ts",
        predicate: "owns",
        object: "session refresh rotateToken",
        fact_kind: "semantic",
        raw_quote: "token rotation rotateToken lives in src/auth/session.ts",
        tags: ["auth"],
      },
    ],
  },
  {
    label: "config loader symbol (entity)",
    kind: "entity",
    query: "which function loads the configuration",
    symbols: ["loadConfig"],
    gold: [
      {
        subject: "src/config/config.ts",
        predicate: "exports",
        object: "loadConfig parses graphctx config",
        fact_kind: "semantic",
        raw_quote: "loadConfig in src/config/config.ts loads the configuration",
        tags: ["config"],
      },
    ],
    distractors: [
      {
        subject: "src/config/defaults.ts",
        predicate: "exports",
        object: "defaultConfig static template",
        fact_kind: "semantic",
        raw_quote: "defaultConfig provides the static config template",
        tags: ["config"],
      },
      {
        subject: "src/config/schema.ts",
        predicate: "exports",
        object: "configSchema zod validator",
        fact_kind: "semantic",
        raw_quote: "configSchema validates the config shape",
        tags: ["config"],
      },
    ],
  },
  {
    label: "node version constraint (keyword)",
    kind: "keyword",
    query: "what node version is required",
    gold: [
      {
        subject: "repo",
        predicate: "node_version",
        object: ">=22",
        fact_kind: "constraint",
        raw_quote: "this repo requires node version >=22",
      },
    ],
    distractors: [
      {
        subject: "repo",
        predicate: "pnpm_version",
        object: ">=9",
        fact_kind: "constraint",
        raw_quote: "this repo requires pnpm version >=9",
      },
      {
        subject: "repo",
        predicate: "typescript_version",
        object: "5.6",
        fact_kind: "constraint",
        raw_quote: "this repo pins typescript version 5.6",
      },
    ],
  },
  {
    label: "deploy decision (mixed)",
    kind: "mixed",
    query: "how do we ship a release to production",
    gold: [
      {
        subject: "repo",
        predicate: "deploy_command",
        object: "./scripts/ship.sh",
        fact_kind: "decision",
        raw_quote: "we ship a release to production by running ./scripts/ship.sh",
        tags: ["deploy"],
      },
    ],
    distractors: [
      {
        subject: "repo",
        predicate: "rollback_command",
        object: "./scripts/rollback.sh",
        fact_kind: "decision",
        raw_quote: "we roll back a bad release with ./scripts/rollback.sh",
        tags: ["deploy"],
      },
      {
        subject: "repo",
        predicate: "release_cadence",
        object: "weekly on thursday",
        fact_kind: "decision",
        raw_quote: "we cut a release weekly on thursday",
        tags: ["deploy"],
      },
    ],
  },
  {
    label: "database engine (paraphrase)",
    kind: "paraphrase",
    query: "where does the app persist its data",
    gold: [
      {
        subject: "backend",
        predicate: "database",
        object: "sqlite via better-sqlite3",
        fact_kind: "constraint",
        raw_quote: "the app persists its data in sqlite using better-sqlite3",
        tags: ["storage"],
      },
    ],
    distractors: [
      {
        subject: "backend",
        predicate: "cache",
        object: "in-memory lru",
        fact_kind: "constraint",
        raw_quote: "the app caches hot data in an in-memory lru",
        tags: ["storage"],
      },
      {
        subject: "backend",
        predicate: "queue",
        object: "redis streams",
        fact_kind: "constraint",
        raw_quote: "the app queues jobs on redis streams",
        tags: ["storage"],
      },
    ],
  },
  {
    label: "lint tool (keyword)",
    kind: "keyword",
    query: "what lint and format tool is configured",
    gold: [
      {
        subject: "repo",
        predicate: "lint_command",
        object: "biome check --write",
        fact_kind: "procedural",
        raw_quote: "lint and format with biome check --write",
      },
    ],
    distractors: [
      {
        subject: "repo",
        predicate: "typecheck_command",
        object: "tsc --noEmit",
        fact_kind: "procedural",
        raw_quote: "typecheck with tsc --noEmit",
      },
      {
        subject: "repo",
        predicate: "format_style",
        object: "two space indent",
        fact_kind: "constraint",
        raw_quote: "the format style is two space indent",
      },
    ],
  },
  {
    label: "ci workflow (mixed)",
    kind: "mixed",
    query: "how does continuous integration run the checks",
    gold: [
      {
        subject: "ci",
        predicate: "ci_command",
        object: "npm run test:ci",
        fact_kind: "procedural",
        raw_quote: "continuous integration runs the checks with npm run test:ci",
        tags: ["ci"],
      },
    ],
    distractors: [
      {
        subject: "ci",
        predicate: "ci_provider",
        object: "github actions",
        fact_kind: "semantic",
        raw_quote: "continuous integration runs on github actions",
        tags: ["ci"],
      },
      {
        subject: "ci",
        predicate: "ci_trigger",
        object: "on pull request",
        fact_kind: "semantic",
        raw_quote: "the ci pipeline triggers on pull request",
        tags: ["ci"],
      },
    ],
  },
  {
    label: "env var for db (mixed)",
    kind: "mixed",
    query: "which environment variable holds the database connection string",
    gold: [
      {
        subject: "config",
        predicate: "env_var",
        object: "DATABASE_URL",
        fact_kind: "constraint",
        raw_quote:
          "the database connection string is read from the DATABASE_URL environment variable",
        tags: ["config"],
      },
    ],
    distractors: [
      {
        subject: "config",
        predicate: "env_var",
        object: "REDIS_URL",
        fact_kind: "constraint",
        raw_quote: "the redis connection string is read from the REDIS_URL environment variable",
        tags: ["config"],
      },
      {
        subject: "config",
        predicate: "env_var",
        object: "LOG_LEVEL",
        fact_kind: "constraint",
        raw_quote: "the log verbosity is read from the LOG_LEVEL environment variable",
        tags: ["config"],
      },
    ],
  },
  {
    label: "flaky test failure (keyword)",
    kind: "keyword",
    query: "which test is flaky and intermittently fails",
    gold: [
      {
        subject: "test/inject/planner.test.ts",
        predicate: "flaky_test",
        object: "planner budget test fails intermittently under load",
        fact_kind: "failure",
        raw_quote: "the planner budget test is flaky and intermittently fails",
        tags: ["failure"],
      },
    ],
    distractors: [
      {
        subject: "test/store/facts.test.ts",
        predicate: "slow_test",
        object: "facts repo test is slow",
        fact_kind: "failure",
        raw_quote: "the facts repo test is slow but stable",
        tags: ["failure"],
      },
      {
        subject: "test/git/dag.test.ts",
        predicate: "skipped_test",
        object: "dag revert test skipped on windows",
        fact_kind: "failure",
        raw_quote: "the dag revert test is skipped on windows",
        tags: ["failure"],
      },
    ],
  },
  {
    label: "secrets storage policy (paraphrase)",
    kind: "paraphrase",
    query: "how should credentials never be stored",
    gold: [
      {
        subject: "policy",
        predicate: "secret_handling",
        object: "never commit credentials to the repository",
        fact_kind: "constraint",
        raw_quote: "credentials must never be stored or committed to the repository",
        tags: ["security"],
      },
    ],
    distractors: [
      {
        subject: "policy",
        predicate: "review_rule",
        object: "two approvals required before merge",
        fact_kind: "constraint",
        raw_quote: "two approvals are required before merge",
        tags: ["security"],
      },
      {
        subject: "policy",
        predicate: "branch_rule",
        object: "no direct pushes to main",
        fact_kind: "constraint",
        raw_quote: "no direct pushes to main are allowed",
        tags: ["security"],
      },
    ],
  },
  {
    label: "migration command (mixed)",
    kind: "mixed",
    query: "how do I apply pending database migrations",
    gold: [
      {
        subject: "backend",
        predicate: "migrate_command",
        object: "npm run db:migrate",
        fact_kind: "procedural",
        raw_quote: "apply pending database migrations with npm run db:migrate",
        tags: ["db"],
      },
    ],
    distractors: [
      {
        subject: "backend",
        predicate: "seed_command",
        object: "npm run db:seed",
        fact_kind: "procedural",
        raw_quote: "seed the database with npm run db:seed",
        tags: ["db"],
      },
      {
        subject: "backend",
        predicate: "reset_command",
        object: "npm run db:reset",
        fact_kind: "procedural",
        raw_quote: "reset the database with npm run db:reset",
        tags: ["db"],
      },
    ],
  },
  {
    label: "api base path (entity)",
    kind: "entity",
    query: "what is the base route for the rest api",
    files: ["src/api/router.ts"],
    gold: [
      {
        subject: "src/api/router.ts",
        predicate: "base_path",
        object: "/api/v2",
        fact_kind: "semantic",
        raw_quote: "the rest api base route is /api/v2 in src/api/router.ts",
        tags: ["api"],
      },
    ],
    distractors: [
      {
        subject: "src/api/legacy.ts",
        predicate: "base_path",
        object: "/api/v1",
        fact_kind: "semantic",
        raw_quote: "the legacy api base route is /api/v1 in src/api/legacy.ts",
        tags: ["api"],
      },
      {
        subject: "src/api/webhooks.ts",
        predicate: "base_path",
        object: "/hooks",
        fact_kind: "semantic",
        raw_quote: "the webhook routes are mounted at /hooks in src/api/webhooks.ts",
        tags: ["api"],
      },
    ],
  },
  {
    label: "logging library (paraphrase)",
    kind: "paraphrase",
    query: "what does the service use to emit structured logs",
    gold: [
      {
        subject: "service",
        predicate: "logger",
        object: "pino",
        fact_kind: "constraint",
        raw_quote: "the service emits structured logs with pino",
        tags: ["observability"],
      },
    ],
    distractors: [
      {
        subject: "service",
        predicate: "metrics",
        object: "prometheus client",
        fact_kind: "constraint",
        raw_quote: "the service exposes metrics to prometheus",
        tags: ["observability"],
      },
      {
        subject: "service",
        predicate: "tracing",
        object: "opentelemetry",
        fact_kind: "constraint",
        raw_quote: "the service emits traces via opentelemetry",
        tags: ["observability"],
      },
    ],
  },
  {
    label: "release versioning decision (mixed)",
    kind: "mixed",
    query: "how do we version and tag a new release",
    gold: [
      {
        subject: "repo",
        predicate: "release_step",
        object: "bump the version then create a git tag",
        fact_kind: "decision",
        raw_quote: "to version a release we bump the version then create a git tag",
        tags: ["release"],
      },
    ],
    distractors: [
      {
        subject: "repo",
        predicate: "changelog_step",
        object: "update CHANGELOG before tagging",
        fact_kind: "decision",
        raw_quote: "update the changelog before tagging a release",
        tags: ["release"],
      },
      {
        subject: "repo",
        predicate: "versioning_scheme",
        object: "semantic versioning",
        fact_kind: "decision",
        raw_quote: "the repo follows semantic versioning",
        tags: ["release"],
      },
    ],
  },
];

const scope = { user_id: "eval-user" } as const;

// Fixed clock so recency/confidence multipliers are identical across every fact
// → fully deterministic fusion ordering (ties broken by content key, never by
// the random fact_id or wall-clock time).
const FIXED_AT = "2025-01-01T00:00:00.000Z";

export interface RetrievalQualityReport {
  queries: number;
  goldFacts: number;
  distractorFacts: number;
  recallAt1: number;
  recallAt5: number;
  recallAt10: number;
  mrr: number;
  floor: number;
  recallAt5Floor: number;
  mrrFloor: number;
  semanticProbe: SemanticProbeReport;
  diversityProbe: DiversityProbeReport;
  pass: boolean;
  rows: Array<{
    label: string;
    kind: string;
    firstRank: number; // rank of first gold hit (0 = not found)
    goldFound: number;
    goldTotal: number;
  }>;
}

export interface SemanticProbeReport {
  label: string;
  vectorEnabled: boolean;
  fallbackMode: boolean;
  skipped: boolean;
  firstRank: number;
  queryObjectOverlap: boolean;
  pass: boolean;
}

export interface DiversityProbeReport {
  label: string;
  vectorEnabled: boolean;
  fallbackMode: boolean;
  skipped: boolean;
  top5Families: string[];
  distinctFamiliesTop5: number;
  pass: boolean;
}

// recall@10 floor: the measured baseline (0.667) rounded DOWN with margin, so the
// suite passes today but flags a real regression in retrieval quality. The gap
// between this baseline and 1.0 is exactly what the upcoming fusion A/B test
// (weighted-average vs Reciprocal Rank Fusion) aims to close.
const RECALL10_FLOOR = 0.6;
const RECALL5_FLOOR = 0.9;
const MRR_FLOOR = 0.7;
const DIVERSITY_FAMILY_FLOOR = 3;

function buildFact(spec: FactSpec, workspaceId: string): NewFact {
  return {
    subject: spec.subject,
    predicate: spec.predicate,
    object: spec.object,
    fact_kind: spec.fact_kind ?? "semantic",
    temporal_kind: "static",
    scope: { user_id: scope.user_id, workspace_id: workspaceId },
    trust_tier: "high",
    status: "active",
    promotion_state: "workspace_active",
    source: {
      asserted_by: "user",
      event_ids: [],
      raw_quote: spec.raw_quote,
    },
    tags: spec.tags ?? [],
  };
}

// Build a populated Runtime/Retriever (vectors enabled when sqlite-vec is
// available; BM25 fallback otherwise), insert every gold + distractor fact as an
// active workspace fact, then score recall@k + MRR over the labeled gold set.
export async function runRetrievalQualityEval(): Promise<RetrievalQualityReport> {
  const dir = mkdtempSync(join(tmpdir(), "graphctx-retrieval-"));
  try {
    const rt = new Runtime({
      workspaceDir: dir,
      userId: scope.user_id,
      clock: fixedClock(FIXED_AT),
    });
    const wsScope = { user_id: scope.user_id, workspace_id: rt.workspaceId };

    // Insert the whole corpus once; every query retrieves against all facts so
    // cross-case distractors compete realistically.
    let goldFacts = 0;
    let distractorFacts = 0;
    const goldIdsByCase: string[][] = [];
    for (const c of RETRIEVAL_CASES) {
      const goldIds: string[] = [];
      for (const spec of c.gold) {
        const fact = rt.facts.insert(buildFact(spec, rt.workspaceId));
        goldIds.push(fact.fact_id);
        goldFacts += 1;
      }
      for (const spec of c.distractors) {
        rt.facts.insert(buildFact(spec, rt.workspaceId));
        distractorFacts += 1;
      }
      goldIdsByCase.push(goldIds);
    }

    const retriever = new Retriever(rt.facts, rt.git, rt.vectors);
    const rows: RetrievalQualityReport["rows"] = [];
    let sumR1 = 0;
    let sumR5 = 0;
    let sumR10 = 0;
    let sumRr = 0;

    for (let i = 0; i < RETRIEVAL_CASES.length; i++) {
      const c = RETRIEVAL_CASES[i]!;
      const goldSet = new Set(goldIdsByCase[i]);
      const ctx = await rt.injectionContext("UserPromptSubmit", "retrieval-eval", {
        user_prompt: c.query,
        current_files: c.files,
        mentioned_symbols: c.symbols,
      });
      const ranked = (await retriever.retrieve(ctx)).map((sf) => sf.fact.fact_id);

      const ranks: number[] = [];
      for (let r = 0; r < ranked.length; r++) {
        if (goldSet.has(ranked[r]!)) ranks.push(r + 1);
      }
      const firstRank = ranks.length > 0 ? Math.min(...ranks) : 0;
      const inTop = (k: number) => ranks.filter((r) => r <= k).length;
      const r1 = inTop(1) / goldSet.size;
      const r5 = inTop(5) / goldSet.size;
      const r10 = inTop(10) / goldSet.size;
      const rr = firstRank > 0 ? 1 / firstRank : 0;

      sumR1 += r1;
      sumR5 += r5;
      sumR10 += r10;
      sumRr += rr;

      rows.push({
        label: c.label,
        kind: c.kind,
        firstRank,
        goldFound: inTop(ranked.length),
        goldTotal: goldSet.size,
      });
    }

    const semanticProbe = await runSemanticNoOverlapProbe();
    const diversityProbe = await runDiversityProbe();

    rt.close();

    const n = RETRIEVAL_CASES.length;
    const recallAt1 = sumR1 / n;
    const recallAt5 = sumR5 / n;
    const recallAt10 = sumR10 / n;
    const mrr = sumRr / n;

    return {
      queries: n,
      goldFacts,
      distractorFacts,
      recallAt1,
      recallAt5,
      recallAt10,
      mrr,
      floor: RECALL10_FLOOR,
      recallAt5Floor: RECALL5_FLOOR,
      mrrFloor: MRR_FLOOR,
      semanticProbe,
      diversityProbe,
      pass:
        recallAt10 >= RECALL10_FLOOR &&
        recallAt5 >= RECALL5_FLOOR &&
        mrr >= MRR_FLOOR &&
        semanticProbe.pass &&
        diversityProbe.pass,
      rows,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function runSemanticNoOverlapProbe(): Promise<SemanticProbeReport> {
  const label = "semantic no-overlap: outage paging -> pagerduty";
  const fallbackMode = explicitVectorFallbackMode();
  const dir = mkdtempSync(join(tmpdir(), "graphctx-retrieval-semantic-"));
  try {
    const rt = new Runtime({
      workspaceDir: dir,
      userId: scope.user_id,
      clock: fixedClock(FIXED_AT),
    });
    const vectorEnabled = rt.vectors.enabled;
    if (!vectorEnabled) {
      rt.close();
      return {
        label,
        vectorEnabled,
        fallbackMode,
        skipped: true,
        firstRank: 0,
        queryObjectOverlap: false,
        pass: fallbackMode,
      };
    }

    for (let i = 0; i < 24; i++) {
      rt.facts.insert(
        buildFact(
          {
            subject: `aaa-noise-${String(i).padStart(2, "0")}`,
            predicate: "owner",
            object: `cache layer ${i}`,
            fact_kind: "semantic",
            raw_quote: `cache layer ${i} is owned by the platform team`,
            tags: ["noise"],
          },
          rt.workspaceId,
        ),
      );
    }
    const gold = rt.facts.insert(
      buildFact(
        {
          subject: "zzzz-incident-policy",
          predicate: "escalation_target",
          object: "pagerduty",
          fact_kind: "constraint",
          raw_quote: "pagerduty owns production escalation",
          tags: ["incident"],
        },
        rt.workspaceId,
      ),
    );

    const query = "who gets paged when service health breaks";
    const ctx = await rt.injectionContext("UserPromptSubmit", "retrieval-semantic-probe", {
      user_prompt: query,
    });
    const ranked = await new Retriever(rt.facts, rt.git, rt.vectors).retrieve(ctx, { k: 10 });
    const firstRank = ranked.findIndex((sf) => sf.fact.fact_id === gold.fact_id) + 1;
    const queryObjectOverlap = hasTokenOverlap(query, String(gold.object));
    rt.close();
    return {
      label,
      vectorEnabled,
      fallbackMode,
      skipped: false,
      firstRank,
      queryObjectOverlap,
      pass: firstRank > 0 && firstRank <= 10 && !queryObjectOverlap,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function runDiversityProbe(): Promise<DiversityProbeReport> {
  const label = "MMR diversity: auth handler cluster";
  const fallbackMode = explicitVectorFallbackMode();
  const dir = mkdtempSync(join(tmpdir(), "graphctx-retrieval-diversity-"));
  try {
    const rt = new Runtime({
      workspaceDir: dir,
      userId: scope.user_id,
      clock: fixedClock(FIXED_AT),
    });
    const vectorEnabled = rt.vectors.enabled;
    if (!vectorEnabled) {
      rt.close();
      return {
        label,
        vectorEnabled,
        fallbackMode,
        skipped: true,
        top5Families: [],
        distinctFamiliesTop5: 0,
        pass: fallbackMode,
      };
    }

    for (let i = 0; i < 10; i++) {
      rt.facts.insert(
        buildFact(
          {
            subject: `src/auth/login-${i}.ts`,
            predicate: "owns",
            object: `login handler authenticate user request variant ${i}`,
            fact_kind: "semantic",
            raw_quote: `auth handler route for login authenticate user request variant ${i}`,
            tags: ["auth", "handler"],
          },
          rt.workspaceId,
        ),
      );
    }
    for (const spec of [
      {
        subject: "src/auth/logout.ts",
        object: "logout handler revoke session request",
        raw_quote: "auth handler route for logout revoke session request",
      },
      {
        subject: "src/auth/session.ts",
        object: "session refresh handler rotate token request",
        raw_quote: "auth handler route for session refresh rotate token request",
      },
      {
        subject: "src/auth/password.ts",
        object: "password reset handler recover account request",
        raw_quote: "auth handler route for password reset recover account request",
      },
    ]) {
      rt.facts.insert(
        buildFact(
          {
            subject: spec.subject,
            predicate: "owns",
            object: spec.object,
            fact_kind: "semantic",
            raw_quote: spec.raw_quote,
            tags: ["auth", "handler"],
          },
          rt.workspaceId,
        ),
      );
    }

    const ctx = await rt.injectionContext("UserPromptSubmit", "retrieval-diversity-probe", {
      user_prompt: "where are the auth request handlers implemented",
    });
    const ranked = await new Retriever(rt.facts, rt.git, rt.vectors).retrieve(ctx, { k: 20 });
    const top5Families = ranked.slice(0, 5).map((sf) => familyOf(sf.fact.subject));
    const distinctFamiliesTop5 = new Set(top5Families).size;
    rt.close();
    return {
      label,
      vectorEnabled,
      fallbackMode,
      skipped: false,
      top5Families,
      distinctFamiliesTop5,
      pass: distinctFamiliesTop5 >= DIVERSITY_FAMILY_FLOOR,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function formatRetrievalQualityReport(r: RetrievalQualityReport): string {
  const pct = (n: number) => `${Math.round(n * 100)}%`;
  const num = (n: number) => n.toFixed(3);
  const lines: string[] = [];
  lines.push("");
  lines.push("graphCTX eval — retrieval quality (recall@k + MRR)");
  lines.push("=".repeat(72));
  lines.push("");
  lines.push("case                                            kind        rank  found");
  lines.push("-".repeat(72));
  for (const row of r.rows) {
    lines.push(
      `${row.label.slice(0, 44).padEnd(46)}${row.kind.padEnd(12)}${String(row.firstRank || "-").padEnd(6)}${row.goldFound}/${row.goldTotal}`,
    );
  }
  lines.push("");
  lines.push("-".repeat(72));
  lines.push(
    `  queries:        ${r.queries}  (gold ${r.goldFacts}, distractors ${r.distractorFacts})`,
  );
  lines.push(`  recall@1:       ${pct(r.recallAt1)}  (${num(r.recallAt1)})`);
  lines.push(`  recall@5:       ${pct(r.recallAt5)}  (${num(r.recallAt5)})`);
  lines.push(`  recall@10:      ${pct(r.recallAt10)}  (${num(r.recallAt10)})`);
  lines.push(`  MRR:            ${num(r.mrr)}`);
  lines.push("");
  lines.push("Semantic no-overlap probe");
  lines.push("-".repeat(72));
  lines.push(
    r.semanticProbe.skipped
      ? `  ${r.semanticProbe.label}: skipped (vector index disabled${r.semanticProbe.fallbackMode ? " by explicit fallback mode" : ""})`
      : `  ${r.semanticProbe.label}: rank ${r.semanticProbe.firstRank || "-"}; query/object keyword overlap: ${r.semanticProbe.queryObjectOverlap ? "yes" : "no"}`,
  );
  lines.push("");
  lines.push("MMR diversity probe");
  lines.push("-".repeat(72));
  lines.push(
    r.diversityProbe.skipped
      ? `  ${r.diversityProbe.label}: skipped (vector index disabled${r.diversityProbe.fallbackMode ? " by explicit fallback mode" : ""})`
      : `  ${r.diversityProbe.label}: top-5 families [${r.diversityProbe.top5Families.join(", ")}], distinct=${r.diversityProbe.distinctFamiliesTop5} (floor ${DIVERSITY_FAMILY_FLOOR})`,
  );
  lines.push("");
  lines.push(
    r.pass
      ? `  VERDICT: ✅ RETRIEVAL PASS — recall@10 ${pct(r.recallAt10)} >= floor ${pct(r.floor)}. Semantic no-overlap and MMR diversity gates pass.`
      : `  VERDICT: ❌ RETRIEVAL FAIL — recall@10 ${pct(r.recallAt10)} (floor ${pct(r.floor)}), recall@5 ${pct(r.recallAt5)} (floor ${pct(r.recallAt5Floor)}), MRR ${num(r.mrr)} (floor ${num(r.mrrFloor)}), semantic=${r.semanticProbe.pass ? "pass" : "fail"}, diversity=${r.diversityProbe.pass ? "pass" : "fail"}.`,
  );
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function explicitVectorFallbackMode(): boolean {
  return !!process.env.GRAPHCTX_VEC0_PATH;
}

function hasTokenOverlap(a: string, b: string): boolean {
  const at = meaningfulTokens(a);
  for (const tok of meaningfulTokens(b)) {
    if (at.has(tok)) return true;
  }
  return false;
}

function meaningfulTokens(text: string): Set<string> {
  const stop = new Set([
    "a",
    "an",
    "and",
    "are",
    "does",
    "for",
    "how",
    "is",
    "of",
    "the",
    "to",
    "what",
    "when",
    "where",
    "which",
    "who",
  ]);
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9_.:/-]+/)
      .filter((t) => t.length >= 2 && !stop.has(t)),
  );
}

function familyOf(subject: string): string {
  const match = subject.match(/src\/auth\/([a-z]+)[^/]*\.ts/);
  return match?.[1] ?? subject;
}
