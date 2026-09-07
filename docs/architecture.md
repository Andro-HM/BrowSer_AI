# PrivAgent — Architecture

This document describes the **module boundaries and their current state**. Milestone
labels below follow the authoritative M0–M11 scheme defined in
[PROJECT_STATUS.md §0A](../PROJECT_STATUS.md); that file is an append-only log whose older
sections keep the working labels they were written with. See
[docs/threat-model.md](threat-model.md) /
[docs/interface-contracts.md](interface-contracts.md) /
[docs/benchmark.md](benchmark.md) for the security design and measured results.

## Runtime surfaces (Chrome MV3)

| Surface            | Path                        | Role                                                        |
| ------------------ | --------------------------- | ----------------------------------------------------------- |
| Service worker     | `extension/src/background/` | Coordinator; opens side panel; relays messages; brokers viewport capture. |
| Content script     | `extension/src/content/`    | Reads the (untrusted) page DOM; executes structured actions. |
| Side panel (React) | `extension/src/sidepanel/`  | User-facing UI; **hosts the entire local pipeline** — rasterization, ONNX inference (WebGPU/WASM), OCR, policy, sanitization. |
| Offscreen document | `extension/src/offscreen/`  | **M0 scaffold, currently unused.** See below.               |

### The offscreen document is not in the execution path

`extension/src/offscreen/` contains `index.html` and an `offscreen.ts` whose body is
`export {}`. Nothing registers or reaches it, and this is verifiable rather than assumed:

- no `chrome.offscreen.createDocument` call exists anywhere in `extension/`;
- the manifest declares no `offscreen` permission, so such a call could not succeed;
- nothing imports the module, and no `offscreen` artifact appears in `dist/`.

All WASM/WebGPU inference runs in the **side-panel document** instead, because that is the
context that already owns the capture data URL and can rasterize it — routing pixels to a
second document would add a cross-document pixel message path for no capability gain (the
reasoning is recorded at `extension/src/perception/visual/faceBlur.ts:17-22`).

The scaffold is kept, not deleted: it is the pre-built home for a future workload that
genuinely cannot run in a panel (e.g. inference that must survive the panel closing).
Until such a workload exists, moving working inference here would be churn.

## Core modules (implemented)

Milestone labels are authoritative (PROJECT_STATUS.md §0A).

```
perception/dom      DOM extraction                          (M1 ✅)
perception/pii      pattern + label-evidence PII             (M2 ✅, multi-signal ✅)
perception/visual   capture/regions/bands/raster/providers   (M3 ✅ — OmniParser icon_detect ONNX)
perception/ocr      Tesseract.js, local wasm                 (M3 ✅, live Chrome verify via e2e)
perception/visual   faceBlur (BlazeFace ONNX) + pageClassifier (M3 ✅ — specialized detectors)
policy              ALLOW/WARN/SANITIZE/BLOCK decision      (M4 ✅)
sanitizer           aliasing + mask directives               (M5 ✅)
vault               local alias<->value store                (M5 ✅)
policy/modes        privacy-mode vocabulary + guard          (M6 ✅ — task privacy contract)
agent               loop driver + deterministic/remote planner (M7 ✅)
actions             schema/policy validation + bridge        (M7 ✅)
backend/fastapi     planner service, deterministic + Gemini  (M7 ✅)
sidepanel           scan UI, agent UI, telemetry dashboard   (M8 ✅)
firewall            single outbound boundary                 (M9 ✅)
telemetry           value-free audit log + timings           (M8 dashboard + M10 metrics ✅)
benchmark           PrivAgent-Bench + leakage sentinel       (M10 ✅)
types/contracts     shared data contracts                    (M0 ✅, extended M3–M9)
```

## The one rule that shapes everything: single egress

All outbound network traffic to a remote model/backend passes through
**`firewall/`** and nothing else. The firewall is the last checkpoint before the
remote boundary and **fails closed** — if it cannot establish that a payload is
alias-only, free of protected values, and free of encoded pixels, it blocks. Raw
protected values and alias→value mappings never leave the device and are never logged
(CONTRIBUTING.md §5).

```
page DOM (untrusted)
   -> DOM perception -> [DOM sufficient? ---- yes ----> skip visual models]
                                |
                                no
                                v
                        local visual perception
                        (UI detector -> face blur -> OCR; all on-device)
                                |
                                v
   -> PII detection -> policy -> sanitizer --(aliases only)--> firewall --> backend -> Gemini
                                    |
                                 vault (local; real values stay here)
```

The agent loop (`agent/loop.ts`) drives this pipeline per step: observe → **visual
perception (DOM-first: skipped entirely when the DOM suffices)** → detect → enforce →
build `RemoteAgentRequest` → firewall → plan → validate → execute locally → re-observe.
Alias resolution happens only in the action bridge, at execution time.

The scan path (`sidepanel/App.tsx`) and the agent path (`sidepanel/AgentTask.tsx`) share
**one** `VisualPerceptionService` instance (`sidepanel/visual-service.ts`) and therefore
one privacy path, one capability probe, and one region cache. A second service would be a
second place where pixels are handled.

## Backend

`backend/fastapi/` is the planner service (`POST /v1/plan`, alias `POST /v1/act`) with a
provider seam selected by `AGENT_PROVIDER`: `deterministic` (default, offline, no model),
`gemini` (Gemini Flash via structured JSON output), or `remote` (the Ollama/VLM adapter,
still loudly unimplemented). `GEMINI_API_KEY` is read only on the `gemini` path — local
visual perception never touches it and works with no key configured.

It is treated as a remote boundary: it must never receive raw protected values, and its
deterministic planner works purely on sanitized field semantics, filled flags and alias
bindings. It also mirrors the client gate as defense in depth (`app/pii_scan.py`) — a
PRE-SCAN refusing raw PII or encoded media on the way in, a POST-SCAN refusing raw PII in
model output, `extra="forbid"` refusing smuggled fields, and a validation handler that
reports which field failed without echoing its value. The mirror makes no policy
decisions; those live once, in the extension.

## Benchmark

`benchmark/` implements PrivAgent-Bench (blueprint §10/§11/§7): synthetic page/task
families with uniquely-identifiable canaries, the §7 leakage sentinel over real agent
runs, and the §11 three-way comparison. Run with `npm run bench`; metric definitions
and measured numbers live in [benchmark.md](benchmark.md).

## Build layout

- Vite + `@crxjs/vite-plugin` builds the MV3 bundle from `extension/manifest.ts`.
- `tsc --noEmit` typechecks; `vitest` runs unit/integration tests (Node env);
  `npm run bench` runs PrivAgent-Bench; Playwright runs browser e2e.
- `npm run build:firefox` re-emits the same bundle with an MV3 transform
  (`scripts/build-firefox.mjs`).
- CI (`.github/workflows/ci.yml`): node gates, backend pytest, e2e, benchmark artifacts.
