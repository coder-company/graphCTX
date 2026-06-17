import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fixedClock } from "../../core/clock.js";
import type { NewFact } from "../../core/types.js";
import { formatWhy, why } from "../../provenance/why.js";
import { type DB, openDb } from "../../store/db.js";
import { EdgesRepo } from "../../store/edges.repo.js";
import { EpisodesRepo } from "../../store/episodes.repo.js";
import { FactsRepo } from "../../store/facts.repo.js";
import { PromotionsRepo } from "../../store/promotions.repo.js";

export interface ProvenanceWhyReport {
  checks: number;
  passed: number;
  detail: string[];
  cliFailures: number;
  completeChains: number;
  incompleteChains: number;
  pass: boolean;
}

interface CliResult {
  status: number;
  stdout: string;
  stderr: string;
}

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const cliPath = join(repoRoot, "src", "cli.ts");
const tsxBin = join(
  repoRoot,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "tsx.cmd" : "tsx",
);
const fixtureRepo = join(repoRoot, "fixtures", "repo-pnpm-web");
const clock = fixedClock("2026-01-01T00:00:00.000Z");

export function runProvenanceWhyEval(): ProvenanceWhyReport {
  const detail: string[] = [];
  let passed = 0;
  let cliFailures = 0;
  let completeChains = 0;
  let incompleteChains = 0;

  const check = (name: string, ok: boolean, note?: string) => {
    if (ok) passed += 1;
    detail.push(`${ok ? "✓" : "✗"} ${name}${note ? ` — ${note}` : ""}`);
  };

  const cliCase = withFixtureRepo((dir) => {
    const extract = cli(["extract", "-C", dir]);
    const suffix = extract.stdout.match(/mem:([A-Z0-9]+)/)?.[1] ?? "";
    const fullId = suffix ? findFactIdBySuffix(join(dir, ".graphctx", "workspace.db"), suffix) : "";
    const suffixWhy = suffix
      ? cli(["why", suffix, "-C", dir])
      : { status: 1, stdout: "", stderr: "" };
    const fullWhy = fullId
      ? cli(["why", fullId, "-C", dir])
      : { status: 1, stdout: "", stderr: "" };
    const missing = cli(["why", "ZZZZZZZZ", "-C", dir]);
    return { extract, suffix, fullId, suffixWhy, fullWhy, missing };
  });

  if (
    cliCase.extract.status !== 0 ||
    cliCase.suffixWhy.status !== 0 ||
    cliCase.fullWhy.status !== 0
  ) {
    cliFailures += 1;
  }
  const deterministicOk =
    cliCase.extract.status === 0 &&
    cliCase.suffixWhy.status === 0 &&
    cliCase.suffixWhy.stdout.includes(`why [mem:${cliCase.suffix}]`) &&
    cliCase.suffixWhy.stdout.includes("asserted by:   deterministic_parser") &&
    cliCase.suffixWhy.stdout.includes("provenance chain: ✅ complete");
  if (deterministicOk) completeChains += 1;
  check(
    "why resolves a deterministic extracted fact's full chain",
    deterministicOk,
    compactWhy(cliCase.suffixWhy.stdout),
  );
  check(
    "why accepts the last-8 [mem:id] suffix and matches the full id report",
    cliCase.suffix.length === 8 &&
      cliCase.fullId.endsWith(cliCase.suffix) &&
      cliCase.suffixWhy.status === 0 &&
      cliCase.fullWhy.status === 0 &&
      cliCase.suffixWhy.stdout === cliCase.fullWhy.stdout,
    `suffix=${cliCase.suffix}`,
  );
  check(
    "why on an unknown id fails soft with clean exit 1",
    cliCase.missing.status === 1 &&
      cliCase.missing.stdout.includes('no fact found for "ZZZZZZZZ"') &&
      !/Error|stack|Trace/i.test(cliCase.missing.stdout + cliCase.missing.stderr),
    `status=${cliCase.missing.status} stdout=${JSON.stringify(cliCase.missing.stdout.trim())}`,
  );

  const storeCase = withTempDb((db) => evaluateStoreProvenance(db));
  if (storeCase.cleanComplete) completeChains += 1;
  if (storeCase.danglingIncomplete) incompleteChains += 1;
  check(
    "completeness distinguishes clean vs missing-evidence chains",
    storeCase.cleanComplete && storeCase.danglingIncomplete,
    `clean=${storeCase.cleanVerdict} dangling=${storeCase.danglingVerdict}`,
  );
  check(
    "why renders git anchor, promotions, and edges when present",
    storeCase.surfaceOk,
    compactWhy(storeCase.surfaceText),
  );
  check(
    "why renders observed and recorded times as distinct temporal provenance",
    storeCase.observedOk,
    storeCase.observedText,
  );

  const checks = detail.length;
  const pass =
    passed === checks && cliFailures === 0 && completeChains >= 2 && incompleteChains >= 1;
  return { checks, passed, detail, cliFailures, completeChains, incompleteChains, pass };
}

export function formatProvenanceWhyReport(r: ProvenanceWhyReport): string {
  const lines: string[] = [];
  lines.push("");
  lines.push("graphCTX eval - provenance why");
  lines.push("=".repeat(72));
  lines.push("");
  for (const d of r.detail) lines.push(`  ${d}`);
  lines.push("");
  lines.push(
    `  checks: ${r.passed}/${r.checks}   cli failures: ${r.cliFailures}   complete chains: ${r.completeChains}   incomplete chains: ${r.incompleteChains}`,
  );
  lines.push(
    r.pass
      ? "  VERDICT: ✅ PROVENANCE PASS - why() explains complete, incomplete, and surfaced chains."
      : "  VERDICT: ❌ PROVENANCE FAIL.",
  );
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function evaluateStoreProvenance(db: DB): {
  cleanComplete: boolean;
  danglingIncomplete: boolean;
  surfaceOk: boolean;
  observedOk: boolean;
  cleanVerdict: string;
  danglingVerdict: string;
  surfaceText: string;
  observedText: string;
} {
  const facts = new FactsRepo(db, clock);
  const episodes = new EpisodesRepo(db, clock);
  const edges = new EdgesRepo(db, clock);
  const promotions = new PromotionsRepo(db, clock);
  const deps = { facts, episodes, edges, promotions };

  const event = episodes.append({
    session_id: "s-provenance",
    workspace_id: "ws-provenance",
    event_type: "user_correction",
    payload: { note: "use pnpm test" },
  });
  const clean = facts.insert(
    fact({
      object: "pnpm test",
      source: {
        asserted_by: "user",
        event_ids: [event.event_id],
        raw_quote: "use pnpm test",
      },
      observed_at: "2025-12-31T23:58:00.000Z",
      git: {
        branch: "main",
        valid_from_commit: "aaaaaaaa11111111",
        introduced_by_commit: "aaaaaaaa11111111",
      },
    }),
  );
  const replacement = facts.insert(fact({ object: "vitest run" }));
  edges.add(clean.fact_id, "SUPERSEDES", replacement.fact_id, clean.fact_id);
  promotions.record({
    fact_id: clean.fact_id,
    from_state: "session_only",
    to_state: "workspace_active",
    decision: "promote",
    gate: "user_explicit",
    reason: "user correction cited",
  });

  const dangling = facts.insert(
    fact({
      object: "npm test",
      source: {
        asserted_by: "user",
        event_ids: ["evt_missing"],
        raw_quote: "old test command",
      },
    }),
  );

  const cleanReport = why(clean.fact_id, deps)!;
  const danglingReport = why(dangling.fact_id, deps)!;
  const cleanText = formatWhy(cleanReport);
  const danglingText = formatWhy(danglingReport);
  const observedLine = lineContaining(cleanText, "observed:");
  return {
    cleanComplete: cleanReport.complete && cleanText.includes("provenance chain: ✅ complete"),
    danglingIncomplete:
      !danglingReport.complete &&
      danglingReport.missing_evidence_ids.length === 1 &&
      danglingText.includes("provenance chain: ⚠ incomplete (missing evidence)"),
    surfaceOk:
      cleanText.includes("git anchor:") &&
      cleanText.includes("promotions:") &&
      cleanText.includes("edges:") &&
      cleanText.includes("gate=user_explicit") &&
      cleanText.includes("SUPERSEDES"),
    observedOk:
      observedLine.includes("2025-12-31T23:58:00.000Z") &&
      observedLine.includes("recorded=2026-01-01T00:00:00.000Z"),
    cleanVerdict: verdictLine(cleanText),
    danglingVerdict: verdictLine(danglingText),
    surfaceText: cleanText,
    observedText: observedLine,
  };
}

function fact(over: Partial<NewFact>): NewFact {
  return {
    subject: "repo",
    predicate: "test_command",
    object: "npm test",
    fact_kind: "procedural",
    temporal_kind: "static",
    scope: { user_id: "provenance-user", workspace_id: "ws-provenance" },
    trust_tier: "high",
    status: "active",
    promotion_state: "workspace_active",
    source: { asserted_by: "deterministic_parser", event_ids: [] },
    tags: ["provenance_eval"],
    ...over,
  };
}

function cli(args: string[], input?: string): CliResult {
  try {
    const stdout = execFileSync(tsxBin, [cliPath, ...args], {
      cwd: repoRoot,
      env: { ...process.env, GRAPHCTX_USER_ID: "provenance-eval" },
      input,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 30000,
    });
    return { status: 0, stdout, stderr: "" };
  } catch (e) {
    const err = e as { status?: number; stdout?: string | Buffer; stderr?: string | Buffer };
    return {
      status: err.status ?? 1,
      stdout: String(err.stdout ?? ""),
      stderr: String(err.stderr ?? ""),
    };
  }
}

function findFactIdBySuffix(dbPath: string, suffix: string): string {
  const db = openDb(dbPath);
  try {
    const row = db
      .prepare("SELECT fact_id FROM facts WHERE fact_id LIKE ? LIMIT 1")
      .get(`%${suffix}`) as { fact_id: string } | undefined;
    return row?.fact_id ?? "";
  } finally {
    db.close();
  }
}

function withFixtureRepo<T>(fn: (dir: string) => T): T {
  return withTempDir((dir) => {
    const work = join(dir, "repo");
    cpSync(fixtureRepo, work, { recursive: true });
    return fn(work);
  });
}

function withTempDb<T>(fn: (db: DB) => T): T {
  return withTempDir((dir) => {
    const db = openDb(join(dir, "provenance.db"));
    try {
      return fn(db);
    } finally {
      db.close();
    }
  });
}

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "graphctx-provenance-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function compactWhy(out: string): string {
  const lines = out
    .split("\n")
    .map((l) => l.trim())
    .filter(
      (l) =>
        l.startsWith("why [mem:") ||
        l.includes("asserted by") ||
        l.includes("git anchor") ||
        l.includes("promotions") ||
        l.includes("edges") ||
        l.includes("provenance chain"),
    );
  return lines.join(" | ");
}

function verdictLine(out: string): string {
  return (
    out
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.startsWith("provenance chain:")) ?? ""
  );
}

function lineContaining(out: string, needle: string): string {
  return (
    out
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.includes(needle)) ?? ""
  );
}
