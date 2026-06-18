import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { NewFact } from "../../core/types.js";
import { existingWorkspacePath } from "../../security/workspace-path.js";
import { type ExtractContext, type Extractor, structuredFact } from "./types.js";

export const pythonExtractor: Extractor = {
  id: "python",
  extract(ctx: ExtractContext): NewFact[] {
    const facts: NewFact[] = [];
    facts.push(...pythonManagerFacts(ctx));
    facts.push(...pythonVersionFacts(ctx));

    const pyproject = readWorkspaceFile(ctx, "pyproject.toml");
    if (pyproject) facts.push(...pyprojectFacts(ctx, pyproject));
    return facts;
  },
};

function pythonManagerFacts(ctx: ExtractContext): NewFact[] {
  const candidates = [
    { file: "uv.lock", manager: "uv", runner: "uv run" },
    { file: "poetry.lock", manager: "poetry", runner: "poetry run" },
    { file: "requirements.txt", manager: "pip", runner: "python -m" },
  ];
  for (const c of candidates) {
    if (!existingWorkspacePath(ctx.workspaceDir, c.file)) continue;
    return [
      structuredFact({
        subject: "python",
        predicate: "package_manager",
        object: c.manager,
        fact_kind: "semantic",
        temporal_kind: "static",
        scope: ctx.scope,
        tags: ["python", "dependency", "command", "config_file"],
        rawQuote: `${c.file} -> Python package manager ${c.manager} (commands usually run via "${c.runner}")`,
        git: anchor(ctx, [c.file]),
      }),
    ];
  }
  return [];
}

function pythonVersionFacts(ctx: ExtractContext): NewFact[] {
  const pin = readWorkspaceFile(ctx, ".python-version")?.trim();
  if (!pin) return [];
  return [
    structuredFact({
      subject: "runtime python",
      predicate: "version_pin",
      object: pin.split(/\s+/)[0] ?? pin,
      fact_kind: "constraint",
      temporal_kind: "static",
      scope: ctx.scope,
      tags: ["python", "runtime", "config_file"],
      rawQuote: `.python-version: ${pin}`,
      git: anchor(ctx, [".python-version"]),
    }),
  ];
}

function pyprojectFacts(ctx: ExtractContext, text: string): NewFact[] {
  const facts: NewFact[] = [];
  const requiresPython = quotedValue(text, "requires-python");
  if (requiresPython) {
    facts.push(
      structuredFact({
        subject: "runtime python",
        predicate: "version_constraint",
        object: requiresPython,
        fact_kind: "constraint",
        temporal_kind: "static",
        scope: ctx.scope,
        tags: ["python", "runtime", "config_file"],
        rawQuote: `pyproject.toml requires-python: ${requiresPython}`,
        git: anchor(ctx, ["pyproject.toml"]),
      }),
    );
  }

  const backend = quotedValue(text, "build-backend");
  if (backend) {
    facts.push(
      structuredFact({
        subject: "python",
        predicate: "build_backend",
        object: backend,
        fact_kind: "semantic",
        temporal_kind: "static",
        scope: ctx.scope,
        tags: ["python", "build", "config_file"],
        rawQuote: `pyproject.toml build-backend: ${backend}`,
        git: anchor(ctx, ["pyproject.toml"]),
      }),
    );
  }

  if (hasSection(text, "tool.pytest") || hasSection(text, "tool.pytest.ini_options")) {
    facts.push(pythonCommandFact(ctx, "test_command", "pytest", "pyproject.toml [tool.pytest]"));
  }
  if (hasSection(text, "tool.ruff")) {
    facts.push(
      pythonCommandFact(ctx, "lint_command", "ruff check .", "pyproject.toml [tool.ruff]"),
    );
  }
  if (hasSection(text, "tool.mypy")) {
    facts.push(pythonCommandFact(ctx, "typecheck_command", "mypy .", "pyproject.toml [tool.mypy]"));
  } else if (hasSection(text, "tool.pyright")) {
    facts.push(
      pythonCommandFact(ctx, "typecheck_command", "pyright", "pyproject.toml [tool.pyright]"),
    );
  }

  for (const entry of projectScripts(text).slice(0, 12)) {
    facts.push(
      structuredFact({
        subject: "python",
        predicate: "cli_entrypoint",
        object: `${entry.name} -> ${entry.target}`,
        fact_kind: "semantic",
        temporal_kind: "static",
        scope: ctx.scope,
        tags: ["python", "cli", "config_file"],
        rawQuote: `pyproject.toml project.scripts.${entry.name}: ${entry.target}`,
        git: anchor(ctx, ["pyproject.toml"]),
      }),
    );
  }

  return facts;
}

function pythonCommandFact(
  ctx: ExtractContext,
  predicate: "test_command" | "lint_command" | "typecheck_command",
  object: string,
  rawQuote: string,
): NewFact {
  return structuredFact({
    subject: "python",
    predicate,
    object,
    fact_kind: "semantic",
    temporal_kind: "static",
    scope: ctx.scope,
    tags: ["python", "command", "config_file"],
    rawQuote,
    git: anchor(ctx, ["pyproject.toml"]),
  });
}

function projectScripts(text: string): Array<{ name: string; target: string }> {
  const body = sectionBody(text, "project.scripts");
  if (!body) return [];
  const out: Array<{ name: string; target: string }> = [];
  for (const line of body.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_.-]+)\s*=\s*["']([^"']+)["']\s*$/);
    if (m?.[1] && m[2]) out.push({ name: m[1], target: m[2] });
  }
  return out;
}

function sectionBody(text: string, section: string): string | null {
  const lines = text.split(/\r?\n/);
  const header = `[${section}]`;
  const start = lines.findIndex((line) => line.trim() === header);
  if (start < 0) return null;
  const body: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*\[[^\]]+\]\s*$/.test(lines[i] ?? "")) break;
    body.push(lines[i] ?? "");
  }
  return body.join("\n");
}

function quotedValue(text: string, key: string): string | null {
  const re = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=\\s*["']([^"']+)["']`, "m");
  return re.exec(text)?.[1]?.trim() ?? null;
}

function hasSection(text: string, section: string): boolean {
  return new RegExp(`^\\s*\\[${escapeRegExp(section)}(?:\\.[^\\]]+)?\\]\\s*$`, "m").test(text);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function readWorkspaceFile(ctx: ExtractContext, rel: string): string | null {
  if (!existingWorkspacePath(ctx.workspaceDir, rel)) return null;
  try {
    return readFileSync(join(ctx.workspaceDir, rel), "utf8");
  } catch {
    return null;
  }
}

function anchor(ctx: ExtractContext, paths: string[]) {
  return {
    repo_id: ctx.repoId,
    branch: ctx.branch,
    valid_from_commit: ctx.head,
    path_globs: paths,
  };
}
