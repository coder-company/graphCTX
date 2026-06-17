import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

copyDir("src/store/migrations", "dist/store/migrations");
copyDir("src/extract/llm/prompts", "dist/extract/llm/prompts");
copyDir("fixtures/repo-pnpm-web", "dist/fixtures/repo-pnpm-web");

function copyDir(fromRel, toRel) {
  const from = join(root, fromRel);
  const to = join(root, toRel);
  if (!existsSync(from)) {
    throw new Error(`missing asset directory: ${fromRel}`);
  }
  rmSync(to, { recursive: true, force: true });
  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to, { recursive: true });
}
