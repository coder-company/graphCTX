// Public programmatic API surface.
export { Runtime } from "./runtime.js";
export { loadConfig } from "./config/config.js";
export { defaultConfig } from "./config/defaults.js";
export * from "./core/types.js";
export { InjectionPlanner } from "./inject/planner.js";
export { Retriever } from "./retrieve/retriever.js";
export { runDeterministicExtraction } from "./extract/pipeline.js";
export { renderCapsule } from "./render/capsule.js";
export { runEval } from "./eval/harness.js";
export { McpServer } from "./mcp/server.js";
export { MCP_TOOLS } from "./mcp/tools.js";
export { detectClient, makeAdapter } from "./adapters/registry.js";
export { OutcomeRecorder, classifyOutcome } from "./telemetry/outcomes.js";
