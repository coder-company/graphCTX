// Provider-agnostic LLM interface (SPEC §10). graphCTX is local-first and
// offline-by-default: ALL LLM work is async, OFF the hot path, and FAIL-SOFT —
// with no configured key/provider the system runs in DETERMINISTIC-ONLY mode
// (the provider resolves to a null implementation that always abstains).

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatRequest {
  messages: ChatMessage[];
  // Ask the provider for strict JSON (providers that support it set the flag).
  json?: boolean;
  jsonSchema?: Record<string, unknown>;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface ChatResponse {
  text: string;
}

export interface LlmProvider {
  readonly id: string;
  readonly available: boolean;
  chat(req: ChatRequest): Promise<ChatResponse>;
  embed(texts: string[]): Promise<number[][]>;
}

export interface ProviderConfig {
  provider: "anthropic" | "openai" | "local";
  chatModel: string;
  embedModel: string;
  apiKeyEnv: string;
  baseUrl?: string;
  timeoutMs?: number;
}

export interface RequestAbort {
  signal?: AbortSignal;
  cleanup(): void;
}

// The null provider — used whenever no key is present. NEVER throws; callers
// treat `available === false` as "deterministic-only mode" (I9).
export const nullProvider: LlmProvider = {
  id: "null",
  available: false,
  async chat() {
    return { text: "" };
  },
  async embed(texts: string[]) {
    return texts.map(() => []);
  },
};

// Resolve a provider from config. Lazy: the concrete SDK adapter is imported
// only when a key is actually present, so a missing optional dep or missing key
// can never crash the module graph. Returns nullProvider on any problem.
export async function resolveProvider(cfg: ProviderConfig): Promise<LlmProvider> {
  const key = process.env[cfg.apiKeyEnv];
  // local/openai-compatible may use a base_url without a key.
  const hasCredential = !!key || (cfg.provider === "local" && !!cfg.baseUrl);
  if (!hasCredential) return nullProvider;

  try {
    switch (cfg.provider) {
      case "openai":
      case "local": {
        const { createOpenAiProvider } = await import("./openai.js");
        return createOpenAiProvider(cfg, key);
      }
      case "anthropic": {
        const { createAnthropicProvider } = await import("./anthropic.js");
        return createAnthropicProvider(cfg, key);
      }
      default:
        return nullProvider;
    }
  } catch {
    return nullProvider; // fail-soft → deterministic-only mode
  }
}

// Best-effort strict-JSON extraction from a model response (handles ```json
// fences and leading prose). Returns null when nothing parses.
export function parseJsonResponse<T>(text: string): T | null {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced ? fenced[1] : text)?.trim() ?? "";
  // try direct, then first {...} / [...] block
  for (const slice of [candidate, firstJsonBlock(candidate)]) {
    if (!slice) continue;
    try {
      return JSON.parse(slice) as T;
    } catch {
      // try next
    }
  }
  return null;
}

export function requestAbort(timeoutMs?: number, parent?: AbortSignal): RequestAbort {
  const timeout = timeoutMs && Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : undefined;
  if (!timeout && !parent) return { cleanup() {} };

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let parentListener: (() => void) | undefined;

  if (parent) {
    if (parent.aborted) {
      controller.abort(parent.reason);
    } else {
      parentListener = () => controller.abort(parent.reason);
      parent.addEventListener("abort", parentListener, { once: true });
    }
  }

  if (timeout) {
    timer = setTimeout(
      () => controller.abort(new Error("graphCTX LLM request timed out")),
      timeout,
    );
    timer.unref?.();
  }

  return {
    signal: controller.signal,
    cleanup() {
      if (timer) clearTimeout(timer);
      if (parent && parentListener) parent.removeEventListener("abort", parentListener);
    },
  };
}

function firstJsonBlock(s: string): string | null {
  const start = s.search(/[[{]/);
  if (start < 0) return null;
  const open = s[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    if (s[i] === open) depth++;
    else if (s[i] === close) {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}
