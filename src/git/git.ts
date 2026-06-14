import { type SimpleGit, simpleGit } from "simple-git";
import { GitError } from "../core/errors.js";

export type SHA = string;

// Thin wrapper around simple-git. All ops are best-effort and never throw on a
// non-git directory beyond a typed GitError the caller can degrade from (I9).
export class Git {
  private readonly git: SimpleGit;
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

  // Is `a` an ancestor of `b` (i.e. a reachable from b)? `git merge-base --is-ancestor`.
  async isAncestor(a: SHA, b: SHA): Promise<boolean> {
    if (a === b) return true;
    try {
      await this.git.raw(["merge-base", "--is-ancestor", a, b]);
      return true;
    } catch (e) {
      // exit code 1 = not an ancestor; other = error. simple-git throws on non-zero.
      const msg = (e as Error).message ?? "";
      if (/exit code=?1\b/.test(msg) || msg.includes("not an ancestor")) return false;
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

  async mergeBase(a: SHA, b: SHA): Promise<SHA | null> {
    try {
      return (await this.git.raw(["merge-base", a, b])).trim() || null;
    } catch {
      return null;
    }
  }

  async patchId(commit: SHA): Promise<string | null> {
    try {
      const diff = await this.git.raw(["diff-tree", "-p", commit]);
      // patch-id reads a patch on stdin; emulate by hashing the diff deterministically.
      return stableHash(diff);
    } catch {
      return null;
    }
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
