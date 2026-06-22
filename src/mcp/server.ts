import { existsSync, unlinkSync } from "node:fs";
import { createServer } from "node:net";
import { createInterface } from "node:readline";
import { buildRider } from "../adapters/channel.js";
import type { Capsule } from "../core/types.js";
import { Runtime } from "../runtime.js";
import { redactSecrets } from "../security/secrets.js";
import { VERSION } from "../version.js";
import { MCP_TOOLS } from "./tools.js";

// graphCTX MCP server (SPEC §18). Long-lived stdio JSON-RPC 2.0 process exposing
// EXACTLY 8 tools (I8). Each tool response may carry a Tier-1 parasitic rider —
// a tiny fresh-context snippet, gated by the same ledger to avoid repetition.
// Implemented over stdio JSON-RPC directly (no SDK dependency, consistent with
// the rest of the codebase). Fail-soft: a tool error returns a JSON-RPC error,
// never crashes the server.

const PROTOCOL_VERSION = "2025-11-25";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string | null;
  method: string;
  params?: unknown;
}

export interface McpServerOptions {
  workspaceDir?: string;
  userId?: string;
  // emit (test seam) — defaults to stdout. Receives a serialized JSON-RPC msg.
  emit?: (line: string) => void;
  // rider session for Tier-1 anti-repetition.
  riderSessionId?: string;
}

export class McpServer {
  private readonly rt: Runtime;
  private readonly emit: (line: string) => void;
  private readonly riderSession: string;

  constructor(opts: McpServerOptions = {}) {
    if (MCP_TOOLS.length !== 8) {
      // I8 hard guard — the surface must be exactly 8 tools.
      throw new Error(`I8 violation: MCP must expose exactly 8 tools, found ${MCP_TOOLS.length}`);
    }
    this.rt = new Runtime({ workspaceDir: opts.workspaceDir, userId: opts.userId });
    this.emit = opts.emit ?? ((line) => process.stdout.write(`${line}\n`));
    this.riderSession = opts.riderSessionId ?? "mcp-rider";
  }

  // Handle one JSON-RPC message; returns the response object (or null for
  // notifications). Public for the in-process smoke test.
  async handle(req: unknown): Promise<unknown | null> {
    const id = idOf(req);
    try {
      if (!isJsonRpcRequest(req)) {
        return this.err(id, -32600, "invalid request");
      }
      switch (req.method) {
        case "initialize":
          return this.ok(req.id, {
            protocolVersion: PROTOCOL_VERSION,
            serverInfo: { name: "graphctx", version: VERSION },
            capabilities: { tools: {} },
          });
        case "notifications/initialized":
          return null; // notification, no response
        case "tools/list":
          return this.ok(req.id, {
            tools: MCP_TOOLS.map((t) => ({
              name: t.name,
              description: t.description,
              inputSchema: t.inputSchema,
              outputSchema: t.outputSchema,
            })),
          });
        case "tools/call":
          return await this.callTool(req);
        case "ping":
          return this.ok(req.id, {});
        default:
          return this.err(req.id, -32601, `method not found: ${req.method}`);
      }
    } catch (e) {
      return this.err(id, -32603, `internal error: ${messageOf(e)}`);
    }
  }

  private async callTool(req: JsonRpcRequest): Promise<unknown> {
    const params = (req.params ?? {}) as { name?: string; arguments?: unknown };
    const tool = MCP_TOOLS.find((t) => t.name === params.name);
    if (!tool) return this.err(req.id, -32602, `unknown tool: ${params.name}`);
    try {
      const result = await tool.handler(this.rt, params.arguments ?? {});
      const text = JSON.stringify(result, null, 2);
      const rider = await this.maybeRider();
      const content = [{ type: "text", text }];
      if (rider) content.push({ type: "text", text: rider });
      return this.ok(req.id, { content, structuredContent: result, isError: false });
    } catch (e) {
      return this.ok(req.id, {
        content: [{ type: "text", text: `error: ${messageOf(e)}` }],
        isError: true,
      });
    }
  }

  // Tier-1 parasitic rider: a tiny fresh-context snippet appended to a tool
  // response, gated by the ledger so it doesn't repeat within a session.
  private async maybeRider(): Promise<string> {
    try {
      const ctx = await this.rt.injectionContext("UserPromptSubmit", this.riderSession, {
        user_prompt: "(mcp rider)",
      });
      const capsule: Capsule = await this.rt.planner().plan(ctx, { bypassGate: true });
      return buildRider(capsule);
    } catch {
      return "";
    }
  }

  // Run the stdio loop (line-delimited JSON-RPC).
  async serve(): Promise<void> {
    const rl = createInterface({ input: process.stdin, terminal: false });
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let req: JsonRpcRequest;
      try {
        req = JSON.parse(trimmed);
      } catch {
        this.emit(JSON.stringify(this.err(null, -32700, "parse error")));
        continue;
      }
      const res = await this.handle(req);
      if (res !== null) this.emit(JSON.stringify(res));
    }
  }

  // Daemon mode: serve line-delimited JSON-RPC over a local Unix domain
  // socket. Each connecting client is a fresh JSON-RPC session that shares
  // the same Runtime/DB with all the others, so Claude Desktop, Cursor, Codex
  // and a CI agent can all attach to one process without spawning a new
  // server per client. Bind path is local-filesystem only — there is no TCP
  // listener and there is no network exposure.
  async serveSocket(socketPath: string): Promise<void> {
    if (existsSync(socketPath)) {
      try {
        unlinkSync(socketPath);
      } catch {
        // a stale socket the kernel still owns will surface on listen() below
      }
    }
    const server = createServer((conn) => {
      const send = (line: string) => conn.write(`${line}\n`);
      const rl = createInterface({ input: conn, terminal: false });
      conn.on("error", () => {
        // a client hanging up mid-write must never crash the daemon
        try {
          conn.destroy();
        } catch {
          /* noop */
        }
      });
      (async () => {
        for await (const line of rl) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          let req: JsonRpcRequest;
          try {
            req = JSON.parse(trimmed);
          } catch {
            send(JSON.stringify(this.err(null, -32700, "parse error")));
            continue;
          }
          const res = await this.handle(req);
          if (res !== null) send(JSON.stringify(res));
        }
      })().catch(() => {
        try {
          conn.destroy();
        } catch {
          /* noop */
        }
      });
    });
    await new Promise<void>((ok, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => {
        server.off("error", reject);
        ok();
      });
    });
    process.stderr.write(`graphctx mcp daemon listening on ${socketPath}\n`);
    await new Promise<void>((resolve) => {
      const stop = () => {
        try {
          server.close(() => resolve());
        } catch {
          resolve();
        }
        try {
          if (existsSync(socketPath)) unlinkSync(socketPath);
        } catch {
          /* noop */
        }
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    });
  }

  close(): void {
    this.rt.close();
  }

  private ok(id: JsonRpcRequest["id"], result: unknown) {
    return { jsonrpc: "2.0", id: id ?? null, result };
  }

  private err(id: JsonRpcRequest["id"], code: number, message: string) {
    return { jsonrpc: "2.0", id: id ?? null, error: { code, message: redactSecrets(message) } };
  }
}

function isJsonRpcRequest(value: unknown): value is JsonRpcRequest {
  if (!value || typeof value !== "object") return false;
  const req = value as Record<string, unknown>;
  return req.jsonrpc === "2.0" && typeof req.method === "string";
}

function idOf(value: unknown): JsonRpcRequest["id"] {
  if (!value || typeof value !== "object") return null;
  const id = (value as Record<string, unknown>).id;
  return typeof id === "string" || typeof id === "number" || id === null ? id : null;
}

function messageOf(error: unknown): string {
  return redactSecrets(error instanceof Error ? error.message : String(error));
}
