import { encode } from "gpt-tokenizer";

// Token estimation (SPEC §16, §24 render < 20ms). Uses gpt-tokenizer; falls back
// to a chars/4 heuristic if encoding throws on odd input.
export function estimateTokens(text: string): number {
  if (!text) return 0;
  try {
    return encode(text).length;
  } catch {
    return Math.ceil(text.length / 4);
  }
}
