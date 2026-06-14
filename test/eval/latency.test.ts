import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { measureHookLatency } from "../../src/eval/latency.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");

describe("hook latency budget (SPEC §24)", () => {
  it("retrieval + render p95 < 150ms on the demo repo", async () => {
    const r = await measureHookLatency(join(repoRoot, "fixtures", "repo-pnpm-web"), 40);
    expect(r.p95).toBeLessThan(150);
    expect(r.pass).toBe(true);
  }, 30000);
});
