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
    facts.push(...pythonHarnessFacts(ctx));
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
  const pyproject = readWorkspaceFile(ctx, "pyproject.toml");
  if (pyproject && hasSection(pyproject, "tool.uv")) {
    return [pythonManagerFact(ctx, "uv", "uv run", "pyproject.toml [tool.uv]", ["pyproject.toml"])];
  }
  if (pyproject && hasSection(pyproject, "tool.poetry")) {
    return [
      pythonManagerFact(ctx, "poetry", "poetry run", "pyproject.toml [tool.poetry]", [
        "pyproject.toml",
      ]),
    ];
  }
  return [];
}

function pythonManagerFact(
  ctx: ExtractContext,
  manager: string,
  runner: string,
  rawQuote: string,
  paths: string[],
): NewFact {
  return structuredFact({
    subject: "python",
    predicate: "package_manager",
    object: manager,
    fact_kind: "semantic",
    temporal_kind: "static",
    scope: ctx.scope,
    tags: ["python", "dependency", "command", "config_file"],
    rawQuote: `${rawQuote} -> Python package manager ${manager} (commands usually run via "${runner}")`,
    git: anchor(ctx, paths),
  });
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

  const hasPytest =
    hasSection(text, "tool.pytest") ||
    hasSection(text, "tool.pytest.ini_options") ||
    dependencySectionsMention(text, ["pytest"]);
  const hasRuff = hasSection(text, "tool.ruff") || dependencySectionsMention(text, ["ruff"]);
  const hasMypy = hasSection(text, "tool.mypy") || dependencySectionsMention(text, ["mypy"]);
  const hasPyright =
    hasSection(text, "tool.pyright") || dependencySectionsMention(text, ["pyright"]);

  if (hasPytest) {
    facts.push(
      pythonCommandFact(ctx, "test_command", "pytest", "pyproject.toml pytest config", [
        "pyproject.toml",
      ]),
    );
  }
  if (hasRuff) {
    facts.push(
      pythonCommandFact(ctx, "lint_command", "ruff check .", "pyproject.toml ruff config", [
        "pyproject.toml",
      ]),
    );
  }
  if (hasMypy) {
    facts.push(
      pythonCommandFact(ctx, "typecheck_command", "mypy .", "pyproject.toml mypy config", [
        "pyproject.toml",
      ]),
    );
  } else if (hasPyright) {
    facts.push(
      pythonCommandFact(ctx, "typecheck_command", "pyright", "pyproject.toml pyright config", [
        "pyproject.toml",
      ]),
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
  paths: string[],
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
    git: anchor(ctx, paths),
  });
}

function pythonHarnessFacts(ctx: ExtractContext): NewFact[] {
  const facts: NewFact[] = [];
  const tox = readWorkspaceFile(ctx, "tox.ini");
  if (tox && /^\s*\[testenv(?::[^\]]+)?\]\s*$/m.test(tox)) {
    facts.push(
      pythonCommandFact(ctx, "test_command", "tox", "tox.ini testenv config", ["tox.ini"]),
    );
  }

  const nox = readWorkspaceFile(ctx, "noxfile.py");
  if (nox && /@nox\.session\b/.test(nox)) {
    facts.push(
      pythonCommandFact(ctx, "test_command", "nox", "noxfile.py @nox.session config", [
        "noxfile.py",
      ]),
    );
  }
  return facts;
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

function dependencySectionsMention(text: string, packageNames: string[]): boolean {
  const body = [
    sectionBody(text, "dependency-groups"),
    sectionBody(text, "project.optional-dependencies"),
  ]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
  if (!body) return false;
  return packageNames.some((name) => {
    const needle = escapeRegExp(name.toLowerCase());
    return new RegExp(`(^|[^a-z0-9_-])${needle}([^a-z0-9_-]|$)`).test(body);
  });
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
