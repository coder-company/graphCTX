import { describe, expect, it } from "vitest";
import type { Episode } from "../../src/core/types.js";
import { extractFactsFromEpisodes } from "../../src/extract/llm/fact-extractor.js";
import type { ChatRequest, LlmProvider } from "../../src/llm/provider.js";

describe("LLM fact extraction safety", () => {
  it("skips secret-bearing subjects before returning candidate facts", async () => {
    const facts = await extractFactsFromEpisodes([episode()], {
      provider: providerReturning({
        facts: [
          {
            subject: "ghp_FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE",
            predicate: "owner",
            object: "platform",
            fact_kind: "semantic",
            evidence_ids: ["evt_1"],
          },
          {
            subject: "repo",
            predicate: "test_command",
            object: "npm test",
            fact_kind: "procedural",
            evidence_ids: ["evt_1"],
          },
        ],
      }),
      scope: { user_id: "u", workspace_id: "w" },
    });

    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({
      subject: "repo",
      predicate: "test_command",
      trust_tier: "low",
      promotion_state: "session_only",
      source: { event_ids: ["evt_1"] },
    });
  });
});

function providerReturning(payload: unknown): LlmProvider {
  return {
    id: "fake",
    available: true,
    async chat(_req: ChatRequest) {
      return { text: JSON.stringify(payload) };
    },
    async embed(texts: string[]) {
      return texts.map(() => []);
    },
  };
}

function episode(): Episode {
  return {
    event_id: "evt_1",
    session_id: "s",
    event_type: "prompt_submitted",
    payload: { prompt: "use npm test" },
    created_at: "2026-01-01T00:00:00.000Z",
  };
}
