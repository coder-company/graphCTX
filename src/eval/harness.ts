import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Capsule, Fact } from "../core/types.js";
import { Runtime } from "../runtime.js";
import { type Need, type Scenario, anyFactSatisfies } from "./suites/compaction-recovery.js";

const here = dirname(fileURLToPath(import.meta.url));

export type Arm = "A" | "B" | "C";

export interface ArmResult {
  arm: Arm;
  repos: number;
  totalNeeds: number;
  needsMet: number;
  correctCommands: number;
  repeatedFailedCommands: number;
  postCompactSolveRate: number; // fraction of needs met after compaction
  injectedTokens: number;
}

export interface EvalReport {
  suite: string;
  arms: ArmResult[];
  perRepo: Array<{
    repo: string;
    scenario: string;
    byArm: Record<string, { needsMet: number; totalNeeds: number; repeatedFailed: number }>;
  }>;
}

export interface RunEvalOptions {
  suite: string;
  arms: string[];
  baseDir?: string; // where fixtures/ lives; defaults to repo root
}

interface FixtureRepo {
  dir: string;
  scenario: Scenario;
}

// The decisive M0 ablation (SPEC §22). For each fixture repo we:
//   1. extract durable facts deterministically (real pipeline),
//   2. simulate a session + forced compaction,
//   3. for each post-compaction need, decide whether the agent gets it right
//      under each arm, then aggregate the gate metrics.
export async function runEval(opts: RunEvalOptions): Promise<EvalReport> {
  const arms = opts.arms.filter((a): a is Arm => a === "A" || a === "B" || a === "C");
  const fixturesDir = locateFixtures(opts.baseDir);
  const repos = loadFixtures(fixturesDir);

  const armResults: ArmResult[] = arms.map((arm) => ({
    arm,
    repos: 0,
    totalNeeds: 0,
    needsMet: 0,
    correctCommands: 0,
    repeatedFailedCommands: 0,
    postCompactSolveRate: 0,
    injectedTokens: 0,
  }));
  const perRepo: EvalReport["perRepo"] = [];

  for (const repo of repos) {
    const { facts, capsule } = await groundRepo(repo);
    const repoEntry: EvalReport["perRepo"][number] = {
      repo: basename(repo.dir),
      scenario: repo.scenario.name,
      byArm: {},
    };

    for (const ar of armResults) {
      const outcome = evaluateArm(ar.arm, repo.scenario, facts, capsule);
      ar.repos += 1;
      ar.totalNeeds += outcome.totalNeeds;
      ar.needsMet += outcome.needsMet;
      ar.correctCommands += outcome.correctCommands;
      ar.repeatedFailedCommands += outcome.repeatedFailed;
      ar.injectedTokens += outcome.injectedTokens;
      repoEntry.byArm[ar.arm] = {
        needsMet: outcome.needsMet,
        totalNeeds: outcome.totalNeeds,
        repeatedFailed: outcome.repeatedFailed,
      };
    }
    perRepo.push(repoEntry);
  }

  for (const ar of armResults) {
    ar.postCompactSolveRate = ar.totalNeeds > 0 ? ar.needsMet / ar.totalNeeds : 0;
  }

  return { suite: opts.suite, arms: armResults, perRepo };
}

interface ArmOutcome {
  totalNeeds: number;
  needsMet: number;
  correctCommands: number;
  repeatedFailed: number;
  injectedTokens: number;
}

// Arm semantics (the thesis test):
//  A — no memory: agent retains nothing post-compaction → guesses `wrong` every time.
//  B — pull-only: agent may recall, but only when recall_compliance[i] is true
//      (model-controlled). When it doesn't recall, it guesses `wrong`.
//  C — push: graphCTX pushed a capsule at PostCompact; any need whose answer is
//      in the capsule is satisfied — guaranteed, no compliance needed.
function evaluateArm(arm: Arm, scenario: Scenario, facts: Fact[], capsule: Capsule): ArmOutcome {
  const out: ArmOutcome = {
    totalNeeds: scenario.needs.length,
    needsMet: 0,
    correctCommands: 0,
    repeatedFailed: 0,
    injectedTokens: arm === "C" ? capsule.token_count : 0,
  };

  const pushedFactIds = new Set(capsule.cards.map((c) => c.fact_id));
  const pushedFacts = facts.filter((f) => pushedFactIds.has(f.fact_id));

  scenario.needs.forEach((need, i) => {
    let satisfied = false;
    if (arm === "A") {
      satisfied = false;
    } else if (arm === "B") {
      const recalled = scenario.recall_compliance[i] ?? false;
      // Pull retrieves from the full store, but only if the agent chooses to.
      satisfied = recalled && anyFactSatisfies(facts, need);
    } else {
      // C: only counts if the fact was actually pushed in the capsule.
      satisfied = anyFactSatisfies(pushedFacts, need);
    }

    if (satisfied) {
      out.needsMet += 1;
      if (isCommandNeed(need)) out.correctCommands += 1;
    } else if (isCommandNeed(need)) {
      // a missed command need = the agent runs the wrong command and it fails.
      out.repeatedFailed += 1;
    }
  });

  return out;
}

function isCommandNeed(need: Need): boolean {
  return need.predicate.includes("command") || need.predicate === "package_manager";
}

// Ground a repo: run real deterministic extraction, then build the real
// PostCompact capsule via the planner using the scenario plan as the prompt.
async function groundRepo(repo: FixtureRepo): Promise<{ facts: Fact[]; capsule: Capsule }> {
  const tmp = mkdtempSync(join(tmpdir(), "graphctx-eval-"));
  try {
    cpSync(repo.dir, tmp, { recursive: true });
    rmSync(join(tmp, ".graphctx"), { recursive: true, force: true });
    const rt = new Runtime({ workspaceDir: tmp, userId: "eval-user" });
    await rt.extract();
    const facts = rt.facts.all({ user_id: "eval-user", workspace_id: rt.workspaceId });

    const ctx = await rt.injectionContext("PostCompact", "eval-session", {
      user_prompt: repo.scenario.plan,
      transcript_tail: repo.scenario.needs.map((n) => n.task).join(". "),
    });
    const capsule = await rt.planner().plan(ctx);
    rt.close();
    return { facts, capsule };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function locateFixtures(baseDir?: string): string {
  const candidates = [
    baseDir ? join(baseDir, "fixtures") : null,
    join(here, "..", "..", "fixtures"),
    join(process.cwd(), "fixtures"),
  ].filter(Boolean) as string[];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  throw new Error(`fixtures/ not found (looked in: ${candidates.join(", ")})`);
}

function loadFixtures(fixturesDir: string): FixtureRepo[] {
  const repos: FixtureRepo[] = [];
  for (const entry of readdirSync(fixturesDir)) {
    const dir = join(fixturesDir, entry);
    const scenarioPath = join(dir, "scenario.json");
    if (!existsSync(scenarioPath)) continue;
    const scenario = JSON.parse(readFileSync(scenarioPath, "utf8")) as Scenario;
    repos.push({ dir, scenario });
  }
  return repos.sort((a, b) => a.dir.localeCompare(b.dir));
}

function basename(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}
