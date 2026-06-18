import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixedClock } from "../../core/clock.js";
import { Ledger } from "../../inject/ledger.js";
import { why } from "../../provenance/why.js";
import { openDb } from "../../store/db.js";
import { EdgesRepo } from "../../store/edges.repo.js";
import { EpisodesRepo } from "../../store/episodes.repo.js";
import { FactsRepo } from "../../store/facts.repo.js";
import { runMigrations, schemaVersion } from "../../store/migrate.js";
import { MIGRATIONS } from "../../store/migrations.generated.js";
import { ProceduresRepo } from "../../store/procedures.repo.js";
import { PromotionsRepo } from "../../store/promotions.repo.js";
import { type DB, openSqlite } from "../../store/sqlite.js";

export interface StorageMigrationsReport {
  checks: number;
  passed: number;
  detail: string[];
  schemaVersion: number;
  migrationsAppliedOnReopen: number;
  malformedRowsSkipped: number;
  pass: boolean;
}

const latestVersion = MIGRATIONS.at(-1)?.version ?? 0;
const clock = fixedClock("2026-01-01T00:00:00.000Z");

export function runStorageMigrationsEval(): StorageMigrationsReport {
  const detail: string[] = [];
  let passed = 0;
  let schema = 0;
  let migrationsAppliedOnReopen = -1;
  let malformedRowsSkipped = 0;

  const check = (name: string, ok: boolean, note?: string) => {
    if (ok) passed += 1;
    detail.push(`${ok ? "✓" : "✗"} ${name}${note ? ` — ${note}` : ""}`);
  };

  withTempDir((dir) => {
    const path = join(dir, "fresh.db");
    const first = openSqlite(path);
    try {
      const applied = runMigrations(first);
      schema = schemaVersion(first);
      check(
        `schema_version == ${latestVersion} after fresh open`,
        schema === latestVersion && applied === MIGRATIONS.length,
        `applied=${applied}`,
      );
    } finally {
      first.close();
    }

    const second = openSqlite(path);
    try {
      migrationsAppliedOnReopen = runMigrations(second);
      check(
        "migrations applied on reopen: 0",
        migrationsAppliedOnReopen === 0 && schemaVersion(second) === latestVersion,
        `schema_version=${schemaVersion(second)}`,
      );
    } finally {
      second.close();
    }
  });

  withTempDir((dir) => {
    const path = join(dir, "failed.db");
    const db = openSqlite(path);
    try {
      let threw = false;
      try {
        runMigrations(db, [
          {
            version: 1,
            file: "0001_bad.sql",
            sql: [
              "CREATE TABLE partial_migration(id TEXT);",
              "INSERT INTO partial_migration(id) VALUES ('x');",
              "CREATE TABLE broken (",
            ].join(" "),
          },
        ]);
      } catch {
        threw = true;
      }
      check(
        "migration failure: partial DDL rolled back and schema_version unchanged",
        threw && !tableExists(db, "partial_migration") && schemaVersion(db) === 0,
        `threw=${threw} partial=${tableExists(db, "partial_migration")} schema_version=${schemaVersion(db)}`,
      );
    } finally {
      db.close();
    }
  });

  withTempDir((dir) => {
    const path = join(dir, "forward.db");
    seedVersionOneDb(path);
    const db = openSqlite(path);
    try {
      const applied = runMigrations(db);
      const facts = countRows(db, "facts");
      const edges = countRows(db, "edges");
      const episodes = countRows(db, "episodes");
      const observed = db
        .prepare("SELECT t_observed, t_recorded FROM facts WHERE fact_id = ?")
        .get("fact_storage_v1") as
        | { t_observed: string | null; t_recorded: string | null }
        | undefined;
      const rowsPreserved = facts === 1 && edges === 1 && episodes === 1;
      check(
        `forward-compat: rows preserved ${facts + edges + episodes}/3, version 1→${schemaVersion(db)}`,
        applied === latestVersion - 1 && schemaVersion(db) === latestVersion && rowsPreserved,
        `applied=${applied}`,
      );
      check(
        "forward-compat: t_observed backfilled from t_recorded",
        observed?.t_observed === observed?.t_recorded && !!observed?.t_observed,
      );
      check(
        "forward-compat: new migration tables exist",
        tableExists(db, "promotions") && tableExists(db, "inject_ledger"),
      );
      check(
        "forward-compat: hot-path fact scope index exists",
        indexExists(db, "idx_facts_status_scope"),
      );
      check(
        "forward-compat: invalidation conflict lookup index exists",
        indexExists(db, "idx_facts_sp_scope_status"),
      );
    } finally {
      db.close();
    }
  });

  withTempDir((dir) => {
    const db = openDb(join(dir, "append-only.db"));
    try {
      const facts = new FactsRepo(db, clock);
      const edges = new EdgesRepo(db, clock);
      const episodes = new EpisodesRepo(db, clock);
      const promotions = new PromotionsRepo(db, clock);
      const oldFact = insertFact(facts, "repo", "package_manager", "npm");
      const newFact = insertFact(facts, "repo", "package_manager", "pnpm");
      edges.add(newFact.fact_id, "SUPERSEDES", oldFact.fact_id, newFact.fact_id);
      facts.expire(oldFact.fact_id, newFact.fact_id, "commit-b");
      const row = db
        .prepare("SELECT status, t_expired, invalidated_by FROM facts WHERE fact_id = ?")
        .get(oldFact.fact_id) as
        | { status: string; t_expired: string | null; invalidated_by: string | null }
        | undefined;
      const anchor = db
        .prepare("SELECT valid_until_commit FROM git_anchors WHERE fact_id = ?")
        .get(oldFact.fact_id) as { valid_until_commit: string | null } | undefined;
      const report = why(oldFact.fact_id, { facts, episodes, edges, promotions });
      check(
        "append-only: expired fact row retained, status=expired",
        countRows(db, "facts") === 2 &&
          row?.status === "expired" &&
          !!row.t_expired &&
          row.invalidated_by === newFact.fact_id &&
          anchor?.valid_until_commit === "commit-b" &&
          report?.fact.fact_id === oldFact.fact_id,
        `rowCount=${countRows(db, "facts")}`,
      );
      check(
        "integrity: anchors/edges consistent after expire",
        !!report?.git_anchor &&
          report.edges.length === 1 &&
          new EdgesRepo(db, clock).touching(oldFact.fact_id).length === 1,
      );
    } finally {
      db.close();
    }
  });

  withTempDir((dir) => {
    const db = openDb(join(dir, "corrupt.db"));
    try {
      const facts = new FactsRepo(db, clock);
      const episodes = new EpisodesRepo(db, clock);
      const procedures = new ProceduresRepo(db, clock);
      const goodFact = insertFact(facts, "repo", "test_runner", "vitest");
      episodes.append({
        session_id: "s1",
        workspace_id: "w1",
        event_type: "prompt_submitted",
        payload: { prompt: "ok" },
      });
      procedures.insert({
        fact_id: goodFact.fact_id,
        name: "run tests",
        steps: [{ description: "run vitest", command: "npm test" }],
      });
      insertMalformedRows(db, goodFact.fact_id);
      const active = facts.activeAsOf({ user_id: "storage-user", workspace_id: "storage-ws" });
      const session = episodes.bySession("s1");
      const allProcedures = procedures.all();
      const survived = active.length === 1 && session.length === 1 && allProcedures.length === 1;
      malformedRowsSkipped = survived ? 3 : 0;
      check(
        "corruption: 3 malformed rows skipped, query survived",
        survived,
        `active=${active.length} episodes=${session.length} procedures=${allProcedures.length}`,
      );
    } finally {
      db.close();
    }
  });

  withTempDir((dir) => {
    const db = openDb(join(dir, "degraded.db"));
    try {
      db.exec("DROP TABLE inject_ledger");
      const ledger = new Ledger(db);
      const fact = insertFact(new FactsRepo(db, clock), "repo", "lint_command", "npm run lint");
      const filtered = ledger.removeRecentlyInjected([{ fact, score: 1 }], "s1");
      check(
        "degraded read: missing table → empty result (no throw)",
        filtered.length === 1 && filtered[0]?.fact.fact_id === fact.fact_id,
      );
    } finally {
      db.close();
    }
  });

  withTempDir((dir) => {
    const db = openDb(join(dir, "pragmas.db"));
    try {
      const journal = String(pragmaValue(db, "journal_mode")).toLowerCase();
      const foreignKeys = Number(pragmaValue(db, "foreign_keys"));
      const busyTimeout = Number(pragmaValue(db, "busy_timeout"));
      check(
        "pragmas: journal_mode=wal foreign_keys=1 busy_timeout>0",
        journal === "wal" && foreignKeys === 1 && busyTimeout > 0,
        `journal_mode=${journal} foreign_keys=${foreignKeys} busy_timeout=${busyTimeout}`,
      );
    } finally {
      db.close();
    }
  });

  withTempDir((dir) => {
    const db = openDb(join(dir, "cascade.db"));
    try {
      const facts = new FactsRepo(db, clock);
      const fact = insertFact(facts, "repo", "build_command", "npm run build");
      const other = insertFact(facts, "repo", "build_command", "pnpm build");
      new EdgesRepo(db, clock).add(fact.fact_id, "CONFLICTS_WITH", other.fact_id, fact.fact_id);
      new ProceduresRepo(db, clock).insert({
        fact_id: fact.fact_id,
        name: "build",
        steps: [{ description: "build", command: "npm run build" }],
      });
      new PromotionsRepo(db, clock).record({
        fact_id: fact.fact_id,
        from_state: "session_only",
        to_state: "workspace_active",
        decision: "promote",
        gate: "deterministic_evidence",
      });
      db.prepare("DELETE FROM facts WHERE fact_id = ?").run(fact.fact_id);
      const anchors = countWhere(db, "git_anchors", "fact_id = ?", fact.fact_id);
      const procedures = countWhere(db, "procedures", "fact_id = ?", fact.fact_id);
      const promotions = countWhere(db, "promotions", "fact_id = ?", fact.fact_id);
      const edgeTrail = new EdgesRepo(db, clock).touching(fact.fact_id).length;
      check(
        "integrity: hard-delete cascades anchors/procedures/promotions; edge trail queryable",
        anchors === 0 && procedures === 0 && promotions === 0 && edgeTrail === 1,
        `anchors=${anchors} procedures=${procedures} promotions=${promotions} edges=${edgeTrail}`,
      );
    } finally {
      db.close();
    }
  });

  const checks = detail.length;
  const pass = passed === checks && schema === latestVersion && migrationsAppliedOnReopen === 0;
  return {
    checks,
    passed,
    detail,
    schemaVersion: schema,
    migrationsAppliedOnReopen,
    malformedRowsSkipped,
    pass,
  };
}

export function formatStorageMigrationsReport(r: StorageMigrationsReport): string {
  const lines: string[] = [];
  lines.push("");
  lines.push("graphCTX eval - storage migrations + corruption recovery");
  lines.push("=".repeat(72));
  lines.push("");
  for (const d of r.detail) lines.push(`  ${d}`);
  lines.push("");
  lines.push(
    `  checks: ${r.passed}/${r.checks}   schema_version: ${r.schemaVersion}   migrations applied on reopen: ${r.migrationsAppliedOnReopen}`,
  );
  lines.push(
    r.pass
      ? "  VERDICT: ✅ STORAGE PASS - migrations, append-only storage, pragmas, and corruption recovery hold."
      : "  VERDICT: ❌ STORAGE FAIL.",
  );
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "graphctx-storage-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function seedVersionOneDb(path: string): void {
  const db = openSqlite(path);
  try {
    db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    db.exec(MIGRATIONS[0]!.sql);
    db.prepare("INSERT INTO meta(key, value) VALUES('schema_version', '1')").run();
    db.prepare(
      `INSERT INTO facts (
        fact_id, subject_id, predicate, object_json, fact_kind, temporal_kind,
        scope_user_id, scope_workspace_id, scope_session_id, status, promotion_state,
        trust_tier, sensitivity, confidence, evidence_count, t_created, t_recorded,
        asserted_by, source_event_ids_json, source_commit, raw_quote, tags_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "fact_storage_v1",
      "repo",
      "package_manager",
      JSON.stringify("pnpm"),
      "semantic",
      "static",
      "storage-user",
      "storage-ws",
      null,
      "active",
      "workspace_active",
      "high",
      "public",
      0.9,
      1,
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
      "user",
      "[]",
      null,
      "pnpm",
      "[]",
    );
    db.prepare("INSERT INTO facts_fts(fact_id, text, tags) VALUES (?, ?, ?)").run(
      "fact_storage_v1",
      "repo package_manager pnpm",
      "",
    );
    db.prepare(
      "INSERT INTO edges(edge_id, from_id, edge_kind, to_id, scope_json, source_fact_id, created_at) VALUES (?, ?, ?, ?, NULL, ?, ?)",
    ).run(
      "edge_storage_v1",
      "fact_storage_v1",
      "SUPERSEDES",
      "fact_storage_v1",
      "fact_storage_v1",
      "2026-01-01T00:00:00.000Z",
    );
    db.prepare(
      "INSERT INTO episodes(event_id, session_id, workspace_id, event_type, payload_json, git_head, git_branch, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      "evt_storage_v1",
      "s1",
      "storage-ws",
      "UserPromptSubmit",
      JSON.stringify({ prompt: "remember pnpm" }),
      null,
      null,
      "2026-01-01T00:00:00.000Z",
    );
  } finally {
    db.close();
  }
}

function insertFact(facts: FactsRepo, subject: string, predicate: string, object: string) {
  return facts.insert({
    subject,
    predicate,
    object,
    fact_kind: "semantic",
    temporal_kind: "static",
    scope: { user_id: "storage-user", workspace_id: "storage-ws" },
    trust_tier: "high",
    status: "active",
    promotion_state: "workspace_active",
    git: {
      repo_id: "repo-storage",
      branch: "main",
      valid_from_commit: "commit-a",
      introduced_by_commit: "commit-a",
    },
    source: { asserted_by: "user", event_ids: [], raw_quote: object },
    tags: ["storage_eval"],
  });
}

function insertMalformedRows(db: DB, goodFactId: string): void {
  db.prepare(
    `INSERT INTO facts (
      fact_id, subject_id, predicate, object_json, fact_kind, temporal_kind,
      scope_user_id, scope_workspace_id, scope_session_id, status, promotion_state,
      trust_tier, sensitivity, confidence, evidence_count, t_created, t_recorded,
      asserted_by, source_event_ids_json, source_commit, raw_quote, tags_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "fact_bad_json",
    "repo",
    "bad",
    "{bad-json",
    "semantic",
    "static",
    "storage-user",
    "storage-ws",
    null,
    "active",
    "workspace_active",
    "high",
    "public",
    0.5,
    1,
    "2026-01-01T00:00:00.000Z",
    "2026-01-01T00:00:00.000Z",
    "user",
    "[]",
    null,
    "bad",
    "[]",
  );
  db.prepare(
    "INSERT INTO episodes(event_id, session_id, workspace_id, event_type, payload_json, git_head, git_branch, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    "evt_bad_json",
    "s1",
    "storage-ws",
    "UserPromptSubmit",
    "{bad-json",
    null,
    null,
    "2026-01-01T00:00:00.000Z",
  );
  db.prepare(
    "INSERT INTO procedures(procedure_id, fact_id, name, procedure_json, success_count, failure_count) VALUES (?, ?, ?, ?, 0, 0)",
  ).run("proc_bad_json", goodFactId, "bad json", "{bad-json");
}

function countRows(db: DB, table: string): number {
  const row = db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number };
  return row.n;
}

function countWhere(db: DB, table: string, where: string, ...params: unknown[]): number {
  const row = db.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${where}`).get(...params) as {
    n: number;
  };
  return row.n;
}

function tableExists(db: DB, name: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name) as { name: string } | undefined;
  return !!row;
}

function indexExists(db: DB, name: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?")
    .get(name) as { name: string } | undefined;
  return !!row;
}

function pragmaValue(db: DB, name: string): unknown {
  const row = db.prepare(`PRAGMA ${name}`).get() as Record<string, unknown> | undefined;
  return row ? Object.values(row)[0] : undefined;
}
