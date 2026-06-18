import type { Fact } from "../core/types.js";
import { isDangerousDirective } from "./sanitize.js";
import { containsSecret } from "./secrets.js";

export function isSecretBearingFact(fact: Fact): boolean {
  if (fact.sensitivity === "secret" || fact.sensitivity === "credential") return true;
  return containsSecret(factText(fact));
}

export function isUnframedDangerousDirectiveFact(fact: Fact): boolean {
  if (fact.trust_tier === "low") return false;
  return isDangerousDirective(factText(fact));
}

export function safeForSend(fact: Fact): boolean {
  return !isSecretBearingFact(fact) && !isUnframedDangerousDirectiveFact(fact);
}

function factText(fact: Fact): string {
  const obj = typeof fact.object === "string" ? fact.object : JSON.stringify(fact.object);
  return `${fact.subject} ${fact.predicate} ${obj} ${fact.source.raw_quote ?? ""} ${fact.tags.join(" ")}`;
}
