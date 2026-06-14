import { describe, expect, it } from "vitest";
import { nullProvider, parseJsonResponse, resolveProvider } from "../../src/llm/provider.js";

describe("llm provider — fail-soft + deterministic-only", () => {
  it("nullProvider is unavailable and never throws", async () => {
    expect(nullProvider.available).toBe(false);
    await expect(nullProvider.chat({ messages: [] })).resolves.toEqual({ text: "" });
    await expect(nullProvider.embed(["a", "b"])).resolves.toEqual([[], []]);
  });

  it("resolveProvider returns nullProvider with no key (deterministic-only)", async () => {
    const p = await resolveProvider({
      provider: "anthropic",
      chatModel: "x",
      embedModel: "y",
      apiKeyEnv: "GRAPHCTX_DEFINITELY_UNSET_KEY",
    });
    expect(p.available).toBe(false);
  });

  it("parseJsonResponse handles fences, prose, and direct json", () => {
    expect(parseJsonResponse('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseJsonResponse('here you go: {"a":2} done')).toEqual({ a: 2 });
    expect(parseJsonResponse('{"a":3}')).toEqual({ a: 3 });
    expect(parseJsonResponse("[1,2,3]")).toEqual([1, 2, 3]);
    expect(parseJsonResponse("not json")).toBeNull();
    expect(parseJsonResponse("")).toBeNull();
  });
});
