import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { StoreError } from "../core/errors.js";
import { runMigrations } from "./migrate.js";
import { type DB, openSqlite } from "./sqlite.js";

export type { DB } from "./sqlite.js";

// Connection factory: WAL, foreign keys, busy timeout (set by the driver).
// Runs migrations on open. Driver (better-sqlite3 vs bun:sqlite) is selected
// by runtime inside openSqlite().
export function openDb(path: string): DB {
  try {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    const db = openSqlite(path);
    runMigrations(db);
    return db;
  } catch (e) {
    throw new StoreError(
      `failed to open db ${path}: ${(e as Error).message}`,
      "check path/permissions",
    );
  }
}

// Transaction helper.
export function tx<T>(db: DB, fn: () => T): T {
  const wrapped = db.transaction(fn);
  return wrapped() as T;
}
