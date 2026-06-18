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

describe("FactsRepo secondary indexes", () => {
  it("redacts secret-bearing content before writing FTS and vector indexes", () => {
    const dir = mkdtempSync(join(tmpdir(), "graphctx-facts-repo-"));
    const db = openDb(join(dir, "facts.db"));
    try {
      const facts = new FactsRepo(db);
      let vectorText = "";
      facts.attachVectorIndex({
        upsert(_factId, text) {
          vectorText = text;
        },
        remove() {},
      });
      const objectSecret = "sk-FAKEFAKEFAKEFAKEFAKE0123abcd";
      const tagSecret = "ghp_FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE";
      const fact = facts.insert({
        subject: "repo",
        predicate: "deploy_token",
        object: objectSecret,
        fact_kind: "semantic",
        temporal_kind: "static",
        scope: { user_id: "u", workspace_id: "w" },
        trust_tier: "high",
        status: "active",
        promotion_state: "workspace_active",
        source: { asserted_by: "user", event_ids: [], raw_quote: `token is ${objectSecret}` },
        tags: [tagSecret],
      });
      const indexed = db
        .prepare("SELECT text, tags FROM facts_fts WHERE fact_id = ?")
        .get(fact.fact_id) as { text: string; tags: string };

      expect(fact.sensitivity).toBe("secret");
      expect(indexed.text).not.toContain(objectSecret);
      expect(indexed.tags).not.toContain(tagSecret);
      expect(vectorText).not.toContain(objectSecret);
      expect(vectorText).not.toContain(tagSecret);
      expect(`${indexed.text} ${indexed.tags} ${vectorText}`).toContain("[REDACTED:");
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps FTS tags searchable after metadata updates", () => {
    const dir = mkdtempSync(join(tmpdir(), "graphctx-facts-repo-"));
    const db = openDb(join(dir, "facts.db"));
    try {
      const facts = new FactsRepo(db);
      const fact = facts.insert({
        subject: "repo",
        predicate: "release_note",
        object: "ship the stable channel",
        fact_kind: "semantic",
        temporal_kind: "static",
        scope: { user_id: "u", workspace_id: "w" },
        trust_tier: "high",
        status: "active",
        promotion_state: "workspace_active",
        source: { asserted_by: "user", event_ids: [] },
        tags: [],
      });

      expect(
        facts.search({ text: "deployable", scope: { user_id: "u", workspace_id: "w" } }),
      ).toEqual([]);

      facts.update(fact.fact_id, { tags: ["deployable"] });

      expect(
        facts.search({ text: "deployable", scope: { user_id: "u", workspace_id: "w" } })[0]?.fact
          .fact_id,
      ).toBe(fact.fact_id);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("restamps sensitivity and redacts indexes when tag updates add secrets", () => {
    const dir = mkdtempSync(join(tmpdir(), "graphctx-facts-repo-"));
    const db = openDb(join(dir, "facts.db"));
    try {
      const facts = new FactsRepo(db);
      let vectorText = "";
      facts.attachVectorIndex({
        upsert(_factId, text) {
          vectorText = text;
        },
        remove() {},
      });
      const fact = facts.insert({
        subject: "repo",
        predicate: "release_note",
        object: "ship the stable channel",
        fact_kind: "semantic",
        temporal_kind: "static",
        scope: { user_id: "u", workspace_id: "w" },
        trust_tier: "high",
        status: "active",
        promotion_state: "workspace_active",
        source: { asserted_by: "user", event_ids: [] },
        tags: [],
      });
      const tagSecret = "ghp_FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE";

      facts.update(fact.fact_id, { tags: [tagSecret] });

      const indexed = db
        .prepare("SELECT tags FROM facts_fts WHERE fact_id = ?")
        .get(fact.fact_id) as { tags: string };
      expect(facts.get(fact.fact_id)?.sensitivity).toBe("secret");
      expect(indexed.tags).not.toContain(tagSecret);
      expect(vectorText).not.toContain(tagSecret);
      expect(`${indexed.tags} ${vectorText}`).toContain("[REDACTED:");
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("removes expired facts from the vector index and restores them on reactivation", () => {
    const dir = mkdtempSync(join(tmpdir(), "graphctx-facts-repo-"));
    const db = openDb(join(dir, "facts.db"));
    try {
      const facts = new FactsRepo(db);
      const events: string[] = [];
      facts.attachVectorIndex({
        upsert(factId) {
          events.push(`upsert:${factId}`);
        },
        remove(factId) {
          events.push(`remove:${factId}`);
        },
      });
      const fact = facts.insert({
        subject: "repo",
        predicate: "release_note",
        object: "ship the stable channel",
        fact_kind: "semantic",
        temporal_kind: "static",
        scope: { user_id: "u", workspace_id: "w" },
        trust_tier: "high",
        status: "active",
        promotion_state: "workspace_active",
        source: { asserted_by: "user", event_ids: [] },
        tags: [],
      });
      events.length = 0;

      facts.expire(fact.fact_id, fact.fact_id);
      facts.reactivate(fact.fact_id);

      expect(events).toEqual([`remove:${fact.fact_id}`, `upsert:${fact.fact_id}`]);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps candidate facts out of the vector index until promotion", () => {
    const dir = mkdtempSync(join(tmpdir(), "graphctx-facts-repo-"));
    const db = openDb(join(dir, "facts.db"));
    try {
      const facts = new FactsRepo(db);
      const events: string[] = [];
      facts.attachVectorIndex({
        upsert(factId, text) {
          events.push(`upsert:${factId}:${text}`);
        },
        remove(factId) {
          events.push(`remove:${factId}`);
        },
      });
      const fact = facts.insert({
        subject: "repo",
        predicate: "agent_doc_claim",
        object: "prefer launching the unverified helper",
        fact_kind: "semantic",
        temporal_kind: "static",
        scope: { user_id: "u", workspace_id: "w" },
        trust_tier: "low",
        status: "candidate",
        promotion_state: "session_only",
        source: { asserted_by: "agent", event_ids: [] },
        tags: [],
      });
      expect(events).toEqual([]);

      facts.update(fact.fact_id, { tags: ["unverified-helper"] });
      expect(events).toEqual([`remove:${fact.fact_id}`]);

      facts.update(fact.fact_id, {
        status: "active",
        promotion_state: "workspace_active",
      });

      expect(events).toHaveLength(2);
      expect(events[1]).toContain(`upsert:${fact.fact_id}:`);
      expect(events[1]).toContain("unverified-helper");
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
