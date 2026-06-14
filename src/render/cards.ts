import type { Fact } from "../core/types.js";
import { asClaim } from "../security/sanitize.js";
import { estimateTokens } from "./tokens.js";

export type CardSection =
  | "open_loops"
  | "task_state"
  | "repo_constraints"
  | "procedure"
  | "user_preferences"
  | "conflict_notes";

export interface RenderedCard {
  fact_id: string;
  section: CardSection;
  markdown: string; // single bullet line, ends with [mem:id] (I7)
  tokens: number;
}

// Maps a fact to its capsule section.
export function sectionFor(fact: Fact): CardSection {
  if (fact.fact_kind === "open_loop") return "open_loops";
  if (fact.fact_kind === "task_state" || fact.fact_kind === "failure") return "task_state";
  if (fact.fact_kind === "procedural") return "procedure";
  if (fact.promotion_state.startsWith("user_")) return "user_preferences";
  return "repo_constraints";
}

// Render a single fact as a ≤250-token, action-shaped, provenance-tagged bullet (I7).
export function renderCard(fact: Fact): RenderedCard {
  const section = sectionFor(fact);
  const body = cardBody(fact);
  const provenance = ` [mem:${shortId(fact.fact_id)}]`;
  let markdown = `- ${body}${provenance}`;
  // Hard per-card cap (SPEC §9: ≤250 tokens).
  if (estimateTokens(markdown) > 250) {
    markdown = `${markdown.slice(0, 900)}…${provenance}`;
  }
  return { fact_id: fact.fact_id, section, markdown, tokens: estimateTokens(markdown) };
}

function cardBody(fact: Fact): string {
  const obj = stringify(fact.object);
  // Low-trust prose is framed as a claim, never a directive (I2).
  if (fact.trust_tier === "low") {
    return asClaim(obj);
  }
  if (fact.fact_kind === "open_loop") {
    return `Unfinished: ${obj}`;
  }
  switch (fact.predicate) {
    case "test_command":
      return `Run tests with: ${obj}. Verified @ ${verifiedAt(fact)}.`;
    case "build_command":
      return `Build with: ${obj}.`;
    case "dev_command":
      return `Dev server: ${obj}.`;
    case "lint_command":
      return `Lint with: ${obj}.`;
    case "typecheck_command":
      return `Typecheck with: ${obj}.`;
    case "package_manager":
      return `This repo uses ${obj} (not other package managers).`;
    case "indent_style":
      return `Indentation: ${obj} (enforced by .editorconfig).`;
    case "ci_command":
      return `CI runs: ${obj}.`;
    case "do_not_edit":
      return `Do not edit ${fact.subject} — it is generated.`;
    default:
      return `${fact.subject} ${fact.predicate.replace(/_/g, " ")}: ${obj}`;
  }
}

function verifiedAt(fact: Fact): string {
  const sha = fact.git?.valid_from_commit ?? fact.source.commit;
  return sha ? sha.slice(0, 7) : "HEAD";
}

function stringify(o: unknown): string {
  if (typeof o === "string") return o;
  if (o === true) return "true";
  return JSON.stringify(o);
}

function shortId(id: string): string {
  // fact_<ulid> -> last 8 chars for readable provenance.
  return id.slice(-8);
}
