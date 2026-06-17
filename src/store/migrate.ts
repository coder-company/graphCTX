import { MIGRATIONS, type Migration } from "./migrations.generated.js";
import type { DB } from "./sqlite.js";

// Forward-only numbered migrations, inlined at build time (see
// scripts/gen-migrations.mjs) so the compiled binary needs no filesystem.
export function runMigrations(db: DB, migrations: Migration[] = MIGRATIONS): number {
  db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as
    | { value: string }
    | undefined;
  const current = row ? Number(row.value) : 0;
  let applied = 0;

  for (const m of migrations) {
    if (m.version <= current) continue;
    db.transaction(() => {
      db.exec(m.sql);
      db.prepare(
        "INSERT INTO meta(key, value) VALUES('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      ).run(String(m.version));
    })();
    applied += 1;
  }
  return applied;
}

export function schemaVersion(db: DB): number {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as
    | { value: string }
    | undefined;
  return row ? Number(row.value) : 0;
}
