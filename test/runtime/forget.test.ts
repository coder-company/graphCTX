import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fixedClock } from "../../src/core/clock.js";
import { Runtime } from "../../src/runtime.js";

const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "graphctx test",
  GIT_AUTHOR_EMAIL: "test@graphctx.local",
  GIT_COMMITTER_NAME: "graphctx test",
  GIT_COMMITTER_EMAIL: "test@graphctx.local",
  GIT_AUTHOR_DATE: "2026-01-01T00:00:00 +0000",
  GIT_COMMITTER_DATE: "2026-01-01T00:00:00 +0000",
};

function git(dir: string, args: string[]): string {
  return execFileSync("git", ["-c", "commit.gpgsign=false", ...args], {
    cwd: dir,
    env: GIT_ENV,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

describe("Runtime forget", () => {
  it("expires facts with the current git closeout anchor", async () => {
    const dir = mkdtempSync(join(tmpdir(), "graphctx-runtime-forget-"));
    try {
      execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q", "."], {
        cwd: dir,
        env: GIT_ENV,
      });
      writeFileSync(join(dir, "README.md"), "# test\n");
      git(dir, ["add", "-A"]);
      git(dir, ["commit", "-qm", "init"]);

      const rt = new Runtime({
        workspaceDir: dir,
        userId: "u",
        clock: fixedClock("2026-06-01T02:03:04.000Z"),
      });
      try {
        const head = await rt.git.head();
        const repoId = await rt.git.repoId();
        const fact = rt.facts.insert({
          subject: "repo",
          predicate: "note",
          object: "deploy with ./scripts/ship.sh",
          fact_kind: "decision",
          temporal_kind: "static",
          scope: { user_id: rt.userId, workspace_id: rt.workspaceId },
          trust_tier: "high",
          status: "active",
          promotion_state: "workspace_active",
          source: { asserted_by: "user", event_ids: [] },
          git: {
            repo_id: repoId,
            branch: "main",
            valid_from_commit: head,
            introduced_by_commit: head,
          },
          tags: ["user_explicit"],
        });

        await rt.forgetFact(fact.fact_id);

        const forgotten = rt.facts.get(fact.fact_id);
        expect(forgotten?.status).toBe("expired");
        expect(forgotten?.time.t_expired).toBe("2026-06-01T02:03:04.000Z");
        expect(forgotten?.time.invalidated_by).toBe(fact.fact_id);
        expect(forgotten?.git?.valid_until_commit).toBe(head);
        expect(forgotten?.git?.invalidated_by_commit).toBe(head);
      } finally {
        rt.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
