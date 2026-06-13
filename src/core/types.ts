// Core domain types (SPEC §7). Names mirror the spec exactly.

export type FactKind =
  | "semantic"
  | "episodic"
  | "procedural"
  | "preference"
  | "decision"
  | "constraint"
  | "failure"
  | "task_state"
  // M1 (steal S1): a durable, resurfacing unfinished thread — distinct from the
  // ephemeral `task_state`. Persists until explicitly resolved (SUPERSEDED_BY).
  | "open_loop";

export type TemporalKind = "atemporal" | "static" | "dynamic";
export type TrustTier = "high" | "low";
export type Sensitivity = "public" | "private" | "secret" | "credential" | "unknown";
export type FactStatus =
  | "candidate"
  | "active"
  | "expired"
  | "superseded"
  | "disputed"
  | "rejected";
export type AssertedBy =
  | "user"
  | "agent"
  | "tool"
  | "deterministic_parser"
  | "llm_extractor"
  | "git_watcher";

export type PromotionState =
  | "session_only"
  | "workspace_candidate"
  | "workspace_active"
  | "user_dynamic_candidate"
  | "user_dynamic_active"
  | "user_static_candidate"
  | "user_static_active";

export interface Scope {
  user_id: string;
  workspace_id?: string;
  session_id?: string;
}

export interface GitAnchor {
  repo_id?: string;
  branch?: string;
  base_head?: string;
  introduced_by_commit?: string;
  valid_from_commit?: string;
  valid_until_commit?: string;
  invalidated_by_commit?: string;
  path_globs?: string[];
  file_ids?: string[];
  symbol_ids?: string[];
  hunk_fingerprints?: string[];
  patch_id?: string;
}

export interface FactSource {
  asserted_by: AssertedBy;
  event_ids: string[];
  commit?: string;
  raw_quote?: string;
}

export interface FactTime {
  t_created: string;
  t_recorded: string;
  t_expired?: string;
  invalidated_by?: string;
}

export interface Fact {
  fact_id: string;
  subject: string;
  predicate: string;
  object: unknown;
  fact_kind: FactKind;
  temporal_kind: TemporalKind;
  scope: Scope;
  status: FactStatus;
  promotion_state: PromotionState;
  trust_tier: TrustTier;
  sensitivity: Sensitivity;
  confidence: number;
  evidence_count: number;
  contradiction_count: number;
  injection_count: number;
  last_verified_at?: string;
  last_injected_at?: string;
  time: FactTime;
  git?: GitAnchor;
  source: FactSource;
  tags: string[];
}

// Shape used to create a new fact. Lifecycle defaults applied by the repo (I1).
export interface NewFact {
  subject: string;
  predicate: string;
  object: unknown;
  fact_kind: FactKind;
  temporal_kind: TemporalKind;
  scope: Scope;
  trust_tier: TrustTier;
  sensitivity?: Sensitivity;
  confidence?: number;
  status?: FactStatus;
  promotion_state?: PromotionState;
  git?: GitAnchor;
  source: FactSource;
  tags?: string[];
  evidence_count?: number;
}

// Mutable metadata/lifecycle fields only (I5 — never mutate truth in place).
export interface FactMeta {
  status?: FactStatus;
  promotion_state?: PromotionState;
  confidence?: number;
  evidence_count?: number;
  contradiction_count?: number;
  injection_count?: number;
  last_verified_at?: string;
  last_injected_at?: string;
  t_expired?: string;
  invalidated_by?: string;
  tags?: string[];
}

export interface ScopeFilter {
  user_id?: string;
  workspace_id?: string;
  session_id?: string;
}

export interface ScoredFact {
  fact: Fact;
  score: number;
  signals?: { bm25?: number; entity?: number; semantic?: number; scope?: number };
}

export type Event =
  | "SessionStart"
  | "UserPromptSubmit"
  | "PreToolUse"
  | "PostToolUse"
  | "PreCompact"
  | "PostCompact"
  | "SessionEnd"
  | "FileChanged"
  | "BranchSwitch";

export interface GitState {
  repo_id: string;
  head: string;
  branch: string;
  dirty_files?: string[];
}

export interface InjectionContext {
  event: Event;
  scope: Scope;
  transcript_tail?: string;
  user_prompt?: string;
  current_files?: string[];
  mentioned_symbols?: string[];
  planned_tool?: { name: string; args?: unknown };
  tool_result?: { success: boolean; stderr?: string; stdout_tail?: string };
  git: GitState;
  budget_tokens?: number;
}

export interface CapsuleCard {
  fact_id: string;
  reason: string;
  tokens: number;
}

export interface ConflictNote {
  conflict_id: string;
  summary: string;
}

export interface Capsule {
  markdown: string;
  cards: CapsuleCard[];
  omitted: Array<{ fact_id: string; reason: string }>;
  conflicts: ConflictNote[];
  token_count: number;
}

export type EpisodeEventType =
  | "prompt_submitted"
  | "tool_call"
  | "tool_result"
  | "file_changed"
  | "pre_compact"
  | "post_compact"
  | "session_start"
  | "session_end"
  | "branch_switch"
  | "user_correction";

export interface Episode {
  event_id: string;
  session_id: string;
  workspace_id?: string;
  event_type: EpisodeEventType;
  payload: unknown;
  git_head?: string;
  git_branch?: string;
  created_at: string;
}

export interface NewEpisode {
  session_id: string;
  workspace_id?: string;
  event_type: EpisodeEventType;
  payload: unknown;
  git_head?: string;
  git_branch?: string;
}
