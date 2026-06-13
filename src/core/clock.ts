// Time helpers (SPEC §2). Injectable for deterministic tests. ISO-8601 everywhere.

export interface Clock {
  now(): Date;
  iso(): string;
}

export const systemClock: Clock = {
  now: () => new Date(),
  iso: () => new Date().toISOString(),
};

// Fixed clock for tests.
export function fixedClock(at: string | Date): Clock {
  const d = typeof at === "string" ? new Date(at) : at;
  return { now: () => new Date(d), iso: () => d.toISOString() };
}

export function isoNow(): string {
  return systemClock.iso();
}
