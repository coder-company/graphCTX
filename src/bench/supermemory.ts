// Live Supermemory client — dependency-free (global fetch, no SDK → no new deps).
// The API key is read ONLY from the environment (SUPERMEMORY_API_KEY). It is
// never written to disk, logged, or printed. Used by the live bake-off harness.

const ADD_URL = "https://api.supermemory.ai/v3/documents";
const SEARCH_URL = "https://api.supermemory.ai/v4/search";

export interface SmSearchResult {
  id: string;
  memory?: string;
  chunk?: string;
  similarity: number;
}

export interface SmSearchResponse {
  results: SmSearchResult[];
  timing?: number;
  total?: number;
}

export class SupermemoryClient {
  private readonly key: string;

  constructor(key?: string) {
    const k = key ?? process.env.SUPERMEMORY_API_KEY;
    if (!k) {
      throw new Error(
        "SUPERMEMORY_API_KEY not set — export it to run the live bake-off (never commit it).",
      );
    }
    this.key = k;
  }

  static available(): boolean {
    return Boolean(process.env.SUPERMEMORY_API_KEY);
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.key}`,
      "Content-Type": "application/json",
    };
  }

  // Ingest a document. Returns wall-clock latency in ms for the add call.
  async add(content: string, containerTag: string, customId?: string): Promise<{ ms: number }> {
    const start = performance.now();
    const res = await fetch(ADD_URL, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ content, containerTag, customId }),
    });
    const ms = performance.now() - start;
    if (!res.ok) throw new Error(`supermemory add failed: HTTP ${res.status}`);
    await res.json().catch(() => ({}));
    return { ms };
  }

  // Hybrid search. Returns the results plus measured client-side latency.
  async search(
    q: string,
    containerTag: string,
    opts: { limit?: number; threshold?: number } = {},
  ): Promise<{ results: SmSearchResult[]; ms: number; serverMs?: number }> {
    const start = performance.now();
    const res = await fetch(SEARCH_URL, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        q,
        containerTag,
        searchMode: "hybrid",
        limit: opts.limit ?? 5,
        threshold: opts.threshold ?? 0.3,
      }),
    });
    const ms = performance.now() - start;
    if (!res.ok) throw new Error(`supermemory search failed: HTTP ${res.status}`);
    const body = (await res.json()) as SmSearchResponse;
    return { results: body.results ?? [], ms, serverMs: body.timing };
  }
}
