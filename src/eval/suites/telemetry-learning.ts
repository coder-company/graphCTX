import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixedClock } from "../../core/clock.js";
import type { Fact, FactKind, ScoredFact } from "../../core/types.js";
import { Ledger } from "../../inject/ledger.js";
import { type DB, openDb } from "../../store/db.js";
import { InjectionsRepo } from "../../store/injections.repo.js";
import {
  type OutcomeClass,
  OutcomeRecorder,
  type OutcomeSignal,
  classifyOutcome,
  rerankWithOutcomeLearning,
} from "../../telemetry/outcomes.js";

export interface TelemetryLearningReport {
  checks: number;
  passed: number;
  detail: string[];
  classificationAccuracy: number;
  classificationThreshold: number;
  baselineMetric: number;
  learnedMetric: number;
  networkCalls: number;
  pass: boolean;
}

const clock = fixedClock("2026-01-01T00:00:00.000Z");
const CLASSIFICATION_THRESHOLD = 0.9;

const LABELED_CASES: Array<{ label: string; signal: OutcomeSignal; expected: OutcomeClass }> = [
  { label: "repeated failure", signal: { repeatedFailure: true }, expected: "harmful" },
  {
    label: "harmful beats downstream success",
    signal: { repeatedFailure: true, followedBySuccess: true },
    expected: "harmful",
  },
  {
    label: "harmful beats reference",
    signal: { repeatedFailure: true, referencedInjectedFact: true },
    expected: "harmful",
  },
  { label: "success", signal: { followedBySuccess: true }, expected: "helped" },
  { label: "reference", signal: { referencedInjectedFact: true }, expected: "helped" },
  {
    label: "helped beats no-effect",
    signal: { followedBySuccess: true, noEffect: true },
    expected: "helped",
  },
  { label: "no effect", signal: { noEffect: true }, expected: "ignored" },
  { label: "empty", signal: {}, expected: "unknown" },
  { label: "all false", signal: { repeatedFailure: false, noEffect: false }, expected: "unknown" },
  {
    label: "reference plus success",
    signal: { referencedInjectedFact: true, followedBySuccess: true },
    expected: "helped",
  },
];

export function runTelemetryLearningEval(): TelemetryLearningReport {
  const detail: string[] = [];
  let passed = 0;
  let classificationAccuracy = 0;
  let baselineMetric = 0;
  let learnedMetric = 0;
  let networkCalls = 0;

  const check = (name: string, ok: boolean, note?: string) => {
    if (ok) passed += 1;
    detail.push(`${ok ? "✓" : "✗"} ${name}${note ? ` — ${note}` : ""}`);
  };

  const classification = scoreClassification();
  classificationAccuracy = classification.accuracy;
  check(
    `classification accuracy: ${fmt(classificationAccuracy)} (threshold ${fmt(
      CLASSIFICATION_THRESHOLD,
    )}) → ${classificationAccuracy >= CLASSIFICATION_THRESHOLD ? "PASS" : "FAIL"}`,
    classificationAccuracy >= CLASSIFICATION_THRESHOLD,
    `${classification.correct}/${classification.total}`,
  );
  check(
    "classification precedence: harmful wins when harmful+helped signals present",
    classifyOutcome({
      repeatedFailure: true,
      followedBySuccess: true,
      referencedInjectedFact: true,
    }) === "harmful",
  );

  const localOnly = withTempDb((db) => evaluateLocalOnlyRecording(db));
  networkCalls = localOnly.networkCalls;
  check(
    `telemetry local-only: ${localOnly.networkCalls} network calls, recorded=${localOnly.recorded}, disabled-write=${localOnly.disabledWrite}`,
    localOnly.ok,
  );
  const signalStorage = withTempDb((db) => evaluateSignalStorageSanitization(db));
  check(
    `telemetry signal storage: persisted keys=${signalStorage.persistedKeys.join(",") || "(none)"}, secret leaked=${signalStorage.secretLeaked}`,
    signalStorage.ok,
  );

  const failSoft = withTempDb((db) => evaluateFailSoft(db));
  check("telemetry fail-soft: record survived missing table (no throw)", failSoft);

  const summary = withTempDb((db) => evaluateSummary(db));
  check(
    `outcome summary: helped=${summary.helped} ignored=${summary.ignored} harmful=${summary.harmful} unknown=${summary.unknown} (matches seeded)`,
    summary.ok,
  );

  const ranking = withTempDb((db) => evaluateLearnedRanking(db));
  baselineMetric = ranking.baseline;
  learnedMetric = ranking.learned;
  check(
    `learned vs baseline: ${fmt(learnedMetric)} > ${fmt(baselineMetric)} (lift +${fmt(
      learnedMetric - baselineMetric,
    )}) → ${learnedMetric > baselineMetric ? "PASS" : "FAIL"}`,
    learnedMetric > baselineMetric,
  );

  const ledger = withTempDb((db) => evaluateLedger(db));
  check("ledger: cross-channel duplicate suppressed within TTL", ledger.duplicateSuppressed);
  check("ledger: open_loop exempt (resurfaces)", ledger.openLoopResurfaces);

  const checks = detail.length;
  const pass =
    passed === checks &&
    classificationAccuracy >= CLASSIFICATION_THRESHOLD &&
    learnedMetric > baselineMetric &&
    networkCalls === 0;
  return {
    checks,
    passed,
    detail,
    classificationAccuracy,
    classificationThreshold: CLASSIFICATION_THRESHOLD,
    baselineMetric,
    learnedMetric,
    networkCalls,
    pass,
  };
}

export function formatTelemetryLearningReport(r: TelemetryLearningReport): string {
  const lines: string[] = [];
  lines.push("");
  lines.push("graphCTX eval - telemetry learning");
  lines.push("=".repeat(72));
  lines.push("");
  for (const d of r.detail) lines.push(`  ${d}`);
  lines.push("");
  lines.push(
    `  checks: ${r.passed}/${r.checks}   accuracy: ${fmt(
      r.classificationAccuracy,
    )}   learned lift: +${fmt(r.learnedMetric - r.baselineMetric)}`,
  );
  lines.push(
    r.pass
      ? "  VERDICT: ✅ TELEMETRY PASS - local outcome learning, summaries, and ledger idempotency hold."
      : "  VERDICT: ❌ TELEMETRY FAIL.",
  );
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function scoreClassification(): { correct: number; total: number; accuracy: number } {
  let correct = 0;
  for (const c of LABELED_CASES) {
    if (classifyOutcome(c.signal) === c.expected) correct += 1;
  }
  return {
    correct,
    total: LABELED_CASES.length,
    accuracy: correct / LABELED_CASES.length,
  };
}

function evaluateLocalOnlyRecording(db: DB): {
  ok: boolean;
  networkCalls: number;
  recorded: number;
  disabledWrite: number;
} {
  const repo = new InjectionsRepo(db, clock);
  const enabledId = repo.log({
    session_id: "s-local",
    event_type: "UserPromptSubmit",
    selected_fact_ids: ["fact_helped"],
    token_count: 12,
  });
  const disabledId = repo.log({
    session_id: "s-local",
    event_type: "PreToolUse",
    selected_fact_ids: ["fact_disabled"],
    token_count: 8,
  });

  let networkCalls = 0;
  withNetworkTrap(
    () => {
      new OutcomeRecorder(db).record(enabledId, { followedBySuccess: true });
      new OutcomeRecorder(db, { enabled: false }).record(disabledId, { repeatedFailure: true });
    },
    () => {
      networkCalls += 1;
    },
  );

  const recorded = countWhere(db, "outcome_json IS NOT NULL AND injection_id = ?", enabledId);
  const disabledWrite = countWhere(db, "outcome_json IS NOT NULL AND injection_id = ?", disabledId);
  return {
    ok: networkCalls === 0 && recorded === 1 && disabledWrite === 0,
    networkCalls,
    recorded,
    disabledWrite,
  };
}

function evaluateSignalStorageSanitization(db: DB): {
  ok: boolean;
  persistedKeys: string[];
  secretLeaked: boolean;
} {
  const repo = new InjectionsRepo(db, clock);
  const id = repo.log({
    session_id: "s-sanitize",
    event_type: "PostToolUse",
    selected_fact_ids: ["fact_signal"],
    token_count: 6,
  });
  const secret = "ghp_FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE";
  const wideSignal = {
    followedBySuccess: true,
    repeatedFailure: false,
    token: secret,
    command: `curl -H 'Authorization: Bearer ${secret}' https://example.invalid`,
    nested: { api_key: secret },
  } as OutcomeSignal & Record<string, unknown>;

  new OutcomeRecorder(db).record(id, wideSignal);
  const row = db.prepare("SELECT outcome_json FROM injections WHERE injection_id = ?").get(id) as {
    outcome_json: string;
  };
  const parsed = JSON.parse(row.outcome_json) as {
    outcome?: string;
    signals?: Record<string, unknown>;
  };
  const persistedKeys = Object.keys(parsed.signals ?? {}).sort();
  const secretLeaked =
    row.outcome_json.includes(secret) ||
    row.outcome_json.includes("Authorization") ||
    row.outcome_json.includes("api_key") ||
    row.outcome_json.includes("command");
  return {
    ok:
      parsed.outcome === "helped" &&
      persistedKeys.length === 1 &&
      persistedKeys[0] === "followedBySuccess" &&
      parsed.signals?.followedBySuccess === true &&
      !secretLeaked,
    persistedKeys,
    secretLeaked,
  };
}

function evaluateFailSoft(db: DB): boolean {
  db.exec("DROP TABLE injections");
  try {
    const outcome = new OutcomeRecorder(db).record("missing", { repeatedFailure: true });
    const summary = new OutcomeRecorder(db).summary();
    return (
      outcome === "harmful" &&
      summary.helped === 0 &&
      summary.ignored === 0 &&
      summary.harmful === 0 &&
      summary.unknown === 0
    );
  } catch {
    return false;
  }
}

function evaluateSummary(db: DB): {
  helped: number;
  ignored: number;
  harmful: number;
  unknown: number;
  ok: boolean;
} {
  insertOutcome(db, "inj_helped", ["f_helped"], "helped");
  insertOutcome(db, "inj_ignored", ["f_ignored"], "ignored");
  insertOutcome(db, "inj_harmful", ["f_harmful"], "harmful");
  insertOutcome(db, "inj_unknown", ["f_unknown"], "unknown");
  db.prepare(
    `INSERT INTO injections (
      injection_id, session_id, event_type, selected_fact_ids_json,
      rejected_fact_ids_json, token_count, predicted_utility, git_head, outcome_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "inj_malformed",
    "s-summary",
    "PostToolUse",
    JSON.stringify(["f_bad"]),
    null,
    1,
    null,
    null,
    "{bad-json",
    clock.iso(),
  );
  const counts = new OutcomeRecorder(db).summary();
  return {
    ...counts,
    ok: counts.helped === 1 && counts.ignored === 1 && counts.harmful === 1 && counts.unknown === 1,
  };
}

function evaluateLearnedRanking(db: DB): { baseline: number; learned: number } {
  insertOutcome(db, "inj_rank_helped_a", ["fact_helped_a"], "helped");
  insertOutcome(db, "inj_rank_helped_b", ["fact_helped_b"], "helped");
  insertOutcome(db, "inj_rank_harmful", ["fact_harmful"], "harmful");
  insertOutcome(db, "inj_rank_ignored", ["fact_ignored"], "ignored");
  insertOutcome(db, "inj_rank_bad_ids", ["fact_noise"], "helped", "{bad-json");

  const baseline: ScoredFact[] = [
    { fact: makeFact("fact_harmful", "semantic"), score: 0.9 },
    { fact: makeFact("fact_ignored", "semantic"), score: 0.8 },
    { fact: makeFact("fact_helped_a", "semantic"), score: 0.7 },
    { fact: makeFact("fact_helped_b", "semantic"), score: 0.6 },
  ];
  const learned = rerankWithOutcomeLearning(baseline, db);
  return {
    baseline: pairwisePreferenceAccuracy(baseline),
    learned: pairwisePreferenceAccuracy(learned),
  };
}

function evaluateLedger(db: DB): { duplicateSuppressed: boolean; openLoopResurfaces: boolean } {
  const normal: ScoredFact = { fact: makeFact("fact_repeat", "semantic"), score: 1 };
  const openLoop: ScoredFact = { fact: makeFact("fact_open", "open_loop"), score: 0.9 };
  const hookLedger = new Ledger(db);
  hookLedger.record("s-ledger", [normal, openLoop], "UserPromptSubmit");

  const mcpLedger = new Ledger(db);
  const kept = mcpLedger.removeRecentlyInjected([normal, openLoop], "s-ledger");
  return {
    duplicateSuppressed: !kept.some((s) => s.fact.fact_id === normal.fact.fact_id),
    openLoopResurfaces: kept.some((s) => s.fact.fact_id === openLoop.fact.fact_id),
  };
}

function insertOutcome(
  db: DB,
  id: string,
  factIds: string[],
  outcome: OutcomeClass,
  selectedJson = JSON.stringify(factIds),
): void {
  db.prepare(
    `INSERT INTO injections (
      injection_id, session_id, event_type, selected_fact_ids_json,
      rejected_fact_ids_json, token_count, predicted_utility, git_head, outcome_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    "s-outcome",
    "PostToolUse",
    selectedJson,
    null,
    1,
    null,
    null,
    JSON.stringify({ outcome, signals: {}, at: clock.iso() }),
    clock.iso(),
  );
}

function pairwisePreferenceAccuracy(scored: ScoredFact[]): number {
  const rank = new Map(scored.map((s, i) => [s.fact.fact_id, i]));
  const preferred = ["fact_helped_a", "fact_helped_b"];
  const dispreferred = ["fact_harmful", "fact_ignored"];
  let correct = 0;
  let total = 0;
  for (const p of preferred) {
    for (const d of dispreferred) {
      total += 1;
      if ((rank.get(p) ?? Number.POSITIVE_INFINITY) < (rank.get(d) ?? Number.POSITIVE_INFINITY)) {
        correct += 1;
      }
    }
  }
  return correct / total;
}

function makeFact(id: string, kind: FactKind): Fact {
  return {
    fact_id: id,
    subject: "repo",
    predicate: id,
    object: id,
    fact_kind: kind,
    temporal_kind: "static",
    scope: { user_id: "telemetry-user", workspace_id: "telemetry-ws" },
    status: "active",
    promotion_state: "workspace_active",
    trust_tier: "high",
    sensitivity: "public",
    confidence: 0.8,
    evidence_count: 1,
    contradiction_count: 0,
    injection_count: 0,
    time: { t_observed: clock.iso(), t_created: clock.iso(), t_recorded: clock.iso() },
    source: { asserted_by: "user", event_ids: [], raw_quote: id },
    tags: ["telemetry_eval"],
  };
}

function countWhere(db: DB, where: string, ...params: unknown[]): number {
  const row = db.prepare(`SELECT count(*) AS n FROM injections WHERE ${where}`).get(...params) as {
    n: number;
  };
  return row.n;
}

function withTempDb<T>(fn: (db: DB) => T): T {
  return withTempDir((dir) => {
    const db = openDb(join(dir, "telemetry.db"));
    try {
      return fn(db);
    } finally {
      db.close();
    }
  });
}

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "graphctx-telemetry-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function withNetworkTrap(fn: () => void, onCall: () => void): void {
  type FetchHolder = {
    fetch?: (...args: unknown[]) => Promise<unknown>;
  };
  const holder = globalThis as unknown as FetchHolder;
  const original = holder.fetch;
  holder.fetch = async () => {
    onCall();
    throw new Error("network disabled in telemetry eval");
  };
  try {
    fn();
  } finally {
    if (original) {
      holder.fetch = original;
    } else {
      holder.fetch = undefined;
    }
  }
}

function fmt(n: number): string {
  return n.toFixed(2);
}
