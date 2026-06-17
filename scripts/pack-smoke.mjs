import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const tmp = mkdtempSync(join(tmpdir(), "graphctx-pack-smoke-"));
const app = join(tmp, "app");
mkdirSync(app);

try {
  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  const tarballName = run("npm", ["pack", "--pack-destination", tmp, "--silent"], repoRoot)
    .trim()
    .split(/\r?\n/)
    .pop();
  if (!tarballName) throw new Error("npm pack did not print a tarball name");

  run("git", ["init", "-q"], app);
  run("npm", ["init", "-y", "--silent"], app);
  run("npm", ["install", join(tmp, tarballName), "--silent"], app);

  const bin = join(
    app,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "graphctx.cmd" : "graphctx",
  );
  const version = run(bin, ["--version"], app).trim();
  assert(version === pkg.version, `installed bin version ${version} != package ${pkg.version}`);

  const serveHelp = run(bin, ["serve", "--help"], app);
  assert(serveHelp.includes("--mcp"), "serve --help does not document --mcp");

  run(bin, ["init"], app);
  const doctor = run(bin, ["doctor"], app);
  assert(doctor.includes("graphctx doctor"), "doctor output missing header");

  run(bin, ["install", "auto", "--bin", "graphctx"], app);

  const remembered = "package smoke remembers the launch readiness note";
  run(bin, ["remember", remembered], app);
  const recall = run(bin, ["recall", remembered], app);
  assert(recall.includes(remembered), "recall did not return the remembered note");

  let agents = readFileSync(join(app, "AGENTS.md"), "utf8");
  assert(agents.includes(remembered), "AGENTS.md did not refresh with remembered note");

  const secretText = "api_key: FAKEsecret01234567890";
  run(bin, ["remember", secretText], app);
  agents = readFileSync(join(app, "AGENTS.md"), "utf8");
  assert(!agents.includes("FAKEsecret01234567890"), "AGENTS.md leaked a secret-scanner fact");

  const mcp = run(
    bin,
    ["serve", "--mcp"],
    app,
    [
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
      "",
    ].join("\n"),
  );
  const responses = mcp
    .trim()
    .split(/\n+/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const init = responses.find((r) => r.id === 1);
  const list = responses.find((r) => r.id === 2);
  assert(init?.result?.serverInfo?.name === "graphctx", "installed MCP initialize failed");
  assert(list?.result?.tools?.length === 8, "installed MCP tools/list did not return 8 tools");

  const pkgRoot = join(app, "node_modules", "graphctx");
  const requiredAssets = [
    "dist/store/migrations/0001_init.sql",
    "dist/store/migrations/0002_m1.sql",
    "dist/store/migrations/0003_m2.sql",
    "dist/extract/llm/prompts/fact_extract.v1.md",
    "dist/extract/llm/prompts/invalidation.v1.md",
    "dist/extract/llm/prompts/procedure_mine.v1.md",
  ];
  for (const rel of requiredAssets) {
    assert(existsSync(join(pkgRoot, rel)), `missing installed asset: ${rel}`);
  }

  console.log(
    JSON.stringify(
      {
        smoke: "pass",
        package: `${pkg.name}@${pkg.version}`,
        tarball: tarballName,
        mcpTools: list.result.tools.length,
        assets: requiredAssets.length,
      },
      null,
      2,
    ),
  );
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  console.error(`pack-smoke temp dir: ${tmp}`);
  process.exitCode = 1;
} finally {
  if (!process.exitCode && process.env.GRAPHCTX_KEEP_PACK_SMOKE !== "1") {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function run(cmd, args, cwd, input) {
  const result = spawnSync(cmd, args, {
    cwd,
    input,
    encoding: "utf8",
    env: { ...process.env, CI: "1" },
    maxBuffer: 20 * 1024 * 1024,
    stdio: input === undefined ? ["ignore", "pipe", "pipe"] : ["pipe", "pipe", "pipe"],
    timeout: 30000,
  });
  if (result.status !== 0) {
    throw new Error(
      [
        `command failed: ${cmd} ${args.join(" ")}`,
        `cwd: ${cwd}`,
        `status: ${result.status}`,
        result.stdout ? `stdout:\n${result.stdout}` : "",
        result.stderr ? `stderr:\n${result.stderr}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
  return result.stdout;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
