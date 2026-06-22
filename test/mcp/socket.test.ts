import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { McpServer } from "../../src/mcp/server.js";

// Daemon mode: line-delimited JSON-RPC over a local Unix socket. Verifies the
// listener binds locally (no TCP), advertises the same 8 tools, and handles two
// concurrent clients against the same backing process.

describe("mcp daemon socket", () => {
  let workDir: string;
  let socket: string;
  let server: McpServer | undefined;
  let stopServer: (() => Promise<void>) | undefined;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "graphctx-mcp-socket-"));
    socket = join(workDir, "mcp.sock");
  });

  afterEach(async () => {
    if (stopServer) {
      try {
        await stopServer();
      } catch {
        /* noop */
      }
      stopServer = undefined;
    }
    try {
      server?.close();
    } catch {
      /* noop */
    }
    server = undefined;
    await rm(workDir, { recursive: true, force: true });
  });

  it("binds locally and answers tools/list with exactly 8 tools", async () => {
    server = new McpServer({ workspaceDir: workDir });
    let serveDone: (() => void) | undefined;
    const servePromise = new Promise<void>((resolve) => {
      serveDone = resolve;
    });
    stopServer = async () => {
      process.emit("SIGTERM");
      await servePromise;
    };
    // start the daemon, but don't await — it stays alive until SIGTERM
    void server
      .serveSocket(socket)
      .catch(() => {
        /* daemon exits via signal handler */
      })
      .finally(() => serveDone?.());

    // wait for the socket to appear
    for (let i = 0; i < 50 && !existsSync(socket); i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(existsSync(socket)).toBe(true);

    const reply = await rpc(socket, [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    ]);
    const init = reply.find((r) => r.id === 1);
    const list = reply.find((r) => r.id === 2);
    expect(init?.result?.serverInfo?.name).toBe("graphctx");
    expect(list?.result?.tools).toHaveLength(8);

    // two concurrent clients share the same daemon and the same store
    const [a, b] = await Promise.all([
      rpc(socket, [{ jsonrpc: "2.0", id: 11, method: "tools/list", params: {} }]),
      rpc(socket, [{ jsonrpc: "2.0", id: 12, method: "tools/list", params: {} }]),
    ]);
    expect(a[0]?.result?.tools).toHaveLength(8);
    expect(b[0]?.result?.tools).toHaveLength(8);
  }, 15000);
});

async function rpc(
  socketPath: string,
  requests: Array<Record<string, unknown>>,
): Promise<Array<{ id?: number; result?: { tools?: unknown[]; serverInfo?: { name?: string } } }>> {
  return await new Promise((resolve, reject) => {
    const conn = createConnection(socketPath);
    let buf = "";
    const out: Array<{ id?: number; result?: unknown }> = [];
    const wantedIds = new Set(requests.map((r) => r.id as number | undefined).filter(Boolean));
    conn.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let nl = buf.indexOf("\n");
      while (nl !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) {
          try {
            const parsed = JSON.parse(line);
            out.push(parsed);
            if (out.length >= wantedIds.size) {
              conn.end();
            }
          } catch {
            /* skip noise */
          }
        }
        nl = buf.indexOf("\n");
      }
    });
    conn.on("error", reject);
    conn.on("close", () => resolve(out as never));
    for (const req of requests) conn.write(`${JSON.stringify(req)}\n`);
  });
}
