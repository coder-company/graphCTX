import { execFileSync } from "node:child_process";
import { cpSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Runtime } from "../../runtime.js";
import { installClaudeHooks } from "./install.js";

// The unfindable fact: present only in graphCTX's store, never in any repo file.
const DEPLOY_CMD = "./scripts/ship.sh --canary --wait";

export interface DemoResult {
  demoDir: string;
  binInvocation: string;
  factCount: number;
  capsulePreview: string;
}

// Resolve a robust `graphctx` invocation for the hook command that works
// offline whether graphctx runs compiled (dist/cli.js via node) or from source
// (src/cli.ts via tsx). No PATH dependency, no network.
export function resolveBinInvocation(): string {
  const self = fileURLToPath(import.meta.url); // .../<dist|src>/adapters/claude-code/demo.{js,ts}
  const isCompiled = self.endsWith(".js");
  if (isCompiled) {
    // dist/adapters/claude-code/demo.js → dist/cli.js
    const cliJs = join(self, "..", "..", "..", "cli.js");
    return `node ${quote(cliJs)}`;
  }
  // src/adapters/claude-code/demo.ts → src/cli.ts
  const cliTs = join(self, "..", "..", "..", "cli.ts");
  return `npx tsx ${quote(cliTs)}`;
}

// Find the bundled sample repo (fixtures/repo-pnpm-web) relative to this module.
function fixtureRepo(): string {
  const self = fileURLToPath(import.meta.url);
  const isCompiled = self.endsWith(".js");
  // src/... resolves to the repo root. dist/... resolves to the package root,
  // with fixture assets copied under dist/fixtures by scripts/copy-assets.mjs.
  const root = join(self, "..", "..", "..", "..");
  const distRoot = join(self, "..", "..", "..");
  const candidates = isCompiled
    ? [
        join(distRoot, "fixtures", "repo-pnpm-web"),
        join(root, "fixtures", "repo-pnpm-web"),
        join(root, "..", "fixtures", "repo-pnpm-web"),
      ]
    : [join(root, "fixtures", "repo-pnpm-web")];
  for (const c of candidates) {
    if (existsSync(join(c, "package.json"))) return c;
  }
  throw new Error("demo fixture (fixtures/repo-pnpm-web) not found");
}

// One-command, offline, robust demo setup. Creates a scratch repo, seeds the
// unfindable fact, installs hooks wired to a working invocation, and removes
// the static AGENTS.md so the SessionStart hook is the ONLY delivery channel.
export async function setupDemo(demoDir: string): Promise<DemoResult> {
  rmSync(demoDir, { recursive: true, force: true });
  cpSync(fixtureRepo(), demoDir, { recursive: true });
  rmSync(join(demoDir, ".graphctx"), { recursive: true, force: true });

  // Make it a real git repo so commit anchors apply.
  const git = (args: string[]) => execFileSync("git", args, { cwd: demoDir, stdio: "ignore" });
  try {
    git(["init", "-q"]);
    git(["add", "-A"]);
    git([
      "-c",
      "user.email=demo@graphctx.local",
      "-c",
      "user.name=graphctx demo",
      "commit",
      "-qm",
      "init",
    ]);
  } catch {
    // git is optional; the demo still works without anchors.
  }

  const bin = resolveBinInvocation();

  // Extract repo facts + install hooks (this also writes AGENTS.md).
  const rt = new Runtime({ workspaceDir: demoDir, userId: "local-user" });
  await rt.extract();

  // Seed the unfindable fact (exists only in the store).
  let head: string | undefined;
  let branch: string | undefined;
  let repoId: string | undefined;
  try {
    if (await rt.git.isRepo()) {
      head = await rt.git.head();
      branch = await rt.git.branch();
      repoId = await rt.git.repoId();
    }
  } catch {
    // degrade without anchors
  }
  rt.facts.insert({
    subject: "repo",
    predicate: "deploy_command",
    object: DEPLOY_CMD,
    fact_kind: "procedural",
    temporal_kind: "static",
    scope: { user_id: rt.userId, workspace_id: rt.workspaceId },
    trust_tier: "high",
    status: "active",
    promotion_state: "workspace_active",
    source: {
      asserted_by: "user",
      event_ids: [],
      raw_quote: `user said: deploy via ${DEPLOY_CMD}`,
    },
    git: { repo_id: repoId, branch, valid_from_commit: head, introduced_by_commit: head },
    tags: ["command", "deploy"],
  });

  installClaudeHooks({ workspaceDir: demoDir, binPath: bin });

  // Remove AGENTS.md so the push hook is the ONLY channel for the deploy fact.
  rmSync(join(demoDir, "AGENTS.md"), { force: true });

  // Build a preview capsule (what the SessionStart/PostCompact hook will emit).
  const ctx = await rt.injectionContext("PostCompact", "demo-preview", {
    user_prompt: "How do I deploy this project and run the tests?",
  });
  const capsule = await rt.planner().plan(ctx);
  const factCount = rt.facts.all({ user_id: rt.userId, workspace_id: rt.workspaceId }).length;
  rt.close();

  return { demoDir, binInvocation: bin, factCount, capsulePreview: capsule.markdown };
}

function quote(p: string): string {
  return p.includes(" ") ? `"${p}"` : p;
}

export const DEMO_DEPLOY_CMD = DEPLOY_CMD;
