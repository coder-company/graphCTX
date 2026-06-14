import { ulid } from "ulid";

// Sortable unique IDs (D: ulid). Prefixed for readability/debuggability.
export function newId(prefix: string): string {
  return `${prefix}_${ulid()}`;
}

export const factId = (): string => newId("fact");
export const eventId = (): string => newId("evt");
export const entityId = (): string => newId("ent");
export const edgeId = (): string => newId("edge");
export const injectionId = (): string => newId("inj");
export const procedureId = (): string => newId("proc");
export const promotionId = (): string => newId("promo");

// Deterministic id for a workspace from its absolute path.
export function workspaceIdFromPath(absPath: string): string {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < absPath.length; i++) {
    h ^= absPath.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return `ws_${h.toString(16).padStart(8, "0")}`;
}
