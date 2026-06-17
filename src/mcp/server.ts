import { createInterface } from "node:readline";
import { buildRider } from "../adapters/channel.js";
import type { Capsule } from "../core/types.js";
import { Runtime } from "../runtime.js";
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
  async handle(req: JsonRpcRequest): Promise<unknown | null> {
    try {
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
      return this.err(req.id, -32603, `internal error: ${(e as Error).message}`);
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
        content: [{ type: "text", text: `error: ${(e as Error).message}` }],
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

  close(): void {
    this.rt.close();
  }

  private ok(id: JsonRpcRequest["id"], result: unknown) {
    return { jsonrpc: "2.0", id: id ?? null, result };
  }

  private err(id: JsonRpcRequest["id"], code: number, message: string) {
    return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
  }
}
