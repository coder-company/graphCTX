import type { Fact } from "../../core/types.js";

// A "need" the agent must satisfy after compaction. `correct` is what the repo
// structure implies; `wrong` is what a drifted agent guesses with no memory.
export interface Need {
  task: string;
  predicate: string;
  correct: string;
  wrong: string;
}

export interface Scenario {
  name: string;
  plan: string;
  needs: Need[];
  recall_compliance: boolean[];
}

// Does a delivered fact satisfy a need? Predicate must match and the fact's
// value (object or subject) must carry the correct answer.
export function factSatisfiesNeed(fact: Fact, need: Need): boolean {
  if (fact.predicate !== need.predicate) return false;
  const obj = typeof fact.object === "string" ? fact.object : JSON.stringify(fact.object);
  const correct = need.correct.toLowerCase();
  return (
    obj.toLowerCase().includes(correct) ||
    String(fact.subject).toLowerCase().includes(correct) ||
    correct.includes(obj.toLowerCase())
  );
}

export function anyFactSatisfies(facts: Fact[], need: Need): boolean {
  return facts.some((f) => factSatisfiesNeed(f, need));
}
