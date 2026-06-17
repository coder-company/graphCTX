import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultConfig } from "../../src/config/defaults.js";
import { createAnthropicProvider } from "../../src/llm/anthropic.js";
import { nullProvider, parseJsonResponse, resolveProvider } from "../../src/llm/provider.js";

describe("llm provider — fail-soft + deterministic-only", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("defaults to Claude Haiku 4.5 for Anthropic chat", () => {
    expect(defaultConfig().llm.chat_model).toBe("claude-haiku-4-5");
  });

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

  it("anthropic provider sends structured output schema when supplied", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify({ content: [{ text: '{"facts":[]}' }] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = createAnthropicProvider(
      {
        provider: "anthropic",
        chatModel: "claude-haiku-4-5",
        embedModel: "unused",
        apiKeyEnv: "ANTHROPIC_API_KEY",
      },
      "test-key",
    );
    await provider.chat({
      messages: [{ role: "user", content: "extract" }],
      json: true,
      jsonSchema: {
        type: "object",
        required: ["facts"],
        additionalProperties: false,
        properties: { facts: { type: "array" } },
      },
    });

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(request.body)) as {
      model: string;
      output_config?: { format?: { type?: string; schema?: unknown } };
    };
    expect(body.model).toBe("claude-haiku-4-5");
    expect(body.output_config?.format?.type).toBe("json_schema");
    expect(body.output_config?.format?.schema).toMatchObject({
      required: ["facts"],
      additionalProperties: false,
    });
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
