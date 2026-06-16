// Runtime-agnostic SQLite driver.
//
// graphCTX ships two ways:
//   - npm / dev / tests → Node + better-sqlite3 (C++ addon)
//   - compiled binary    → Bun + bun:sqlite (built-in, loads sqlite-vec too)
//
// Both expose nearly the same API; this module normalizes them behind a tiny
// shared interface (DB / Stmt) so the rest of the codebase is driver-agnostic.
// Detection is by runtime: if `Bun` is the host, use bun:sqlite; else fall back
// to better-sqlite3.
import { createRequire } from "node:module";

// Node ESM has no implicit `require`; build one from this module's URL. Under
// Bun this branch is never taken (we use the bun:sqlite builtin instead), so a
// missing import.meta.url is harmless.
const nodeRequire = createRequire(import.meta.url);

export interface Stmt {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

export interface DB {
  prepare(sql: string): Stmt;
  exec(sql: string): void;
  transaction<T>(fn: (...args: unknown[]) => T): (...args: unknown[]) => T;
  close(): void;
  // Access to the raw underlying handle for sqlite-vec extension loading.
  readonly raw: unknown;
}

const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";

// Cached bun:sqlite Database ctor (resolved once, lazily, under Bun).
let BunDatabaseCtor: (new (p: string) => BunDatabase) | null = null;

export function openSqlite(path: string): DB {
  return isBun ? openBun(path) : openBetterSqlite(path);
}

// --- bun:sqlite -------------------------------------------------------------
function openBun(path: string): DB {
  if (!BunDatabaseCtor) {
    // bun:sqlite is a Bun builtin. Inside a `bun build --compile` binary the
    // only working resolver is `import.meta.require` (globalThis.require and
    // eval-require are undefined there). Never reached under Node.
    const metaRequire = (import.meta as { require?: (m: string) => unknown }).require as
      | ((m: string) => { Database: new (p: string) => BunDatabase })
      | undefined;
    if (!metaRequire) throw new Error("bun:sqlite unavailable: no import.meta.require");
    BunDatabaseCtor = metaRequire("bun:sqlite").Database;
  }
  const Database = BunDatabaseCtor;
  const db = new Database(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  return {
    prepare(sql: string): Stmt {
      const s = db.query(sql);
      return {
        run: (...p: unknown[]) => s.run(...bindArgs(p)),
        get: (...p: unknown[]) => s.get(...bindArgs(p)) ?? undefined,
        all: (...p: unknown[]) => s.all(...bindArgs(p)),
      };
    },
    exec: (sql: string) => db.exec(sql),
    transaction: <T>(fn: (...a: unknown[]) => T) => db.transaction(fn),
    close: () => db.close(),
    raw: db,
  };
}

// better-sqlite3 binds a named-param object with BARE keys ({ a: 1 } → @a),
// while bun:sqlite requires the sigil in the key ({ "@a": 1 }). Our SQL uses
// the `@` sigil, so when a single plain-object arg is passed, rewrite its keys
// to `@`-prefixed form for the Bun driver. Positional args pass through.
function bindArgs(p: unknown[]): never[] {
  if (p.length === 1 && isPlainParamObject(p[0])) {
    const src = p[0] as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(src)) {
      out[k.startsWith("@") || k.startsWith("$") || k.startsWith(":") ? k : `@${k}`] = src[k];
    }
    return [out] as never[];
  }
  return p as never[];
}

function isPlainParamObject(v: unknown): boolean {
  return (
    typeof v === "object" &&
    v !== null &&
    !Array.isArray(v) &&
    !(v instanceof Uint8Array) &&
    !(v instanceof ArrayBuffer) &&
    !ArrayBuffer.isView(v)
  );
}

interface BunStatement {
  run(...params: never[]): unknown;
  get(...params: never[]): unknown;
  all(...params: never[]): unknown[];
}
interface BunDatabase {
  query(sql: string): BunStatement;
  exec(sql: string): void;
  transaction<T>(fn: (...a: unknown[]) => T): (...a: unknown[]) => T;
  close(): void;
  loadExtension(path: string): void;
}

// --- better-sqlite3 ---------------------------------------------------------
function openBetterSqlite(path: string): DB {
  // Lazy require so the binary build (Bun) never resolves the C++ addon.
  const Database = nodeRequire("better-sqlite3") as new (p: string) => BetterDatabase;
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  return {
    prepare(sql: string): Stmt {
      const s = db.prepare(sql);
      return {
        run: (...p: unknown[]) => s.run(...p),
        get: (...p: unknown[]) => s.get(...p),
        all: (...p: unknown[]) => s.all(...p),
      };
    },
    exec: (sql: string) => db.exec(sql),
    transaction: <T>(fn: (...a: unknown[]) => T) => db.transaction(fn),
    close: () => db.close(),
    raw: db,
  };
}

interface BetterStatement {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}
interface BetterDatabase {
  prepare(sql: string): BetterStatement;
  exec(sql: string): void;
  pragma(p: string): unknown;
  transaction<T>(fn: (...a: unknown[]) => T): (...a: unknown[]) => T;
  close(): void;
}
