import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDb } from "../../src/store/db.js";
import { FactsRepo } from "../../src/store/facts.repo.js";

describe("FactsRepo git anchors", () => {
  it("updates every temporal anchor field when restamping an existing fact", () => {
    const dir = mkdtempSync(join(tmpdir(), "graphctx-facts-repo-"));
    const db = openDb(join(dir, "facts.db"));
    try {
      const facts = new FactsRepo(db);
      const fact = facts.insert({
        subject: "repo",
        predicate: "test_command",
        object: "pnpm test",
        fact_kind: "decision",
        temporal_kind: "static",
        scope: { user_id: "u", workspace_id: "w" },
        trust_tier: "high",
        status: "active",
        promotion_state: "workspace_active",
        source: { asserted_by: "deterministic_parser", event_ids: [] },
        git: {
          repo_id: "repo-old",
          branch: "main",
          valid_from_commit: "old",
          path_globs: ["old/path.ts"],
          file_ids: ["old-file"],
          symbol_ids: ["old-symbol"],
          hunk_fingerprints: ["old-hunk"],
          patch_id: "old-patch",
        },
      });

      facts.setAnchor(fact.fact_id, {
        repo_id: "repo-new",
        branch: "feature",
        base_head: "base",
        introduced_by_commit: "intro",
        valid_from_commit: "new",
        valid_until_commit: "until",
        invalidated_by_commit: "invalidator",
        path_globs: ["new/path.ts"],
        file_ids: ["new-file"],
        symbol_ids: ["new-symbol"],
        hunk_fingerprints: ["new-hunk"],
        patch_id: "new-patch",
      });

      expect(facts.get(fact.fact_id)?.git).toEqual({
        repo_id: "repo-new",
        branch: "feature",
        base_head: "base",
        introduced_by_commit: "intro",
        valid_from_commit: "new",
        valid_until_commit: "until",
        invalidated_by_commit: "invalidator",
        path_globs: ["new/path.ts"],
        file_ids: ["new-file"],
        symbol_ids: ["new-symbol"],
        hunk_fingerprints: ["new-hunk"],
        patch_id: "new-patch",
      });
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
