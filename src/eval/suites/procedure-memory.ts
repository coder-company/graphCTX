import type { Episode, Scope } from "../../core/types.js";
import { extractFactsFromEpisodes } from "../../extract/llm/fact-extractor.js";
import { mineProcedures } from "../../extract/llm/procedure-miner.js";
import type { ChatRequest, ChatResponse, LlmProvider } from "../../llm/provider.js";

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
  detail: string[];
  pass: boolean;
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

export async function runProcedureMemoryEval(): Promise<ProcedureMemoryReport> {
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

  const checks = 6;
  const pass =
    passed === checks &&
    secretsLeaked === 0 &&
    highTrustLlmFacts === 0 &&
    hallucinatedEvidence === 0;
  return { checks, passed, secretsLeaked, highTrustLlmFacts, hallucinatedEvidence, detail, pass };
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
  lines.push(
    r.pass
      ? "  VERDICT: ✅ LLM extraction safe + precise; procedures descriptive-only."
      : "  VERDICT: ❌ procedure-memory FAIL.",
  );
  lines.push("");
  return `${lines.join("\n")}\n`;
}
