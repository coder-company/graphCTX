import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
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

// Negative-control fact: exists ONLY in graphCTX's store, never in any repo
// file. Proves push supplies information the agent cannot get by reading files.
export const NEGATIVE_CONTROL = {
  subject: "repo",
  predicate: "deploy_command",
  object: "./scripts/ship.sh --canary --wait",
  needle: "ship.sh", // must NOT appear in any fixture file
} as const;

// Stale fact: references a path that does not exist in the repo. graphCTX must
// NOT inject it (I4 synchronous verification + commit-anchoring).
export const STALE_FACT = {
  subject: "src/legacy/removed.gen.ts",
  predicate: "do_not_edit",
  object: true,
  needle: "removed.gen.ts", // must NOT exist as a file in any fixture
} as const;

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

// Recursively assert a needle string appears in NO file under a repo dir.
// Used to keep the negative-control honest: if `ship.sh` ever leaks into a
// fixture, the eval throws rather than reporting a false proof.
const SKIP_DIRS = new Set(["node_modules", ".git", ".graphctx", "dist", "build"]);

export function needleAbsentFromRepo(dir: string, needle: string): boolean {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return true;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (!needleAbsentFromRepo(full, needle)) return false;
    } else if (st.isFile() && st.size < 1_000_000) {
      try {
        if (readFileSync(full, "utf8").includes(needle)) return false;
      } catch {
        // unreadable/binary — ignore
      }
    }
  }
  return true;
}
