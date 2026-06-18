import { redactSecrets } from "./secrets.js";

export const RETRIEVAL_CONTEXT_TEXT_LIMIT = 4000;

export function sanitizeRetrievalText(
  text: string | undefined,
  limit = RETRIEVAL_CONTEXT_TEXT_LIMIT,
): string | undefined {
  if (text === undefined) return undefined;
  if (limit <= 0) return "";
  return redactSecrets(text).slice(0, limit);
}
