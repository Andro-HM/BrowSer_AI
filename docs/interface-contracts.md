# PrivAgent — Interface Contracts

_Status: **implemented**. This document mirrors the committed code: request schema =
`backend/fastapi/app/agent.py` (`PlanRequest`), firewall shape =
`extension/src/firewall/inspect.ts`, extension type =
`extension/src/types/contracts.ts` (`RemoteAgentRequest`)._
_Grounded in blueprint §7, §9, §14._

---

## 1. Alias lifecycle

State machine for every protected value:

```
DETECTED ──▶ ALLOCATED ──▶ IN_USE (remote) ──▶ RESOLVED (local, at action) ──▶ EXPIRED (wiped)
```

| Phase         | Where                      | What happens                                                                                                                                                                                      |
| ------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **DETECTED**  | local (sensitivity engine) | Value flagged sensitive with category + confidence + reasons                                                                                                                                      |
| **ALLOCATED** | local (sanitizer + vault)  | Assign a stable, typed, opaque alias `USER_<CATEGORY>_<n>`; store `alias ↔ value` in the **local vault**, marked local-only                                                                       |
| **IN_USE**    | crosses boundary           | Only the **alias + category** appears in sanitized context / agent I/O. Mapping never leaves the device                                                                                           |
| **RESOLVED**  | local (action bridge)      | At action execution, **after** schema + policy validation, the alias is resolved to its real value and injected into the target element. Record metadata only (`ALIAS_RESOLVED`), never the value |
| **EXPIRED**   | local (vault)              | On task/session end, tab close, or extension reload → mapping wiped                                                                                                                               |

**Alias invariants** (PDF §7): stable within a session/task · opaque (encodes no part of the secret) · typed (`USER_EMAIL_1` not `VALUE_7`) · unique · non-reversible by the remote agent · resolvable **only** locally · mapping never placed in prompts, logs, telemetry, or benchmark exports.

## 2. Remote AI input contract (implemented)

The remote agent receives a single **sanitized** request object (`POST /v1/plan`,
alias `POST /v1/act`). Field table — exactly as implemented in
`backend/fastapi/app/agent.py`:

| Field | Type | Required | Constraints |
| ----- | ---- | -------- | ----------- |
| `taskObjective` | string | yes | 1–2000 chars |
| `pageOrigin` | string \| null | no (default `null`) | origin-only when present |
| `sanitizedPageStructure` | `SanitizedNode[]` | yes | ≤ 500 nodes |
| `sanitizedVisibleText` | string | yes | ≤ 100 000 chars, aliased |
| `aliases` | `{ alias, category }[]` | yes | ≤ 100 bindings, TYPE ONLY — never the value, never the mapping |
| `availableActions` | `AgentActionKind[]` | yes | `CLICK \| TYPE \| SELECT \| SCROLL \| NAVIGATE` |
| `provider` | `deterministic \| gemini \| ollama` \| null | no (default `null` → `AGENT_PROVIDER` env → `deterministic`) | planner hint only |
| `policy` | `{ privacyMode, navigationAllowlist }` | yes | `privacyMode`: only `"strict"` accepted (anything else → 422); `navigationAllowlist: string[]` (default `[]` = navigation denied) |

`SanitizedNode`: `tag: input \| textarea \| select \| button` (required) ·
`selector: string` 1–512 chars (required) · `inputType?`, `label?`, `name?: string` ·
`filled: boolean`, `disabled: boolean` (required) · `belowFold?: boolean`.
`AliasBinding`: `alias` must match `^USER_[A-Z]+_\d+$` (required) · `category: string` (required).

There is no `pageContext`/`nodes` shape — clients must send the fields above.

**Example request** (deterministic provider; this exact payload is asserted by
`backend/fastapi/tests/test_contract.py`):

```json
{
  "taskObjective": "fill the form with my details and submit",
  "pageOrigin": null,
  "sanitizedPageStructure": [
    {
      "tag": "input",
      "selector": "#email",
      "inputType": "email",
      "label": "Email",
      "filled": false,
      "disabled": false
    }
  ],
  "sanitizedVisibleText": "Contact USER_EMAIL_1",
  "aliases": [{ "alias": "USER_EMAIL_1", "category": "EMAIL" }],
  "availableActions": ["CLICK", "TYPE", "SELECT", "SCROLL", "NAVIGATE"],
  "provider": "deterministic",
  "policy": { "privacyMode": "strict", "navigationAllowlist": [] }
}
```

**Example response** (`{"actions": [...]}` — `[]` when nothing to do or task done):

```json
{
  "actions": [{ "action": "TYPE", "target": "#email", "value": "USER_EMAIL_1" }]
}
```

**Firewall gate:** every request passes the privacy firewall before transmission. Denied content (raw values, mappings, unfiltered screenshots) → block/replace, fail closed.

## 3. Structured agent action contract

From blueprint §14 — the agent emits **only** these structured actions (no arbitrary JS):

```ts
type AgentAction =
  | { action: 'CLICK'; target: string }
  | { action: 'TYPE'; target: string; value: string } // value = alias or safe text only
  | { action: 'SELECT'; target: string; value: string }
  | { action: 'SCROLL'; amount: number }
  | { action: 'NAVIGATE'; url: string };
```

**Validation pipeline** (PDF §7 action contract, §9 validation column; CONTRIBUTING.md §7):

```
Agent output
  → 1. Schema validation      (well-formed AgentAction)
  → 2. Target verification    (element exists + visible + allowed)
  → 3. Policy validation      (TYPE: alias-or-safe-text only; NAVIGATE: allowlist; SCROLL: bounds)
  → 4. Local alias resolution (only here; only if needed)
  → 5. Execute browser action
  → 6. Record metadata only   (never the resolved secret)
```

Forbidden at every stage: `eval`, `Function`, arbitrary code execution, or any action originating from page-injected instructions.

## 4. Supporting types (from blueprint §14, for reference)

```ts
type SensitiveEntity = {
  id: string;
  category:
    'EMAIL' | 'PHONE' | 'NAME' | 'ADDRESS' | 'PASSWORD' | 'OTP' | 'PAYMENT' | 'ID' | 'CUSTOM';
  source: 'DOM' | 'OCR' | 'VISION' | 'FUSED';
  text?: string; // LOCAL ONLY for protected entities
  bbox?: [number, number, number, number];
  confidence: number;
  reasons: string[];
  elementId?: string;
};

type AliasRecord = {
  alias: string; // e.g. USER_EMAIL_1
  category: string;
  sessionId: string;
  createdAt: number;
  // actualValue MUST remain local (stored in vault, never serialized remotely)
};

type PrivacyEvent = {
  type: 'DETECTED' | 'SANITIZED' | 'BLOCKED' | 'ALIAS_RESOLVED' | 'TASK_RESULT';
  entityCategory?: string;
  alias?: string;
  timestamp: number; // never store the raw protected value
};
```
