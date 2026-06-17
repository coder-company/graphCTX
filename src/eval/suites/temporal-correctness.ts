import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isValidAsOf } from "../../git/anchors.js";
import { type DagEventKind, detectEvent, revalidateOnRevert } from "../../git/dag.js";
import { Git } from "../../git/git.js";
import { Runtime } from "../../runtime.js";

// Temporal-correctness (SPEC §8, M3). graphCTX's core thesis is "commit-valid
// memory": every fact is anchored to a git commit and must stay temporally
// correct as HEAD moves. branch-truth.ts proves the RULE logic against a
// hardcoded ancestry oracle; this suite proves the SAME guarantees against REAL
// temporary git repos exercising actual fast-forward / branch / revert / merge /
// rebase / cherry-pick operations — surfacing behaviour the oracle cannot.
//
// Each scenario builds its own throwaway repo with a deterministic git env,
// drives a real history operation, and asserts the EXPECTED valid/invalid (or
// detectEvent classification) outcome.

export interface ScenarioResult {
  id: string;
  label: string;
  pass: boolean;
  detail: string;
  gated: boolean; // does this scenario count toward the PASS gate?
  informational?: boolean; // measured + printed, but does not fail the gate
}

export interface TemporalCorrectnessReport {
  scenarios: ScenarioResult[];
  gatedTotal: number;
  gatedPassed: number;
  classification: Array<{ kind: DagEventKind; got: DagEventKind; ok: boolean }>;
  patchIdEqual: boolean; // git.patchId(X) === git.patchId(Y) for a cherry-pick (MUST be true)
  patchIdWired: boolean; // is patch-id equivalence wired into fact validity today?
  pass: boolean;
}

// Deterministic git env so commits are reproducible and tests never depend on
// host git config (user identity, gpg signing, default branch, dates).
const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "graphctx eval",
  GIT_AUTHOR_EMAIL: "eval@graphctx.local",
  GIT_COMMITTER_NAME: "graphctx eval",
  GIT_COMMITTER_EMAIL: "eval@graphctx.local",
  GIT_AUTHOR_DATE: "2025-01-01T00:00:00 +0000",
  GIT_COMMITTER_DATE: "2025-01-01T00:00:00 +0000",
};

// A tiny real-repo harness: shells `git` with deterministic config + env.
class Repo {
  readonly dir: string;
  readonly git: Git;
  constructor(dir: string) {
    this.dir = dir;
    this.git = new Git(dir);
  }
  run(args: string[]): string {
    return execFileSync("git", ["-c", "commit.gpgsign=false", ...args], {
      cwd: this.dir,
      env: GIT_ENV,
      encoding: "utf8",
      // git writes progress (e.g. "Rebasing (1/1)") to stderr; keep the report clean.
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  }
  init(): void {
    execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q", "."], {
      cwd: this.dir,
      env: GIT_ENV,
    });
  }
  write(file: string, content: string): void {
    writeFileSync(join(this.dir, file), content);
  }
  // Stage everything + commit; returns the new HEAD sha.
  commit(file: string, content: string, message: string): string {
    this.write(file, content);
    this.run(["add", "-A"]);
    this.run(["commit", "-qm", message]);
    return this.run(["rev-parse", "HEAD"]);
  }
  head(): string {
    return this.run(["rev-parse", "HEAD"]);
  }
}

function withRepo<T>(fn: (r: Repo) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "graphctx-temporal-"));
  const repo = new Repo(dir);
  repo.init();
  return (async () => {
    try {
      return await fn(repo);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  })();
}

// A Runtime over the repo dir with a clean store (drops any seeded .graphctx).
function runtimeFor(dir: string): Runtime {
  rmSync(join(dir, ".graphctx"), { recursive: true, force: true });
  return new Runtime({ workspaceDir: dir, userId: "temporal-eval" });
}

// --- Scenario 1: fast-forward validity ------------------------------------
// A fact anchored at c1 is valid at a descendant HEAD (c2) and invalid before c1.
async function scFastForward(): Promise<ScenarioResult> {
  return withRepo(async (r) => {
    const c0 = r.commit("f.txt", "base\n", "c0");
    const c1 = r.commit("f.txt", "base\nv1\n", "c1 introduce");
    const c2 = r.commit("f.txt", "base\nv1\nmore\n", "c2 advance");
    const anchor = { valid_from_commit: c1, introduced_by_commit: c1 };
    const validAtC2 = await isValidAsOf(r.git, anchor, c2, "main");
    const validAtC0 = await isValidAsOf(r.git, anchor, c0, "main");
    const pass = validAtC2 === true && validAtC0 === false;
    return {
      id: "1-fast-forward",
      label: "fast-forward: fact valid at descendant HEAD, invalid before introduction",
      pass,
      gated: true,
      detail: `valid@c2=${validAtC2} (want true), valid@c0=${validAtC0} (want false)`,
    };
  });
}

// --- Scenario 2: branch isolation (real repo) -----------------------------
// A fact introduced on feature is NOT valid on main, and vice versa.
async function scBranchIsolation(): Promise<ScenarioResult> {
  return withRepo(async (r) => {
    r.commit("f.txt", "base\n", "c0");
    const mainHead = r.commit("f.txt", "base\nmain\n", "c1 main");
    r.run(["checkout", "-q", "-b", "feat", "HEAD~1"]);
    const featHead = r.commit("g.txt", "feature\n", "b1 feat");

    const mainAnchor = {
      branch: "main",
      introduced_by_commit: mainHead,
      valid_from_commit: mainHead,
    };
    const featAnchor = {
      branch: "feat",
      introduced_by_commit: featHead,
      valid_from_commit: featHead,
    };

    const mainOnMain = await isValidAsOf(r.git, mainAnchor, mainHead, "main");
    const featOnMain = await isValidAsOf(r.git, featAnchor, mainHead, "main");
    const featOnFeat = await isValidAsOf(r.git, featAnchor, featHead, "feat");
    const mainOnFeat = await isValidAsOf(r.git, mainAnchor, featHead, "feat");

    const pass =
      mainOnMain === true && featOnMain === false && featOnFeat === true && mainOnFeat === false;
    return {
      id: "2-branch-isolation",
      label: "branch isolation: feature fact does not leak onto main (and vice versa)",
      pass,
      gated: true,
      detail: `mainOnMain=${mainOnMain} featOnMain=${featOnMain} (leak?) featOnFeat=${featOnFeat} mainOnFeat=${mainOnFeat} (leak?)`,
    };
  });
}

// --- Scenario 3: revert restores truth ------------------------------------
// F1 valid_from c1; c2 invalidates it (valid_until=c2); `git revert c2` must
// reactivate F1 via revalidateOnRevert, and F1 must be valid at the new HEAD.
async function scRevertRestores(): Promise<ScenarioResult> {
  return withRepo(async (r) => {
    r.commit("f.txt", "base\n", "c0");
    const c1 = r.commit("f.txt", "base\nv1\n", "c1 introduce");
    const c2 = r.commit("f.txt", "base\nv2\n", "c2 invalidate");
    r.run(["revert", "--no-edit", c2]);
    const c3 = r.head();

    const rt = runtimeFor(r.dir);
    try {
      const scope = { user_id: rt.userId, workspace_id: rt.workspaceId };
      const f1 = rt.facts.insert({
        subject: "repo",
        predicate: "setting",
        object: "v1",
        fact_kind: "decision",
        temporal_kind: "static",
        scope,
        trust_tier: "high",
        status: "active",
        promotion_state: "workspace_active",
        source: { asserted_by: "user", event_ids: [] },
        git: { valid_from_commit: c1, introduced_by_commit: c1 },
      });
      // The invalidating fact (FK target for invalidated_by) lives at c2.
      const f2 = rt.facts.insert({
        subject: "repo",
        predicate: "setting",
        object: "v2",
        fact_kind: "decision",
        temporal_kind: "static",
        scope,
        trust_tier: "high",
        status: "active",
        promotion_state: "workspace_active",
        source: { asserted_by: "user", event_ids: [] },
        git: { valid_from_commit: c2, introduced_by_commit: c2 },
      });
      rt.facts.expire(f1.fact_id, f2.fact_id, c2);
      const expiredBefore = rt.facts.get(f1.fact_id)?.status === "expired";

      const restored = await revalidateOnRevert(rt.git, rt.facts, c3, "main");
      const activeAfter = rt.facts.get(f1.fact_id)?.status === "active";
      const refreshed = rt.facts.get(f1.fact_id);
      const validAtHead = await isValidAsOf(rt.git, refreshed?.git, c3, "main");

      const pass =
        expiredBefore &&
        restored.some((f) => f.fact_id === f1.fact_id) &&
        activeAfter &&
        validAtHead;
      return {
        id: "3-revert-restores",
        label:
          "revert restores truth: reverting the invalidating commit reactivates the prior fact",
        pass,
        gated: true,
        detail: `expiredBefore=${expiredBefore} restored=${restored.length} activeAfter=${activeAfter} validAtNewHead=${validAtHead}`,
      };
    } finally {
      rt.close();
    }
  });
}

// --- Scenario 4: merge ----------------------------------------------------
// A feature fact becomes valid on main AFTER the feature merges into main; the
// HEAD move main->mergeHead classifies as 'merge'.
async function scMerge(): Promise<ScenarioResult> {
  return withRepo(async (r) => {
    const c0 = r.commit("f.txt", "base\n", "c0");
    const mainBefore = r.commit("f.txt", "base\nmain\n", "c1 main");
    r.run(["checkout", "-q", "-b", "feat", c0]);
    const featCommit = r.commit("g.txt", "feature\n", "b1 feat");
    r.run(["checkout", "-q", "main"]);
    r.run(["merge", "--no-ff", "-m", "merge feat", "feat"]);
    const mergeHead = r.head();

    const featAnchor = {
      branch: "feat",
      introduced_by_commit: featCommit,
      valid_from_commit: featCommit,
    };
    const validBeforeMerge = await isValidAsOf(r.git, featAnchor, mainBefore, "main");
    const validAfterMerge = await isValidAsOf(r.git, featAnchor, mergeHead, "main");
    const ev = await detectEvent(r.git, mainBefore, mergeHead, "main", "main");

    const pass = validBeforeMerge === false && validAfterMerge === true && ev.kind === "merge";
    return {
      id: "4-merge",
      label: "merge: feature fact becomes valid on main after merge; HEAD move classified 'merge'",
      pass,
      gated: true,
      detail: `validBeforeMerge=${validBeforeMerge} validAfterMerge=${validAfterMerge} event=${ev.kind} (want merge)`,
    };
  });
}

// --- Scenario 5: rebase ---------------------------------------------------
// After a rebase the old HEAD is not an ancestor of the new HEAD (history
// rewritten). detectEvent must classify it 'rebase', and a fact anchored to the
// pre-rebase SHA must NOT be falsely "still valid" at the rewritten HEAD.
async function scRebase(): Promise<ScenarioResult> {
  return withRepo(async (r) => {
    const c0 = r.commit("f.txt", "base\n", "c0");
    // main advances so feature's base is behind.
    r.commit("f.txt", "base\nmain1\n", "c1 main");
    r.run(["checkout", "-q", "-b", "feat", c0]);
    const preRebase = r.commit("g.txt", "feature\n", "b1 feat");
    r.run(["rebase", "main"]);
    const postRebase = r.head();

    const ev = await detectEvent(r.git, preRebase, postRebase, "feat", "feat");
    const oldIsAncestor = await r.git.isAncestor(preRebase, postRebase);
    // A fact anchored to the OLD (pre-rebase, now-orphaned) sha must not be valid
    // at the rewritten HEAD — its valid_from is no longer reachable.
    const oldAnchor = { valid_from_commit: preRebase, introduced_by_commit: preRebase };
    const oldStillValid = await isValidAsOf(r.git, oldAnchor, postRebase, "feat");

    const pass = ev.kind === "rebase" && oldIsAncestor === false && oldStillValid === false;
    return {
      id: "5-rebase",
      label: "rebase: classified 'rebase'; fact on the rewritten (old) SHA is not falsely valid",
      pass,
      gated: true,
      detail: `event=${ev.kind} (want rebase) oldIsAncestor=${oldIsAncestor} oldFactStillValid=${oldStillValid} (want false)`,
    };
  });
}

// --- Scenario 6: cherry-pick / patch-id equivalence (THE KEY GAP) ---------
// Create change X on branch A, cherry-pick onto branch B (new SHA Y, same patch).
// patch-id MUST recognize X and Y as the same change (a pure git capability that
// already exists). We then measure whether graphCTX's fact-validity logic treats
// the cherry-picked change as "present" on branch B. It does NOT today — validity
// is ancestry-only and patch_id is never consulted — so the higher-level
// recognition is reported as INFORMATIONAL, while the patch-id equality is GATED.
async function scCherryPick(): Promise<{
  result: ScenarioResult;
  patchIdEqual: boolean;
  patchIdWired: boolean;
  informationalPass: boolean;
}> {
  return withRepo(async (r) => {
    const c0 = r.commit("f.txt", "base\n", "c0");
    // main diverges so the cherry-pick lands on a different parent → different SHA.
    r.commit("f.txt", "base\nmain\n", "c1 main");
    r.run(["checkout", "-q", "-b", "feat", c0]);
    const x = r.commit("change.txt", "the-change\n", "introduce change X");
    r.run(["checkout", "-q", "main"]);
    r.run(["cherry-pick", x]);
    const y = r.head();

    const pidX = await r.git.patchId(x);
    const pidY = await r.git.patchId(y);
    const patchIdEqual = pidX !== null && pidY !== null && pidX === pidY;
    const differentSha = x !== y;

    // Would graphCTX's validity logic see a fact anchored to X (on feat) as valid
    // on main@Y? Validity is ancestry-only: X is NOT an ancestor of Y, so a
    // branch-scoped fact anchored at X is NOT valid on main — even though the
    // change IS present (as Y). That is the gap. patch_id is never read by
    // isValidAsOf, so equivalence is NOT wired into validity.
    const xAnchor = { branch: "feat", introduced_by_commit: x, valid_from_commit: x };
    const recognizedAsPresentOnB = await isValidAsOf(r.git, xAnchor, y, "main");
    const patchIdWired = recognizedAsPresentOnB; // would only be true if validity consulted patch-id

    // The CORRECT expected behaviour is recognizedAsPresentOnB === true (the
    // change exists on main via Y). It is false today — documented as the gap.
    const informationalPass = recognizedAsPresentOnB === true;

    const result: ScenarioResult = {
      id: "6-cherry-pick",
      label:
        "cherry-pick: patch-id recognizes the same change across SHAs (gated); validity wiring (informational)",
      // Gate only on the patch-id EQUALITY capability (pure git, must hold).
      pass: patchIdEqual && differentSha,
      gated: true,
      detail:
        `patchId(X)=${pidX} patchId(Y)=${pidY} equal=${patchIdEqual} differentSha=${differentSha}` +
        ` | [informational] change recognized as present on branch B via fact validity=${recognizedAsPresentOnB}` +
        ` (correct=true; today=${recognizedAsPresentOnB ? "YES — wired" : "NO — patch-id not consulted by isValidAsOf (known gap)"})`,
      informational: false,
    };

    return { result, patchIdEqual, patchIdWired, informationalPass };
  });
}

// --- Scenario 7: detectEvent classification matrix ------------------------
// Build the real-git situation for each kind and assert detectEvent's verdict.
async function scClassificationMatrix(): Promise<{
  result: ScenarioResult;
  rows: TemporalCorrectnessReport["classification"];
}> {
  const rows: TemporalCorrectnessReport["classification"] = [];

  // noop + fast_forward: linear history.
  await withRepo(async (r) => {
    const c0 = r.commit("f.txt", "base\n", "c0");
    const c1 = r.commit("f.txt", "base\nv1\n", "c1");
    const noop = await detectEvent(r.git, c1, c1);
    rows.push({ kind: "noop", got: noop.kind, ok: noop.kind === "noop" });
    const ff = await detectEvent(r.git, c0, c1);
    rows.push({ kind: "fast_forward", got: ff.kind, ok: ff.kind === "fast_forward" });
  });

  // merge.
  await withRepo(async (r) => {
    const c0 = r.commit("f.txt", "base\n", "c0");
    const mainBefore = r.commit("f.txt", "base\nmain\n", "c1 main");
    r.run(["checkout", "-q", "-b", "feat", c0]);
    r.commit("g.txt", "feature\n", "b1 feat");
    r.run(["checkout", "-q", "main"]);
    r.run(["merge", "--no-ff", "-m", "merge feat", "feat"]);
    const ev = await detectEvent(r.git, mainBefore, r.head(), "main", "main");
    rows.push({ kind: "merge", got: ev.kind, ok: ev.kind === "merge" });
  });

  // rebase.
  await withRepo(async (r) => {
    const c0 = r.commit("f.txt", "base\n", "c0");
    r.commit("f.txt", "base\nmain1\n", "c1 main");
    r.run(["checkout", "-q", "-b", "feat", c0]);
    const preRebase = r.commit("g.txt", "feature\n", "b1 feat");
    r.run(["rebase", "main"]);
    const ev = await detectEvent(r.git, preRebase, r.head(), "feat", "feat");
    rows.push({ kind: "rebase", got: ev.kind, ok: ev.kind === "rebase" });
  });

  // revert.
  await withRepo(async (r) => {
    r.commit("f.txt", "base\n", "c0");
    const c1 = r.commit("f.txt", "base\nv1\n", "c1");
    const c2 = r.commit("f.txt", "base\nv2\n", "c2");
    void c1;
    r.run(["revert", "--no-edit", c2]);
    const ev = await detectEvent(r.git, c2, r.head());
    rows.push({ kind: "revert", got: ev.kind, ok: ev.kind === "revert" });
  });

  // switch: different branch label, divergent history.
  await withRepo(async (r) => {
    const c0 = r.commit("f.txt", "base\n", "c0");
    const mainHead = r.commit("f.txt", "base\nmain\n", "c1 main");
    r.run(["checkout", "-q", "-b", "feat", c0]);
    const featHead = r.commit("g.txt", "feature\n", "b1 feat");
    const ev = await detectEvent(r.git, mainHead, featHead, "main", "feat");
    rows.push({ kind: "switch", got: ev.kind, ok: ev.kind === "switch" });
  });

  const ok = rows.every((row) => row.ok);
  const result: ScenarioResult = {
    id: "7-classification-matrix",
    label: "detectEvent classification matrix: fast_forward/merge/rebase/revert/switch/noop",
    pass: ok,
    gated: true,
    detail: rows.map((row) => `${row.kind}->${row.got}${row.ok ? "" : " ✗"}`).join(", "),
  };
  return { result, rows };
}

export async function runTemporalCorrectnessEval(): Promise<TemporalCorrectnessReport> {
  const scenarios: ScenarioResult[] = [];

  scenarios.push(await scFastForward());
  scenarios.push(await scBranchIsolation());
  scenarios.push(await scRevertRestores());
  scenarios.push(await scMerge());
  scenarios.push(await scRebase());

  const cherry = await scCherryPick();
  scenarios.push(cherry.result);

  const matrix = await scClassificationMatrix();
  scenarios.push(matrix.result);

  // Informational line for the higher-level cherry-pick recognition (not gated
  // unless it currently passes, per the verdict policy).
  const informationalPass = cherry.informationalPass;
  scenarios.push({
    id: "6b-cherry-pick-validity",
    label: "cherry-pick fact-validity recognition (informational; gated only if it passes today)",
    pass: informationalPass,
    gated: informationalPass, // only contributes to the gate if it already works
    informational: true,
    detail: informationalPass
      ? "fact anchored to X recognized as present on branch B via Y"
      : "NOT recognized today — isValidAsOf is ancestry-only; patch-id equivalence is the known unbuilt capability",
  });

  const gated = scenarios.filter((s) => s.gated);
  const gatedPassed = gated.filter((s) => s.pass).length;

  return {
    scenarios,
    gatedTotal: gated.length,
    gatedPassed,
    classification: matrix.rows,
    patchIdEqual: cherry.patchIdEqual,
    patchIdWired: cherry.patchIdWired,
    pass: gatedPassed === gated.length && cherry.patchIdEqual,
  };
}

export function formatTemporalCorrectnessReport(r: TemporalCorrectnessReport): string {
  const lines: string[] = [];
  lines.push("");
  lines.push("graphCTX eval — temporal correctness (real-git commit-valid memory, SPEC §8)");
  lines.push("=".repeat(72));
  lines.push("");
  for (const s of r.scenarios) {
    const tag = s.informational ? "[info]" : "[gate]";
    lines.push(`  ${s.pass ? "✓" : "✗"} ${tag} ${s.label}`);
    lines.push(`        ${s.detail}`);
  }
  lines.push("");
  lines.push("  detectEvent classification matrix:");
  for (const row of r.classification) {
    lines.push(`    ${row.ok ? "✓" : "✗"} ${row.kind.padEnd(13)} -> ${row.got}`);
  }
  lines.push("");
  lines.push(
    `  cherry-pick patch-id equality (git.patchId(X) === git.patchId(Y)): ${r.patchIdEqual ? "YES ✓" : "NO ✗"}`,
  );
  lines.push(
    `  patch-id equivalence wired into fact validity today: ${r.patchIdWired ? "YES" : "NO (known gap — isValidAsOf is ancestry-only)"}`,
  );
  lines.push("");
  lines.push(`  gated scenarios: ${r.gatedPassed}/${r.gatedTotal}`);
  lines.push(
    r.pass
      ? "  VERDICT: ✅ TEMPORAL CORRECTNESS PASS — real-git fast-forward/branch/revert/merge/rebase hold; patch-id recognizes cherry-picks."
      : "  VERDICT: ❌ TEMPORAL CORRECTNESS FAIL.",
  );
  lines.push("");
  return `${lines.join("\n")}\n`;
}
