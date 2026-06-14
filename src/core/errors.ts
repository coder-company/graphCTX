// Typed error hierarchy (SPEC §23). Each error carries a code + suggested action.

export type ErrorCode = "CONFIG" | "STORE" | "GIT" | "LLM" | "ADAPTER" | "VALIDATION";

export class GraphCtxError extends Error {
  readonly code: ErrorCode;
  readonly action?: string;
  constructor(code: ErrorCode, message: string, action?: string) {
    super(message);
    this.name = `${code}Error`;
    this.code = code;
    this.action = action;
  }
}

export class ConfigError extends GraphCtxError {
  constructor(message: string, action?: string) {
    super("CONFIG", message, action);
  }
}

export class StoreError extends GraphCtxError {
  constructor(message: string, action?: string) {
    super("STORE", message, action);
  }
}

export class GitError extends GraphCtxError {
  constructor(message: string, action?: string) {
    super("GIT", message, action);
  }
}

export class LLMError extends GraphCtxError {
  constructor(message: string, action?: string) {
    super("LLM", message, action);
  }
}

export class AdapterError extends GraphCtxError {
  constructor(message: string, action?: string) {
    super("ADAPTER", message, action);
  }
}

export class ValidationError extends GraphCtxError {
  constructor(message: string, action?: string) {
    super("VALIDATION", message, action);
  }
}
