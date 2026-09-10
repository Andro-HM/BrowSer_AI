// Planner-mode selection for the side-panel agent task UI.
//
// The panel NEVER talks to a model vendor directly: every remote mode goes
// through the SAME local FastAPI endpoint (`REMOTE_PLAN_ENDPOINT`) behind the
// SAME fail-closed privacy firewall, and the `provider` hint only tells the
// backend which planner brain to use for this run. No vendor key or vendor
// domain belongs here — the backend alone owns those (CONTRIBUTING.md §5).

import type { RemoteAgentRequest } from '../types/contracts';

export type PlannerMode = 'local' | 'gemini' | 'zen' | 'offline';

export type RemoteProviderHint = NonNullable<RemoteAgentRequest['provider']>;

/** Local FastAPI planner endpoint. Remote modes never fetch anywhere else. */
export const REMOTE_PLAN_ENDPOINT = 'http://localhost:8000/v1/plan';

/** Backend waits: Gemini 30s, Zen 35s, Ollama 90s. The panel never aborts first. */
export function timeoutForPlannerMode(mode: PlannerMode): number {
  if (mode === 'local') return 95_000;
  if (mode === 'zen') return 40_000;
  return 35_000;
}

/** Backend `provider` hint for a remote mode. Offline runs no remote planner. */
export function providerForPlannerMode(mode: Exclude<PlannerMode, 'offline'>): RemoteProviderHint {
  if (mode === 'local') return 'ollama';
  if (mode === 'zen') return 'zen';
  return 'gemini';
}
