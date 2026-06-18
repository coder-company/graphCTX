import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Runtime } from "../../src/runtime.js";

let dir: string;
let rt: Runtime;

const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "graphctx test",
  GIT_AUTHOR_EMAIL: "test@graphctx.local",
  GIT_COMMITTER_NAME: "graphctx test",
  GIT_COMMITTER_EMAIL: "test@graphctx.local",
  GIT_AUTHOR_DATE: "2026-01-01T00:00:00 +0000",
  GIT_COMMITTER_DATE: "2026-01-01T00:00:00 +0000",
};

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
    await rt.noteOpenLoop("finish wiring the retry backoff in api.ts", "s1");
    const capsule = await postCompact("s1");
    expect(capsule.markdown).toContain("Open loops / unfinished work");
    expect(capsule.markdown).toContain("finish wiring the retry backoff");
  });

  it("keeps resurfacing across repeated compactions (exempt from anti-repetition)", async () => {
    await rt.noteOpenLoop("rename getCwd everywhere", "s1");
    const first = await postCompact("s1");
    const second = await postCompact("s1");
    expect(first.markdown).toContain("rename getCwd everywhere");
    expect(second.markdown).toContain("rename getCwd everywhere");
  });

  it("refuses secret-bearing session metadata before writing the open loop", async () => {
    await expect(
      rt.noteOpenLoop(
        "finish the release checklist",
        "Authorization: Bearer plainlowentropytoken123",
      ),
    ).rejects.toThrow("refusing to store secret-bearing memory");
    expect(rt.facts.openLoops(rt.scope()).map((f) => f.object)).not.toContain(
      "finish the release checklist",
    );
  });

  it("anchors open loops to the current git head", async () => {
    execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q", "."], {
      cwd: dir,
      env: GIT_ENV,
    });
    writeFileSync(join(dir, "README.md"), "# test\n");
    execFileSync("git", ["-c", "commit.gpgsign=false", "add", "-A"], {
      cwd: dir,
      env: GIT_ENV,
      stdio: "ignore",
    });
    execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-qm", "init"], {
      cwd: dir,
      env: GIT_ENV,
      stdio: "ignore",
    });

    const head = await rt.git.head();
    const repoId = await rt.git.repoId();
    const loop = await rt.noteOpenLoop("finish the branch-aware handoff", "s1");

    expect(loop.git).toMatchObject({
      repo_id: repoId,
      branch: "main",
      valid_from_commit: head,
      introduced_by_commit: head,
    });
  });

  it("a resolved open loop stops appearing", async () => {
    const loop = await rt.noteOpenLoop("delete the dead feature flag", "s1");
    const before = await postCompact("s1");
    expect(before.markdown).toContain("delete the dead feature flag");

    await rt.resolveOpenLoop(loop.fact_id);

    const after = await postCompact("s1");
    expect(after.markdown).not.toContain("delete the dead feature flag");
  });
});
