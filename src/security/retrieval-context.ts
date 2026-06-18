import type { InjectionContext } from "../core/types.js";
import { redactSecretValue, redactSecrets } from "./secrets.js";

export const RETRIEVAL_CONTEXT_TEXT_LIMIT = 4000;
export const TOOL_RESULT_TEXT_LIMIT = 1000;

export function sanitizeRetrievalText(
  text: string | undefined,
  limit = RETRIEVAL_CONTEXT_TEXT_LIMIT,
): string | undefined {
  if (text === undefined) return undefined;
  if (limit <= 0) return "";
  return redactSecrets(text).slice(0, limit);
}

export function sanitizeInjectionContextExtra(
  extra: Partial<InjectionContext>,
): Partial<InjectionContext> {
  const clean: Partial<InjectionContext> = {
    ...extra,
    user_prompt: sanitizeRetrievalText(extra.user_prompt),
    transcript_tail: sanitizeRetrievalText(extra.transcript_tail),
    current_files: extra.current_files?.map((file) => sanitizeRetrievalText(file, 1000) ?? ""),
    mentioned_symbols: extra.mentioned_symbols?.map(
      (symbol) => sanitizeRetrievalText(symbol, 1000) ?? "",
    ),
  };

  if (extra.planned_tool) {
    clean.planned_tool = {
      ...extra.planned_tool,
      args: redactSecretValue(extra.planned_tool.args),
    };
  }

  if (extra.tool_result) {
    clean.tool_result = {
      ...extra.tool_result,
      stderr: sanitizeRetrievalText(extra.tool_result.stderr, TOOL_RESULT_TEXT_LIMIT),
      stdout_tail: sanitizeRetrievalText(extra.tool_result.stdout_tail, TOOL_RESULT_TEXT_LIMIT),
    };
  }

  return clean;
}
