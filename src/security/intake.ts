import { ValidationError } from "../core/errors.js";
import { containsSecret } from "./secrets.js";

const SECRET_MEMORY_MESSAGE = "refusing to store secret-bearing memory";
const SECRET_MEMORY_ACTION =
  "Remove credentials from the memory text and store only non-secret guidance.";

export function assertSafeMemoryWrite(text: string): void {
  if (containsSecret(text)) {
    throw new ValidationError(SECRET_MEMORY_MESSAGE, SECRET_MEMORY_ACTION);
  }
}

export function formatMemoryWriteError(error: unknown): string {
  if (error instanceof ValidationError && error.message === SECRET_MEMORY_MESSAGE) {
    return `${error.message}. ${error.action}`;
  }
  return error instanceof Error ? error.message : String(error);
}
