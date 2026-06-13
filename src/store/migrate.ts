import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";

const here = dirname(fileURLToPath(import.meta.url));

// Forward-only numbered migrations. M0 ships 0001 only.
const MIGRATIONS: Array<{ version: number; file: string }> = [
  { version: 1, file: "0001_init.sql" },
];

export function runMigrations(db: Database.Database): void {
  db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as
    | { value: string }
    | undefined;
  const current = row ? Number(row.value) : 0;

  for (const m of MIGRATIONS) {
    if (m.version <= current) continue;
    const sql = readFileSync(resolveMigration(m.file), "utf8");
    db.exec(sql);
    db.prepare(
      "INSERT INTO meta(key, value) VALUES('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run(String(m.version));
  }
}

function resolveMigration(file: string): string {
  return join(here, "migrations", file);
}

export function schemaVersion(db: Database.Database): number {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as
    | { value: string }
    | undefined;
  return row ? Number(row.value) : 0;
}
