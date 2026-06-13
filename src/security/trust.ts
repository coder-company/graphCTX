import type { TrustTier } from "../core/types.js";

// Trust-tier assignment (I2). Structured config the repo enforces = high.
// Free-text prose (AGENTS.md/README/comments) = low. Never configurable to
// upgrade prose to high.
const STRUCTURED_SOURCES = new Set([
  "package.json",
  ".editorconfig",
  "lockfile",
  "ci",
  "generated-markers",
]);

export function trustForSource(source: string): TrustTier {
  return STRUCTURED_SOURCES.has(source) ? "high" : "low";
}
