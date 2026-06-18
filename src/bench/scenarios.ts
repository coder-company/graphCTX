// Deep benchmark scenarios for graphCTX vs cloud memory (Supermemory).
//
// Goes beyond a single recall number: measures latency DISTRIBUTIONS (p50/p95/
// p99), cold-start, retrieval at SCALE (N facts), and the push-vs-pull gap that
// is the whole thesis. The local side runs for real; the cloud side runs live
// when SUPERMEMORY_API_KEY is set (otherwise its columns are marked N/A).
//
// Output is both human-readable and a machine JSON blob (for the website) via
// runScenarios({ json: true }).

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Fact } from "../core/types.js";
import { Runtime } from "../runtime.js";
import { SupermemoryClient } from "./supermemory.js";

// ----------------------------------------------------------------------------
// stats helpers
// ----------------------------------------------------------------------------
export interface Dist {
  p50: number;
  p95: number;
  p99: number;
  mean: number;
  min: number;
  max: number;
  n: number;
}

export function dist(xs: number[]): Dist {
  if (xs.length === 0) return { p50: 0, p95: 0, p99: 0, mean: 0, min: 0, max: 0, n: 0 };
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] as number;
  const round = (x: number) => Math.round(x * 100) / 100;
  return {
    p50: round(q(50)),
    p95: round(q(95)),
    p99: round(q(99)),
    mean: round(s.reduce((a, b) => a + b, 0) / s.length),
    min: round(s[0] as number),
    max: round(s[s.length - 1] as number),
    n: s.length,
  };
}

// ----------------------------------------------------------------------------
// shared coding fact/probe corpus
// ----------------------------------------------------------------------------
export interface Probe {
  fact: string;
  query: string;
  expect: string;
}

export const PROBES: Probe[] = [
  {
    fact: "The deploy command is ./scripts/ship.sh --canary --wait",
    query: "how do I deploy",
    expect: "ship.sh",
  },
  {
    fact: "This repo uses pnpm, never npm or yarn",
    query: "which package manager",
    expect: "pnpm",
  },
  {
    fact: "Run tests with: pnpm vitest run --coverage",
    query: "how to run tests",
    expect: "vitest",
  },
  {
    fact: "Do not edit src/generated/api.ts — it is auto-generated",
    query: "can I edit the generated api file",
    expect: "generated",
  },
  {
    fact: "Production migrations run with: pnpm migrate:prod --confirm",
    query: "how to run prod migrations",
    expect: "migrate:prod",
  },
  {
    fact: "The auth service lives in packages/auth and owns all JWT logic",
    query: "where is auth handled",
    expect: "packages/auth",
  },
  {
    fact: "Never commit to main directly; open a PR against develop",
    query: "what branch do I commit to",
    expect: "develop",
  },
  {
    fact: "The staging URL is https://staging.internal.acme.dev",
    query: "what is the staging url",
    expect: "staging.internal",
  },
  { fact: "Lint with biome, not eslint or prettier", query: "how do I lint", expect: "biome" },
  {
    fact: "The feature flag service is gated behind LAUNCHDARKLY_SDK_KEY",
    query: "how are feature flags configured",
    expect: "LAUNCHDARKLY",
  },
  {
    fact: "If TypeScript cannot find packaged vec0 assets, run node scripts/copy-assets.mjs before tsc",
    query: "tsc cannot find vec0 asset what fixes it",
    expect: "copy-assets",
  },
  {
    fact: "The graphCTX MCP surface must stay exactly 8 tools unless the I8 gate changes",
    query: "how many MCP tools should graphCTX expose",
    expect: "8 tools",
  },
  {
    fact: "Never stage autoresearch-results, .graphctx, .codex-autoresearch, or .env",
    query: "which generated agent files should stay out of commits",
    expect: "autoresearch-results",
  },
  {
    fact: "Do not edit generated API files directly; update openapi/spec.yaml and regenerate them",
    query: "where should I edit the generated API source",
    expect: "openapi/spec",
  },
  {
    fact: "Run the adapter and MCP regression gate with npx tsx src/cli.ts eval mcp",
    query: "which command verifies MCP adapters",
    expect: "eval mcp",
  },
];

export interface TemporalProbe {
  stale: string;
  current: string;
  query: string;
  expect: string;
  reject: string;
  scope?: "workspace" | "user";
}

export const TEMPORAL_PROBES: TemporalProbe[] = [
  {
    stale: "Historical fact: the deploy command used to be ./scripts/release-v1.sh --fast",
    current: "Current fact: the deploy command is ./scripts/release-v3.sh --canary --wait",
    query: "how do I deploy",
    expect: "release-v3",
    reject: "release-v1",
  },
  {
    stale: "Historical fact: this repo used npm for package operations",
    current: "Current fact: this repo uses pnpm for every package operation",
    query: "which package manager should I use",
    expect: "pnpm",
    reject: "used npm",
  },
  {
    stale: "Historical fact: tests used to run with npm test -- --watch",
    current: "Current fact: tests now run with pnpm vitest run --coverage",
    query: "how do I run tests",
    expect: "vitest",
    reject: "npm test",
  },
  {
    stale: "Historical fact: src/generated/api.ts was safe to edit manually",
    current: "Current fact: do not edit src/generated/api.ts because it is generated",
    query: "can I edit the generated api file",
    expect: "do not edit",
    reject: "safe to edit",
  },
  {
    stale: "Historical fact: production migrations used pnpm migrate:old",
    current: "Current fact: production migrations use pnpm migrate:prod --confirm",
    query: "how do I run production migrations",
    expect: "migrate:prod",
    reject: "migrate:old",
  },
  {
    stale: "Historical fact: user preferred verbose implementation status updates",
    current:
      "Current fact: user prefers concise implementation status updates with command results",
    query: "how should I write status updates",
    expect: "concise",
    reject: "verbose implementation",
    scope: "user",
  },
];

// Filler facts to test retrieval precision at scale (distractors).
export function fillerAt(i: number): string {
  const verbs = ["refactor", "optimize", "document", "test", "review", "profile", "cache", "index"];
  const nouns = [
    "parser",
    "scheduler",
    "renderer",
    "client",
    "worker",
    "pipeline",
    "resolver",
    "gateway",
  ];
  const v = verbs[i % verbs.length];
  const nn = nouns[(i >> 3) % nouns.length];
  return `Note ${i}: ${v} the ${nn} module before the ${i % 5 === 0 ? "release" : "sprint"} (item ${i}).`;
}

export function filler(n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(fillerAt(i));
  return out;
}

// ----------------------------------------------------------------------------
// graphCTX local side
// ----------------------------------------------------------------------------
export function insertFact(rt: Runtime, text: string): Fact {
  return rt.facts.insert({
    subject: "repo",
    predicate: "note",
    object: text,
    fact_kind: "decision",
    temporal_kind: "static",
    scope: { user_id: rt.userId, workspace_id: rt.workspaceId },
    trust_tier: "high",
    status: "active",
    promotion_state: "workspace_active",
    source: { asserted_by: "user", event_ids: [], raw_quote: text },
    tags: ["bench"],
  });
}

function insertTemporalFact(rt: Runtime, probe: TemporalProbe, text: string): Fact {
  if (probe.scope !== "user") return insertFact(rt, text);
  return rt.facts.insert({
    subject: "user",
    predicate: "prefers_status_updates",
    object: text,
    fact_kind: "preference",
    temporal_kind: "static",
    scope: { user_id: rt.userId },
    trust_tier: "high",
    status: "active",
    promotion_state: "user_static_active",
    source: { asserted_by: "user", event_ids: [], raw_quote: text },
    tags: ["bench", "preference"],
  });
}

export interface LocalScenario {
  ingestMs: Dist;
  retrievalMs: Dist;
  recallHits: number;
  recallTotal: number;
  scaleFacts: number;
}

export interface TemporalScenario {
  retrievalMs: Dist;
  currentHits: number;
  staleSuppressed: number;
  total: number;
  scaleFacts: number;
}

// Run the local benchmark at a given scale (number of filler distractors).
export async function runLocal(scaleFacts: number, repeats = 20): Promise<LocalScenario> {
  const dir = mkdtempSync(join(tmpdir(), "graphctx-bench-"));
  const rt = new Runtime({ workspaceDir: dir });
  const ingest: number[] = [];
  const retr: number[] = [];
  let hits = 0;
  try {
    // ingest distractors first
    for (const f of filler(scaleFacts)) insertFact(rt, f);
    // ingest the real probes, timing each
    for (const p of PROBES) {
      const t0 = performance.now();
      insertFact(rt, p.fact);
      ingest.push(performance.now() - t0);
    }
    const { Retriever } = await import("../retrieve/retriever.js");
    const retriever = new Retriever(rt.facts, rt.git, rt.vectors, rt.clock);
    // warm + measured retrieval, repeated for a real distribution
    for (let r = 0; r < repeats; r++) {
      for (const p of PROBES) {
        const ctx = await rt.injectionContext("UserPromptSubmit", "bench", {
          user_prompt: p.query,
          budget_tokens: 1000,
        });
        const t0 = performance.now();
        // Measure the per-prompt HOT PATH (indexed BM25 + bounded semantic
        // re-rank, k-limited) — not the includeAllActive boot/compaction pass,
        // which is an O(N) "fill empty context" scan run only at session start.
        const scored = await retriever.retrieve(ctx, { k: 10 });
        retr.push(performance.now() - t0);
        if (r === 0) {
          const top = scored
            .slice(0, 5)
            .map((s) => String(s.fact.object))
            .join(" ");
          if (top.includes(p.expect)) hits++;
        }
      }
    }
  } finally {
    rt.close();
    rmSync(dir, { recursive: true, force: true });
  }
  return {
    ingestMs: dist(ingest),
    retrievalMs: dist(retr),
    recallHits: hits,
    recallTotal: PROBES.length,
    scaleFacts,
  };
}

// Measures temporal graph hygiene: historical facts remain auditable in storage
// but must not leak into current hot-path retrieval once superseded.
export async function runTemporalLocal(
  scaleFacts: number,
  repeats = 20,
): Promise<TemporalScenario> {
  const dir = mkdtempSync(join(tmpdir(), "graphctx-bench-temporal-"));
  const rt = new Runtime({ workspaceDir: dir });
  const retr: number[] = [];
  let currentHits = 0;
  let staleSuppressed = 0;
  try {
    for (const f of filler(scaleFacts)) insertFact(rt, f);
    for (const p of TEMPORAL_PROBES) {
      const stale = insertTemporalFact(rt, p, p.stale);
      const current = insertTemporalFact(rt, p, p.current);
      rt.facts.supersede(stale.fact_id, current.fact_id);
    }
    const { Retriever } = await import("../retrieve/retriever.js");
    const retriever = new Retriever(rt.facts, rt.git, rt.vectors, rt.clock);
    for (let r = 0; r < repeats; r++) {
      for (const p of TEMPORAL_PROBES) {
        const ctx = await rt.injectionContext("UserPromptSubmit", "bench-temporal", {
          user_prompt: p.query,
          budget_tokens: 1000,
        });
        const t0 = performance.now();
        const scored = await retriever.retrieve(ctx, { k: 10 });
        retr.push(performance.now() - t0);
        if (r === 0) {
          const top = scored
            .slice(0, 5)
            .map((s) => String(s.fact.object).toLowerCase())
            .join(" ");
          if (top.includes(p.expect.toLowerCase())) currentHits++;
          if (!top.includes(p.reject.toLowerCase())) staleSuppressed++;
        }
      }
    }
  } finally {
    rt.close();
    rmSync(dir, { recursive: true, force: true });
  }
  return {
    retrievalMs: dist(retr),
    currentHits,
    staleSuppressed,
    total: TEMPORAL_PROBES.length,
    scaleFacts,
  };
}

// ----------------------------------------------------------------------------
// Supermemory cloud side (live)
// ----------------------------------------------------------------------------
export interface CloudScenario {
  ingestMs: Dist;
  retrievalMs: Dist;
  serverMs: Dist;
  recallHits: number;
  recallTotal: number;
}

export async function runCloud(): Promise<CloudScenario | null> {
  if (!SupermemoryClient.available()) return null;
  const client = new SupermemoryClient();
  const tag = `graphctx-bench-${randomUUID().slice(0, 8)}`;
  const ingest: number[] = [];
  const retr: number[] = [];
  const server: number[] = [];
  let hits = 0;
  for (const p of PROBES) {
    const { ms } = await client.add(p.fact, tag);
    ingest.push(ms);
  }
  // async indexing — wait before searching
  await new Promise((r) => setTimeout(r, 15000));
  // repeat searches twice for a small distribution
  for (let r = 0; r < 2; r++) {
    for (const p of PROBES) {
      const { results, ms, serverMs } = await client.search(p.query, tag, {
        limit: 5,
        threshold: 0.2,
      });
      retr.push(ms);
      if (serverMs) server.push(serverMs);
      if (r === 0) {
        const blob = results.map((x) => x.memory ?? x.chunk ?? "").join(" ");
        if (blob.includes(p.expect)) hits++;
      }
    }
  }
  return {
    ingestMs: dist(ingest),
    retrievalMs: dist(retr),
    serverMs: dist(server),
    recallHits: hits,
    recallTotal: PROBES.length,
  };
}

// ----------------------------------------------------------------------------
// push-vs-pull (the thesis): reuse the eval harness numbers
// ----------------------------------------------------------------------------
export interface PushPull {
  noMemorySolve: number;
  pullSolve: number;
  pushSolve: number;
  total: number;
}

export async function runPushPull(baseDir: string): Promise<PushPull | null> {
  try {
    const { runEval } = await import("../eval/harness.js");
    const report = await runEval({ suite: "compaction-recovery", arms: ["A", "B", "C"], baseDir });
    const arm = (id: string) => report.arms.find((a) => a.arm === id);
    const a = arm("A");
    const b = arm("B");
    const c = arm("C");
    if (!a || !b || !c) return null;
    return {
      noMemorySolve: a.needsMet,
      pullSolve: b.needsMet,
      pushSolve: c.needsMet,
      total: c.totalNeeds,
    };
  } catch {
    return null;
  }
}

// ----------------------------------------------------------------------------
// full run
// ----------------------------------------------------------------------------
export interface ScenarioReport {
  generatedAt: string;
  local: {
    small: LocalScenario;
    medium: LocalScenario;
    large: LocalScenario;
    temporal: TemporalScenario;
  };
  cloud: CloudScenario | null;
  pushPull: PushPull | null;
  headline: {
    localRetrievalP50: number;
    cloudRetrievalP50: number | null;
    speedup: number | null;
    localRecallPct: number;
    cloudRecallPct: number | null;
  };
}

export async function runScenarios(opts: { baseDir?: string } = {}): Promise<ScenarioReport> {
  const baseDir = opts.baseDir ?? process.cwd();
  const small = await runLocal(0);
  const medium = await runLocal(500);
  const large = await runLocal(5000);
  const temporal = await runTemporalLocal(500);
  const cloud = await runCloud();
  const pushPull = await runPushPull(baseDir);

  const localP50 = medium.retrievalMs.p50;
  const cloudP50 = cloud?.retrievalMs.p50 ?? null;
  return {
    generatedAt: new Date().toISOString(),
    local: { small, medium, large, temporal },
    cloud,
    pushPull,
    headline: {
      localRetrievalP50: localP50,
      cloudRetrievalP50: cloudP50,
      speedup: cloudP50 ? Math.round(cloudP50 / Math.max(0.01, localP50)) : null,
      localRecallPct: Math.round((medium.recallHits / medium.recallTotal) * 100),
      cloudRecallPct: cloud ? Math.round((cloud.recallHits / cloud.recallTotal) * 100) : null,
    },
  };
}
