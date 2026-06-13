# graphCTX — Infrastructure & Deployment Tiers

> How graphCTX scales from a local single binary to a synced, multi-device, team-grade
> service — **without** changing the core (injection loop, promotion, temporal logic).
> Cloudflare and Supabase are **optional backends behind one interface**, not a rewrite.

| | |
|---|---|
| **Status** | v1.0 |
| **Last updated** | 2026-06-13 |
| **Companion docs** | [PRD.md](PRD.md) · [GAMEPLAN.md](GAMEPLAN.md) · [SPEC.md](SPEC.md) |

---

## 1. Guiding principle

> **Local-first by default. Cloud is opt-in. The core never knows which backend it's on.**

- **M0 stays 100% local.** The decisive experiment (does push beat pull?) needs only SQLite + git + hooks. No network, no auth, no deploy. Adding cloud now would only add latency to the hook critical path (<150ms budget) and friction to adoption.
- **Install friction kills dev tools** (Decision D3). `npx graphctx install claude` must work offline.
- Cloud unlocks the things local cannot do: **multi-device sync, remote MCP (no install), team-shared graphs, stable cross-device identity, scale.**

This preserves Decisions D3/D4 (local-first, own-the-runtime) while *extending* them.

---

## 2. The `StorageBackend` interface (the seam)

graphCTX already isolates persistence behind repositories (SPEC §6.2). We formalize one seam so any backend is swappable by config:

```ts
// store/backend.ts
export interface StorageBackend {
  readonly kind: "local-sqlite" | "cloudflare" | "supabase";

  facts:      FactsRepo;
  entities:   EntitiesRepo;
  edges:      EdgesRepo;
  episodes:   EpisodesRepo;
  procedures: ProceduresRepo;
  injections: InjectionsRepo;
  vectors:    VectorIndex;

  // coordination primitive (single-writer per workspace) — see §5
  withWorkspaceLock<T>(workspaceId: string, fn: (v: GraphVersion) => T): Promise<T>;

  migrate(): Promise<void>;
  health(): Promise<HealthReport>;
}
```

Everything above the store — capture, extract, invalidate, promote, retrieve, resolve, inject, render — is **backend-agnostic**. Switching tiers is a config change (`baseURL` / backend type), exactly like Supermemory's local→hosted by changing `baseURL`.

Implementations:
- `LocalSqlite` — v1 default (unchanged from SPEC).
- `CloudflareBackend` — D1 + Durable Objects + Vectorize.
- `SupabaseBackend` — Postgres + pgvector + Auth + RLS.

---

## 3. Deployment tiers

| Tier | Backend | Unlocks | Default? |
|---|---|---|---|
| **T1 — Local** | SQLite single binary | Offline, private, zero-dep, fastest hooks | ✅ v1 default |
| **T2 — Sync** | Local + Cloudflare (D1/DO/Vectorize/Workers) | Multi-device, remote MCP (no install), edge embeddings, scale | v2 opt-in |
| **T3 — Team** | Supabase (Postgres/pgvector/Auth/RLS/Realtime) | Shared workspace graphs, identity, collaboration, RBAC | v2+ opt-in |

T2 and T3 are **composable**: a team can use Supabase for durable team data + Cloudflare Workers for the edge MCP serving layer.

---

## 4. Cloudflare — the edge serving + coordination layer

| Service | Role in graphCTX |
|---|---|
| **D1** | Cloud SQLite. Our `0001_init.sql` runs nearly as-is (same SQL dialect) → cleanest sync backend. |
| **Durable Objects** | **One DO per `workspace_id`** = the single-writer serialization point. Solves parallel-session conflicts (optimistic concurrency, `base_graph_version`) without distributed locks. Hosts git-state coordination + the anti-repetition ledger. |
| **Vectorize** | Vector search at scale (replaces `sqlite-vec` in cloud tiers). |
| **Queues** | Async extraction + promotion + staleness sweeps (replaces the in-proc worker). |
| **Workers** | Host the **remote MCP server** (`mcp.graphctx.*`) → users add memory with zero local install (cf. Supermemory's hosted MCP). |
| **Workers AI** | Cheap edge embeddings / small extraction models. |
| **R2** | Episode-log blob storage + backups. |
| **KV** | Hot caches: ledger, warm capsule fragments, config. |

### Why Durable Objects matter most
Our hardest concurrency problem (GAMEPLAN §16, SPEC §14) is **parallel sessions writing contradictory workspace facts**. A per-workspace DO gives us a natural single-writer with strong ordering — every durable write goes through `withWorkspaceLock(workspaceId)`, which the DO implements as in-order execution. No silent last-writer-wins; `base_graph_version` checks are trivial inside the DO. This is the single most elegant fit between our design and Cloudflare's primitives.

---

## 5. Supabase — the durable team data + identity layer

| Service | Role in graphCTX |
|---|---|
| **Postgres + pgvector** | Multi-tenant durable store for the team tier; richer queries (recursive CTEs for graph walks, JSONB on facts) than D1. |
| **Auth** | Stable `user_id` across devices → directly addresses our **cross-session identity resolution** open problem (GAMEPLAN §16). |
| **Row Level Security** | Hard multi-tenant isolation of user/workspace graphs (`scope_user_id` / `scope_workspace_id` as RLS predicates). |
| **Realtime** | Live fact propagation for multi-agent/team sync (two devs' agents sharing a workspace graph see updates). |
| **Edge Functions** | Optional server-side extraction/promotion if not using CF Queues. |

### Schema port
The SPEC §6 schema ports to Postgres with minimal change:
- `TEXT`→`text`, `*_json TEXT`→`jsonb`, FTS5→Postgres `tsvector` + GIN, `fact_vectors`→`vector(1536)` (pgvector + HNSW index).
- RLS policies keyed on `scope_user_id` (from Supabase Auth `auth.uid()`) and team membership tables.
- Append-only invariant (I5) enforced by policy: only `INSERT` + metadata `UPDATE`; no truth mutation.

---

## 6. Reference topology (T2 + T3 combined)

```
  Local client (Claude Code)                     Other devices / teammates
     hooks │ local MCP                                   │
           ▼                                             ▼
  ┌──────────────────────┐                      ┌──────────────────────┐
  │ graphctx (local)      │   sync (CRDT-ish)   │ graphctx (local)      │
  │ LocalSqlite (cache)   │◄───────────────────►│ LocalSqlite (cache)   │
  └──────────┬───────────┘                      └──────────┬───────────┘
             │ push/pull deltas                            │
             ▼                                             ▼
  ┌─────────────────────────────────────────────────────────────────┐
  │ Cloudflare Workers — remote MCP + sync API                        │
  │   Durable Object per workspace_id  ── single-writer coordination  │
  │   Queues ── async extract/promote   Vectorize ── vector search    │
  │   Workers AI ── embeddings          R2 ── episode blobs / backups │
  └───────────────────────────┬─────────────────────────────────────┘
                               │ durable team data
                               ▼
  ┌─────────────────────────────────────────────────────────────────┐
  │ Supabase                                                          │
  │   Postgres + pgvector (team graphs)   Auth (stable user_id)       │
  │   RLS (tenant isolation)              Realtime (live sync)        │
  └─────────────────────────────────────────────────────────────────┘
```

**Local remains source-of-truth for a solo dev.** In sync/team mode, local is a fast cache + offline buffer; the workspace DO is the ordering authority; Supabase is the durable team record.

---

## 7. Sync model (T2/T3)

- **Local-first, eventually consistent.** Local writes are immediate (candidate facts); deltas push to the workspace DO which serializes and persists to D1/Supabase.
- **Conflict handling reuses our existing logic** (SPEC §14): branch-disjoint → partition; deterministic winner → invalidate; else → `disputed`. The DO is just where that runs authoritatively.
- **Offline:** local continues to function fully; queued deltas flush on reconnect.
- **Privacy:** sync is opt-in per workspace; secrets (I3) never sync; episode raw text can be configured to stay local (only extracted facts sync).

---

## 8. Security & privacy across tiers

- **I3 holds everywhere:** secrets/credentials never promoted, never injected, **never synced.**
- **Encryption:** TLS in transit; per-workspace encryption at rest for synced data; optional client-side encryption so the server stores ciphertext (zero-knowledge mode for sensitive teams).
- **Tenant isolation:** Supabase RLS + per-workspace DO boundaries.
- **Data residency / deletion:** `forget --hard` propagates a tombstone through DO → D1/Supabase; user can export/delete all data (`graphctx export` / `graphctx purge --cloud`).
- **Trust tiers (I2) unchanged:** prose stays low-trust regardless of backend.

---

## 9. What this does NOT change

- The **thesis** (push > pull) and the **moat** (injection loop + promotion discipline).
- The **core modules** (capture/extract/invalidate/promote/retrieve/resolve/inject/render) — all backend-agnostic.
- The **invariants I1–I9**.
- **M0** — stays local-only. Cloud work does not start until after the M0 gate passes.

---

## 10. Decisions (added to GAMEPLAN log)

| # | Decision | Rationale |
|---|---|---|
| D17 | **Local-first default; cloud is opt-in via a `StorageBackend` interface** | Preserve M0 simplicity + adoption; extend, don't pivot |
| D18 | **Cloudflare = edge serving + coordination** (D1, Durable Objects, Vectorize, Queues, Workers, R2/KV, Workers AI) | DO-per-workspace elegantly solves parallel-session conflict; remote MCP removes install friction |
| D19 | **Supabase = durable team data + identity** (Postgres/pgvector, Auth, RLS, Realtime) | Auth gives stable `user_id` (cross-session identity problem); RLS for tenant isolation; Realtime for team sync |
| D20 | **Per-workspace Durable Object is the single-writer authority** in synced tiers | Clean ordering + optimistic concurrency without distributed locks |
| D21 | **Cloud work begins only after M0 gate passes** | Don't build infra for an unvalidated thesis |

---

## 11. Roadmap fit

- **M0–M3:** local only (per SPEC §27). No cloud code.
- **M4:** multi-client adapters — and the `StorageBackend` interface is formalized here (cheap refactor of existing repos).
- **v2 (post-validation):** T2 Sync — Cloudflare backend, remote MCP, multi-device.
- **v2+ :** T3 Team — Supabase backend, Auth, RLS, Realtime, RBAC.

> **Bottom line:** Cloudflare + Supabase make graphCTX a real product (sync, teams, no-install MCP) — but they live *behind the seam*. The local single binary remains the default and the place the thesis is won.
