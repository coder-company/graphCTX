import type { ChatRequest, ChatResponse, LlmProvider, ProviderConfig } from "./provider.js";

// Anthropic (Claude) provider over fetch (no SDK dependency). Async + fail-soft:
// any error resolves to empty output (the extraction/invalidation worker is off
// the hot path, so a model hiccup never breaks the agent — I9). Anthropic has no
// embeddings endpoint, so embeddings fall back to empty (callers use the local
// deterministic embedder for the vector path).
export function createAnthropicProvider(cfg: ProviderConfig, key?: string): LlmProvider {
  const baseUrl = (cfg.baseUrl || "https://api.anthropic.com").replace(/\/$/, "");
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "anthropic-version": "2023-06-01",
  };
  if (key) headers["x-api-key"] = key;

  return {
    id: "anthropic",
    available: true,
    async chat(req: ChatRequest): Promise<ChatResponse> {
      try {
        const system = req.messages
          .filter((m) => m.role === "system")
          .map((m) => m.content)
          .join("\n\n");
        const messages = req.messages
          .filter((m) => m.role !== "system")
          .map((m) => ({ role: m.role, content: m.content }));
        const res = await fetch(`${baseUrl}/v1/messages`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            model: cfg.chatModel,
            max_tokens: req.maxTokens ?? 1024,
            temperature: req.temperature ?? 0,
            ...(system ? { system } : {}),
            messages,
          }),
        });
        if (!res.ok) return { text: "" };
        const data = (await res.json()) as { content?: Array<{ text?: string }> };
        return { text: data.content?.map((c) => c.text ?? "").join("") ?? "" };
      } catch {
        return { text: "" };
      }
    },
    async embed(texts: string[]): Promise<number[][]> {
      // Anthropic has no first-party embeddings API; the local deterministic
      // embedder owns the vector path. Return empty so callers fall back.
      return texts.map(() => []);
    },
  };
}
