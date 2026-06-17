import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Fact, NewFact } from "../../src/core/types.js";
import { Invalidator } from "../../src/invalidate/invalidator.js";
import type { LlmInvalidationAgent } from "../../src/invalidate/llm-agent.js";
import { classifyRelation } from "../../src/invalidate/relation.js";
import { EdgesRepo } from "../../src/store/edges.repo.js";
import { EpisodesRepo } from "../../src/store/episodes.repo.js";
import { FactsRepo } from "../../src/store/facts.repo.js";
import { runMigrations } from "../../src/store/migrate.js";

let db: Database.Database;
let facts: FactsRepo;
let edges: EdgesRepo;
let episodes: EpisodesRepo;

beforeEach(() => {
  db = new Database(":memory:");
  runMigrations(db);
  facts = new FactsRepo(db);
  edges = new EdgesRepo(db);
  episodes = new EpisodesRepo(db);
});
afterEach(() => db.close());

const base = (over: Partial<NewFact> = {}): NewFact => ({
  subject: "repo",
  predicate: "test_command",
  object: "npm test",
  fact_kind: "procedural",
  temporal_kind: "static",
  scope: { user_id: "u", workspace_id: "ws1" },
  trust_tier: "high",
  status: "active",
  promotion_state: "workspace_active",
  source: { asserted_by: "deterministic_parser", event_ids: [] },
  ...over,
});

describe("relation classifier (deterministic-first)", () => {
  const mk = (over: Partial<Fact>): Fact => facts.insert(base(over as Partial<NewFact>));

  it("identical s/p/o → same", () => {
    const a = mk({ object: "npm test" });
    const b = mk({ object: "npm test" });
    expect(classifyRelation(a, b).relation).toBe("same");
  });

  it("same scope, high-trust new value → refines", () => {
    const existing = mk({ object: "npm test" });
    const incoming = mk({ object: "pnpm test" });
    const v = classifyRelation(incoming, existing);
    expect(v.relation).toBe("refines");
    expect(v.deterministic).toBe(true);
  });

  it("branch-disjoint → coexists", () => {
    const existing = facts.insert(base({ object: "npm test", git: { branch: "main" } }));
    const incoming = facts.insert(base({ object: "pnpm test", git: { branch: "feature" } }));
    expect(classifyRelation(incoming, existing).relation).toBe("coexists");
  });

  it("low-trust contradictory value → conflicts (no silent winner)", () => {
    const existing = mk({
      object: "npm test",
      trust_tier: "low",
      source: { asserted_by: "deterministic_parser", event_ids: [] },
    });
    const incoming = facts.insert(
      base({
        object: "yarn test",
        trust_tier: "low",
        source: { asserted_by: "deterministic_parser", event_ids: [] },
      }),
    );
    expect(classifyRelation(incoming, existing).relation).toBe("conflicts");
  });

  it("lower-precedence durable memory does not supersede structured repo evidence", () => {
    const existing = mk({
      object: "npm test",
      trust_tier: "high",
      source: { asserted_by: "deterministic_parser", event_ids: [] },
    });
    const incoming = facts.insert(
      base({
        object: "yarn test",
        trust_tier: "high",
        source: { asserted_by: "user", event_ids: [] },
      }),
    );
    const v = classifyRelation(incoming, existing);
    expect(v.relation).toBe("coexists");
    expect(v.reason).toContain("higher-precedence");
  });

  it("different subject/predicate → unrelated (deterministic)", () => {
    const a = facts.insert(base({ predicate: "build_command", object: "npm run build" }));
    const b = facts.insert(base({ predicate: "test_command", object: "npm test" }));
    const v = classifyRelation(a, b);
    expect(v.relation).toBe("unrelated");
    expect(v.deterministic).toBe(true);
  });
});

describe("invalidator effects + injection suppression", () => {
  it("refines: existing fact becomes superseded and stops being active", async () => {
    const existing = facts.insert(base({ object: "npm test" }));
    const incoming = facts.insert(base({ object: "pnpm test" }));
    const inv = new Invalidator({ facts, edges, episodes });
    const res = await inv.processIncomingFact(incoming);

    expect(res.actions.some((a) => a.relation === "refines")).toBe(true);
    expect(facts.get(existing.fact_id)!.status).toBe("superseded");
    // superseded → no longer returned by activeAsOf (won't be injected)
    const active = facts.activeAsOf({ user_id: "u", workspace_id: "ws1" });
    expect(active.find((f) => f.fact_id === existing.fact_id)).toBeUndefined();
    expect(active.find((f) => f.fact_id === incoming.fact_id)).toBeDefined();
    // SUPERSEDES edge recorded
    expect(edges.from(incoming.fact_id, "SUPERSEDES").length).toBe(1);
  });

  it("preserves active structured evidence when lower-precedence memory contradicts it", async () => {
    const existing = facts.insert(
      base({
        object: "npm test",
        trust_tier: "high",
        source: { asserted_by: "deterministic_parser", event_ids: [] },
      }),
    );
    const incoming = facts.insert(
      base({
        object: "yarn test",
        trust_tier: "high",
        source: { asserted_by: "user", event_ids: [] },
      }),
    );
    const inv = new Invalidator({ facts, edges, episodes });
    const res = await inv.processIncomingFact(incoming);

    expect(res.actions.some((a) => a.relation === "refines")).toBe(false);
    expect(facts.get(existing.fact_id)!.status).toBe("active");
    expect(facts.get(incoming.fact_id)!.status).toBe("active");
    expect(edges.from(incoming.fact_id, "SUPERSEDES").length).toBe(0);
  });

  it("resolve(): an open loop is superseded and stops being active", async () => {
    const loop = facts.insert(
      base({ predicate: "open_loop", object: "finish the retry logic", fact_kind: "open_loop" }),
    );
    const inv = new Invalidator({ facts, edges, episodes });
    const resolver = facts.insert(base({ predicate: "outcome", object: "retry logic done" }));
    inv.resolve(loop.fact_id, resolver.fact_id);
    expect(facts.get(loop.fact_id)!.status).toBe("superseded");
    expect(edges.from(loop.fact_id, "SUPERSEDED_BY").length).toBe(1);
  });
});

describe("LLM fallback cited-evidence post-check (hard rule)", () => {
  it("rejects an invalidation whose cited evidence does NOT exist", async () => {
    const existing = facts.insert(base({ object: "npm test", trust_tier: "low" }));
    // make incoming NOT deterministically classifiable: different scope level
    const incoming = facts.insert(
      base({
        object: "deno test",
        trust_tier: "low",
        scope: { user_id: "u", session_id: "s1" },
        promotion_state: "session_only",
      }),
    );
    const liar: LlmInvalidationAgent = {
      async classify() {
        return {
          relation: "invalidates",
          cited_evidence_ids: ["evt_DOES_NOT_EXIST"],
          rationale: "world knowledge",
        };
      },
    };
    const inv = new Invalidator({ facts, edges, episodes, llm: liar });
    await inv.processIncomingFact(incoming);
    // existing must NOT be expired — the bogus citation was rejected
    expect(facts.get(existing.fact_id)!.status).toBe("active");
  });

  it("accepts an invalidation when cited evidence exists in the store", async () => {
    const ev = episodes.append({
      session_id: "s1",
      event_type: "user_correction",
      payload: { note: "we switched runners" },
    });
    const existing = facts.insert(base({ object: "npm test", trust_tier: "low" }));
    const incoming = facts.insert(
      base({
        object: "deno test",
        trust_tier: "low",
        scope: { user_id: "u", session_id: "s1" },
        promotion_state: "session_only",
      }),
    );
    const honest: LlmInvalidationAgent = {
      async classify() {
        return {
          relation: "invalidates",
          cited_evidence_ids: [ev.event_id],
          rationale: "cited correction",
        };
      },
    };
    const inv = new Invalidator({ facts, edges, episodes, llm: honest });
    await inv.processIncomingFact(incoming);
    expect(facts.get(existing.fact_id)!.status).toBe("expired");
  });
});
