import { cpSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Runtime } from "../../runtime.js";
import { containsSecret } from "../../security/secrets.js";

const here = dirname(fileURLToPath(import.meta.url));

// Phase-2 (M2) gate suite. Measures the relevance gate + injection-loop quality:
//   1. PreToolUse fires SELECTIVELY (not on every tool call).
//   2. harmful-injection rate (secrets / scanner-tripping cards reaching a
//      capsule) is ZERO.
//   3. anti-repetition suppresses cross-channel duplicate cards in a session.
export interface DriftGateReport {
  repos: number;
  preToolCalls: number;
  preToolFired: number;
  preToolFireRate: number; // want < 1.0 (selective)
  capsules: number;
  cardsInjected: number;
  harmfulInjections: number; // want 0
  harmfulRate: number;
  duplicateCards: number; // cross-channel repeats that slipped through (want 0)
  pass: boolean;
  detail: string[];
}

const HARMFUL_RATE_TARGET = 0.02; // < 2% harmful-injection rate (we expect 0)

// A scripted PreToolUse sequence: a mix of memory-relevant and irrelevant calls.
// A good gate fires on the relevant ones and stays quiet on the rest.
const TOOL_SEQUENCE: Array<{ name: string; args?: unknown; relevant: boolean }> = [
  { name: "Bash", args: { command: "npm test" }, relevant: true },
  { name: "WebSearch", args: { query: "how to center a div" }, relevant: false },
  { name: "Read", args: { file_path: "README.md" }, relevant: false },
  { name: "Edit", args: { file_path: "src/index.ts" }, relevant: true },
  { name: "WebFetch", args: { url: "https://example.com" }, relevant: false },
  { name: "Bash", args: { command: "npm run build" }, relevant: true },
  { name: "Bash", relevant: false }, // no concrete args → not actionable
];

export async function runDriftGateEval(baseDir?: string): Promise<DriftGateReport> {
  const fixturesDir = locateFixtures(baseDir);
  const repoDirs = readdirSync(fixturesDir)
    .map((e) => join(fixturesDir, e))
    .filter((d) => {
      try {
        return readdirSync(d).includes("scenario.json");
      } catch {
        return false;
      }
    })
    .sort();

  const report: DriftGateReport = {
    repos: 0,
    preToolCalls: 0,
    preToolFired: 0,
    preToolFireRate: 0,
    capsules: 0,
    cardsInjected: 0,
    harmfulInjections: 0,
    harmfulRate: 0,
    duplicateCards: 0,
    pass: false,
    detail: [],
  };

  for (const repoDir of repoDirs) {
    const tmp = mkdtempSync(join(tmpdir(), "graphctx-drift-"));
    try {
      cpSync(repoDir, tmp, { recursive: true });
      rmSync(join(tmp, ".graphctx"), { recursive: true, force: true });
      const rt = new Runtime({ workspaceDir: tmp, userId: "eval-user" });
      await rt.extract();
      report.repos += 1;

      // Seed a secret-bearing fact (forced active) so only the inject-time guard
      // can stop it — this is the harmful-injection probe.
      rt.facts.insert({
        subject: "repo",
        predicate: "deploy_token",
        object: "sk-SECRETSECRETSECRETSECRET0001",
        fact_kind: "procedural",
        temporal_kind: "static",
        scope: { user_id: "eval-user", workspace_id: rt.workspaceId },
        trust_tier: "high",
        status: "active",
        promotion_state: "workspace_active",
        sensitivity: "secret",
        source: { asserted_by: "user", event_ids: [] },
      });

      const session = "drift-s1";

      // --- (1) PreToolUse selectivity ---
      for (const tool of TOOL_SEQUENCE) {
        report.preToolCalls += 1;
        const ctx = await rt.injectionContext("PreToolUse", session, {
          planned_tool: { name: tool.name, args: tool.args },
          user_prompt: "continue the task",
        });
        const capsule = await rt.planner().plan(ctx);
        const fired = capsule.markdown.length > 0;
        if (fired) {
          report.preToolFired += 1;
          report.capsules += 1;
          report.cardsInjected += capsule.cards.length;
          report.harmfulInjections += countHarmful(capsule.markdown);
        }
      }

      // --- (3) cross-channel anti-repetition: a PostCompact then an immediate
      // re-injection (simulating a second channel) must not repeat cards. ---
      const c1 = await rt
        .planner()
        .plan(await rt.injectionContext("PostCompact", session, { user_prompt: "recover" }));
      const c2 = await rt
        .planner()
        .plan(await rt.injectionContext("PostCompact", session, { user_prompt: "recover" }));
      report.capsules += 2;
      report.cardsInjected += c1.cards.length + c2.cards.length;
      report.harmfulInjections += countHarmful(c1.markdown) + countHarmful(c2.markdown);
      // Cards in c2 that are NOT open loops but were already in c1 = leaks.
      const c1Ids = new Set(c1.cards.map((c) => c.fact_id));
      for (const card of c2.cards) {
        const f = rt.facts.get(card.fact_id);
        if (f?.fact_kind === "open_loop") continue; // exempt by design
        if (c1Ids.has(card.fact_id)) report.duplicateCards += 1;
      }

      rt.close();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  report.preToolFireRate = report.preToolCalls > 0 ? report.preToolFired / report.preToolCalls : 0;
  report.harmfulRate =
    report.cardsInjected > 0 ? report.harmfulInjections / report.cardsInjected : 0;
  report.pass =
    report.harmfulInjections === 0 &&
    report.harmfulRate <= HARMFUL_RATE_TARGET &&
    report.preToolFireRate < 1 && // selective: did not fire on every tool call
    report.duplicateCards === 0;

  report.detail.push(
    `PreToolUse fired on ${report.preToolFired}/${report.preToolCalls} calls (rate ${pct(report.preToolFireRate)}) — selective`,
  );
  report.detail.push(
    `harmful injections: ${report.harmfulInjections}/${report.cardsInjected} cards (rate ${pct(report.harmfulRate)})`,
  );
  report.detail.push(`cross-channel duplicate cards: ${report.duplicateCards}`);
  return report;
}

// A harmful card = one whose rendered text carries a secret/credential.
function countHarmful(markdown: string): number {
  let count = 0;
  for (const line of markdown.split("\n")) {
    if (line.trim().startsWith("-") && containsSecret(line)) count += 1;
  }
  return count;
}

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

export function formatDriftGateReport(r: DriftGateReport): string {
  const lines: string[] = [];
  lines.push("");
  lines.push("graphCTX eval — drift/gate + injection quality (M2 GATE)");
  lines.push("=".repeat(72));
  lines.push("");
  for (const d of r.detail) lines.push(`  ${d}`);
  lines.push("");
  lines.push("-".repeat(72));
  lines.push(`  repos:                  ${r.repos}`);
  lines.push(`  PreToolUse fire-rate:   ${pct(r.preToolFireRate)}  (must be < 100% — selective)`);
  lines.push(`  harmful injections:     ${r.harmfulInjections}  (must be 0)`);
  lines.push(
    `  harmful rate:           ${pct(r.harmfulRate)}  (target < ${pct(HARMFUL_RATE_TARGET)})`,
  );
  lines.push(`  cross-channel dupes:    ${r.duplicateCards}  (must be 0)`);
  lines.push("");
  lines.push(
    r.pass
      ? "  VERDICT: ✅ M2 GATE PASS — selective gate, zero harmful injections, no cross-channel dupes."
      : "  VERDICT: ❌ M2 GATE FAIL.",
  );
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function locateFixtures(baseDir?: string): string {
  const candidates = [
    baseDir ? join(baseDir, "fixtures") : null,
    join(here, "..", "..", "..", "fixtures"),
    join(process.cwd(), "fixtures"),
  ].filter(Boolean) as string[];
  for (const c of candidates) {
    try {
      readdirSync(c);
      return c;
    } catch {
      // try next
    }
  }
  throw new Error(`fixtures/ not found (looked in: ${candidates.join(", ")})`);
}
