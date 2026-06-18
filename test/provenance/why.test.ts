import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { NewFact } from "../../src/core/types.js";
import { Invalidator } from "../../src/invalidate/invalidator.js";
import { formatWhy, redactWhyReport, why } from "../../src/provenance/why.js";
import { EdgesRepo } from "../../src/store/edges.repo.js";
import { EpisodesRepo } from "../../src/store/episodes.repo.js";
import { FactsRepo } from "../../src/store/facts.repo.js";
import { runMigrations } from "../../src/store/migrate.js";
import { PromotionsRepo } from "../../src/store/promotions.repo.js";

let db: Database.Database;
let facts: FactsRepo;
let episodes: EpisodesRepo;
let edges: EdgesRepo;
let promotions: PromotionsRepo;

const scope = { user_id: "u", workspace_id: "ws1" };

beforeEach(() => {
  db = new Database(":memory:");
  runMigrations(db);
  facts = new FactsRepo(db);
  episodes = new EpisodesRepo(db);
  edges = new EdgesRepo(db);
  promotions = new PromotionsRepo(db);
});
afterEach(() => db.close());

const deps = () => ({ facts, episodes, edges, promotions });

const f = (over: Partial<NewFact>): NewFact => ({
  subject: "repo",
  predicate: "test_command",
  object: "npm test",
  fact_kind: "procedural",
  temporal_kind: "static",
  scope,
  trust_tier: "high",
  status: "active",
  promotion_state: "workspace_active",
  source: { asserted_by: "deterministic_parser", event_ids: [] },
  ...over,
});

describe("why() provenance reader", () => {
  it("returns null for an unknown fact", () => {
    expect(why("nope", deps())).toBeNull();
  });

  it("resolves evidence events that exist and flags missing ones", () => {
    const ev = episodes.append({ session_id: "s1", event_type: "user_correction", payload: {} });
    const fact = facts.insert(
      f({
        source: {
          asserted_by: "user",
          event_ids: [ev.event_id, "evt_missing"],
          raw_quote: "use npm test here",
        },
      }),
    );
    const r = why(fact.fact_id, deps())!;
    expect(r.evidence.length).toBe(1);
    expect(r.missing_evidence_ids).toEqual(["evt_missing"]);
    expect(r.complete).toBe(false);
    expect(r.raw_quote).toBe("use npm test here");
  });

  it("includes the git anchor and edges (supersession chain)", async () => {
    const existing = facts.insert(
      f({ object: "npm test", git: { branch: "main", valid_from_commit: "abc123" } }),
    );
    const incoming = facts.insert(f({ object: "pnpm test" }));
    const inv = new Invalidator({ facts, edges, episodes });
    await inv.processIncomingFact(incoming);

    const rExisting = why(existing.fact_id, deps())!;
    expect(rExisting.git_anchor?.branch).toBe("main");
    // existing was superseded → has a SUPERSEDED_BY edge
    expect(rExisting.edges.some((e) => e.edge_kind === "SUPERSEDED_BY")).toBe(true);

    const rIncoming = why(incoming.fact_id, deps())!;
    expect(rIncoming.edges.some((e) => e.edge_kind === "SUPERSEDES")).toBe(true);
    expect(rIncoming.complete).toBe(true); // no cited evidence to miss
  });

  it("reports when a fact was observed separately from when it was recorded", () => {
    const fact = facts.insert(
      f({
        observed_at: "2025-12-31T23:59:00.000Z",
        source: {
          asserted_by: "user",
          event_ids: [],
          raw_quote: "observed before it was recorded",
        },
      }),
    );
    const r = why(fact.fact_id, deps())!;
    expect(r.fact.time.t_observed).toBe("2025-12-31T23:59:00.000Z");
    expect(r.fact.time.t_recorded).not.toBe(r.fact.time.t_observed);
  });

  it("formats expiry and invalidation timing for historical facts", () => {
    const fact = facts.insert(f({ git: { branch: "main", valid_from_commit: "c1" } }));
    const invalidator = facts.insert(f({ predicate: "superseding_command", object: "pnpm test" }));
    facts.expire(fact.fact_id, invalidator.fact_id, "c2");

    const formatted = formatWhy(why(fact.fact_id, deps())!);

    expect(formatted).toContain("expired:");
    expect(formatted).toContain(`invalidated_by=${invalidator.fact_id.slice(0, 8)}`);
    expect(formatted).toContain("until=c2");
    expect(formatted).toContain("invalidated_commit=c2");
  });

  it("includes the promotion audit trail (which gate fired)", () => {
    const fact = facts.insert(f({}));
    promotions.record({
      fact_id: fact.fact_id,
      from_state: "session_only",
      to_state: "workspace_active",
      decision: "promote",
      gate: "config_evidence",
      reason: "high-trust deterministic repo evidence",
    });
    const r = why(fact.fact_id, deps())!;
    expect(r.promotions.length).toBe(1);
    expect(r.promotions[0]!.gate).toBe("config_evidence");
  });

  it("redacts secrets from formatted and structured provenance output", () => {
    const secret = "sk-FAKEFAKEFAKEFAKEFAKE0123abcd";
    const ev = episodes.append({
      session_id: `s-${secret}`,
      workspace_id: `w-${secret}`,
      event_type: "user_correction",
      payload: { token: secret },
      git_head: `head-${secret}`,
      git_branch: `feature/${secret}`,
    });
    const fact = facts.insert(
      f({
        subject: `repo-${secret}`,
        predicate: `api_key_${secret}`,
        object: secret,
        scope: {
          user_id: `u-${secret}`,
          workspace_id: `w-${secret}`,
          session_id: `s-${secret}`,
        },
        source: {
          asserted_by: "user",
          event_ids: [ev.event_id, `missing-${secret}`],
          commit: `commit-${secret}`,
          raw_quote: `token is ${secret}`,
        },
        tags: [secret],
        git: {
          branch: `feature/${secret}`,
          path_globs: [`docs/${secret}.md`],
          patch_id: secret,
        },
      }),
    );
    promotions.record({
      fact_id: fact.fact_id,
      from_state: "session_only",
      to_state: "workspace_active",
      decision: "promote",
      gate: `gate-${secret}`,
      reason: `reason includes ${secret}`,
    });
    const r = why(fact.fact_id, deps())!;
    const formatted = formatWhy(r);
    const structured = redactWhyReport(r);

    expect(formatted).not.toContain(secret);
    expect(JSON.stringify(structured)).not.toContain(secret);
    expect(formatted).toContain("[REDACTED:openai]");
    expect(structured.fact.subject).toContain("[REDACTED:openai]");
    expect(structured.fact.predicate).toContain("[REDACTED:openai]");
    expect(structured.fact.scope.user_id).toContain("[REDACTED:openai]");
    expect(structured.fact.scope.workspace_id).toContain("[REDACTED:openai]");
    expect(structured.fact.scope.session_id).toContain("[REDACTED:openai]");
    expect(structured.fact.object).toBe("[REDACTED:openai]");
    expect(structured.fact.tags[0]).toBe("[REDACTED:openai]");
    expect(structured.fact.source.event_ids[1]).toContain("[REDACTED:openai]");
    expect(structured.fact.source.commit).toContain("[REDACTED:openai]");
    expect(structured.git_anchor?.branch).toContain("[REDACTED:openai]");
    expect(structured.fact.git?.path_globs?.[0]).toContain("[REDACTED:openai]");
    expect(structured.fact.git?.patch_id).toBe("[REDACTED:openai]");
    expect(structured.promotions[0]?.gate).toContain("[REDACTED:openai]");
    expect(structured.promotions[0]?.reason).toContain("[REDACTED:openai]");
    expect(JSON.stringify(structured.evidence[0]?.payload)).not.toContain(secret);
    expect(structured.evidence[0]?.session_id).toContain("[REDACTED:openai]");
    expect(structured.evidence[0]?.workspace_id).toContain("[REDACTED:openai]");
    expect(structured.evidence[0]?.git_head).toContain("[REDACTED:openai]");
    expect(structured.evidence[0]?.git_branch).toContain("[REDACTED:openai]");
    expect(structured.missing_evidence_ids[0]).toContain("[REDACTED:openai]");
    expect(structured.raw_quote).toContain("[REDACTED:openai]");
  });
});
