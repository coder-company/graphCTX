import { type SimpleGit, simpleGit } from "simple-git";
import { GitError } from "../core/errors.js";

export type SHA = string;

// Thin wrapper around simple-git. All ops are best-effort and never throw on a
// non-git directory beyond a typed GitError the caller can degrade from (I9).
export class Git {
  private readonly git: SimpleGit;
  private readonly patchIdByCommit = new Map<SHA, string | null>();
  private readonly reachablePatchIdsByHead = new Map<SHA, Set<string>>();
  readonly cwd: string;

  constructor(cwd: string) {
    this.cwd = cwd;
    this.git = simpleGit(cwd);
  }

  async isRepo(): Promise<boolean> {
    try {
      return await this.git.checkIsRepo();
    } catch {
      return false;
    }
  }

  async head(): Promise<SHA> {
    try {
      return (await this.git.revparse(["HEAD"])).trim();
    } catch (e) {
      throw new GitError(`cannot resolve HEAD: ${(e as Error).message}`, "ensure repo has commits");
    }
  }

  async branch(): Promise<string> {
    try {
      return (await this.git.revparse(["--abbrev-ref", "HEAD"])).trim();
    } catch (e) {
      throw new GitError(`cannot resolve branch: ${(e as Error).message}`);
    }
  }

  async dirtyFiles(): Promise<string[]> {
    try {
      const status = await this.git.status();
      return status.files.map((f) => f.path);
    } catch {
      return [];
    }
  }

  // Is `a` an ancestor of `b` (i.e. a reachable from b)? `git merge-base
  // --is-ancestor` signals via EXIT CODE (0=yes, 1=no), but simple-git's raw()
  // does NOT throw on exit code 1 — it returns "" — so the exit status is lost
  // and every query would read as "ancestor". We instead use the robust
  // identity: a is an ancestor of b iff merge-base(a,b) === a (canonical sha).
  async isAncestor(a: SHA, b: SHA): Promise<boolean> {
    if (a === b) return true;
    try {
      const base = (await this.git.raw(["merge-base", a, b])).trim();
      if (!base) return false;
      const full = (await this.git.raw(["rev-parse", "--verify", `${a}^{commit}`])).trim();
      return base === full;
    } catch {
      // Unknown commit etc. -> treat as not-ancestor (conservative).
      return false;
    }
  }

  // Parent SHAs of a commit (>1 for a merge). Empty on error/root.
  async parentsOf(sha: SHA): Promise<string[]> {
    try {
      const raw = (await this.git.raw(["rev-list", "--parents", "-n", "1", sha])).trim();
      const parts = raw.split(/\s+/).filter(Boolean);
      return parts.slice(1); // first token is the commit itself
    } catch {
      return [];
    }
  }

  // Full commit message (subject + body). Empty string on error.
  async commitMessage(sha: SHA): Promise<string> {
    try {
      return (await this.git.raw(["log", "-1", "--format=%B", sha])).trim();
    } catch {
      return "";
    }
  }

  // Has the change introduced by `target` been reverted somewhere in the history
  // reachable from `head`? A real `git revert` adds a NEW commit (target stays an
  // ancestor), so reachability alone can't tell — we look for the standard
  // "This reverts commit <target>" trailer git writes. Best-effort; false on error.
  async isRevertedBy(target: SHA, head: SHA): Promise<boolean> {
    try {
      const out = await this.git.raw([
        "log",
        "-F",
        `--grep=This reverts commit ${target}`,
        "--max-count=1",
        "--format=%H",
        head,
      ]);
      return out.trim().length > 0;
    } catch {
      return false;
    }
  }

  async mergeBase(a: SHA, b: SHA): Promise<SHA | null> {
    try {
      return (await this.git.raw(["merge-base", a, b])).trim() || null;
    } catch {
      return null;
    }
  }

  async patchId(commit: SHA): Promise<string | null> {
    if (this.patchIdByCommit.has(commit)) return this.patchIdByCommit.get(commit) ?? null;
    try {
      // --no-commit-id drops the leading commit SHA so the hash reflects only the
      // change (the patch), not the commit it lives in. Without it a cherry-picked
      // change would hash differently on each branch and patch-id would be useless.
      const diff = await this.git.raw(["diff-tree", "--no-commit-id", "-p", commit]);
      if (diff.trim().length === 0) {
        this.patchIdByCommit.set(commit, null);
        return null;
      }
      // patch-id reads a patch on stdin; emulate by hashing the diff deterministically.
      const patchId = stableHash(diff);
      this.patchIdByCommit.set(commit, patchId);
      return patchId;
    } catch {
      this.patchIdByCommit.set(commit, null);
      return null;
    }
  }

  async hasPatchEquivalent(target: SHA, head: SHA, knownTargetPatchId?: string): Promise<boolean> {
    const targetPatchId = knownTargetPatchId?.trim() || (await this.patchId(target));
    if (!targetPatchId) return false;
    const reachable = await this.reachablePatchIds(head);
    return reachable.has(targetPatchId);
  }

  private async reachablePatchIds(head: SHA): Promise<Set<string>> {
    const cached = this.reachablePatchIdsByHead.get(head);
    if (cached) return cached;
    const ids = new Set<string>();
    try {
      const raw = await this.git.raw(["rev-list", "--no-merges", head]);
      const commits = raw.split(/\s+/).filter(Boolean);
      for (const commit of commits) {
        const patchId = await this.patchId(commit);
        if (patchId) ids.add(patchId);
      }
    } catch {
      // Unknown/unreachable HEAD: conservative "no equivalent patch".
    }
    this.reachablePatchIdsByHead.set(head, ids);
    return ids;
  }

  // repo_id: stable identifier — first commit sha if available, else hashed path.
  async repoId(): Promise<string> {
    try {
      const root = (await this.git.raw(["rev-list", "--max-parents=0", "HEAD"])).trim();
      const first = root.split("\n")[0]?.trim();
      if (first) return `repo_${first.slice(0, 12)}`;
    } catch {
      // fall through
    }
    return `repo_${stableHash(this.cwd).slice(0, 12)}`;
  }
}

function stableHash(s: string): string {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

export function pathMatches(globs: string[], file: string): boolean {
  return globs.some((g) => globToRegExp(g).test(file));
}

// Minimal glob → RegExp supporting ** , * and ?.
function globToRegExp(glob: string): RegExp {
  let re = "^";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++;
        if (glob[i + 1] === "/") i++;
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if (".+^${}()|[]\\".includes(c as string)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  re += "$";
  return new RegExp(re);
}
