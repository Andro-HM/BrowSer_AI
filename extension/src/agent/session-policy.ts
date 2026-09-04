// M6 — per-run navigation policy handle.
//
// The action bridge validates every action against an `ActionPolicy`; the NAVIGATE
// allowlist is DERIVED per step by the agent loop (explicit option, else the scanned
// page's own origin — "navigation may stay on the site the user is on") and published
// here so a bridge built BEFORE the first observation can validate against the CURRENT
// allowlist without sharing object references.
//
// This used to be a module-level `let`: one mutable allowlist shared by every loop,
// bridge, and panel document in the process. It is now an explicit handle created by the
// caller and injected into exactly the loop + bridge that belong to one run, so two runs
// can never widen each other's navigation policy. Origins only — value-free, in-memory,
// never persisted.

export interface SessionNavigationPolicy {
  /** Publish the allowlist derived for the current step. Copied + frozen on write. */
  set(list: readonly string[]): void;
  /** The allowlist in force right now. EMPTY ⇒ navigation denied (fail closed). */
  get(): readonly string[];
}

/**
 * Create one navigation-policy handle. Fail closed by default: with no initial list,
 * `get()` returns an empty allowlist, which `validateActionPolicy` treats as "NAVIGATE is
 * denied" until the loop publishes an origin.
 */
export function createSessionNavigationPolicy(
  initial: readonly string[] = [],
): SessionNavigationPolicy {
  let allowlist: readonly string[] = Object.freeze([...initial]);
  return {
    set(list: readonly string[]): void {
      allowlist = Object.freeze([...list]);
    },
    get(): readonly string[] {
      return allowlist;
    },
  };
}
