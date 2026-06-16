// Binary-only: extracts the sqlite-vec loadable extension embedded in the
// compiled Bun executable to a temp file, then points the vector layer at it
// via GRAPHCTX_VEC0_PATH. No-op under Node (npm/dev/tests use the sqlite-vec
// npm package directly). Called once at CLI startup before any DB is opened.
//
// `vec0-embed.generated.ts` is rewritten by scripts/build-binary.mjs to embed
// the correct per-platform extension (Bun bakes it into the binary). Under Node
// the generated module's default export is undefined, so this is a clean no-op.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import embeddedVec0 from "./vec0-embed.generated.js";

export function bootstrapVec0(): void {
  const debug = !!process.env.GRAPHCTX_DEBUG;
  const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
  if (!isBun) return;
  if (process.env.GRAPHCTX_VEC0_PATH) return;
  if (!embeddedVec0) return;

  try {
    const ext = embeddedVec0.endsWith(".dylib")
      ? "dylib"
      : embeddedVec0.endsWith(".dll")
        ? "dll"
        : "so";
    // The SQLite loader derives the init symbol from the BASENAME, so the file
    // must be named exactly `vec0.<ext>` to resolve sqlite3_vec0_init. Isolate
    // it in a versioned subdir to avoid collisions across graphctx versions.
    const dir = join(tmpdir(), "graphctx-vec0-0.1.9");
    const dest = join(dir, `vec0.${ext}`);
    if (!existsSync(dest)) {
      mkdirSync(dir, { recursive: true });
      // The embedded path lives in Bun's virtual FS (/$bunfs/...). copyFileSync
      // can't read it, but readFileSync can — pull the bytes and write them to
      // a real temp path the SQLite loader can dlopen.
      const bytes = readFileSync(embeddedVec0);
      writeFileSync(dest, bytes);
      try {
        chmodSync(dest, 0o755);
      } catch {
        // permissions best-effort
      }
    }
    process.env.GRAPHCTX_VEC0_PATH = dest;
    if (debug) process.stderr.write(`[vec0] extracted → ${dest}\n`);
  } catch (e) {
    if (debug) process.stderr.write(`[vec0] extraction failed: ${(e as Error).message}\n`);
    // If extraction fails, the vector layer disables itself and BM25 carries
    // retrieval (graceful degradation). Never block startup.
  }
}
