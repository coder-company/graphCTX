import type { ChatRequest, ChatResponse, LlmProvider, ProviderConfig } from "./provider.js";

// OpenAI / OpenAI-compatible (incl. local: ollama, vLLM, LM Studio) provider.
// Implemented over fetch (no SDK dependency) so it works for any
// OpenAI-compatible endpoint. All calls are async and fail-soft: network errors
// resolve to empty output rather than throwing (the worker is off the hot path).
export function createOpenAiProvider(cfg: ProviderConfig, key?: string): LlmProvider {
  const baseUrl = (cfg.baseUrl || "https://api.openai.com/v1").replace(/\/$/, "");
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (key) headers.authorization = `Bearer ${key}`;

  return {
    id: cfg.provider === "local" ? "local(openai-compatible)" : "openai",
    available: true,
    async chat(req: ChatRequest): Promise<ChatResponse> {
      try {
        const res = await fetch(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            model: cfg.chatModel,
            messages: req.messages,
            temperature: req.temperature ?? 0,
            max_tokens: req.maxTokens ?? 1024,
            ...(req.json ? { response_format: { type: "json_object" } } : {}),
          }),
        });
        if (!res.ok) return { text: "" };
        const data = (await res.json()) as {
          choices?: Array<{ message?: { content?: string } }>;
        };
        return { text: data.choices?.[0]?.message?.content ?? "" };
      } catch {
        return { text: "" };
      }
    },
    async embed(texts: string[]): Promise<number[][]> {
      if (texts.length === 0) return [];
      try {
        const res = await fetch(`${baseUrl}/embeddings`, {
          method: "POST",
          headers,
          body: JSON.stringify({ model: cfg.embedModel, input: texts }),
        });
        if (!res.ok) return texts.map(() => []);
        const data = (await res.json()) as { data?: Array<{ embedding?: number[] }> };
        return texts.map((_, i) => data.data?.[i]?.embedding ?? []);
      } catch {
        return texts.map(() => []);
      }
    },
  };
}
