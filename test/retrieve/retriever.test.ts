import { describe, expect, it } from "vitest";
import { fixedClock } from "../../src/core/clock.js";
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

  it("does not return send-unsafe secret facts even when they are forced active", async () => {
    const db = openDb(":memory:");
    try {
      const facts = new FactsRepo(db);
      const secret = facts.insert(
        fact({
          predicate: "deploy_token",
          object: "sk-FAKEFAKEFAKEFAKEFAKE0123abcd",
          scope: { user_id: "u", workspace_id: "w" },
          promotion_state: "workspace_active",
          sensitivity: "secret",
          source: { asserted_by: "user", event_ids: [] },
        }),
      );
      const safe = facts.insert(
        fact({
          predicate: "deploy_note",
          object: "redact deployment credentials before sharing",
          scope: { user_id: "u", workspace_id: "w" },
          promotion_state: "workspace_active",
          source: { asserted_by: "user", event_ids: [] },
        }),
      );

      const ranked = await new Retriever(facts, null).retrieve(
        { ...ctx(), user_prompt: "deploy token credentials" },
        { includeAllActive: true, k: 10 },
      );
      const ids = ranked.map((sf) => sf.fact.fact_id);
      expect(ids).toContain(safe.fact_id);
      expect(ids).not.toContain(secret.fact_id);
    } finally {
      db.close();
    }
  });

  it("does not leak same-session facts from another workspace", async () => {
    const db = openDb(":memory:");
    try {
      const facts = new FactsRepo(db);
      const local = facts.insert(
        fact({
          object: "local workspace session note",
          scope: { user_id: "u", workspace_id: "w", session_id: "s" },
          promotion_state: "session_only",
          source: { asserted_by: "user", event_ids: [] },
        }),
      );
      const foreign = facts.insert(
        fact({
          object: "foreign workspace session note",
          scope: { user_id: "u", workspace_id: "other-w", session_id: "s" },
          promotion_state: "session_only",
          source: { asserted_by: "user", event_ids: [] },
        }),
      );
      const seenTexts: string[] = [];
      const vectors = {
        enabled: true,
        embedQuery: () => new Float32Array([1]),
        cosineDistanceTo: (_query: Float32Array, text: string) => {
          seenTexts.push(text);
          return text.includes("local workspace") ? 0 : 0.5;
        },
        cosineSimilarityText: () => 0,
      } as unknown as VectorIndex;

      const ranked = await new Retriever(facts, null, vectors).retrieve(
        { ...ctx(), user_prompt: "workspace session note" },
        { includeAllActive: true, k: 10 },
      );
      const ids = ranked.map((sf) => sf.fact.fact_id);
      expect(ids).toContain(local.fact_id);
      expect(ids).not.toContain(foreign.fact_id);
      expect(seenTexts.join(" ")).toContain("local workspace session note");
      expect(seenTexts.join(" ")).not.toContain("foreign workspace session note");
    } finally {
      db.close();
    }
  });

  it("uses the injected clock for recency reranking", async () => {
    const db = openDb(":memory:");
    try {
      const facts = new FactsRepo(db);
      const old = facts.insert(
        fact({
          object: "older project note",
          scope: { user_id: "u", workspace_id: "w" },
          promotion_state: "workspace_active",
          source: { asserted_by: "user", event_ids: [] },
          time: {
            t_observed: "2025-01-01T00:00:00.000Z",
            t_created: "2025-01-01T00:00:00.000Z",
            t_recorded: "2025-01-01T00:00:00.000Z",
          },
        }),
      );
      const fresh = facts.insert(
        fact({
          object: "fresher project note",
          scope: { user_id: "u", workspace_id: "w" },
          promotion_state: "workspace_active",
          source: { asserted_by: "user", event_ids: [] },
          time: {
            t_observed: "2026-01-31T00:00:00.000Z",
            t_created: "2026-01-31T00:00:00.000Z",
            t_recorded: "2026-01-31T00:00:00.000Z",
          },
        }),
      );

      const ranked = await new Retriever(
        facts,
        null,
        null,
        fixedClock("2026-02-01T00:00:00.000Z"),
      ).retrieve({ ...ctx(), user_prompt: "" }, { includeAllActive: true, k: 10 });

      expect(ranked.map((sf) => sf.fact.fact_id).slice(0, 2)).toEqual([fresh.fact_id, old.fact_id]);
    } finally {
      db.close();
    }
  });

  it("redacts fact text before semantic reranking sees it", async () => {
    const db = openDb(":memory:");
    try {
      const facts = new FactsRepo(db);
      const secret = "sk-FAKEFAKEFAKEFAKEFAKE0123abcd";
      facts.insert(
        fact({
          predicate: "deploy_token",
          object: secret,
          scope: { user_id: "u", workspace_id: "w" },
          promotion_state: "workspace_active",
          sensitivity: "secret",
          source: { asserted_by: "user", event_ids: [], raw_quote: `token is ${secret}` },
        }),
      );
      const seenTexts: string[] = [];
      const vectors = {
        enabled: true,
        embedQuery: () => new Float32Array([1]),
        cosineDistanceTo: (_query: Float32Array, text: string) => {
          seenTexts.push(text);
          return 0;
        },
        cosineSimilarityText: () => 0,
      } as unknown as VectorIndex;

      await new Retriever(facts, null, vectors).retrieve(
        { ...ctx(), user_prompt: "deploy token credentials" },
        { includeAllActive: true, k: 10 },
      );

      expect(seenTexts.length).toBeGreaterThan(0);
      expect(seenTexts.join(" ")).not.toContain(secret);
      expect(seenTexts.join(" ")).toContain("[REDACTED:openai]");
    } finally {
      db.close();
    }
  });

  it("redacts prompt and tool text before vector query embedding sees it", async () => {
    const db = openDb(":memory:");
    try {
      const facts = new FactsRepo(db);
      facts.insert(
        fact({
          object: "redact deploy credentials before sharing",
          scope: { user_id: "u", workspace_id: "w" },
          promotion_state: "workspace_active",
          source: { asserted_by: "user", event_ids: [] },
        }),
      );
      const secret = "sk-FAKEFAKEFAKEFAKEFAKE0123abcd";
      const seenQueries: string[] = [];
      const vectors = {
        enabled: true,
        embedQuery: (query: string) => {
          seenQueries.push(query);
          return new Float32Array([1]);
        },
        cosineDistanceTo: () => 0,
        cosineSimilarityText: () => 0,
      } as unknown as VectorIndex;

      await new Retriever(facts, null, vectors).retrieve(
        {
          ...ctx(),
          user_prompt: `deploy with ${secret}`,
          planned_tool: { name: "Bash", args: { command: `echo ${secret}` } },
        },
        { k: 10 },
      );

      expect(seenQueries).toHaveLength(1);
      expect(seenQueries[0]).not.toContain(secret);
      expect(seenQueries[0]).toContain("[REDACTED:openai]");
    } finally {
      db.close();
    }
  });
});
