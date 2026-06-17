import { describe, expect, it } from "vitest";
import type { InjectionContext, NewFact } from "../../src/core/types.js";
import type { Git } from "../../src/git/git.js";
import { Retriever } from "../../src/retrieve/retriever.js";
import { VectorIndex } from "../../src/retrieve/vectors.js";
import { openDb } from "../../src/store/db.js";
import { FactsRepo } from "../../src/store/facts.repo.js";

function fact(over: Partial<NewFact> = {}): NewFact {
  return {
    subject: "repo",
    predicate: "note",
    object: "redact credentials before sharing",
    fact_kind: "preference",
    temporal_kind: "static",
    scope: { user_id: "u" },
    trust_tier: "high",
    status: "active",
    promotion_state: "user_static_active",
    source: { asserted_by: "user", event_ids: [], raw_quote: "redact credentials before sharing" },
    tags: ["privacy"],
    ...over,
  };
}

function ctx(): InjectionContext {
  return {
    event: "UserPromptSubmit",
    scope: { user_id: "u", workspace_id: "w", session_id: "s" },
    git: { repo_id: "w", head: "", branch: "" },
    user_prompt: "how should I manage api keys before sending context",
  };
}

describe("Retriever", () => {
  it("semantic expansion includes user-scoped facts with no BM25 overlap", async () => {
    const db = openDb(":memory:");
    try {
      const facts = new FactsRepo(db);
      const userFact = facts.insert(fact());
      facts.insert(
        fact({
          subject: "repo",
          predicate: "test_command",
          object: "run vitest",
          fact_kind: "procedural",
          scope: { user_id: "u", workspace_id: "w" },
          promotion_state: "workspace_active",
          source: { asserted_by: "deterministic_parser", event_ids: [] },
          tags: ["test"],
        }),
      );

      const vectors = new VectorIndex(db);
      expect(vectors.enabled).toBe(true);

      const ranked = await new Retriever(facts, null, vectors).retrieve(ctx(), { k: 10 });
      expect(ranked.map((sf) => sf.fact.fact_id)).toContain(userFact.fact_id);
    } finally {
      db.close();
    }
  });

  it("does not return commit-scoped facts when no Git adapter is available", async () => {
    const db = openDb(":memory:");
    try {
      const facts = new FactsRepo(db);
      const anchored = facts.insert(
        fact({
          object: "run pnpm test",
          scope: { user_id: "u", workspace_id: "w" },
          promotion_state: "workspace_active",
          source: { asserted_by: "deterministic_parser", event_ids: [] },
          git: {
            repo_id: "repo_a",
            branch: "main",
            introduced_by_commit: "c1",
            valid_from_commit: "c1",
          },
          tags: ["test"],
        }),
      );

      const ranked = await new Retriever(facts, null).retrieve(
        { ...ctx(), user_prompt: "pnpm test command" },
        { k: 10 },
      );
      expect(ranked.map((sf) => sf.fact.fact_id)).not.toContain(anchored.fact_id);
    } finally {
      db.close();
    }
  });

  it("fails closed when Git validity checks throw for commit-scoped facts", async () => {
    const db = openDb(":memory:");
    try {
      const facts = new FactsRepo(db);
      const anchored = facts.insert(
        fact({
          object: "use yarn test",
          scope: { user_id: "u", workspace_id: "w" },
          promotion_state: "workspace_active",
          source: { asserted_by: "deterministic_parser", event_ids: [] },
          git: {
            repo_id: "repo_a",
            branch: "main",
            introduced_by_commit: "c1",
            valid_from_commit: "c1",
          },
          tags: ["test"],
        }),
      );
      const brokenGit = {
        isAncestor: async () => {
          throw new Error("git unavailable");
        },
      } as unknown as Git;

      const ranked = await new Retriever(facts, brokenGit).retrieve(
        {
          ...ctx(),
          git: { repo_id: "repo_a", head: "c2", branch: "main" },
          user_prompt: "yarn test",
        },
        { k: 10 },
      );
      expect(ranked.map((sf) => sf.fact.fact_id)).not.toContain(anchored.fact_id);
    } finally {
      db.close();
    }
  });
});
