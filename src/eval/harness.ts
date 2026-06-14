import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Capsule, Fact } from "../core/types.js";
import { Runtime } from "../runtime.js";
import {
  NEGATIVE_CONTROL,
  type Need,
  STALE_FACT,
  type Scenario,
  anyFactSatisfies,
  needleAbsentFromRepo,
} from "./suites/compaction-recovery.js";

const here = dirname(fileURLToPath(import.meta.url));

// A/B/C are the headline ablation; N and S are integrity controls:
//   N — negative-control: a fact in graphCTX's store but in NO repo file. Push
//       must deliver it; file-reading (pull-by-inspection) provably cannot.
//   S — stale-fact: a fact whose target path no longer exists. graphCTX must
//       NOT inject it (proves I4 verification, not blind recall).
export type Arm = "A" | "B" | "C" | "N" | "S";

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

// Integrity-control results (per the N/S arms). These are pass/fail counts
// across repos, not solve-rates.
export interface ControlResult {
  arm: "N" | "S";
  repos: number;
  passed: number; // repos where the control behaved correctly
  // N: delivered the unfindable fact via push AND it was absent from files.
  // S: correctly SUPPRESSED the stale fact (did not inject it).
  detail: string;
}

export interface EvalReport {
  suite: string;
  arms: ArmResult[];
  controls: ControlResult[];
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
  const requested = new Set(opts.arms.map((a) => a.trim().toUpperCase()));
  const solveArms = (["A", "B", "C"] as const).filter((a) => requested.has(a));
  const runN = requested.has("N");
  const runS = requested.has("S");
  const fixturesDir = locateFixtures(opts.baseDir);
  const repos = loadFixtures(fixturesDir);

  const armResults: ArmResult[] = solveArms.map((arm) => ({
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

  let nPassed = 0;
  let sPassed = 0;

  for (const repo of repos) {
    const ground = await groundRepo(repo);
    const repoEntry: EvalReport["perRepo"][number] = {
      repo: basename(repo.dir),
      scenario: repo.scenario.name,
      byArm: {},
    };

    for (const ar of armResults) {
      const outcome = evaluateArm(ar.arm, repo.scenario, ground.facts, ground.capsule);
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

    if (runN && ground.negativeControlPass) nPassed += 1;
    if (runS && ground.staleSuppressedPass) sPassed += 1;
  }

  for (const ar of armResults) {
    ar.postCompactSolveRate = ar.totalNeeds > 0 ? ar.needsMet / ar.totalNeeds : 0;
  }

  const controls: ControlResult[] = [];
  if (runN) {
    controls.push({
      arm: "N",
      repos: repos.length,
      passed: nPassed,
      detail:
        "memory-only fact (./scripts/ship.sh) absent from every repo file AND delivered by push",
    });
  }
  if (runS) {
    controls.push({
      arm: "S",
      repos: repos.length,
      passed: sPassed,
      detail: "stale fact (missing path) correctly suppressed — not injected (I4)",
    });
  }

  return { suite: opts.suite, arms: armResults, controls, perRepo };
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

interface GroundResult {
  facts: Fact[];
  capsule: Capsule;
  negativeControlPass: boolean;
  staleSuppressedPass: boolean;
}

// Ground a repo. We run extraction once, then build TWO capsules:
//  - the solve-arm capsule (scenario prompt only) keeps A/B/C measuring exactly
//    the scenario needs, unpolluted by the control facts;
//  - the control capsule (a deploy prompt, with N+S facts seeded) is used purely
//    to verify the integrity controls.
// This keeps the headline A/B/C reproducible and the controls independent.
async function groundRepo(repo: FixtureRepo): Promise<GroundResult> {
  const tmp = mkdtempSync(join(tmpdir(), "graphctx-eval-"));
  try {
    cpSync(repo.dir, tmp, { recursive: true });
    rmSync(join(tmp, ".graphctx"), { recursive: true, force: true });
    const rt = new Runtime({ workspaceDir: tmp, userId: "eval-user" });
    await rt.extract();

    const scope = { user_id: "eval-user", workspace_id: rt.workspaceId };
    const facts = rt.facts.all(scope);

    // --- Solve-arm capsule: scenario prompt, no control facts seeded ---
    const solveCtx = await rt.injectionContext("PostCompact", "eval-solve", {
      user_prompt: repo.scenario.plan,
      transcript_tail: repo.scenario.needs.map((n) => n.task).join(". "),
    });
    const capsule = await rt.planner().plan(solveCtx);

    // --- Control facts + capsule (fresh session to bypass anti-repetition) ---
    const ncFact = rt.facts.insert({
      subject: NEGATIVE_CONTROL.subject,
      predicate: NEGATIVE_CONTROL.predicate,
      object: NEGATIVE_CONTROL.object,
      fact_kind: "procedural",
      temporal_kind: "static",
      scope,
      trust_tier: "high",
      status: "active",
      promotion_state: "workspace_active",
      source: {
        asserted_by: "user",
        event_ids: [],
        raw_quote: `user said: deploy via ${NEGATIVE_CONTROL.object}`,
      },
      tags: ["command", "deploy"],
    });
    const staleFact = rt.facts.insert({
      subject: STALE_FACT.subject,
      predicate: STALE_FACT.predicate,
      object: STALE_FACT.object,
      fact_kind: "constraint",
      temporal_kind: "static",
      scope,
      trust_tier: "high",
      status: "active",
      promotion_state: "workspace_active",
      source: { asserted_by: "deterministic_parser", event_ids: [] },
      git: { path_globs: [STALE_FACT.subject] },
      tags: ["generated_code"],
    });

    const controlCtx = await rt.injectionContext("PostCompact", "eval-control", {
      user_prompt: "How do I deploy this project? Which generated files must I not edit?",
      transcript_tail: "deploy the project; avoid editing generated files",
    });
    const controlCapsule = await rt.planner().plan(controlCtx);
    rt.close();

    const pushedIds = new Set(controlCapsule.cards.map((c) => c.fact_id));

    // N passes iff: the needle is absent from every repo file AND push delivered it.
    const absent = needleAbsentFromRepo(tmp, NEGATIVE_CONTROL.needle);
    const negativeControlPass = absent && pushedIds.has(ncFact.fact_id);

    // S passes iff the stale fact was NOT injected (I4 suppression).
    const staleSuppressedPass = !pushedIds.has(staleFact.fact_id);

    return { facts, capsule, negativeControlPass, staleSuppressedPass };
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
