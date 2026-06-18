import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { FactKind, NewFact } from "../../core/types.js";
import { existingWorkspacePath } from "../../security/workspace-path.js";
import { type ExtractContext, type Extractor, structuredFact } from "./types.js";

const TEST_CONFIGS = [
  { runner: "vitest", files: ["vitest.config.ts", "vitest.config.mts", "vitest.config.js"] },
  { runner: "jest", files: ["jest.config.ts", "jest.config.js", "jest.config.cjs"] },
  { runner: "playwright", files: ["playwright.config.ts", "playwright.config.js"] },
  { runner: "cypress", files: ["cypress.config.ts", "cypress.config.js"] },
];

export const testConfigExtractor: Extractor = {
  id: "test-config",
  extract(ctx: ExtractContext): NewFact[] {
    const facts: NewFact[] = [];
    for (const config of TEST_CONFIGS) {
      const file = config.files.find((candidate) =>
        existingWorkspacePath(ctx.workspaceDir, candidate),
      );
      if (!file) continue;
      facts.push(
        testFact(ctx, file, {
          predicate: "test_runner",
          object: config.runner,
          factKind: "semantic",
          tags: ["test", "config_file", config.runner],
          rawQuote: `${file} configures ${config.runner}`,
        }),
      );
      if (config.runner === "vitest") facts.push(...extractVitest(ctx, file));
    }
    return facts;
  },
};

function extractVitest(ctx: ExtractContext, file: string): NewFact[] {
  let text: string;
  try {
    text = readFileSync(join(ctx.workspaceDir, file), "utf8");
  } catch {
    return [];
  }

  const facts: NewFact[] = [];
  const environment = scalarStringAfter(text, "environment");
  if (environment) {
    facts.push(
      testFact(ctx, file, {
        predicate: "test_environment",
        object: environment,
        factKind: "semantic",
        tags: ["test", "runtime", "config_file", "vitest"],
        rawQuote: `${file} test.environment: ${environment}`,
      }),
    );
  }

  const timeout = scalarNumberAfter(text, "testTimeout");
  if (timeout !== undefined) {
    facts.push(
      testFact(ctx, file, {
        predicate: "test_timeout_ms",
        object: timeout,
        factKind: "semantic",
        tags: ["test", "timeout", "config_file", "vitest"],
        rawQuote: `${file} test.testTimeout: ${String(timeout)}`,
      }),
    );
  }

  const coverageProvider = scalarStringAfter(text, "provider");
  if (coverageProvider) {
    facts.push(
      testFact(ctx, file, {
        predicate: "coverage_provider",
        object: coverageProvider,
        factKind: "semantic",
        tags: ["test", "coverage", "config_file", "vitest"],
        rawQuote: `${file} coverage.provider: ${coverageProvider}`,
      }),
    );
  }

  const coverageIndex = text.indexOf("coverage");
  for (const match of arrayAssignments(text, "include")) {
    facts.push(
      testFact(ctx, file, {
        predicate:
          coverageIndex !== -1 && match.index > coverageIndex
            ? "coverage_include_globs"
            : "test_include_globs",
        object: match.values,
        factKind: "semantic",
        tags: ["test", "paths", "config_file", "vitest"],
        rawQuote: `${file} include: ${match.values.join(", ")}`,
      }),
    );
  }
  for (const match of arrayAssignments(text, "exclude")) {
    facts.push(
      testFact(ctx, file, {
        predicate:
          coverageIndex !== -1 && match.index > coverageIndex
            ? "coverage_exclude_globs"
            : "test_exclude_globs",
        object: match.values,
        factKind: "semantic",
        tags: ["test", "paths", "config_file", "vitest"],
        rawQuote: `${file} exclude: ${match.values.join(", ")}`,
      }),
    );
  }

  return facts.slice(0, 30);
}

function testFact(
  ctx: ExtractContext,
  file: string,
  options: {
    predicate: string;
    object: unknown;
    factKind: FactKind;
    tags: string[];
    rawQuote: string;
  },
): NewFact {
  return structuredFact({
    subject: "repo",
    predicate: options.predicate,
    object: options.object,
    fact_kind: options.factKind,
    temporal_kind: "static",
    scope: ctx.scope,
    tags: options.tags,
    rawQuote: options.rawQuote,
    git: {
      repo_id: ctx.repoId,
      branch: ctx.branch,
      valid_from_commit: ctx.head,
      introduced_by_commit: ctx.head,
      path_globs: [file],
    },
  });
}

function scalarStringAfter(text: string, key: string): string | undefined {
  const match = new RegExp(`\\b${key}\\s*:\\s*["']([^"']+)["']`).exec(text);
  return match?.[1]?.trim();
}

function scalarNumberAfter(text: string, key: string): number | undefined {
  const match = new RegExp(`\\b${key}\\s*:\\s*(\\d+)`).exec(text);
  return match ? Number(match[1]) : undefined;
}

function arrayAssignments(text: string, key: string): Array<{ index: number; values: string[] }> {
  const out: Array<{ index: number; values: string[] }> = [];
  const re = new RegExp(`\\b${key}\\s*:\\s*\\[([\\s\\S]*?)\\]`, "g");
  let match = re.exec(text);
  while (match) {
    const values = quotedStrings(match[1] ?? "");
    if (values.length > 0) out.push({ index: match.index, values });
    match = re.exec(text);
  }
  return out;
}

function quotedStrings(text: string): string[] {
  const values: string[] = [];
  const re = /["']([^"']+)["']/g;
  let match = re.exec(text);
  while (match) {
    values.push(match[1] as string);
    match = re.exec(text);
  }
  return values.slice(0, 50);
}
