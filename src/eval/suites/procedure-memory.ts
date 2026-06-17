import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { defaultConfig } from "../../config/defaults.js";
import type { Episode, Scope } from "../../core/types.js";
import { extractFactsFromEpisodes } from "../../extract/llm/fact-extractor.js";
import { mineProcedures } from "../../extract/llm/procedure-miner.js";
import type { ChatRequest, ChatResponse, LlmProvider } from "../../llm/provider.js";
import { resolveProvider } from "../../llm/provider.js";

// Procedure-memory (SPEC §10.2, M3 gate). Uses a DETERMINISTIC stub provider
// (no network) so CI is hermetic. Verifies:
//   1. extraction precision — durable facts kept, secrets dropped (I3),
//      hallucinated evidence ids filtered, trust capped to low (I2).
//   2. procedure reuse — a mined procedure is descriptive-only with steps + a
//      verifier (D10: never auto-runnable).
export interface ProcedureMemoryReport {
  checks: number;
  passed: number;
  secretsLeaked: number; // want 0
  highTrustLlmFacts: number; // want 0 (LLM facts capped to low)
  hallucinatedEvidence: number; // want 0
  live?: LiveProcedureReport;
  detail: string[];
  pass: boolean;
}

export interface LiveProcedureReport {
  attempted: boolean;
  model: string;
  factsExtracted: number;
  schemaValidFacts: number;
  precision: number;
  recall: number;
  precisionFloor: number;
  recallFloor: number;
  secretsLeaked: number;
  highTrustLlmFacts: number;
  unavailableReason?: string;
  detail: string[];
  pass: boolean;
}

export interface ProcedureMemoryEvalOptions {
  live?: boolean;
  cwd?: string;
}

const scope: Scope = { user_id: "eval-user", workspace_id: "ws-eval", session_id: "s1" };

function ep(event_id: string, payload: unknown): Episode {
  return {
    event_id,
    session_id: "s1",
    workspace_id: "ws-eval",
    event_type: "tool_result",
    payload,
    created_at: "2026-01-01T00:00:00Z",
  };
}

const EPISODES: Episode[] = [
  ep("evt_1", { text: "decided to use vitest as the test runner" }),
  ep("evt_2", { text: "release flow: bump version, build, publish, tag" }),
  ep("evt_3", { text: "export DEPLOY_TOKEN=sk-SECRETSECRETSECRETSECRET0001" }),
];

const LIVE_EPISODES: Episode[] = [
  ep("evt_live_1", {
    text: "Please remember exactly this durable repo fact: the test runner is vitest.",
  }),
  ep("evt_live_2", {
    text: "A log mentioned DEPLOY_TOKEN=sk-ant-api03-SECRETSECRETSECRETSECRET0001; credentials must not be stored as memory.",
  }),
];

const LIVE_GOLD = [
  {
    label: "test_runner=vitest",
    matches: (f: { predicate: string; object: unknown; source: { raw_quote?: string } }): boolean =>
      factText(f).includes("vitest") &&
      (f.predicate.toLowerCase().includes("test") || factText(f).includes("test runner")),
  },
];

// Stub provider: returns canned JSON keyed by which prompt is in the system msg.
function stubProvider(): LlmProvider {
  return {
    id: "stub",
    available: true,
    async chat(req: ChatRequest): Promise<ChatResponse> {
      const sys = req.messages.find((m) => m.role === "system")?.content ?? "";
      if (sys.includes("fact extractor")) {
        return {
          text: JSON.stringify({
            facts: [
              {
                subject: "repo",
                predicate: "test_runner",
                object: "vitest",
                fact_kind: "decision",
                trust_tier: "high", // model claims high; extractor must CAP to low
                confidence: 0.8,
                evidence_ids: ["evt_1", "evt_999"], // evt_999 is hallucinated → filtered
                raw_quote: "decided to use vitest",
              },
              {
                subject: "repo",
                predicate: "deploy_token",
                object: "sk-SECRETSECRETSECRETSECRET0001", // secret → dropped (I3)
                fact_kind: "semantic",
                trust_tier: "low",
                confidence: 0.9,
                evidence_ids: ["evt_3"],
              },
            ],
          }),
        };
      }
      if (sys.includes("procedure miner")) {
        return {
          text: JSON.stringify({
            procedures: [
              {
                name: "cut a release",
                steps: [
                  { description: "bump version", command: "npm version patch" },
                  { description: "build", command: "npm run build" },
                  { description: "publish", command: "npm publish" },
                ],
                verifier: { command: "npm view . version", expected_exit_code: 0 },
                evidence_ids: ["evt_2"],
                confidence: 0.7,
              },
              {
                name: "deploy with token",
                steps: [{ description: "deploy", command: "npm run deploy" }],
                verifier: {
                  command: "curl -H 'Authorization: Bearer plainlowentropytoken123'",
                  expected_exit_code: 0,
                },
                evidence_ids: ["evt_2"],
                confidence: 0.9,
              },
            ],
          }),
        };
      }
      return { text: "" };
    },
    async embed(texts: string[]) {
      return texts.map(() => []);
    },
  };
}

export async function runProcedureMemoryEval(
  opts: ProcedureMemoryEvalOptions = {},
): Promise<ProcedureMemoryReport> {
  const detail: string[] = [];
  let passed = 0;
  let secretsLeaked = 0;
  let highTrustLlmFacts = 0;
  let hallucinatedEvidence = 0;
  const provider = stubProvider();

  const facts = await extractFactsFromEpisodes(EPISODES, { provider, scope });

  // (1) the secret fact must NOT appear.
  const secret = facts.find((f) => String(f.object).startsWith("sk-"));
  if (secret) secretsLeaked += 1;
  const c1 = !secret;
  if (c1) passed += 1;
  detail.push(`${c1 ? "✓" : "✗"} secret fact dropped (I3)`);

  // (2) the durable decision fact must appear, capped to low trust.
  const decision = facts.find((f) => f.predicate === "test_runner");
  const c2 = !!decision;
  if (c2) passed += 1;
  detail.push(`${c2 ? "✓" : "✗"} durable decision extracted (test_runner=vitest)`);

  if (decision && decision.trust_tier !== "low") highTrustLlmFacts += 1;
  const c3 = !!decision && decision.trust_tier === "low";
  if (c3) passed += 1;
  detail.push(`${c3 ? "✓" : "✗"} LLM fact trust capped to low (I2) — got ${decision?.trust_tier}`);

  // (3) hallucinated evidence id filtered out.
  if (decision?.source.event_ids.includes("evt_999")) hallucinatedEvidence += 1;
  const c4 =
    !!decision &&
    !decision.source.event_ids.includes("evt_999") &&
    decision.source.event_ids.includes("evt_1");
  if (c4) passed += 1;
  detail.push(`${c4 ? "✓" : "✗"} hallucinated evidence id filtered (kept evt_1, dropped evt_999)`);

  // (4) procedure mined: descriptive-only, multi-step, with a verifier.
  const procs = await mineProcedures(EPISODES, { provider, scope });
  const proc = procs.find((p) => p.name === "cut a release");
  const c5 = !!proc && proc.steps.length === 3 && !!proc.verifier?.command;
  if (c5) passed += 1;
  detail.push(`${c5 ? "✓" : "✗"} procedure mined with steps + verifier (descriptive-only, D10)`);

  // (5) procedure carries no executable auto-run flag — by type it can't, but we
  // assert the verifier expected exit code is captured for the human/agent.
  const c6 = !!proc && proc.verifier?.expected_exit_code === 0;
  if (c6) passed += 1;
  detail.push(`${c6 ? "✓" : "✗"} verifier expected exit code captured`);

  const secretVerifierDropped = !procs.some((p) => p.name === "deploy with token");
  if (secretVerifierDropped) passed += 1;
  detail.push(`${secretVerifierDropped ? "✓" : "✗"} secret verifier procedure dropped (I3)`);

  const checks = 7;
  const pass =
    passed === checks &&
    secretsLeaked === 0 &&
    highTrustLlmFacts === 0 &&
    hallucinatedEvidence === 0;
  const live = opts.live ? await runLiveProcedureEval(opts.cwd ?? process.cwd()) : undefined;
  return {
    checks,
    passed,
    secretsLeaked,
    highTrustLlmFacts,
    hallucinatedEvidence,
    live,
    detail,
    pass: pass && (live ? live.pass : true),
  };
}

async function runLiveProcedureEval(cwd: string): Promise<LiveProcedureReport> {
  const cfg = defaultConfig().llm;
  loadDotEnvKey(cwd, cfg.api_key_env);
  const provider = await resolveProvider({
    provider: cfg.provider,
    chatModel: cfg.chat_model,
    embedModel: cfg.embed_model,
    apiKeyEnv: cfg.api_key_env,
    baseUrl: cfg.base_url || undefined,
  });
  const detail: string[] = [];
  const precisionFloor = 0.8;
  const recallFloor = 0.8;
  if (!provider.available) {
    return {
      attempted: true,
      model: cfg.chat_model,
      factsExtracted: 0,
      schemaValidFacts: 0,
      precision: 0,
      recall: 0,
      precisionFloor,
      recallFloor,
      secretsLeaked: 0,
      highTrustLlmFacts: 0,
      unavailableReason: `${cfg.api_key_env} unavailable`,
      detail: [`live extraction skipped: ${cfg.api_key_env} unavailable`],
      pass: false,
    };
  }

  const facts = await extractFactsFromEpisodes(LIVE_EPISODES, { provider, scope });
  const factsExtracted = facts.length;
  const schemaValidFacts = facts.length;
  const secretsLeaked = facts.filter((f) => String(f.object).includes("sk-ant-")).length;
  const highTrustLlmFacts = facts.filter((f) => f.trust_tier === "high").length;
  const matched = new Set<string>();
  for (const f of facts) {
    for (const gold of LIVE_GOLD) {
      if (gold.matches(f)) matched.add(gold.label);
    }
  }
  const supportedFacts = facts.filter(
    (f) => f.source.event_ids.length > 0 && !String(f.object).includes("sk-ant-"),
  );
  const precision = factsExtracted === 0 ? 0 : supportedFacts.length / factsExtracted;
  const recall = matched.size / LIVE_GOLD.length;
  const pass =
    factsExtracted > 0 &&
    schemaValidFacts === factsExtracted &&
    precision >= precisionFloor &&
    recall >= recallFloor &&
    secretsLeaked === 0 &&
    highTrustLlmFacts === 0;

  detail.push(`live extraction: ${factsExtracted} facts (${cfg.chat_model})`);
  detail.push(
    `precision: ${Math.round(precision * 100)}%  recall: ${Math.round(recall * 100)}%  floor: ${Math.round(precisionFloor * 100)}%`,
  );
  detail.push(`high-trust LLM facts: ${highTrustLlmFacts}  secrets leaked: ${secretsLeaked}`);
  return {
    attempted: true,
    model: cfg.chat_model,
    factsExtracted,
    schemaValidFacts,
    precision,
    recall,
    precisionFloor,
    recallFloor,
    secretsLeaked,
    highTrustLlmFacts,
    detail,
    pass,
  };
}

function factText(f: {
  predicate: string;
  object: unknown;
  source: { raw_quote?: string };
}): string {
  return `${f.predicate} ${String(f.object)} ${f.source.raw_quote ?? ""}`.toLowerCase();
}

function loadDotEnvKey(cwd: string, key: string): void {
  if (process.env[key]) return;
  const path = join(cwd, ".env");
  if (!existsSync(path)) return;
  const text = readFileSync(path, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const name = trimmed.slice(0, eq).trim();
    if (name !== key) continue;
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (value) process.env[key] = value;
    return;
  }
}

export function formatProcedureMemoryReport(r: ProcedureMemoryReport): string {
  const lines: string[] = [];
  lines.push("");
  lines.push("graphCTX eval — procedure-memory / LLM extraction (M3)");
  lines.push("=".repeat(72));
  lines.push("");
  for (const d of r.detail) lines.push(`  ${d}`);
  lines.push("");
  lines.push(
    `  checks: ${r.passed}/${r.checks}   secrets leaked: ${r.secretsLeaked}   high-trust LLM facts: ${r.highTrustLlmFacts}   hallucinated evidence: ${r.hallucinatedEvidence}`,
  );
  if (r.live) {
    lines.push("");
    lines.push("  Live Anthropic extraction (opt-in)");
    for (const d of r.live.detail) lines.push(`  ${d}`);
    if (r.live.unavailableReason) lines.push(`  unavailable: ${r.live.unavailableReason}`);
    lines.push(`  VERDICT: ${r.live.pass ? "✅ live extraction PASS" : "❌ live extraction FAIL"}`);
  }
  lines.push(
    r.pass
      ? "  VERDICT: ✅ LLM extraction safe + precise; procedures descriptive-only."
      : "  VERDICT: ❌ procedure-memory FAIL.",
  );
  lines.push("");
  return `${lines.join("\n")}\n`;
}
