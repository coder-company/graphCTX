import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Runtime } from "../../src/runtime.js";

let dir: string;
let rt: Runtime;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gctx-loop-"));
  rt = new Runtime({ workspaceDir: dir, userId: "u" });
});
afterEach(() => {
  rt.close();
  rmSync(dir, { recursive: true, force: true });
});

async function postCompact(session: string) {
  const ctx = await rt.injectionContext("PostCompact", session, {
    user_prompt: "continue working",
  });
  return rt.planner().plan(ctx);
}

describe("open loops — compaction recovery (M1 §7)", () => {
  it("re-hands an active open loop to the agent after compaction", async () => {
    rt.noteOpenLoop("finish wiring the retry backoff in api.ts", "s1");
    const capsule = await postCompact("s1");
    expect(capsule.markdown).toContain("Open loops / unfinished work");
    expect(capsule.markdown).toContain("finish wiring the retry backoff");
  });

  it("keeps resurfacing across repeated compactions (exempt from anti-repetition)", async () => {
    rt.noteOpenLoop("rename getCwd everywhere", "s1");
    const first = await postCompact("s1");
    const second = await postCompact("s1");
    expect(first.markdown).toContain("rename getCwd everywhere");
    expect(second.markdown).toContain("rename getCwd everywhere");
  });

  it("a resolved open loop stops appearing", async () => {
    const loop = rt.noteOpenLoop("delete the dead feature flag", "s1");
    const before = await postCompact("s1");
    expect(before.markdown).toContain("delete the dead feature flag");

    await rt.resolveOpenLoop(loop.fact_id);

    const after = await postCompact("s1");
    expect(after.markdown).not.toContain("delete the dead feature flag");
  });
});
