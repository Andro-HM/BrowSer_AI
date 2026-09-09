// M7 — session-scoped navigation policy state.
//
// The action bridge validates every action against an `ActionPolicy`; the NAVIGATE
// allowlist is DERIVED per step by the agent loop (explicit option, else the scanned
// page's own origin — "navigation may stay on the site the user is on") and stored
// here so a bridge built earlier can validate against the CURRENT allowlist without
// sharing object references. Session-scoped, in-memory, value-free (origins only).

export interface SessionNavigationPolicy {
  set(list: readonly string[]): void;
  get(): readonly string[];
}

/** One immutable-copy policy handle per agent run; empty means NAVIGATE is denied. */
export function createSessionNavigationPolicy(initial: readonly string[] = []): SessionNavigationPolicy {
  let allowlist: readonly string[] = Object.freeze([...initial]);
  return {
    set(list): void { allowlist = Object.freeze([...list]); },
    get(): readonly string[] { return allowlist; },
  };
}
