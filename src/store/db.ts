import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { StoreError } from "../core/errors.js";
import { runMigrations } from "./migrate.js";

export type DB = Database.Database;

// Connection factory: WAL, foreign keys, busy timeout. Runs migrations on open.
export function openDb(path: string): DB {
  try {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    const db = new Database(path);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    db.pragma("busy_timeout = 5000");
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
  return wrapped();
}
