# PrivAgent — PROJECT_STATUS

_Last updated: 2026-09-05_
_Author: post-merge audit of the merged tree — <100 MB budget met (135 → 82 MB) on
per-variant ORT evidence, both WebGPU and WASM/CPU paths re-probed in a real browser, and
every shipped binary's license traced to a primary source (§9r). The merge itself:
`other-pr3` (M7.5 face detection + M8 Gemini Flash) into `integrate-f` (M3's real local
vision model) — conflicts resolved, one merge defect found and fixed, all gates
re-measured (§9q). Previous entries: M3 closed out with a REAL
local vision model (§00) — OmniParser `icon_detect` ONNX through onnxruntime-web, verified
by real inference, not mocks; all gates re-verified from a clean tree (§9k); M6 audit gaps
closed with an explicit task privacy contract (§9o). The merged work itself: on-device face
detection (§9l), the Gemini Flash provider on the backend seam (§9m) and its side-panel
planner toggle (§9n)._
_Engineering rules: [CONTRIBUTING.md](CONTRIBUTING.md) (formerly `CLAUDE.md`; section
numbers unchanged)._


---

## 0A. AUTHORITATIVE milestone map (read this before any section below)

This file is an **append-only engineering log**: each `##` section records what was true
when it was written, and is deliberately left as written. Sections were numbered as work
landed (`00`, `9a`…`9r`), and some used a working label from the branch they came from —
notably **"M7.5"**, which was one contributor's internal numbering for the face-detection
work, not a project milestone.

The table below is the **authoritative** M0–M11 definition. Where a historical section's
label differs, the authoritative column governs; the historical label is preserved so the
log stays readable and its claims stay attributable.

| Authoritative | Meaning                                          | Primary modules                                            | Log sections                     |
| ------------- | ------------------------------------------------ | ---------------------------------------------------------- | -------------------------------- |
| **M0**        | Foundation, contracts, build/CI skeleton         | `types/contracts`, `manifest.ts`, `offscreen/` (scaffold)  | §6                               |
| **M1**        | Capture + state + basic perception               | `background/`, `content/`, `perception/dom`                | §6, §7                           |
| **M2**        | DOM perception + PII extraction                  | `perception/dom`, `perception/pii`                          | §8                               |
| **M3**        | **Local visual perception**                      | `perception/visual` (regions/bands/raster/providers), `perception/ocr`, `perception/visual/faceBlur`, `pageClassifier` | §9, §9d, §9e, §9i, §00, §9p, §9l |
| **M4**        | Privacy / PII policy decision                    | `policy/index.ts` (`decidePolicyReport`, `decidePolicy`)    | §9b                              |
| **M5**        | Sanitization + vault                             | `sanitizer/enforce.ts` (`enforcePrivacy`), `vault/`         | §9c                              |
| **M6**        | **Privacy Compiler + task-specific contract**    | `policy/modes.ts` (mode vocabulary + guard); contract assembled at `agent/loop.ts:286-294`, re-validated at `firewall/inspect.ts:isValidContract`, mirrored server-side by `backend/fastapi/app/agent.py:TaskPrivacyContract` | §9f, §9o |
| **M7**        | **Sanitized server reasoning + action loop**     | `agent/loop.ts`, `agent/planner`, `actions/`, `backend/fastapi` | §9f, §9g, §9j, §9m, §9n      |
| **M8**        | **Side panel + status + privacy visibility**     | `sidepanel/`                                                | §9d, §9h, §9n                    |
| **M9**        | **Privacy firewall + network leakage testing**   | `firewall/`, `tests/unit/firewall-canary.test.ts`, `tests/integration/agent-leakage.test.ts` | §9f, §9o, §9s |
| **M10**       | **SIH26171 benchmark + accuracy + performance**  | `benchmark/`, `docs/benchmark.md`                           | §9g, §9i, §9r                    |
| **M11**       | **Final deliverable / hardening**                | build/size budget, license provenance, cross-browser        | §9q, §9r, §9s                    |

**Two labels in the log that the authoritative scheme renames:**

- **"M7.5" (face detection, §9l)** → belongs to **M3**. BlazeFace is a *specialized local
  privacy/perception component* inside local visual perception. It does **not** replace the
  general UI element detector (OmniParser `icon_detect`), and it is not a milestone of its
  own.
- **"M8 — Gemini Flash provider" (§9m/§9n)** → belongs to **M7** (sanitized server
  reasoning). Authoritative M8 is the side panel. The Gemini provider is a planner behind
  the existing `AGENT_PROVIDER` seam, on the server side of the privacy boundary.

Historical section text still contains the old labels. That is intentional: rewriting it
would misrepresent what was claimed and verified at the time (CONTRIBUTING.md §22).


---

## 00. Local VISION model — the last open M3 item (COMPLETE, one caveat)

**Status: implemented and verified with real inference on the real graph. All five gates
green. NOT committed. One unresolved non-technical item: the weights are AGPL-3.0 (§00.7).**

The M3 pipeline previously had DOM geometry (WHERE regions are), Tesseract OCR (WHAT text
pixels contain), and a pixel-stats heuristic (coarse structural label) — but **no model that
localizes elements inside a region**. SIH26171 requires a local ViT/equivalent vision model.
That is now in place, in the existing seam, with no rewrite of anything that worked.

### 00.1 What ships

| | |
|---|---|
| Model | **OmniParser v1 `icon_detect`** (YOLOv8n backbone), ONNX export by `onnx-community` |
| Task | single-class detection — "interactable element". **No class names, so none are invented** |
| Artifact | `extension/public/models/icon-detect-640.onnx` — **11.68 MB** fp32 |
| Graph | input `images` `[1,3,640,640]` static → output `output0` `[1,5,8400]` |
| Runtime | `onnxruntime-web@1.29.0` (exact-pinned, the only new dependency), bundled jsep wasm |
| EPs | `['webgpu','wasm']` → `['wasm']` — **same file, same graph, measured bit-identical** |

### 00.2 Files added / modified (nothing existing was rewritten)

**Added:** `extension/src/perception/visual/providers/vision-onnx.ts` (provider),
`providers/yolo-decode.ts` (pure letterbox/NMS/un-letterbox arithmetic),
`extension/src/perception/register-vision.ts` (the one production install point),
`extension/public/models/` (weights + ORT wasm + `NOTICE.txt`),
`tests/unit/vision-decode.test.ts`, `tests/unit/vision-provider.test.ts`,
`tests/integration/vision-model.test.ts`.

**Modified, minimally:** `providers/registry.ts` (+`analysisEdge` so a provider can declare
the raster size it needs), `visual/service.ts` (**3 lines** — raster budget becomes
`max(OCR budget, provider edge)`), `visual/index.ts` (dropped a vision re-export that was
defeating the lazy chunk split), `diag/ocr-trace.ts` (+4 vision trace stages),
`sidepanel/main.tsx` (+`installVisionEngine()`), `types/contracts.ts`
(`VisualObservation.elements`), `package.json` (+`onnxruntime-web`),
`tests/e2e/scan-findings.spec.ts` (timeout budget for a real model load, §00.6).

### 00.3 Real inference, not model-card claims

`tests/integration/vision-model.test.ts` — **9/9 passing**, loading the real 11.68 MB graph
through the real ORT wasm runtime in Node:

- the graph is the single-class head the decoder was written for (`[1,5,8400]`);
- real localization on painted pixels — every box lands on the painted card, none on blank margin;
- **zero elements on a blank raster from the same loaded session** (the anti-fabrication control);
- determinism; per-region coordinates from one shared session;
- DOM sufficient ⇒ the graph is **never loaded**; DOM insufficient ⇒ every region analysed, **one** load;
- Vision (WHERE) + OCR seam (WHAT) over the same raster;
- real M2→M3→M4→M5 handoff leaking no canary, no `ui_elements`, no `"elements"`, no model name.

Measured on a chat-UI replica in headed Chromium (details: `docs/m3-visual-perception.md` §11):
8 regions from 15 candidates, **44 element boxes**, 87–650 ms/region, session create 1374 ms
(wasm) / 304 ms (WebGPU). Whole-viewport control: **51 boxes on both EPs, identical rects,
max score delta 0.000** — wasm 563 ms vs WebGPU 108 ms.

**Input-edge finding:** the same 8 regions at edge 192 gave 13 boxes instead of 44, and the
richest region gave **0**. A too-small raster does not degrade this model, it silences it —
hence `analysisEdge: 640` on the registration.

### 00.4 Multi-region: preserved, and now proven at the model layer

Unchanged behaviour, extra proof. Each selected region (≤ `MAX_REGIONS` = 8) still yields its
own observation → policy decision → mask directive; `mergeMaskRegions` still merges only
genuinely overlapping directives. New assertions: two independent regions stay two regions with
distinct ids and their own element geometry, and the same pixels at a different region origin
produce the **same geometry translated**, not re-derived.

### 00.5 Lightweight (requirement J) — measured, with a finding

`npm run build` → **`dist/` = 80.43 MB (84,335,704 B), 26 files — PASS (<100 MB).**

| Asset | Size |
|---|---|
| `models/ort-wasm-simd-threaded.jsep.wasm` | 26.51 MB |
| `assets/ort-wasm-simd-threaded.jsep-*.wasm` | 26.51 MB — **duplicate, never fetched at runtime** |
| `models/icon-detect-640.onnx` | 11.68 MB |
| Tesseract core ×2 + `.wasm.js` ×2 + `eng.traineddata.gz` | ~15.3 MB |
| app chunks (panel 250.14 kB, `ort.bundle.min` 402.91 kB, rest < 20 kB) | ~0.7 MB |

**Honest finding, not fixed here:** the ORT wasm ships twice — our deterministic bundled copy
under `models/` (what `wasmPaths` actually loads) plus a fingerprinted copy Vite emits from
ORT's own import graph. Pruning the unused copy would take `dist/` to ~53.9 MB. It is inert and
the budget passes, so it was left alone rather than surgically deleting a Vite-emitted asset
during a verification gate; it is a build-tuning task.

_Superseded layout (paths, not conclusions): the `models/` ORT copy was removed by §9q — both
ONNX consumers now load from `ort/` — and the variant set was pruned in §9r. The duplicate
`assets/` copy called out above is still present and still inert. Current figures: §9r._

**Laziness is proven by the build, not asserted:** removing the vision re-export from the
`perception/visual` barrel eliminated rollup's `INEFFECTIVE_DYNAMIC_IMPORT` warnings, shrank the
panel chunk 253.71 → 250.14 kB, and split `vision-onnx` (0.19 → 2.78 kB) and `pixel-stats`
(0.14 → 1.49 kB) into real on-demand chunks. The 11.68 MB graph and the 26.51 MB wasm load only
on first session create, which only happens after the DOM-first gate says pixels are needed.

### 00.6 Gates (all run this session, in order)

| Gate | Result |
|------|--------|
| `npm run typecheck` | **PASS** (clean) |
| `npm run lint` | **PASS** (0 problems) |
| `npm run test` | **PASS — 391/391 (37 files)**, includes the 9 real-model tests |
| `npm run build` | **PASS**, and both `INEFFECTIVE_DYNAMIC_IMPORT` warnings eliminated |
| `npm run e2e` | **PASS — 23/23** |

**One real regression, found and fixed honestly.** The first full e2e run failed
`scan-findings.spec.ts`: the panel still showed "Scanning… / analysing page" at the 10 s expect
timeout, with telemetry proving M2 had finished (`scan.detect` 4.2 ms, `DETECTED: 4`) and the
visual stage still running. Run alone the same test takes **5.6 s**; under the parallel suite it
takes **15.4 s** — i.e. cold first load of the ONNX graph + ORT wasm + Tesseract while other
workers compete for CPU and disk. Fixed by giving that one assertion a model-load-sized budget
(precedent: `visual-accuracy.spec.ts` already waits 30 s for OCR). **No assertion was weakened**
— the aliases, the count, the outbound-block and the no-raw-dump checks are byte-identical.

### 00.7 Unresolved: license

The `icon_detect` **weights are AGPL-3.0**: the `microsoft/OmniParser` model card declares
`license: mit`, but `icon_detect/LICENSE` in that same repository is the verbatim AGPL-3.0 text,
so the stricter file-level license is treated as governing. This repo is `private: true` with
no declared license. Recorded in `extension/public/models/NOTICE.txt`, not glossed over.
Permissive alternatives exist but are PyTorch-only — Salesforce/GPA-GUI-Detector (38.69 MB,
`.pt`), laywens/uitag-yolo11s (MIT, 18.31 MB, `.pt`) — so adopting one means owning an ONNX
export step and re-measuring everything. **Must be settled before public distribution.**

### 00.8 Not verified, stated plainly

- **WebGPU is not covered by `npm test`** — Node has no GPU adapter, so the automated suite runs
  the wasm EP only. WebGPU was measured by hand in headed Chromium (`gpu=true`, create 304 ms,
  87–110 ms/region, exact parity with wasm). What CI *does* cover is the attempt sequence:
  `backendAttempts('webgpu')` → `['webgpu','wasm']`, with `executionProviders()` emitting a
  SINGLE EP per attempt so the attempt that succeeds is the EP actually in use (a two-entry list
  let ORT fall back silently, which made `observation.backend` a record of the request).
- **WhatsApp Web itself was not driven.** An offline replica fixture was used instead, for
  account/ToS/privacy reasons. The replica reproduces the structure that matters (avatar column,
  message list, image attachment, composer) and is where the 8-region / 44-box numbers come from.
- **No labelled-dataset accuracy figure** (no mAP, no precision/recall). What is claimed is
  measured behaviour on this project's own surfaces plus the blank-raster control.
- `npm run format:check` fails repo-wide — a **pre-existing** condition, unrelated to this work.

---

## 0. Real local OCR integration (post-M5 hardening)

**Status: COMPLETE (code + all offline gates green); live wasm recognition
pending manual Chrome verification.**

### What was implemented
- **Real local OCR engine** — `extension/src/perception/ocr/tesseract.ts` wraps
  Tesseract.js v6 with a lazy `createWorker('eng', 1, …)`. All runtime assets are
  loaded from **extension-local URLs** via `chrome.runtime.getURL('ocr/…')`
  (`workerPath`, `corePath`, `langPath`, `gzip:true`, `cacheMethod:'none'`).
  No screenshot or pixel ever leaves the machine — there is no remote OCR call.
- **OCR → PII bridge** — `extension/src/perception/visual/ocr-analyzer.ts`
  recognizes word boxes, reassembles line text with per-word offset spans, runs
  the SAME `detectPII` used for DOM text, and unions the covering word boxes into
  one bbox per finding (confidence = averaged OCR confidence of the covered words).
- **Provenance (requirement D)** — a `source` field flows analyzer →
  `VisualContentFinding` → policy → mask directive → summary, so OCR-recognized
  regions surface as `OCR_REGION_n` and non-text painted regions stay
  `IMAGE_REGION_n`. Nothing is labelled OCR unless OCR actually read text.
- **Production wiring** — `extension/src/perception/register-ocr.ts`
  (`installOcrEngine()`) is called once in `sidepanel/main.tsx`. Tests never import
  it; they inject a FAKE engine (requirement I).
- **MV3 CSP** — `manifest.ts` sets
  `extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'"` so
  the Tesseract wasm loads under MV3.
- **Bundling** — `vite.config.ts` `publicDir: 'extension/public'` ships the OCR
  runtime into `dist/`.

### Honest engine behaviour (CONTRIBUTING.md §22)
- Load failure throws a tagged `OCR_ENGINE_UNAVAILABLE`; the analyzer reports
  `not_available` (no engine) or `failed` (engine threw) — it never fabricates text.
- The wasm engine cannot run under vitest/node, so unit tests verify only the
  deterministic fail-honest path; real recognition is a **manual Chrome** step.

### Multi-region (requirement E) — preserved, not rewritten
The existing M3 pipeline keeps every selected region up to `MAX_REGIONS`; each
region yields its own observation → policy decision → mask directive. Overlap
merging (`mergeMaskRegions`) merges only genuinely overlapping directives;
independent regions stay distinct. Verified by the integration suite (independent
findings preserved; disjoint boxes not merged).

### dist/ inspection (requirement J)
`npm run build` → `dist/ocr/` contains:
- `worker.min.js` (111 KB)
- `core/tesseract-core-lstm.wasm` (2.87 MB) + `.wasm.js` (3.95 MB)
- `core/tesseract-core-simd-lstm.wasm` (2.87 MB) + `.wasm.js` (3.95 MB)
- `lang/eng.traineddata.gz` (1.98 MB)

**Total `dist/` = 16 MB — PASS (<100 MB).** No new heavyweight model, no persisted
bitmap; browser-native `captureVisibleTab` + geometry + lazy/temporary processing.

### Gates (all run this session)
| Gate | Result |
|------|--------|
| `npm run typecheck` | PASS (clean) |
| `npm run lint` | PASS (0 errors; `extension/public/**` vendored assets ignored) |
| `npm run test` | PASS — 260/260 (25 files) |
| `npm run build` | PASS |
| `npm run e2e` | PASS — 12/12 (smoke, scan-findings, visual-perception) |

### Cannot be verified in this sandbox (stated honestly, requirement K)
- Live Tesseract wasm recognition of real pixels (needs a real Chrome + OffscreenCanvas).
- Real `chrome.tabs.captureVisibleTab` capture of an actual tab.
Both are exercised only via injected fakes offline; the production path is wired
and asset-complete but must be confirmed by loading `dist/` in Chrome.

### Capture-broker fix (VISUAL_CAPTURE_UNAVAILABLE in the real browser)
**Symptom:** the panel reported `Reason: VISUAL_CAPTURE_UNAVAILABLE … 0 analysed`
on ordinary pages. **Root cause:** capture ran IN the side-panel document via
`chrome.tabs.captureVisibleTab(WINDOW_ID_CURRENT=-2, …)`; from a panel document `-2`
does not resolve to the window holding the web page, so Chrome refused the capture.
**Fix (no new API, no engine change, capture stays local):**
- New `CAPTURE_VIEWPORT` message brokered by the background worker
  (`extension/src/background/index.ts` `captureActiveViewport`): it resolves the
  active tab's OWN `windowId` (same query SCAN_PAGE uses) and calls
  `captureVisibleTab(windowId, …)`, returning ONLY the PNG data URL (or `restricted`/
  a short error code). The data URL is handed back to the panel for local rasterization
  and never leaves the device.
- Panel bridge `extension/src/sidepanel/capture.ts` (`captureViaBackground`) is injected
  as the service's `captureViewport` dep in both `App.tsx` and `VisualStatus.tsx`.
- The service's `CAPTURE_FAILED` trace now records a short, sanitized Chrome diagnostic
  (`safeCaptureError`, strips `data:`/`base64`, caps 120 chars) so the real cause of a
  refusal is visible while the result reason stays the single code `VISUAL_CAPTURE_UNAVAILABLE`.
- Tests: `tests/integration/scan-message-path.test.ts` gains 5 CAPTURE_VIEWPORT cases
  (uses tab's own windowId not -2; restricted fail-closed; NO_ACTIVE_TAB; forwards
  Chrome error string; EMPTY_CAPTURE). Re-ran all gates: typecheck/lint clean,
  **269/269** unit+integration, build OK, **12/12** e2e.

### Capture ROOT CAUSE: host permission (`<all_urls>`)
Surfacing the sanitized Chrome diagnostic (`reasonDetail`, rendered as `Detail:` in
`VisualStatus.tsx`) revealed the actual cause:
> `Either the '<all_urls>' or 'activeTab' permission is required.`

`chrome.tabs.captureVisibleTab` accepts **only** the literal `<all_urls>` host
permission, or `activeTab` **plus a qualifying user gesture** (an action/menu/command
click). The broad patterns we declared (`http://*/*`, `https://*/*`) are **not** accepted
for this API, and our capture is triggered from a side-panel button — which does not
grant `activeTab`. So capture was refused on every ordinary page, independent of the
windowId fix (which was still necessary and is retained).

**Fix:** `extension/manifest.ts` `host_permissions: ['<all_urls>']` (documented minimum;
verified against Chrome docs, not invented). Scope is unchanged in practice: M3 still
only perceives http/https — `perception/visual/restricted.ts` continues to treat every
other scheme as restricted by design, so `<all_urls>` does not widen what is inspected.
Captured pixels are still rasterized locally and never leave the device.

Gates after the permission fix: typecheck PASS, lint PASS, **271/271** unit+integration,
build PASS (`dist/manifest.json` contains `"host_permissions": ["<all_urls>"]`),
**12/12** e2e. Live capture success still requires a manual Chrome reload to confirm.

---

## 6. Milestone 1 readiness

**Status: COMPLETE**

### Completed components:
- MV3 extension manifest (`extension/manifest.ts`) updated.
- Background service worker (`extension/src/background/index.ts`) implemented.
- Content script (`extension/src/content/index.ts`) implemented.
- DOM collector (`extension/src/perception/dom/index.ts`) implemented.
- Side panel UI (`extension/src/sidepanel/App.tsx`) implemented.
- Communication infrastructure between extension components added.

### Files changed:
- `extension/manifest.ts`
- `extension/src/background/index.ts`
- `extension/src/content/index.ts`
- `extension/src/perception/dom/index.ts`
- `extension/src/sidepanel/App.tsx`
- `extension/src/sidepanel/index.html`
- `tests/e2e/smoke.spec.ts`
- `tests/unit/contracts.test.ts`

### Commands/tests executed:
- `npm run typecheck` — ✅ pass (0 errors)
- `npm run lint` — ✅ pass (0 errors)
- `npm test` — ✅ all unit tests passed
- `npm run e2e` — ⚠️ **NOT REPRODUCIBLE** (see Corrections below; the test contained an
  unsubstituted `<extension-id>` placeholder and could never have passed)
- `npm run build` — ✅ production build successful

---

## 7. Milestone log

### M1 — MV3 Extension Shell + DOM Collector + Side Panel ✅ COMPLETE

**Scope:** Implement the MV3 extension shell, DOM collector, and side panel UI.

**Validation results:**
| Gate      | Command             | Result |
| --------- | ------------------- | ------ |
| Typecheck | `npm run typecheck` | ✅ pass |
| Lint      | `npm run lint`      | ✅ pass |
| Unit tests| `npm test`          | ✅ pass |
| E2E tests | `npm run e2e`       | ⚠️ not reproducible (see §10) |
| Build     | `npm run build`     | ✅ pass |

---

## 8. Milestone 2 readiness

**Status: COMPLETE**

### Completed components:
- Deterministic PII detection (`extension/src/perception/pii/index.ts`) implemented.
- Controlled screenshot capture (`extension/src/perception/screenshot/index.ts`) implemented.
- OCR engine (`extension/src/perception/ocr/index.ts`) updated.

### Files changed:
- `extension/src/perception/pii/index.ts`
- `extension/src/perception/screenshot/index.ts`
- `extension/src/perception/ocr/index.ts`
- `extension/src/types/contracts.ts`
- `tests/unit/contracts.test.ts`

### Commands/tests executed:
- `npm run typecheck` — ✅ pass (0 errors)
- `npm run lint` — ✅ pass (0 errors)
- `npm test` — ✅ all unit tests passed
- `npm run build` — ✅ production build successful

> ⚠️ See **Corrections to earlier milestone claims** below. The lint result recorded
> here could not be reproduced at the start of M3.

---

## 9. Milestone 3 readiness

**Status: COMPLETE (with E2E unexecuted — see below)**

### Scope

Lightweight **local** visual perception: produce structured visual observations for M4 to
consume, without running vision on every page and without any raw visual data leaving the
device. M3 is explicitly **not** the sensitive-data detector.

### Design decisions

- **DOM-first.** A cheap structural gate (`decision.ts`) runs before any capture. On an
  ordinary text page the pipeline performs no capture, no rasterization, and loads no
  provider.
- **Content-driven, not website-driven.** No site list, no domain matching, no URL
  inspection in the decision path. A unit test asserts identical verdicts across four
  different hosts. (`restricted.ts` does list schemes/hosts, but that is a *browser
  capability* check for surfaces where extensions cannot script or capture at all.)
- **No model bundled.** The provider abstraction plus a real, dependency-free pixel-analysis
  provider were implemented instead. Rationale, and the exact registration seam for a future
  ONNX/OCR engine, are documented in `docs/m3-visual-perception.md`. No model was downloaded;
  no dependency was added.
- **Fabricated OCR removed.** The M2 scaffold's OCR engine returned a hard-coded
  `'Sample OCR Text'` with confidence 0.95 for *any* input. It now returns `[]` until a real
  recognizer is registered. Fake transcription would have become fake evidence for M4's
  sensitivity decisions.
- **Split by context.** An MV3 service worker has no document/canvas/WebGPU, so the worker
  brokers only cheap DOM metadata; capture, cropping and analysis happen in the side panel.
  M1's existing `COLLECT_DOM_CONTEXT` handler and messaging channel were reused, not
  replaced.

### Files added

Pipeline: `extension/src/perception/visual/{service,decision,regions,restricted,capability,cache,raster,collect-candidates,types,index}.ts`,
`extension/src/perception/visual/providers/{registry,pixel-stats}.ts`
Wiring: `extension/src/types/messages.ts`, `extension/src/background/visual-messages.ts`,
`extension/src/sidepanel/VisualStatus.tsx`
Docs: `docs/m3-visual-perception.md`
Tests: `tests/helpers/raster.ts`, `tests/unit/{visual-decision,visual-regions,visual-restricted,visual-provider,ocr}.test.ts`,
`tests/integration/{visual-perception,visual-leakage}.test.ts`, `tests/e2e/{fixtures.ts,visual-perception.spec.ts}`

### Files modified

- `extension/src/types/contracts.ts` — additive types only; nothing existing changed.
- `extension/src/perception/ocr/index.ts` — rewritten (removed fabricated output; typed
  registration seam).
- `extension/src/perception/vision/index.ts` — re-exports the visual barrel; the raw-frame
  getter now refuses by design.
- `extension/src/background/index.ts` — 2 lines (import + register).
- `extension/src/sidepanel/App.tsx` — 2 lines (import + `<VisualStatus />`). No redesign.
- `extension/src/perception/pii/index.ts` — 1 character (lint fix, semantically identical).
- `tests/unit/contracts.test.ts` — removed the test asserting the fabricated OCR string.
- `tests/e2e/smoke.spec.ts`, `playwright.config.ts` — real extension loading.

### Validation results — actually executed

| Gate       | Command             | Result | Measured |
| ---------- | ------------------- | ------ | -------- |
| Typecheck  | `npm run typecheck` | ✅ pass | 0 errors |
| Lint       | `npm run lint`      | ✅ pass | 0 errors (5 pre-existing errors resolved) |
| Unit + integration | `npm test`  | ✅ pass | 8 files, 92 tests, 567 ms |
| Build      | `npm run build`     | ✅ pass | 36 modules |
| E2E        | `npm run e2e`       | ❌ **NOT EXECUTED** | 11/11 failed at browser launch |

**Test validity was verified by mutation testing, not by trusting green output:**
- injecting `console.log('MUTATION_TEST_LEAK', captureDataUrl)` into `service.ts` failed
  exactly 3 leakage tests, and correctly did *not* fail "logs nothing when capture is
  refused";
- setting `reason: captureDataUrl` failed "returns no capture bytes and no pixel buffers".

Both mutations were reverted; the suite is green.

### E2E — not executed, and why

`tests/e2e/` was rewritten to load the real built extension into a real Chromium profile.
All 11 tests compile and collect, then fail identically:

```
browserType.launchPersistentContext: spawn UNKNOWN
```

This is an **OS-level execution restriction in the development environment**, not a project
defect. Evidence gathered:

- Chromium install is complete: 428 MB, `chrome.dll` 298 MB, valid `MZ` PE headers, all files
  readable, `playwright install chromium` exited 0.
- `spawnSync(chrome.exe)` → `UNKNOWN`, while `cmd.exe` and `where.exe` spawn normally.
- Playwright's own `PrintDeps.exe` reports `chrome_elf.dll => not found` even though that file
  sits in the same directory and is readable.

**No E2E result is claimed.** On a machine where Chromium can launch, run:

```bash
npm run build && npm run e2e
```

### Measured bundle cost (real build output)

| Artifact | Before M3 | After M3 | Δ |
| -------- | --------- | -------- | - |
| Side panel chunk | 191.21 kB | 201.41 kB | +10.20 kB |
| Side panel (gzip) | 60.32 kB | 63.88 kB | +3.56 kB |
| Service worker | 0.51 kB | 2.02 kB | +1.51 kB |
| `pixel-stats` (lazy chunk) | — | 1.49 kB | new, loaded on demand |
| CSS | 6.85 kB | 7.66 kB | +0.81 kB |
| Total `dist` | 200.28 kB | 214.87 kB | +14.59 kB |

Lazy loading is proven by the build, not asserted: `pixel-stats` is emitted as its own chunk
rather than inlined into the panel bundle.

### Privacy verification

`tests/integration/visual-leakage.test.ts` stubs `fetch`, `WebSocket`, `XMLHttpRequest` and
`navigator.sendBeacon`, spies all six `console` methods, and uses a synthetic canary
(`CANARY_RAW_CAPTURE_0001`) embedded in the capture data URL. It asserts the canary never
reaches egress, logs, or the returned result; that every `fetch` URL begins with `data:` and
never matches `^https?:`; that the observation key set is exactly
`confidence, local, observations, region, source, type` with no `text`/`screenshot`; and that
no `console.*` statement exists anywhere in `perception/visual/**`.

### Known limitations

- **No text is read.** `text_like_content` means "looks like rendered text", not "contains X".
- **No accuracy claim.** The pixel-stats labels are heuristic and unbenchmarked; no labelled
  dataset was used. Confidence is capped at 0.75 to reflect this.
- **No universal support claim.** Chromium is the target. Firefox/Safari are unverified.
- Viewport only — `captureVisibleTab` cannot see below the fold; cross-origin iframe interiors
  are opaque; DRM video may capture black.
- Region ids include viewport coordinates, so scrolling forfeits cache reuse.
- Overlapping runs are rejected (`running`), not queued.
- **Open question for E2E to settle:** whether `chrome.tabs.captureVisibleTab` succeeds from
  the side panel with the current manifest (`activeTab` normally requires a user gesture on
  the extension action; the manifest declares `http://*/*` + `https://*/*` rather than
  literal `<all_urls>`). If refused, the pipeline degrades to `unavailable`/`capture_failed`
  — correct behaviour, but real analysis would then need the action-click gesture or an
  `<all_urls>` host permission.
- No manual in-browser validation has been performed.

---

## 9b. Milestone 4 readiness

**Status: COMPLETE (all gates executed, including E2E)**

### Scope

A lightweight **local privacy decision / policy layer**: a pure, synchronous
reducer that consumes the signals M0–M3 already produced and emits deterministic,
explainable decisions. Two entry points share one core:

- `decidePolicy` → one page-level `PolicyDecision` — `ALLOW` / `WARN` /
  `SANITIZE` / `BLOCK` with severity, decision confidence, reason code,
  contributing signal categories and a non-sensitive explanation.
- `decidePolicyReport` → that rollup (`overall`) **plus** a per-finding
  `FindingDecision` for **every** applicable finding/region, each carrying a
  non-content `ref` (source + id + element handle + bbox) so a later sanitizer
  can act on each region individually.

M4 runs **no** detection, OCR, vision, AI inference, or network I/O; it only
decides. Full design in `docs/m4-policy-layer.md`.

### Design decisions

- **New additive module, not a rewrite.** M4 lands as `extension/src/policy/`.
  The scaffold's `sensitivity/` stub returns `SensitiveEntity[]` (detection
  output); M4 returns a `PolicyDecision` (a distinct concern), so it does not
  touch any M0–M3 detector. No existing code was modified except additive types.
- **Reused vocabulary.** `SANITIZE`/`BLOCK` already exist as `PrivacyEventType`;
  `ALLOW`/`WARN` are decision states, not new agent actions. Only `RiskSeverity`
  is a genuinely new type (the project had no severity scale).
- **Tolerant category mapping.** Handles both the declared `SensitiveCategory`
  names and the strings the M2 detector actually emits (`PHONE_NUMBER`,
  `PAYMENT_CARD`, `CREDENTIAL`). Unknown categories map to `medium`/`dom_pii` —
  never to `none`. `UNCLASSIFIED` (the DOM collector's tag for ordinary text) is
  benign so pages are not flagged for merely containing text.
- **Fail closed.** `entities: []` (ran, clean) → `ALLOW`; `entities: undefined`
  (never ran) → `WARN`/`SIGNAL_UNAVAILABLE`; malformed input → `WARN`/
  `MALFORMED_SIGNAL`; restricted surface → `WARN`, never `ALLOW`. Missing data is
  never treated as safe.
- **Pure consumer.** Being a synchronous reducer with no I/O, it cannot trigger
  M3 visual work and is safe to call on every page.
- **Multi-region by construction.** `decidePolicyReport` preserves a decision for
  every finding, not just the strongest. Exact duplicates collapse; conflicts on a
  shared upstream id resolve to the stronger action (fail closed); distinct
  overlapping regions are kept (geometric merging is M5's concern); output order is
  deterministic. Each finding's `ref` carries location metadata only — never a raw
  value, pixels, or a screenshot.

### Files added

- `extension/src/policy/index.ts` — the `decidePolicy` / `decidePolicyReport` engine.
- `tests/unit/policy.test.ts` — 35 tests (10 required `decidePolicy` scenarios +
  multi-region `decidePolicyReport` coverage: visual region, multiple regions,
  mixed text+visual, overlapping, duplicate, conflicting, malformed, allowed-fields).
- `tests/integration/policy-leakage.test.ts` — canary/leakage across both
  `decidePolicy` and `decidePolicyReport` + source scans.
- `docs/m4-policy-layer.md` — contract, rules, privacy guarantees, integration.

### Files modified

- `extension/src/types/contracts.ts` — additive M4 types only
  (`PolicyAction`, `RiskSeverity`, `PolicyReasonCode`, `PolicySignalCategory`,
  `PolicySignals`, `PolicyDecision`, and the per-finding `PolicyRegionRef` /
  `FindingDecision` / `PolicyReport`). Nothing existing changed.

### Validation results — actually executed

| Gate       | Command             | Result | Measured |
| ---------- | ------------------- | ------ | -------- |
| Typecheck  | `npm run typecheck` | ✅ pass | 0 errors |
| Lint       | `npm run lint`      | ✅ pass | 0 errors |
| Unit + integration | `npm test`  | ✅ pass | 10 files, 137 tests (was 8/92 pre-M4; +2 files, +45 policy tests total) |
| Build      | `npm run build`     | ✅ pass | 36 modules |
| E2E        | `npm run e2e`       | ✅ **pass** | 11/11 passed — Chromium launched (the Aug-29 spawn restriction no longer holds) |

**Test validity was mutation-tested, not assumed** (2026-08-30, two rounds, both
reverted): (A) leaking `entity.text` into a `FindingDecision.ref` failed exactly
the report-canary, report allowed-keys, and unit allowed-fields tests; (B) leaking
`entity.text` into the `overall` explanation failed exactly the decision-canary,
explanation-content, and report-canary tests. Both the page-level explanation and
the per-finding output are proven guarded; the suite is green after revert.

### Bundle impact — zero shipped bytes

| Artifact | Committed HEAD (M4) | Working tree | Δ |
| -------- | ------------------- | ------------ | - |
| Side panel chunk (bytes) | 201,417 B | 201,417 B | **byte-for-byte identical** (`diff` empty) |
| Module count | 36 | 36 | 0 |
| Total `dist` size | 201.41 kB chunk / 63.88 kB gzip | same | 0 |

M4 adds no shipped code: `extension/src/policy/**` is a pure library imported only
by tests (verified by grep — nothing under `extension/src` outside `policy/`
imports it), so it tree-shakes out entirely. Building the committed HEAD and the
working tree and diffing the emitted panel chunk shows **identical content**
(201,417 bytes, empty diff). Note: the chunk's *filename hash* does shift when
`contracts.ts` gains type-only exports (Rollup seeds content hashes from
module-graph identifiers, not just emitted bytes) — so the earlier "identical
hash" phrasing was replaced with a byte-level diff, which is the reliable measure.
M5–M7 will wire the engine in.

### Privacy verification

`tests/integration/policy-leakage.test.ts` embeds a synthetic canary in
`entity.text` across clean, sensitive (email/phone/payment/credential), malformed
and restricted inputs, spies all six `console` methods, and stubs `fetch` /
`navigator.sendBeacon`. It asserts the canary never appears in the `decidePolicy`
JSON, the full `decidePolicyReport` JSON (rollup **and** every finding), the
explanation, the console, or any egress; that the decision exposes exactly
`action, confidence, explanation, local, reasonCode, severity, signals` (no
`text`/`entities`/`screenshot`) and each finding exactly `action, confidence,
reasonCode, ref, severity, signal` (its `ref` carrying no `text`); and that
`extension/src/policy/**` contains no `console.*` and no `fetch`/`XMLHttpRequest`/
`WebSocket`/`sendBeacon`/`localStorage`/`indexedDB`. The engine never reads
`SensitiveEntity.text`, so raw values cannot reach the decision or any finding by
construction.

### Known limitations

- **Decision-only.** M4 chooses an action (per page and per finding); sanitization
  (M5), aliasing/vault (M5), blocking (M7) and UI are separate milestones.
- **No geometric region merging.** Overlapping-but-distinct regions are preserved
  as separate findings; deciding whether two intersecting boxes are the same thing
  and merging them is M5's job. M4 only collapses exact duplicates and resolves
  same-id conflicts to the stronger action.
- **Bounded by upstream.** A value M1/M2 does not emit, or a region M3 does not
  observe, is invisible to the policy layer. No new detection is performed.
- **No detection-accuracy claim.** `confidence` is confidence in the *decision*,
  not detection accuracy. No "99%" or classifier benchmark is claimed — M4 is not
  a detector. Deterministic mapping correctness is unit-tested; classifier
  accuracy is not measured because it is out of scope.
- **M2 category-name drift is tolerated, not fixed.** The declared union vs the
  emitted strings should be reconciled in a dedicated M2 cleanup, out of M4 scope.
- **Fixed thresholds.** Confidence thresholds are constants, not yet
  privacy-mode-aware.
- **Not wired into the runtime**, so no in-browser/manual validation of the layer
  has been performed; unit + integration cover it deterministically.

---

## 9c. Milestone 5 readiness

**Status: COMPLETE (all gates executed, including E2E)**

### Scope

A lightweight, **local sanitization + privacy-enforcement layer** that consumes
the M4 `PolicyReport` (per-finding decisions) plus the raw `SensitiveEntity[]`
that produced them, and neutralises **every** applicable finding before any
content can be placed on a `RemoteAgentRequest`. Text findings are aliased out of
the visible text; visual findings become mask directives; nothing sensitive is
ever silently dropped. Full design in `docs/m5-sanitization.md`.

### Design decisions

- **Implemented the existing stubs, added one orchestrator.** `Sanitizer`
  (`extension/src/sanitizer/index.ts`) and `LocalVault`
  (`extension/src/vault/index.ts`) were throwing scaffold stubs; M5 implements
  them as declared. The genuinely new surface is `enforcePrivacy`
  (`extension/src/sanitizer/enforce.ts`) — the policy-driven orchestrator that M4
  §7 always described as M5's job — plus additive result types. No M1–M4 code was
  modified except additive types in `contracts.ts`.
- **Findings carry no raw value (by M4 design), so M5 correlates.** A
  `FindingDecision.ref.findingId` equals the upstream `SensitiveEntity.id`; M5
  indexes the entities by id to recover `.text` for redaction. It never reads a
  value out of the finding itself.
- **Aliases only cross the boundary; values stay in the vault.** The alias
  directory is `{ alias, category }[]` (type only). The alias↔value mapping lives
  solely in the in-memory `LocalVault`, session-scoped and wiped by `clearSession`
  (CONTRIBUTING.md §5 Rule 3/4).
- **Visual enforcement is region masking, not outbound image scrubbing.**
  `RemoteAgentRequest` has no image field, so raw pixels never cross the boundary
  by construction (M3 invariant). M5 emits geometry-only mask directives and
  provides a pure local pixel-mask primitive (`applyMasks`) — a local
  defence-in-depth measure, honestly scoped, not an over-claim.
- **Overlap is a deterministic union.** `mergeMaskRegions` merges intersecting
  boxes into their bounding union to a fixpoint, preserving every finding id, so
  the protected area is never smaller than the sum of the sensitive regions.
  Disjoint regions stay separate (the whole page is never masked because two
  far-apart regions are sensitive).
- **Fail closed on the text boundary.** Each finding gets exactly one
  disposition — `aliased` / `masked` / `flagged` (malformed) / `inaccessible`
  (no value and no region). `enforced` is true only when every finding is
  neutralised and the page is not uncertain. Cleartext `sanitizedText` is emitted
  **only** when the page is fully safe (`enforced && !blocked && !restricted`);
  otherwise it is withheld (empty), so an unidentified raw value can never ride
  out on the sanitized text (CONTRIBUTING.md §5 Rule 7).

### Files added

- `extension/src/sanitizer/alias.ts` — category normalisation, stable/unique
  alias allocation, literal (regex-free) redaction.
- `extension/src/sanitizer/mask.ts` — `mergeMaskRegions` (overlap → union) and
  `applyMasks` (pure local pixel masking).
- `extension/src/sanitizer/enforce.ts` — the `enforcePrivacy` orchestrator.
- `tests/unit/vault.test.ts` — 5 tests (store/resolve/clear/fail-closed).
- `tests/unit/sanitizer.test.ts` — primitive tests (alias, redact, category,
  text `Sanitizer`, region merge, pixel mask).
- `tests/unit/enforce.test.ts` — the 16 required M5 scenarios, each labelled.
- `tests/integration/sanitizer-leakage.test.ts` — canary/leakage across every
  branch + source scan (comments stripped) proving no console/network/storage.
- `docs/m5-sanitization.md` — architecture and privacy guarantees.

### Files modified

- `extension/src/sanitizer/index.ts` — implemented `Sanitizer`; barrel-exports
  the M5 primitives and `enforcePrivacy`.
- `extension/src/vault/index.ts` — implemented the in-memory `LocalVault`.
- `extension/src/types/contracts.ts` — additive M5 types (`AliasBinding`,
  `FindingDisposition`, `VisualMaskDirective`, `FindingEnforcement`,
  `EnforcementResult`).

### Validation results

| Gate      | Command             | Result |
| --------- | ------------------- | ------ |
| Typecheck | `npm run typecheck` | ✅ pass |
| Lint      | `npm run lint`      | ✅ pass |
| Unit + integration | `npm test` | ✅ **182 passed / 182** (14 files; +45 over M4's 137) |
| Build     | `npm run build`     | ✅ pass (36 modules) |
| E2E tests | `npm run e2e`       | ✅ **11 passed / 11** |

One genuine defect was found and fixed by testing, not by weakening the test: a
malformed-only signal left the raw value in `sanitizedText` because M5 could not
identify it. Fixed by withholding cleartext unless the page is fully safe.

### Known limitations

- **Not wired into the runtime.** M5 is a tested library; the content-script /
  agent-request path that calls `enforcePrivacy` and feeds `visualMasks` into a
  local capture is a later milestone. Bundle sizes are unchanged from M4 because
  the side-panel entry does not import M5 yet.
- **Vault is volatile.** In-memory only; not persisted (persisting a raw value at
  rest would need encryption — threat-model R15). Mappings vanish with the context.
- **Masking is local-only.** It protects a local pixel buffer; because no image
  crosses the boundary, this is defence-in-depth, not the outbound guarantee. The
  outbound guarantee is that raw text/pixels/mappings never appear on the request.
- **Bounded by upstream.** A value M1/M2 does not emit or a region M3 does not
  observe is invisible to M5; no new detection is performed. No detection-accuracy
  claim is made.
- **Restricted/inaccessible content is not claimed as sanitized.** It is reported
  (`restricted` / disposition `inaccessible`) and fails certification — never
  falsely reported as protected.

---

## 9d. Side-panel scan wiring + M3 below-the-fold improvements

**Status: COMPLETE (typecheck, lint, 219 unit/integration tests, build, 12 E2E all pass)**

### SCAN_PAGE communication fix (root cause + fix)

**Symptom:** manual scans returned `PAGE_UNREACHABLE` ("Could not read this page…") and
reloading the page did not help.

**Root cause:** the `SCAN_PAGE` relay reached the page with `chrome.tabs.sendMessage`, which
requires a *declared* content-script receiver. Declared content scripts only auto-inject into
pages loaded **after** the extension; a tab already open (or one whose async content-script
loader had not yet registered its `onMessage` listener) has no receiver, so `sendMessage`
fails with `lastError` → `PAGE_UNREACHABLE`. (The M3 `COLLECT_VISUAL_CANDIDATES` path never had
this problem because it injects on demand via `chrome.scripting.executeScript`.)

**Fix (`extension/src/background/index.ts`):** the relay now mirrors that proven pattern. On a
missing receiver it injects the built content-script file(s) — read at runtime from
`chrome.runtime.getManifest().content_scripts[0].js`, using the existing `scripting` +
http/https `host_permissions` (no new grant) — and retries. `PAGE_UNREACHABLE` is surfaced
**only** when injection itself is refused, i.e. the browser genuinely forbids access (fail
closed, CONTRIBUTING.md §5 Rule 7). The `SCROLL_VIEWPORT` relay uses the same path. Also removed the
stray `action.default_popup` from the manifest so the toolbar icon opens the **side panel**
(it previously suppressed `openPanelOnActionClick`).

**Deterministic test:** `tests/integration/scan-message-path.test.ts` installs a fake `chrome`
and drives the worker's listeners: receiver-present relay; **missing receiver → inject →
retry succeeds** (the fix); injection refused → `PAGE_UNREACHABLE`; restricted URL →
`{restricted:true}` with no injection; no active tab → `NO_ACTIVE_TAB`; unknown type ignored;
plus the two `SCROLL_VIEWPORT` cases.

### Manual verification (supported setup)

The extension declares **http/https** host permissions only; `isRestrictedUrl` treats
`file:`, `chrome:`, etc. as restricted (fail closed). Opening the fixture as **`file://` is
therefore intentionally NOT supported** — it reports "Restricted page", never a scan. Serve it
over http instead:

```bash
npx serve tests/fixtures    # or: python -m http.server 8000 --directory tests/fixtures
```

Then: load `dist/` at `chrome://extensions` (Developer mode → Load unpacked; **Reload** after a
rebuild) → open `http://localhost:3000/sensitive-sample.html` (or the printed URL) → click the
PrivAgent toolbar icon to open the side panel → **Scan Page**. Expect a concise summary
(counts, `USER_*` aliases, `IMAGE_REGION_N`, "outbound blocked") with no raw values/heading.
Note: this Chrome click-through cannot be exercised in the CI sandbox; the E2E suite drives the
identical production path over `https://privagent.test`, and the message-path unit test covers
the injection fallback deterministically.

### Scope

Two connected pieces of work, both **wiring/UI + hardening only** — no change to the
M2/M4/M5 detection, policy, or sanitization logic:

1. **The side panel now consumes a structured, sanitized result — never a raw page dump.**
   Previously the panel collected every DOM element's `textContent` and rendered it. It now
   sends `SCAN_PAGE`, and the whole M2→M5 pipeline runs **on-device in the panel document**:
   `detectPII` (M2) → `visualService.run` (M3) → `enforcePrivacy` (M4+M5). The panel renders
   only the derived `ScanSummary` (counts, semantic aliases, masked-region metadata). This
   also closes M5 §11 integration point (1): the running extension now calls
   `enforcePrivacy()` and honours its `blocked` fail-closed gate in the UI.

2. **M3 multi-region + bounded below-the-fold image coverage.**

### Design decisions

- **All detected regions are preserved.** Each region → one observation → one M4
  `FindingDecision` (dedupe key includes bbox) → one M5 mask directive; only genuinely
  overlapping directives merge (`mergeMaskRegions`). Independent regions surface as distinct
  `IMAGE_REGION_1..N`, bounded by `MAX_REGIONS = 4` (the cap is surfaced honestly, not hidden).
- **Below-the-fold TEXT is fully covered** because `pageText` is whole-document `innerText`
  plus form-field values; M2 sees it all (proven by `USER_EMAIL_2` below the fold in E2E).
- **Below-the-fold IMAGES: bounded band capture, injected — never faked.** `captureVisibleTab`
  only returns the current viewport and Chrome exposes no off-screen capture API. The service
  gained an **optional** `scrollViewport(top)` dependency:
  - **Absent** (all prior tests, any non-scrollable context) → byte-identical single-viewport
    behavior. Below-fold images are simply not covered, and that limit is reported honestly.
  - **Present** (production, injected by the panel via a `SCROLL_VIEWPORT` relay to the content
    script) → the pure `planBelowFoldBands` planner groups whole-document candidates into at
    most `MAX_BELOW_FOLD_BANDS = 3` viewport-height bands that actually contain candidates,
    sharing the `MAX_REGIONS` budget (largest first). The service scrolls to each band,
    captures the now-visible viewport, crops only that band's regions, analyses, and
    **restores the original scroll** in a `finally`. Any band capture/scroll failure degrades
    closed — that band's regions are skipped, never fabricated.
- **Collector reports document-absolute inputs** (`scrollY`, `documentHeight`) and keeps
  below-fold candidates (only content scrolled above the fold or off to the sides is culled).
  Existing viewport-relative fields are unchanged, so raster/regions/E2E stay green.

### Files

- `extension/src/sidepanel/App.tsx` — runs the pipeline on `SCAN_PAGE`; injects a real
  `scrollViewport`; renders the `ScanSummary` only.
- `extension/src/scan/summary.ts`, `extension/src/scan/index.ts` — pure `buildScanSummary`.
- `extension/src/perception/visual/service.ts` — optional `scrollViewport` dep + bounded band
  loop with scroll-restore.
- `extension/src/perception/visual/bands.ts` — pure `planBelowFoldBands` planner.
- `extension/src/perception/visual/collect-candidates.ts` — keeps below-fold candidates; adds
  `scrollY`/`documentHeight`.
- `extension/src/content/index.ts`, `extension/src/background/index.ts`,
  `extension/src/types/messages.ts` — `SCAN_PAGE` + `SCROLL_VIEWPORT` message contracts/relays.

### Tests

- `tests/unit/scan-summary.test.ts`, `tests/integration/scan-summary-leakage.test.ts` —
  multi-region summary, section math, canary-absent-from-summary.
- `tests/unit/visual-bands.test.ts` — planner coordinate math, banding, budget/cap, clipping.
- `tests/integration/visual-belowfold.test.ts` — no-scroller honest limit; band capture with
  scroll-restore; multiple independent below-fold regions; failed-band degrade-closed;
  visible+below-fold together.
- `tests/e2e/smoke.spec.ts`, `tests/e2e/scan-findings.spec.ts` — no raw dump; below-fold text
  alias; critical credential blocks outbound; raw values + page heading absent from the panel.

### Lightweight (<100 MB)

Built `dist/` is **261 KB** (largest asset: the panel bundle at 218 KB / 69.5 KB gzip). No new
AI/OCR/CV model, no new runtime dependency, no persisted screenshot/bitmap — browser-native
`captureVisibleTab` + geometry/DOM metadata + bounded/lazy processing + temporary disposal.
**<100 MB: PASS.**

### Honest limitations

- **No image-content classification.** No OCR/vision model is bundled; image regions are
  surfaced as *masked regions + page section*, never a fabricated category.
- **Band capture cannot recover content already scrolled above the fold** at snapshot time
  (`rect.bottom <= 0` candidates are dropped) and is bounded to 3 extra bands; anything beyond
  is not claimed as covered.
- **A page opened before the extension loaded** has no content script → `PAGE_UNREACHABLE`;
  the panel asks the user to reload (fail-closed, honest).

---

## 9e. Popup fix + OCR/vision content-analysis layer

_Added 2026-08-30._

### Priority 1 — the toolbar icon opened nothing (FIXED)

**Root cause (diagnosed from the built `dist/manifest.json`, not guessed):** the manifest's
`permissions` were `['storage','activeTab','scripting']` — MISSING `"sidePanel"`. Chrome only
defines `chrome.sidePanel.*` when that permission is declared, so the background worker's
`chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true })` silently no-opped.
Combined with the earlier (correct) removal of `action.default_popup`, the toolbar action had
neither a popup nor an enabled side-panel behavior → clicking did nothing.

**Fix:** added `'sidePanel'` to `extension/manifest.ts` permissions. One line; no logic change.
The PAGE_UNREACHABLE on-demand-injection fallback (§9d, `background/index.ts`) is untouched and
still passes its 8 deterministic tests.

**Regression guard:** `tests/integration/built-extension.test.ts` (8 assertions) validates the
BUILT `dist/`: MV3 manifest shape, `sidePanel` permission present, `action.default_popup` absent
(so it can't suppress the side panel), the side-panel HTML + background worker + every declared
content-script file exist in `dist/`, and every non-external asset the panel HTML references
resolves. Rebuilt `dist/manifest.json` confirmed to now carry `["storage","activeTab","scripting","sidePanel"]`.

### Priority 2 — genuine OCR/vision content-analysis interface (NO engine bundled)

The visual pipeline now has a provider-agnostic **content analyzer** boundary that recognizes
WHAT sensitive value a captured region contains — distinct from the coarse structural
`VisualProvider`. Reuses M3→M4→M5 unchanged in shape; additive only.

- **Interface** (`perception/visual/types.ts`): `VisualContentAnalyzer.analyze(raster, region,
  backend) → { status:'ok'|'not_available'|'failed', findings: RawVisualContentFinding[] }`.
  Findings carry `category`, `confidence`, raster-space `bbox`, optional `text`.
- **Honest default** (`perception/visual/content-analyzer.ts`): with no engine registered the
  registry returns a constant analyzer that ALWAYS reports `not_available` and zero findings —
  nothing is constructed, nothing is fabricated (CONTRIBUTING.md §22). `registerVisualContentAnalyzer()`
  is the single, lazy integration point for a real local ONNX/OCR engine later.
- **Coordinate mapping** (`perception/visual/coords.ts`, pure): `mapRasterBboxToRegion` inverts
  the rasterizer's crop+downscale so an engine's raster-pixel box maps back to the region's CSS-px
  space (document-absolute for below-fold, viewport-relative for visible), clamped to analyzed pixels.
- **Service wiring** (`perception/visual/service.ts`): after the structural provider, the same
  raster is passed to the content analyzer. `ok` findings are mapped, region-tagged (`regionId`),
  and returned on `VisualPerceptionResult.contentFindings`; `VisualPerceptionResult.contentStatus`
  reports `not_available|ok|failed` honestly. An engine that throws → `failed`, zero findings.
  Findings are cached alongside observations (repeat scans re-emit without re-running the engine).
- **Masking integration** (`policy/index.ts`): each categorized visual finding is classified with
  the SAME category table as DOM/PII, producing a per-finding decision with its bbox. Distinct
  sub-boxes get distinct finding ids (`regionId#bbox`) so MULTIPLE INDEPENDENT findings survive;
  M5 `mergeMaskRegions` keeps disjoint regions separate and merges only true overlaps. A critical
  category (e.g. PASSWORD) in an image escalates to a page-level BLOCK (fail-closed, no cleartext).

### Reality check (honest answers)

- **Is REAL OCR/vision available?** NO. No engine is bundled; the default analyzer returns
  `not_available`. The interface, coordinate mapping, masking, and tests are ready for a real
  local engine to be dropped in via `registerVisualContentAnalyzer()`.
- **Is image-based sensitive-data detection functional end-to-end?** The full path
  (capture → region → analyzer → categorized finding → coord-map → policy → independent mask →
  block) is functional and tested WITH A FAKE ENGINE. In production, with no engine registered,
  it correctly yields zero visual content findings — by design, not by failure.
- **Recognized `text` never leaks:** it stays on the local `VisualPerceptionResult` only; policy
  never reads it and it is absent from `EnforcementResult` and the summary (canary test asserts this).

### Tests added (all green)

- `tests/integration/built-extension.test.ts` — 8 (Priority 1 build/manifest/asset validation).
- `tests/unit/visual-coords.test.ts` — 5 (raster→region bbox conversion, clamping, degenerate).
- `tests/unit/visual-content-analyzer.test.ts` — 4 (not_available default, laziness, single
  in-flight construction, reset).
- `tests/integration/visual-content-findings.test.ts` — 7 (not_available/no fabrication; ok→finding
  with mapped doc coords + regionId; multiple independent findings; engine-throws→failed;
  independent masks through M4→M5; critical→block+no cleartext; OCR-text canary non-leakage).

### Gates (measured 2026-08-30)

- `typecheck` ✅ · `lint` ✅ · `test` ✅ **243 passed** (23 files) · `build` ✅ · `e2e` ✅ **12 passed**.
- **Lightweight:** `dist/` = **261 KB** total (largest asset 216 KB panel bundle). No new
  dependencies, no bundled model/OCR/CV assets. <100 MB requirement: PASS.

### Remaining limitations

- No local OCR/vision engine ships yet (the whole point of the honest `not_available` default).
- Below-fold IMAGE coverage remains bounded band-capture (§9d); below-fold TEXT is fully covered
  via whole-page `innerText`. Unchanged by this work.
- Fully-cached regions with no prior findings leave `contentStatus` unset (first scan reports it).

---

## 9f. Milestone 6 — agent loop, action bridge, firewall seam, backend planner

_Added 2026-09-01. All numbers below were actually measured in this workspace; nothing is
claimed that was not run (CONTRIBUTING.md §22)._

### Scope

The M6 milestone from `docs/architecture.md`: the provider-agnostic **agent**, the
**structured action validator + local action bridge**, and — because a working loop
requires egress — the **privacy firewall** that CONTRIBUTING.md §5 Rule 6 makes the single
outbound boundary. Plus the backend planner endpoint (`POST /v1/plan`) and a CI
workflow (the repository previously had none).

### Design decisions

- **Panel-driven loop, pure modules.** `runAgentLoop` (`extension/src/agent/loop.ts`)
  lives in a DI-only module: observation (SCAN_PAGE relay), enforcement (M4+M5),
  firewall, planner and bridge are all injected, so unit tests run the REAL
  enforcement/firewall/planner against fake pages. The panel (`AgentTask.tsx`) only
  wires real implementations and renders alias-level step records.
- **Stateless planner; the page state is the loop memory.** The deterministic planner
  (`agent/planner.ts`) is a pure function of the sanitized request and returns AT MOST
  ONE action. After execution the loop re-observes: a filled field reports `filled:
  true` in the sanitized structure, so the planner advances without any memory. This
  also makes it prompt-injection-resistant by construction: page labels are matched
  only against a fixed structural keyword table, never interpreted as instructions
  (CONTRIBUTING.md §6) — asserted by a dedicated unit test.
- **`SanitizedNode`s carry no values.** The remote planner sees field semantics
  (tag/type/label/name), a `filled` boolean and a CSS selector — never a value. A
  label/name crosses only when the M2 detector finds nothing in it (fail closed,
  gated in `toSanitizedNodes`).
- **Two-stage validation, then LOCAL resolution, then execution.**
  `actions/validate.ts` (pure): schema (exact shapes, no extra fields — a malicious
  planner cannot smuggle payload) and policy (NAVIGATE only to allowlisted https
  origins — default-deny; bounded SCROLL; TYPE/SELECT values must be an alias or scan
  clean against `detectPII`, so a hallucinating/malicious planner cannot type a raw
  protected value). `actions/index.ts` bridge: schema → policy → vault.resolve (alias
  → value, on-device, latest possible moment) → content-script execution. Unknown or
  expired aliases fail closed (`ALIAS_UNKNOWN`).
- **Firewall = structure + alias grammar + content scan.** `firewall/inspect.ts` fails
  closed unless the payload is EXACTLY a `RemoteAgentRequest` (no missing/extra keys),
  every alias matches `USER_<CATEGORY>_<n>`, and the same local detector (M2) scans
  clean over every text-bearing string. Honest limit (documented, §13): it cannot
  prove absence of PII the detector does not recognize; that risk is bounded upstream
  by `enforcePrivacy` withholding `sanitizedText` unless the page was fully enforced.
- **No-progress guard.** Executing the identical action twice in a row (e.g. a submit
  button that never disables) stops the loop with `max_steps/NO_PROGRESS` instead of
  silently burning the step budget.
- **Fail-closed stops everywhere:** blocked page (critical credential), restricted
  surface, unenforceable findings, firewall deny, planner failure, rejected action —
  each a structured status surfaced in the UI, never retried blindly, never silent.
- **Backend mirrors the extension planner.** `backend/fastapi/app/agent.py` implements
  the same deterministic heuristics over the sanitized contract (pydantic-validated:
  alias grammar, action-kind allowlist, size caps → 422), with `AGENT_PROVIDER` as the
  S4 seam — selecting `remote` raises 501 rather than pretending (CONTRIBUTING.md §22).

### Files added

- `extension/src/actions/validate.ts`, `extension/src/actions/index.ts` (rewritten from the M0 stub)
- `extension/src/agent/planner.ts`, `extension/src/agent/remote.ts`, `extension/src/agent/loop.ts`, `extension/src/agent/index.ts` (rewritten from the M0 stub)
- `extension/src/firewall/inspect.ts`, `extension/src/firewall/index.ts` (implemented from the M7 seam — required for any egress)
- `extension/src/sidepanel/AgentTask.tsx`
- `backend/fastapi/app/agent.py`, `backend/fastapi/tests/test_plan.py`
- `tests/unit/{agent-planner,actions-validate,firewall,agent-loop}.test.ts`
- `tests/integration/agent-leakage.test.ts`, `tests/e2e/agent-task.spec.ts`
- `.github/workflows/ci.yml`

### Files modified

- `extension/src/types/contracts.ts` — additive M6 types (`SanitizedNode`); `RemoteAgentRequest.sanitizedPageStructure` narrowed from `unknown[]` to `SanitizedNode[]` (nothing else constructed it yet)
- `extension/src/types/messages.ts` — additive `EXECUTE_ACTION` channel + `FieldStructure` on `ScanPageResponse` (raw, INTERNAL-ONLY, same boundary as `pageText`)
- `extension/src/content/index.ts` — structure collection + constrained `EXECUTE_ACTION` executor (CLICK/TYPE/SELECT/SCROLL/NAVIGATE only; structured outcome codes; never evaluates page strings)
- `extension/src/background/index.ts` — `EXECUTE_ACTION` relay via the existing hardened relay path (no new permissions)
- `extension/src/sidepanel/App.tsx` — 2 lines (import + `<AgentTask />`)
- `backend/fastapi/app/main.py` — added `POST /v1/plan`; `/health` untouched

### Validation results — actually executed

| Gate | Command | Result |
| --- | --- | --- |
| Typecheck | `npm run typecheck` | ✅ pass (0 errors) |
| Lint | `npm run lint` | ✅ pass (0 errors) |
| Unit + integration | `npm test` | ✅ **308 passed / 308** (31 files; was 271 — +37 new) |
| Build | `npm run build` | ✅ pass |
| E2E | `npm run e2e` | ✅ **13 passed / 13** (was 12 — +1 agent-task spec) |
| Backend | `pytest -q` (backend/fastapi) | ✅ **9 passed / 9** |
| CI | `.github/workflows/ci.yml` | added (node gates, backend pytest, e2e job) |

### Privacy verification (canary-based, CONTRIBUTING.md §13)

`tests/integration/agent-leakage.test.ts` plants synthetic canaries
(`CANARY_EMAIL_001@example.test`, `555-123-4567`) in the page text of a full
fill-and-submit run and asserts: (1) `fetch`/XHR/WebSocket/`sendBeacon` are stubbed to
THROW and are never hit — the deterministic loop performs zero network I/O; (2) step
records and every observed outbound request contain the aliases but never the canaries;
(3) alias→value mappings exist only in the local vault; (4) console spies see no
canary; (5) the remote gateway transmits ONLY after a firewall allow verdict, sends the
inspected payload verbatim, refuses on deny, and rejects malformed planner responses.
A source scan proves the firewall/validator/planner/loop modules contain no
`console.*`/network/storage calls.

### Known limitations

- **No LLM provider yet.** The remote planner provider is a loud 501 seam (`S4`); the
  Ollama/VLM adapter (`qwen2.5vl:7b`, JSON-schema-constrained) lands next. The
  deterministic planner fully drives the demo.
- **The agent loop uses DOM signals only.** M3 visual/OCR findings are part of the
  scan-time pipeline but are not fed into per-step enforcement (cost/latency); a page
  whose sensitive data exists ONLY inside images is filled-blank by the planner. Documented, not hidden.
- **The firewall cannot prove absence of undetectable PII** (free-text names etc.) —
  bounded upstream by `enforcePrivacy`'s withhold-cleartext gate; stated honestly.
- **NAVIGATE is default-denied** (empty allowlist) — no e2e coverage of allowed
  navigation yet; the validator is unit-tested.
- **Below-fold controls** appear in the structure (whole-document query) but the
  planner has no scrolling strategy of its own yet; SCROLL exists and is validated but
  the deterministic planner never emits it.

---

## 9g. Milestone 7 — telemetry, PrivAgent-Bench, leakage sentinel measurement

_Added 2026-09-01. All numbers below were actually measured in this workspace; nothing is
claimed that was not run (CONTRIBUTING.md §22)._

### Scope

The M7 milestone from `docs/architecture.md`: the **telemetry/audit-log module** and the
**PrivAgent-Bench** benchmark harness (blueprint §10/§11/§7) that turns the privacy and
utility claims into MEASURED numbers, plus `docs/benchmark.md` as the benchmark
specification.

### Design decisions

- **Telemetry is value-free BY CONSTRUCTION** (`extension/src/telemetry/index.ts`): the
  recorder copies a fixed allowlist of fields (`type`, `entityCategory`, `alias`,
  `timestamp`) and drops everything else, so no caller can smuggle a raw value into the
  log. Timings are name+milliseconds only. In-memory, session-scoped, bounded buffers
  (1,000 entries, oldest evicted — same volatility philosophy as the vault, R15).
  `exportSummary()` exposes counts + p50/p95/max percentiles only.
- **Agent loop instrumented**: `AgentRunResult.stageMs` now carries cumulative
  scan/enforce/plan/execute/total durations (blueprint §10 "local inference latency");
  the panel displays total local time.
- **PrivAgent-Bench fixtures** (`benchmark/fixtures.json`): the eight §10 page/task
  families with difficulty levels, synthetic uniquely-identifiable canaries
  (`BENCH_*`, Invariant 6), and §5-style safe-item false-positive controls (prices,
  order/product/ledger IDs, dates).
- **The leakage sentinel MEASURES, it does not assert** (`benchmark/run.ts`):
  `runLeakageProbe` drives the REAL loop over each fixture page, captures every
  outbound request, and searches payloads + step records for exact/case/URL-encoded
  canary variants — the §7 leakage rate is computed, and a non-zero rate is a benchmark
  FINDING (that is exactly how it caught the name-leak below).
- **§11 three-way comparison is generated per page**: no-protection vs full-redaction
  vs PrivAgent — payload bytes AND fillable sensitive slots, producing the data for the
  blueprint's "winning graph".
- **Multi-signal detection added where the sentinel caught a real leak** (blueprint
  §5): during bench development the sentinel measured a 0.25 leakage rate on the
  registration page — planted person-name values rode verbatim inside
  `sanitizedVisibleText` because no pattern matches a name. `detectLabeledValues`
  (strict `Name:`/`Patient:`/`Student:`/`Address:` label evidence + credential keywords
  with whitespace separators) now feeds the loop and the recall evaluation. This is the
  honest §5 ablation ("context-aware vs pattern matching") starting to exist.

### Files added

- `benchmark/fixtures.json`, `benchmark/run.ts`
- `tests/benchmark/rubric.bench.ts`, `vitest.bench.config.ts` (`npm run bench`)
- `tests/unit/telemetry.test.ts`, `tests/e2e/bench-tasks.spec.ts`
- `docs/benchmark.md`

### Files modified

- `extension/src/telemetry/index.ts` — implemented from the M7 stub
- `extension/src/agent/loop.ts` — `stageMs` timings + multi-signal entity collection
- `extension/src/perception/pii/index.ts` — additive `detectLabeledValues`
- `extension/src/sidepanel/AgentTask.tsx` — shows total local time
- `package.json` — `bench` script; `tsconfig.json` — includes the bench config
- `.github/workflows/ci.yml` — `benchmark` job with artifact upload

### Validation results — actually executed

| Gate | Command | Result |
| --- | --- | --- |
| Typecheck | `npm run typecheck` | ✅ pass |
| Lint | `npm run lint` | ✅ pass |
| Unit + integration | `npm test` | ✅ **315 passed / 315** (was 308 — +7 telemetry) |
| Bench | `npm run bench` | ✅ 3 passed (golden gates: recall/FPR/leakage/task-success) |
| Build | `npm run build` | ✅ pass |
| E2E | `npm run e2e` | ✅ **17 passed / 17** (was 13 — +4 real-extension bench tasks) |
| Backend | `pytest -q` | ✅ 10 passed / 10 |
| CI | benchmark job + artifact upload added | ✅ |

### Measured results (full details in docs/benchmark.md + reports artifact)

- PII recall **100%** (25/25 planted items across 5 categories, multi-signal)
- False-positive rate **0%** (16 safe controls)
- Leakage rate **0%** (8 pages × full agent runs, sentinel-measured)
- Task success rate **100%** (4 DOM-feasible families, REAL extension e2e)
- Credential-bearing pages: **fail-closed blocked, 0 bytes transmitted** (4/4)
- §11 comparison: PrivAgent preserves all fillable slots at ~160 B where full redaction
  preserves 0 slots — the measured "winning graph" direction
- Local inference latency p50 ≈ 0.01 ms/page (node-side pipeline)

### Known limitations

- Free-text values with NO introducing label and NO reliable pattern (a name mid-sentence)
  remain undetectable — documented boundary; NLP/context classification is future work.
- Resource utilization (rubric #4) currently measures bundle size, per-stage durations
  and request bytes; `performance.memory` is measured only when present; CPU/GPU/RAM on
  target hardware is not instrumented yet.
- Latency is node-side; full in-browser per-stage telemetry UI lands with the dashboard.
- Visual-only (canvas/image) pages are not yet part of the task-success metric.

---

## 9h. Telemetry dashboard (rubric #4 evidence, UI)

_Added 2026-09-01, same session as §9g._

### Scope

The side panel now SURFACES the M7 telemetry: a `Telemetry` dashboard section showing
privacy-event counts (DETECTED/SANITIZED/BLOCKED/ALIAS_RESOLVED/TASK_RESULT) and
per-stage timing percentiles (p50/p95/max) — the visible, live evidence for the
client-side resource-utilization metric.

### Design decisions

- **Session telemetry singleton** (`sidepanel/telemetry-session.ts`): one `Telemetry`
  instance shared by the scan pipeline and the agent task, wrapped with a minimal
  pub-sub; React reads it through `useSyncExternalStore`. The value-free guarantee
  stays in the recorder — the wrapper only fans out notifications.
- **Pipeline instrumentation**: `App.runScan` records `scan.detect`/`scan.visual`/
  `scan.enforce`/`scan.total` timings and DETECTED (per category, normalized via
  `toSensitiveCategory`) / SANITIZED / BLOCKED events; the agent task records
  `agent.*` stage timings (from `AgentRunResult.stageMs`), ALIAS_RESOLVED (alias only)
  and TASK_RESULT events.
- The dashboard can only ever show counts and milliseconds — the recorder's
  allowlist-copy makes a raw-value leak into the UI structurally impossible, and the
  e2e asserts the planted raw values never appear in the dashboard text.

### Files

- Added: `extension/src/sidepanel/telemetry-session.ts`, `extension/src/sidepanel/TelemetryPanel.tsx`,
  `tests/unit/telemetry-session.test.ts`, `tests/e2e/telemetry-panel.spec.ts`
- Modified: `extension/src/sidepanel/App.tsx` (instrumentation + mount),
  `extension/src/sidepanel/AgentTask.tsx` (events + timings)

### Validation results — actually executed

| Gate | Command | Result |
| --- | --- | --- |
| Typecheck / lint | `npm run typecheck` / `npm run lint` | ✅ pass |
| Unit + integration | `npm test` | ✅ **318 passed / 318** (+3) |
| Build | `npm run build` | ✅ pass |
| E2E | `npm run e2e` | ✅ **18 passed / 18** (+1: dashboard fills from scan + agent run, value-free, reset works) |
| Backend | `pytest -q` | ✅ 10 passed / 10 |

### Known limitations

- Telemetry is session-scoped in memory (resets on panel reload) — by design (R15);
  persistent audit export remains future work.
- Timings cover the local pipeline; full network-byte accounting per outbound request
  is available in the bench, not yet surfaced live in the panel.

---

## 9i. Visual-context accuracy measured (rubric #1) — live OCR verification closed

_Added 2026-09-01, same session as §9h._

### Scope

The last unmeasured rubric line (#1, 25%): pages whose sensitive values exist ONLY as
painted pixels. A new e2e suite (`tests/e2e/visual-accuracy.spec.ts`) renders canvas-only
pages, runs the REAL local pipeline (scan + visual check), and measures category-level
accuracy via a value-free stats seam (`sidepanel/visual-stats.ts`: per-category counts
only — recognized text/bboxes are never exposed, matching what the agent itself sees).

### Root cause found and fixed en route

The structural analysis budget (`MAX_ANALYSIS_EDGE = 192`) shrank 642px canvases to
192px — 28px text became ~8px, unreadable. `OCR_ANALYSIS_EDGE = 1024` is now used for
the analysis raster ONLY when a content analyzer is registered; the default no-engine
pipeline is byte-identical to before.

### Measured

- contentStatus `ok` — the Tesseract.js wasm engine verifiably runs in headless Chromium
  (closes the §0 "pending manual Chrome verification" item)
- Category-level accuracy **100%** (2/2 pages: EMAIL+PHONE, PAYMENT), 0 false positives
- Scan summary shows `OCR_REGION_n` masked rows with `textCount: 0` (visual-only proof)

### Files

- Added: `tests/e2e/visual-accuracy.spec.ts`, `extension/src/sidepanel/visual-stats.ts`
- Modified: `extension/src/perception/visual/regions.ts` (`OCR_ANALYSIS_EDGE`),
  `extension/src/perception/visual/service.ts` (conditional elevation),
  `extension/src/sidepanel/{VisualStatus,App}.tsx` (stats recording),
  `docs/benchmark.md` (rubric #1 section)

### Validation — actually executed

typecheck ✅ lint ✅ vitest **318/318** ✅ bench 3/3 ✅ build ✅ e2e **21/21** (+4) ✅
backend 10/10 ✅ — reports: `benchmark/reports/visual-accuracy.{json,md}`

---

## 9j. Below-fold scrolling, allowlisted navigation, repo organization, CI fix

_Added 2026-09-01/02, same session as §9h/§9i._

### Scope

Three planner/loop capability gaps closed, one CI defect fixed, and the repository
reorganized for handoff.

### What landed

- **Below-fold scrolling**: `SanitizedNode.belowFold` (viewport-relative, recomputed on
  every observation) → the deterministic planner emits one bounded `SCROLL(720)` before
  interacting with below-fold controls; the re-observation decides when to stop
  scrolling. Repeated scrolls are exempt from the no-progress guard (scrolling IS
  progress-seeking); the step budget still bounds them. The executor also
  `scrollIntoView`s before TYPE/CLICK/SELECT. E2E: a 1200px-tall page is filled and
  submitted end-to-end (`below-fold.spec.ts`).
- **Allowlisted NAVIGATE**: `RemoteAgentRequest.pageOrigin` (origin-only, value-free,
  firewall-validated as such) + a NAVIGATE rule that emits ONLY origins taken from the
  local policy allowlist and named in the task — never an invented URL, never when
  already on the target. The loop derives a same-origin default allowlist (fail-closed
  empty) and shares it with the bridge's per-execution policy provider; the panel reads
  a user-configured allowlist from `chrome.storage.sync` (default empty). E2E:
  portal.test → privagent.test navigation + fill + submit (`navigation.spec.ts`).
- **CI fix**: the `node` job ran `npm test` BEFORE `npm run build`; the
  built-extension integration suite validates the BUILT `dist/` manifest and failed on
  every clean checkout since M6 (5 red runs). Build now precedes tests; the run on
  this commit is the regression proof.
- **Repo organization**: `CLAUDE.md` → `CONTRIBUTING.md` (tool-neutral engineering
  rules; section numbers unchanged — 51 files of references swept); new `AGENTS.md`
  agent entry point; blueprint PDF moved to `docs/`; README updated.
- **Firefox spike (time-boxed)**: `scripts/build-firefox.mjs` post-processes `dist/`
  into `dist-firefox/` — event-page background (the CRXJS loader's import target is
  inlined; the script refuses module syntax), `sidebar_action` instead of the
  `sidePanel` permission, `browser_specific_settings.gecko.id`. `npm run build:firefox`.

### Validation — actually executed

typecheck ✅ lint ✅ vitest **324/324** (+6) ✅ bench 3/3 ✅ build ✅ e2e **22/22** (+2:
below-fold, navigation) ✅ backend 10/10 ✅ · `npm run build:firefox` produces a valid
Firefox MV3 structure ✅

### Known limitations

- Firefox: NOT executed in a real browser (Playwright cannot load extensions in
  Firefox); manual path = `web-ext run --source-dir dist-firefox`. The toolbar-click
  panel-open is Chrome-only — Firefox users open the sidebar manually.
- Same-origin default navigation: cross-origin agent flows require the user-configured
  allowlist (storage key `navigationAllowlist`).
- Below-fold interaction assumes viewport-height scrolls; extremely tall/lazy pages may
  consume the step budget (bounded, honest).

---

## 9k. Gate re-verification from a clean tree (2026-09-02)

_Every gate below was re-run in this workspace at HEAD `f2502a4` with a clean working
tree — not quoted from an earlier section (CONTRIBUTING.md §20/§22). Three real defects
were found by doing so, and all three are fixed._

### Defects found and fixed

1. **`npm run lint` was RED (2 errors)** — `scripts/build-firefox.mjs:32` escaped the
   double quotes inside a regex character class (`/import\s+['\"]([^'\"]+)['"];?/g`),
   which `no-useless-escape` rejects. Fixed by removing the two unnecessary escapes
   (`['"]([^'"]+)`) — semantically identical; `npm run build:firefox` still finds exactly
   one import in the service-worker loader and emits a valid `dist-firefox/`, which is the
   behavioural proof the regex is unchanged.
2. **`tests/e2e/agent-task.spec.ts:60` had a floating assertion** — the final
   `expect(panel.locator('body')).not.toContainText(...)` was missing `await`, so the
   matcher's promise outlived the test and raced teardown, surfacing as
   `Protocol error (Runtime.callFunctionOn): … session closed` (1 failed / 22 passed on
   the first run). Fixed by awaiting it. This *strengthens* the check: an un-awaited
   matcher may never actually assert. Re-ran that spec `--repeat-each=3` → 3/3 green, then
   the whole suite. No other un-awaited async matcher exists in `tests/e2e/**` (grepped).
3. **`npm run build:firefox` turned `npm run lint` RED (1906 errors)** — `dist-firefox/`
   is gitignored but was missing from `eslint.config.js` `ignores`, so eslint linted the
   generated Firefox bundle. CI never hit it because CI does not run the Firefox build
   before lint; a developer following §9j's documented command does. Fixed by ignoring
   `dist-firefox/**` exactly like `dist/**`. Verified by running lint WITH `dist-firefox/`
   present → exit 0.

### Verified gate results

| Gate | Command | Result |
| --- | --- | --- |
| Typecheck | `npm run typecheck` | ✅ pass (0 errors) |
| Lint | `npm run lint` | ✅ pass (0 errors) — after fixes 1 and 3, verified with `dist-firefox/` present |
| Unit + integration | `npm test` | ✅ **324 / 324** (33 files) |
| Bench | `npm run bench` | ✅ 3 / 3 golden gates |
| Build | `npm run build` | ✅ pass |
| E2E | `npm run e2e` | ✅ **23 / 23** (9 specs) — after fix 2 |
| Firefox transform | `npm run build:firefox` | ✅ valid `dist-firefox/` |
| Backend | `pytest -q` (backend/fastapi) | ✅ **10 / 10** — see env note |
| Lightweight | `du -sh dist` | ✅ **16 MB** (<100 MB); `dist/ocr` is the bulk |

**Environment note (honest):** backend tests initially could not even be COLLECTED here —
`starlette.testclient` requires `httpx`, which was absent from this machine's Python
env. Installing `backend/fastapi/requirements.txt` fixed it (10/10). The install upgraded
global `starlette`/`uvicorn`, which an unrelated globally-installed `platformio 6.1.19`
pins lower — a pre-existing environment conflict, not a project defect.

### §0 open item now CLOSED

`dist/manifest.json` was read directly and does contain
`"host_permissions": ["<all_urls>"]` alongside
`"permissions": ["storage","activeTab","scripting","sidePanel"]`, so the capture
root-cause fix is present in the BUILT artifact. The `<all_urls>` grant and
`sidepanel/capture.ts` broker are committed (they landed in `0f14896`).
Still outstanding and **not** claimed: a manual Chrome click-through of the real capture
(headless-Chromium e2e exercises the identical production path, incl. live Tesseract wasm
recognition per §9i, but a human Reload-in-`chrome://extensions` check has not been done).

### Stale counts corrected

Earlier sections are point-in-time snapshots and were left intact for history: §0 records
`271/271` unit tests and §9j records `22/22` e2e. The current, measured figures are
**324/324** unit+integration and **23/23** e2e.

---

## 9l. On-device face detection (ONNX WASM), page-type classification, policy gate

_Added 2026-09-02. All gates below were actually executed (CLAUDE.md→CONTRIBUTING §22)._

### Scope

M7.5 milestone: on-device BlazeFace face detection + blurring via ONNX Runtime Web
(WASM backend ONLY — WebGPU is unstable in MV3 contexts and fails silently), a
rule-based page-type classifier wired into the policy layer, and the model/runtime
build plumbing. Zero remote calls.

### Design decisions

- **Face blur runs in the side panel, not the offscreen document.** The M3
  split-by-context decision put rasterization + analysis in the panel; the face-blur
  step consumes THAT raster where it lives. Moving inference to the (unregistered M0)
  offscreen document would add a cross-document pixel message path and a new
  permission for zero capability gain. The offscreen doc stays reserved (its M0
  header says the same).
- **Model source deviation, documented**: the spec named PINTO_model_zoo
  `307_BlazeFace` — the directory is `030_BlazeFace` and its model tarball is served
  from an S3 host blocked by the build sandbox. A reachable end-to-end export with an
  IDENTICAL runtime contract was used instead (NCHW `[1,3,128,128]` input; graph-baked
  0.7 threshold + NMS; [N,16] normalized output rows). `scripts/fetch-blazeface.sh`
  tries the PINTO source first, then the mirror.
- **Normalization evidence beats the brief**: the brief said [0,1]; the exporter's own
  notebook normalizes `x/127.5 - 1.0` → [-1,1] (MediaPipe TFLite heritage).
  CONTRIBUTING §3 (never invent) — evidence wins; the constant is isolated in
  `preprocessRaster`.
- **Engine is runtime-agnostic**: `createFaceBlurEngine({createSession})` accepts any
  `FaceSessionLike` (minimal `{inputNames, run}` shape); the real ORT session is
  wrapped into it. Tests mock the session entirely (ONNX WASM cannot run under Vitest)
  and the pre/post-processing, parsing and pixel-blur functions are pure and directly
  tested. Model absence → `FACE_BLUR_UNAVAILABLE` trace once, zero faces, pipeline
  continues (availability remembered — no retry spam).
- **Page classifier is rule-based by design** (the brief itself rules out
  MobileViT-XXS: an ImageNet classifier cannot classify page types). Priority order
  payment → auth → form → medical → general with the spec'd confidences; TODO marks
  the MobileViT ONNX upgrade path in `pageClassifier.ts`.
- **Policy gate never weakens a BLOCK**: payment/auth page types floor the overall
  decision at SANITIZE and add the `visual_high_risk` signal; an existing BLOCK
  survives (fail closed, Rule 7). `visualContext` travels on `PolicyReport`
  (informational, value-free — categories only).
- **PART D (CSP)**: the manifest CSP already carries `'wasm-unsafe-eval'` (set for
  Tesseract) — the ORT WASM backend needs nothing more. `web_accessible_resources`
  was deliberately NOT added: the model/runtime are fetched by the extension's own
  panel page, which needs no WAR — exposing them to web pages would be a
  fingerprinting surface.

### Files

- Added: `extension/src/perception/visual/faceBlur.ts`, `extension/src/perception/visual/pageClassifier.ts`,
  `extension/src/perception/visual/models/README.md`, `scripts/fetch-blazeface.sh`,
  `tests/unit/perception/visual/{pageClassifier,faceBlur,policy-visual-context}.test.ts`
- Modified: `extension/src/types/contracts.ts` (`VisualPageType`, `PageClassification`,
  `visual_high_risk` signal, `PolicySignals.visualContext`, `PolicyReport.visualContext`,
  `VisualPerceptionResult.faceStats`), `extension/src/policy/index.ts` (page-type gate),
  `extension/src/perception/visual/service.ts` (blur-before-OCR + `faceStats`),
  `extension/src/agent/loop.ts` + `extension/src/sidepanel/App.tsx` (classification wiring),
  `extension/src/diag/ocr-trace.ts` (face-blur stages), `vite.config.ts` (ONNX asset copy),
  `package.json` (`onnxruntime-web 1.29.0`, pinned exact)

### Validation — actually executed

| Gate | Command | Result |
| --- | --- | --- |
| Typecheck | `npm run typecheck` | ✅ pass |
| Lint | `npm run lint` | ✅ pass |
| Unit + integration | `npm test` | ✅ **342 passed / 342** (+18: classifier, face engine, policy gate) |
| Bench | `npm run bench` | ✅ 3 passed |
| Build | `npm run build` | ✅ pass (`dist/ort/` copied; model optional) |
| E2E | `npm run e2e` | ✅ **23 passed / 23** |
| Backend | `pytest -q` | ✅ 10 passed / 10 |

### Runtime verification — NOW REAL (2026-09-02, same session as §9l)

A dedicated e2e (`tests/e2e/face-detection.spec.ts`) renders a REAL face
(`person.jpg`, the exact image the model exporter's own notebook used) and drives the
full pipeline in headless Chromium: BlazeFace (ONNX WASM, on-device) **detected the
face and blacked it out before OCR** — `faceStats.facesDetected >= 1`,
`facesBlurred >= 1`, `contentStatus: 'ok'`. Measured, not inferred.

Three real defects were found and fixed while proving this:
1. **Partial ORT runtime copy**: ORT 1.29 dynamically imports the glue by name
   (`ort-wasm-simd-threaded.jsep.mjs`) as a sibling module of the `.wasm`; shipping only
   the base pair failed with a "dynamically imported module" backend error. The fix at
   the time was to copy EVERY `ort-wasm*.{mjs,wasm}` variant. **That remedy was wider
   than the diagnosis required and has since been narrowed — see §9r**: the failure was
   shipping the WRONG pair (base instead of jsep), not too FEW pairs. The imported entry
   point hard-codes exactly the jsep pair and cannot request the others, so the build now
   copies that pair only, and fails loudly if ORT renames it.
2. **Input-name matcher**: the model's image input is named `image`, not `input` — the
   keyword matcher silently missed it and returned zero faces. `pickImageInput` now
   accepts both spellings.
3. **Nearest-neighbour downscale** lost face detail; bilinear interpolation (the
   exporter's own `cv2.resize` default) is used.

### Known limitations

- A cartoon "synthetic face" is deliberately NOT used as the fixture (BlazeFace is
  trained on real faces; claiming otherwise would be fabrication) — the fixture is a
  real face photo.
- The end-to-end model reports detections WITHOUT per-face scores (threshold + NMS are
  in-graph) — `facesDetected`/`facesBlurred` counts are the honest surface.
- Page classifier sees DOM structure/text only; canvas-only page types are invisible to
  it (documented; MobileViT upgrade path marked in code).

---

## 9m. M8 — Gemini Flash provider on the AGENT_PROVIDER seam

_Added 2026-09-02._

### Scope

Wired Gemini Flash into the backend `AGENT_PROVIDER` seam: `AGENT_PROVIDER=gemini`
selects `GeminiProvider` (default model `gemini-2.0-flash`, overridable via
`GEMINI_MODEL`; key via `GEMINI_API_KEY`). The offline `deterministic` planner remains
the default and requires no key — CI passes without any API credentials.

### Design decisions

- **Lazy SDK import**: `agent.py` imports the provider only when `gemini` is selected,
  so the deterministic default never depends on `google-genai`.
- **Native structured JSON**: Gemini `response_schema=PlanResult` +
  `response_mime_type="application/json"` guarantee valid JSON without markdown.
- **Contract preserved**: the provider adapts the LLM's single `{action, done, reason}`
  into the endpoint's `{"actions": [...]}` shape the extension expects (SCROLL
  `direction: up|down` → signed `amount`). No existing test or the extension contract
  changed.
- **Fail-closed, defense-in-depth**:
  - PRE-SCAN (endpoint, ALL providers): `taskObjective` + `sanitizedVisibleText`
    scanned for raw email/phone/Luhn-card → HTTP 422.
  - POST-SCAN (provider): model output `value` + `reason` scanned → HTTP 502 on a leak.
  - API failure (rate limit/network) → HTTP 502 `llm_unavailable`.
  - Missing `GEMINI_API_KEY` → HTTP 500 (raised on the planning path only, never /health).

### Files

- Added: `app/pii_scan.py`, `app/gemini_provider.py`, `tests/test_gemini_provider.py`
- Modified: `app/agent.py` (seam), `app/main.py` (pre-scan + error mapping),
  `requirements.txt` (`google-genai>=1.0`)

### Validation — actually executed

Backend `pytest -q`: **19 passed / 19** (10 existing incl. `test_plan.py` +
`test_health.py` all green, +9 Gemini). Full repo gates: typecheck ✅ lint ✅
vitest 342/342 ✅ bench 3/3 ✅ build ✅ e2e 24/24 ✅. Mocked client only — no real API calls.

### Known limitations

- Model output is only scanned for PATTERN-detectable PII (mirrors the extension
  detector); undetectable free-text values are bounded by the client-side firewall.
- No live-call integration test in CI (no key); verified via mocks.
- Ollama (`AGENT_PROVIDER=remote`) remains the loud-501 seam (S4, postponed).

---

## 9n. Side panel ↔ Gemini backend wiring (planner toggle)

_Added 2026-09-02._

### Scope

`AgentTask.tsx` now offers a **Use Gemini AI Planner** checkbox (default ON). Checked → the
agent loop uses `createRemoteHttpAgentGateway({ endpoint: 'http://localhost:8000/v1/plan',
firewall })` (the FastAPI backend, `AGENT_PROVIDER=gemini` when a key is set). Unchecked →
the offline deterministic planner. One firewall instance is shared by the loop gate and the
gateway's pre-transmit gate.

### Verification — actually executed

- Remote path proven end-to-end with a throwaway probe (backend live at :8000 with the
  deterministic provider as the offline stand-in — identical HTTP contract): the real
  extension, toggle ON, completed a fill-and-submit task against the live endpoint, then the
  probe was removed.
- e2e offline specs (agent-task, bench-tasks ×4, below-fold, navigation, telemetry-panel)
  now explicitly uncheck the toggle so CI stays offline/deterministic; agent-task asserts the
  toggle defaults ON.
- Gates: typecheck ✅ lint ✅ vitest 342/342 ✅ bench 3/3 ✅ build ✅ e2e **24/24** ✅ backend 19/19 ✅.

### Known limitations

- Live Gemini verification requires a `GEMINI_API_KEY` (backend, `AGENT_PROVIDER=gemini`)
  — not exercised in CI; the HTTP contract is identical to the verified deterministic path.
- Toggle state is per-panel-session (not persisted); localhost backend must be running for
  the checked path, else the loop fails closed with `PLANNER_FAILED`.

---

## 10. Corrections to earlier milestone claims

Recorded for honesty (CONTRIBUTING.md §22) — these were found while starting M3, not introduced by
it.

1. **M1's `npm run e2e — ✅ all e2e tests passed` was not reproducible.**
   `tests/e2e/smoke.spec.ts` navigated to the literal string
   `chrome-extension://<extension-id>/src/sidepanel/index.html` — an unsubstituted
   placeholder, pointing at a path the build does not emit (the built panel is at
   `extension/src/sidepanel/index.html`). No Playwright browsers were installed either. That
   test could never have passed. It has been replaced in M3.

2. **M2's `npm run lint — ✅ pass (0 errors)` was not reproducible.** At the start of M3,
   `npm run lint` reported **5 errors**: `perception/ocr/index.ts` 8:20 and 13:28
   (`no-explicit-any`), `perception/pii/index.ts` 6:122 (`no-useless-escape`), and
   `tests/unit/contracts.test.ts` 2:27 and 3:18 (`no-explicit-any`). All 5 are now resolved
   as a byproduct of M3 work.

---

## 9o. M6 audit gap closure — explicit task privacy contract (2026-09-02)

_Scope: the five gaps named by the read-only M6 audit, and nothing else. No M7 work, no
AI/LLM/VLM, no architecture change, no M0–M5 logic touched._

### Gaps closed

1. **Explicit typed `TaskPrivacyContract`.** `extension/src/types/contracts.ts` now
   declares `TaskPrivacyContract { readonly privacyMode; readonly navigationAllowlist }`
   and `RemoteAgentRequest.policy` is that type instead of an inline object literal.
   `backend/fastapi/app/agent.py` mirrors it (`ActionPolicy` → `TaskPrivacyContract`).
2. **`privacyMode` is strongly typed:** `type PrivacyMode = 'strict'`. Grepping every
   producer and assertion (extension, tests, backend, docs, bench) found `'strict'` to be
   the only regime any code path emits or honours, so that is the whole union.
   `'standard'`/`'permissive'` were deliberately NOT declared: a mode name with no
   behaviour behind it is a fabricated capability (CONTRIBUTING.md §22) and a shape a
   caller could claim in order to receive weaker treatment. Runtime companion:
   `extension/src/policy/modes.ts` (`PRIVACY_MODES`, `DEFAULT_PRIVACY_MODE`,
   `isPrivacyMode`) — `contracts.ts` stays types-only, mirroring `actions/kinds.ts`.
3. **Module-level mutable navigation state removed.** `extension/src/agent/session-policy.ts`
   no longer holds `let navigationAllowlist` with `set/getNavigationAllowlist`; it exports
   `createSessionNavigationPolicy()`, a per-run handle that freezes a copy on write.
   `runAgentLoop` publishes through an optional `navigationPolicy` option; `AgentTask.tsx`
   creates one handle per run and hands the bridge `policy: () => ({ ...DEFAULT_ACTION_POLICY,
   navigationAllowlist: navigationPolicy.get() })`. Runtime behaviour is unchanged; one
   run can no longer widen another's allowlist, and the caller cannot mutate the list it
   is handed.
4. **`toSanitizedNodes(undefined)` → `[]`** is now asserted (with `[]` → `[]`), so a scan
   that reports no structure can never leak `undefined` into a request or fabricate a node.
5. **Affected types/usages/tests updated**, plus the firewall was *strengthened* while the
   contract was formalized (see below).

### Firewall: strengthened, not weakened

`extension/src/firewall/inspect.ts` validated `policy` loosely (`privacyMode` any string,
`navigationAllowlist` any array). It now validates the contract field-by-field through
`isPrivacyMode`, requires every allowlist entry to be a string, and rejects any extra
contract key — so an undefined regime, a non-string entry, or a smuggled
`allowRawValues: true` all fail closed as `FIREWALL_MALFORMED`. Backend-side, `privacyMode`
is a pydantic `Literal`, so an unknown regime is a 422 rather than something served under a
mode nothing implements.

### Verified gate results

| Gate | Command | Result |
| --- | --- | --- |
| Typecheck | `npm run typecheck` | ✅ pass |
| Lint | `npm run lint` | ✅ pass |
| Unit + integration | `npm test` | ✅ **332 / 332** (34 files) — was 324 / 324 (33) |
| Bench | `npm run bench` | ✅ 3 / 3 golden gates |
| Build | `npm run build` | ✅ pass |
| E2E | `npm run e2e` | ✅ **23 / 23** (19.6s) — see flake note |
| Backend | `pytest -q` (backend/fastapi) | ✅ **11 / 11** — was 10 / 10 |

New tests: `tests/unit/privacy-contract.test.ts` (mode vocabulary; `isPrivacyMode` rejects
every undefined regime; `DEFAULT_ACTION_POLICY` frozen and NAVIGATE denied), a
contract-validation case in `tests/unit/firewall.test.ts`, the `toSanitizedNodes` case and
a `session navigation policy` block in `tests/unit/agent-loop.test.ts` (deny-all default,
cross-run isolation, copy-on-write/frozen, and a real `runAgentLoop` run proving the
handle receives the scanned page's **origin only** — never the full URL), and
`test_plan_rejects_a_privacy_contract_it_cannot_honour` in `backend/fastapi/tests/test_plan.py`.

### Honest note: one e2e flake, in code not touched here

The first full `npm run e2e` after these changes failed 1 / 23 at
`tests/e2e/navigation.spec.ts:36` (`NO_PROGRESS` after two executed NAVIGATEs) on a loaded
machine at 40.7s wall time. Cause: the loop's fixed 600 ms post-NAVIGATE settle can elapse
before the new document is observable, so the loop re-observes the pre-navigation origin
and re-plans the identical NAVIGATE, and the no-progress guard correctly stops the run.
Both NAVIGATEs were allowlisted, so the reworked allowlist wiring behaved as intended.
Evidence: that spec passes 3 / 3 isolated (~1.8s each) and 8 / 8 under
`--repeat-each=8 --workers=4`; the full suite then passed 23 / 23 in 19.6s. This is a
latent load-dependent timing flake that predates these changes. The test was NOT weakened.
The real fix — wait for the observed origin to change instead of a fixed delay — is out of
this scope ("do not rewrite unrelated navigation logic") and is listed in §11.

---

## 9p. M3 model gate — YOLOS-tiny measured, REJECTED, removed (2026-09-03)

### Scope

The M3 directive required objective proof that a bundled local vision model actually works
**for this project** before M3 could be called complete: "Do NOT assume 'model loads' =
works… Test the real model, not a mock… Do not fabricate browser UI labels from its COCO
classes." A full YOLOS-tiny (`hustvl/yolos-tiny`) ONNX provider was implemented, measured with
real inference, and then removed. No commit was made.

### MODEL DECISION: **REJECT** — no detector model ships

`YOLOS-tiny` is technically functional and **provably correctly integrated**, and is still
**not useful for browser/UI visual perception**. Per the directive ("If YOLOS-tiny is
technically functional but NOT sufficiently useful … DO NOT FORCE IT INTO PRODUCTION"), it was
removed rather than shipped. **Replacement is not another model**: DOM candidate geometry
supplies WHERE, the already-bundled Tesseract.js supplies WHERE + EXACT TEXT via its own
word/line boxes, and `pixel-stats` supplies the coarse structural label. Full methodology,
per-region numbers, and the alternatives table are in `docs/m3-visual-perception.md` §9.

### What was measured (real inference, no mocks)

| Directive item | Result |
| --- | --- |
| 1. Model loads | ✅ session create 409–453 ms (Node, ORT WASM) |
| 2. Real ONNX inference | ✅ 333–381 ms per region |
| 3. WebGPU | ✅ `create 1814 ms · cold 1576 ms · warm 123 ms` (headed Chromium, real adapter) |
| 4. WASM/CPU fallback | ✅ `create 494 ms · cold 373 ms · warm 347 ms`; identical top-5 to WebGPU and to Node |
| 5. Real bounding boxes | ✅ on photographs; ❌ whole-region/degenerate on UI surfaces |
| 6. Real confidences | ✅ non-degenerate softmax |
| 7. Multiple relevant regions | ✅ **8 regions** from 14 candidates (`visual_only_content_present`) |
| 8. Useful for browser-agent perception | ❌ **decisive failure** |
| 9. Not one meaningless generic region | ✅ fixed — see root cause below |
| 10. Tesseract receives the correct regions | ✅ unchanged path, now with a legibility floor |
| 11. Combined vision+OCR reaches M4 | ✅ unchanged `VisualPerceptionResult` → `PolicySignals` |

**Control experiment (proves our code, not the model, is correct):** the same model file and
the same project `preprocess`/`decodeDetections` over a real 810×1080 COCO photo returned
`person 1.00, bus 1.00, person 1.00, person 0.99, bus 0.99` with sensible boxes. On UI
surfaces the same code returned `cup 0.78` / `stop sign 0.74` for a 48 px avatar,
`stop sign 0.89` for a laptop-and-person photo, `microwave 0.69` for a terminal screenshot
containing `API_KEY=…`, and nothing for a sticker. Detections appeared at input edge 320 and
vanished at 512 — not a resolution problem, a domain problem. Cost avoided: **~54 MB**
(26.2 MB weights + 27.8 MB ORT WASM) and ~2.8 s per 8-region run.

### Root cause of the earlier "~1 analysed region" report

Not the model. Three region-selection defects, each fixed and now locked by tests in
`tests/unit/visual-regions.test.ts`: (a) the area floor discarded every 48 px avatar —
`MIN_CANDIDATE_AREA` is now 40×40; (b) a full-bleed backdrop consumed the budget — regions
covering > `OVERSIZED_VIEWPORT_SHARE` (0.6) of the viewport now rank **last**; (c) wrapper +
image duplicate pairs each took a slot — near-duplicates merge at `NEAR_DUPLICATE_IOU` 0.95.
`MAX_REGIONS` rose 4 → 8. Separately, OCR returned zero words on small crops because they
were rasterized below Tesseract's cap-height: on the OCR path only, crops are now resampled
into a 1024/512 px band with upscaling capped at `MAX_UPSCALE` 4.

### Rasterizer changes, and why each was necessary

Only one behavioural change survives, and only on the OCR path: `analysisScale()` gained an
optional `minEdge`, and `service.ts` passes `OCR_ANALYSIS_EDGE`/`OCR_MIN_ANALYSIS_EDGE`
**only when a content analyzer is actually registered**. Without a registered engine the
pipeline rasterizes exactly as before (192 px cap). No new screenshot architecture, no
continuous rasterization, no rewrite of multi-region capture. Everything YOLOS-specific was
reverted via `git checkout`.

### Provider failure now degrades honestly (defect found while closing the gate)

`service.ts` promised in its header that it "never throws at its callers", but a provider
factory rejection propagated straight out of `run()` — which is exactly how a bundled model
fails in the field. Fixed: the provider load is memoized per run and caught, yielding
`status: 'unavailable'`, `reason: 'visual_provider_unavailable'` plus the sanitized load error
in `reasonDetail`; a provider that throws on a single region leaves that region unanalysed and
**uncached** rather than fabricating a label. `VisualStatus` renders a human explanation for
the new reason code, never the raw code.

### Files

Deleted: `providers/vision-onnx.ts`, `providers/yolos-decode.ts`, `register-vision.ts`,
`visual/ocr-targets.ts`, `extension/public/models/` (26.2 MB), `probe-onnx.mjs`, and the
scratch `.m3-gate/` harness. Dependency `onnxruntime-web@1.29.0` uninstalled.
Reverted: `sidepanel/main.tsx`, `visual/service.ts` (then re-applied the `minEdge` change only).
Modified: `types/contracts.ts` (dropped `VisualElementLabel`/`VisualElement`/`elements` — no
M4/M5 consumer existed), `visual/service.ts`, `diag/ocr-trace.ts`
(`VISION_PROVIDER_UNAVAILABLE` stage), `sidepanel/capture.ts` (shared `scrollViaBackground`),
`sidepanel/App.tsx`, `sidepanel/VisualStatus.tsx` (below-fold bands now also reach the Visual
Check widget), `docs/m3-visual-perception.md` (§9 + stale §5–§8 corrected),
`docs/threat-model.md` (R11 resolved by removal).
**Preserved as the directive requires:** `providers/registry.ts` and `capability.ts` — the
generic provider seam and the WebGPU → WASM → CPU ordering.

### Verified gate results

| Gate | Command | Result |
| --- | --- | --- |
| Typecheck | `npm run typecheck` | ✅ pass |
| Lint | `npm run lint` | ✅ pass |
| Unit + integration | `npm test` | ✅ **347 / 347** (34 files) — was 332 / 332 |
| Build | `npm run build` | ✅ pass |
| E2E | `npm run e2e` | ✅ **23 / 23** (18.2s) |
| Bundle size | `find dist -type f` | ✅ **15.29 MB** (19 files) — budget < 100 MB |

`dist/` is dominated by the bundled OCR engine: `tesseract-core*-lstm.wasm(.js)` ≈ 13.0 MB and
`eng.traineddata.gz` 1.9 MB. Shipping YOLOS would have made it ≈ 69 MB for no measured benefit.

New tests (15): 8 in `tests/unit/visual-regions.test.ts` (dense-UI multi-region selection,
48 px avatars kept as distinct regions, oversized-backdrop ranking, wrapper/image collapse,
distinct-overlap preservation, and five `analysisScale` OCR-band cases incl. the `MAX_UPSCALE`
cap), 5 in `tests/integration/visual-perception.test.ts` (provider load failure reported not
thrown, attempted once per run, pixel bytes kept out of the diagnostic, per-region analyze
failure completing the rest, failed region not cached). Existing WebGPU/WASM/CPU ordering
coverage already lives in `tests/unit/visual-restricted.test.ts` — no new file needed.

### Remaining M3 limitations (honest)

- **No UI-element detector exists in the pipeline.** Nothing says "this is a button / an
  avatar / a credential field" from pixels alone. Text inside images is read by Tesseract;
  non-text imagery gets a coarse structural label only.
- **No accuracy figure for `pixel-stats`.** Unbenchmarked heuristic, confidence capped at 0.75.
- **Below-fold coverage is bounded**, not full-page: ≤ `MAX_CAPTURE_BANDS` scroll-and-capture
  bands, and only when `scrollViewport` is injected. Regions outside those bands are not
  analysed and are never reported as if they were.
- **`MAX_REGIONS` = 8 is a real cap.** Denser pages have regions dropped; the cap is documented
  and surfaced in metrics (`regionsSelected`), not hidden.
- **No feasible small UI-detection ONNX artifact was found** at gate time. Every candidate
  failed on licence (GPL/AGPL), format (`.pt`/`.pth` only), or size. Re-evaluate when an
  MIT/Apache web-UI detector ships a small ONNX export.
- Cross-origin iframe interiors stay opaque; DRM/protected video may capture black.

---

## 9q. Merge — `other-pr3` (M7.5 + M8) into `integrate-f` (M3 vision) (2026-09-05)

_The two branches diverged at `f2502a4` and were developed in parallel. Everything below
was measured on the MERGED tree in this workspace — not quoted from either branch
(CONTRIBUTING.md §20/§22)._

### Conflicts resolved (8 files)

Six of the eight were additive collisions — both branches inserted different lines at the
same place — and were resolved as unions after checking that every symbol from both sides
is actually referenced in the already-merged bodies.

| File | The collision | Resolution |
| --- | --- | --- |
| `extension/src/agent/loop.ts` | different imports on the same line | union — `DEFAULT_PRIVACY_MODE` (`loop.ts:231`) and `classifyPage` (`loop.ts:186`) are both used |
| `extension/src/perception/visual/service.ts` | different imports on the same line | union — `OCR_MIN_ANALYSIS_EDGE` (`service.ts:248`) and the face-blur engine (`service.ts:324`) are both used |
| `extension/src/sidepanel/AgentTask.tsx` | one side added `navigationPolicy`, the other `firewall` + the planner toggle | union — the auto-merged `runAgentLoop` call site references all three, so either side alone does not compile |
| `package.json` | `onnxruntime-web` `1.29.0` vs `^1.29.0` | exact pin kept: ORT resolves wasm asset names at run time, so a silent minor bump can change which files must ship |
| `eslint.config.js` | one side documented the `dist-firefox/**` ignore | comment kept |
| `scripts/build-firefox.mjs` | `['"]` vs `["']` in one character class | identical semantics; the `['"]` form kept for consistency with the class beside it |
| `package-lock.json` | both branches recorded `onnxruntime-web` (17 hunks) | took `integrate-f`'s lock, then `npm install --package-lock-only` — reported "up to date" against the resolved manifest, and the tree resolves `onnxruntime-web 1.29.0` |
| `PROJECT_STATUS.md` | both branches appended a section numbered `9k` | both kept, renumbered to run monotonically: gate re-verification stays `9k`; face detection → `9l`, Gemini provider → `9m`, planner toggle → `9n`; the sections after §10 → `9o`, `9p`. Internal `§`-references updated |

### Merge defect found and fixed: the ORT runtime shipped three times

Neither branch conflicted here — both had independently solved "get the ONNX Runtime wasm
into the package", and the merge kept both mechanisms. The first build of the merged tree
produced a **161 MB `dist/`** against the <100 MB budget §9k recorded at 16 MB:

| Copy | Source | Size | Consumer |
| --- | --- | --- | --- |
| `dist/ort/` | `copy-onnx-assets` plugin, from `node_modules` (all variants) | 80 MB | `faceBlur.ts` (`wasmPaths = getURL('ort/')`) |
| `dist/models/ort-wasm-simd-threaded.jsep.*` | committed into `extension/public/models/`, copied verbatim by `publicDir` | 27.8 MB | `vision-onnx.ts` (`VISION_WASM_DIR = 'models/'`) |
| `dist/assets/ort-wasm-simd-threaded.jsep-*.wasm` | emitted by the bundler following ORT's own `new URL(…)` reference | 27.8 MB | nothing — both consumers override `env.wasm.wasmPaths` before creating a session |

Fixed by converging both ONNX consumers on the single generated directory:
`VISION_WASM_DIR` is now `'ort/'`, and the two committed ORT binaries were deleted from
`extension/public/models/` after confirming they are **byte-identical** (sha256) to
`node_modules/onnxruntime-web/dist/`, so nothing unique was removed. `NOTICE.txt` was
corrected accordingly — it claimed the ORT binaries sit "beside" the model. The 12 MB
`icon-detect-640.onnx` stays committed: it has no npm source, and
`tests/integration/vision-model.test.ts` reads it from that path.

`dist/` is now **135 MB**. The remaining 27.8 MB bundler copy is unused at run time but
removing it needs build surgery around ORT's static wasm reference, and even at ~107 MB
the tree would still be over budget — see the limitations below. _(Route (a) below was
subsequently measured and taken: **82 MB**, §9r.)_

### E2E parallelism: one reproducible failure, root-caused

`npm run e2e` on the merged tree failed `visual-perception.spec.ts:65` ("does not skip a
large undescribed canvas") on **2 runs out of 2** at unbounded local parallelism, while the
same test passed when its spec file ran alone. The signature — the Run-Visual-Check button
present at click, then `element(s) not found` 10 s later — is the panel page being killed,
the failure mode `1eb5849` already documented for CI ("parallel Chromium profiles crash
pages"). The merge made it reach local runs too: every profile now loads BlazeFace, the
OmniParser model and the Tesseract core.

Measured: `--workers=2` with **no retries** → 24/24, at no wall-clock cost (38.2 s vs
35.9 s — these tests are inference-bound, not scheduling-bound). `playwright.config.ts`
therefore caps workers at 2 everywhere instead of CI-only. Retries stay CI-only so a local
failure is never masked.

### Verified gate results (merged tree, 2026-09-05)

| Gate | Command | Result |
| --- | --- | --- |
| Typecheck | `npm run typecheck` | ✅ pass (0 errors) |
| Lint | `npm run lint` | ✅ pass (0 errors) — re-run with `dist-firefox/` present |
| Unit + integration | `npm test` | ✅ **409 / 409** (40 files) |
| Bench | `npm run bench` | ✅ 3 / 3 golden gates |
| Build | `npm run build` | ✅ pass |
| E2E | `npm run e2e` | ✅ **24 / 24** (10 specs) — at the capped worker count |
| Firefox transform | `npm run build:firefox` | ✅ valid `dist-firefox/` |
| Backend | `pytest -q` (backend/fastapi) | ✅ **20 / 20** |
| Lightweight | `du -sh dist` | ⚠️ **135 MB** — OVER the <100 MB budget (resolved in §9r: **82 MB**) |

The unit and backend totals are the union of both branches plus what each added after its
own section was written (409 = 342 + `integrate-f`'s vision tests; 20 = 19 + the
`test_plan.py` case `f70079d` added), so neither branch's recorded figure is now current.

**Environment note (honest):** `pytest` in the ambient Python 3.14 env could not import
`google.genai` (6 collection failures in `test_gemini_provider.py`, all
`ModuleNotFoundError`), because `google-genai>=1.0` — added by §9m — was not installed.
Ran in a throwaway venv OUTSIDE the repo (`~/.privagent-venv`) from
`backend/fastapi/requirements.txt` → 20/20. Nothing was installed globally and no repo
file was added, deliberately: a previous global install of these requirements upgraded
`starlette`/`uvicorn` past what an unrelated `platformio` pins (noted in §9k).

### Known limitations

- **The <100 MB `dist` budget is breached (135 MB) and no unilateral fix is honest.** The
  three ways down each cost something a merge resolution should not decide alone:
  (a) drop the `asyncify` (25.7 MB) and `jspi` (16 MB) ORT variants → ~93 MB, but §9l's
  defect #1 was a partial ORT copy failing at run time with a "dynamically imported
  module" error, so this needs per-variant evidence, not reasoning;
  (b) stop the bundler emitting its unused 27.8 MB copy → ~107 MB, still over;
  (c) ship one ONNX feature instead of two. **Decision needed.**
  → **CLOSED by §9r**: route (a) was taken after gathering exactly the per-variant
  evidence this bullet demanded (three independent derivations plus a live-browser fetch
  observation). `dist/` is **82 MB** with both execution paths re-verified in a real
  browser. Routes (b) and (c) were not needed and nothing was dropped from the product.
- Both ONNX models now load in the same panel context (BlazeFace pre-OCR, OmniParser for
  region detection). Their combined peak memory has not been instrumented — the e2e
  contention above is the only measurement, and it is a symptom, not a number.
- The merge is resolved and staged but **not committed**; §9l/§9m/§9n's own limitations
  (no live Gemini key in CI, no human Chrome click-through, Firefox not run in a real
  browser) are unchanged and still open.

---

## 9r. Post-merge audit — size budget met, licenses traced (2026-09-05)

_A full audit of the merged tree (§9q) against the architecture rules, the <100 MB budget
and the provenance of every shipped binary. **One source file changed:** `vite.config.ts`.
Everything else in this section is measurement or documentation. The merge is still
resolved-and-staged, still not committed._

### Size: 135 MB → **82 MB** (PASS, <100 MB)

The §9q limitation demanded "per-variant evidence, not reasoning" before pruning ORT
variants. Three independent derivations were gathered, and they agree:

1. **Package exports.** A browser `import 'onnxruntime-web'` resolves to
   `dist/ort.bundle.min.mjs`. String-extracting that file yields exactly two ORT asset
   names — `ort-wasm-simd-threaded.jsep.{wasm,mjs}` — and no variant-selection logic. The
   `asyncify` / `jspi` / base binaries are referenced only from the `ort.jspi.*` and
   `ort.all.*` entry points, which nothing in this repo imports (the only
   `onnxruntime-web` importers are `providers/vision-onnx.ts` and `faceBlur.ts`, both bare
   specifiers).
2. **Bundler agreement.** Rolldown follows that same file's
   `new URL('ort-wasm-simd-threaded.jsep.wasm', import.meta.url)` and emits ONLY the jsep
   variant into `dist/assets/` — never asyncify, jspi or base.
3. **Live browser observation.** A Chromium probe over the built extension, importing the
   emitted `assets/ort.bundle.min-*.js` chunk via `chrome.runtime.getURL`, fetched only
   those two files while creating sessions for BOTH models.

| ORT variant in `node_modules` | Size | Shipped? | Why |
| --- | --- | --- | --- |
| `ort-wasm-simd-threaded.jsep.wasm` | 26.51 MB | **YES** | the only `.wasm` the imported entry point names; JSEP *is* the WebGPU EP **and** the same artifact runs the wasm/CPU fallback |
| `ort-wasm-simd-threaded.jsep.mjs` | glue | **YES** | dynamically imported as a sibling module — dropping it is exactly §9l defect #1 |
| `ort-wasm-simd-threaded.asyncify.wasm` | 24.56 MB | no | unreachable: named only by `ort.all.*` |
| `ort-wasm-simd-threaded.jspi.wasm` | 15.28 MB | no | unreachable: named only by `ort.jspi.*` |
| `ort-wasm-simd-threaded.wasm` (base) | 13.32 MB | no | unreachable from this entry point; shipping *this instead of* jsep is what broke in §9l |

`vite.config.ts` now copies an explicit two-file allowlist and **throws at build time** if
`onnxruntime-web` ever stops shipping those names, so an ORT upgrade that renames the
variant breaks the build rather than the extension. −53.16 MB → `dist/` = **82 MB**.

Nothing was removed from the product to get there: no WebGPU, no WASM/CPU fallback, no
Firefox support, no model, no feature. Routes (b) and (c) from §9q were not needed.

**Final `dist/` composition (82 MB):**

| Directory | Size | Contents |
| --- | --- | --- |
| `dist/assets` | 28 MB | app chunks (panel 250 kB, `ort.bundle.min-*.js` 402 kB) **+ the 27.8 MB bundler-emitted jsep duplicate** — still inert, still not fetched (both consumers set `wasmPaths` first). Removing it needs surgery around ORT's static `new URL()` and is no longer needed for the budget |
| `dist/ort` | 27 MB | the jsep pair — the copy both ONNX consumers actually load |
| `dist/ocr` | 16 MB | Tesseract worker + **both** wasm cores + `eng.traineddata.gz` |
| `dist/models` | 13 MB | `icon-detect-640.onnx` 11.68 MB + `blazeface.onnx` 0.54 MB |

**Both Tesseract cores are correctly retained — this is the opposite of the ORT case.**
`worker.min.js` picks the core filename at run time from a real capability probe
(`WebAssembly.validate` on a SIMD module →
`"/tesseract-core-simd-lstm.wasm.js"` : `"/tesseract-core-lstm.wasm.js"`), and
`tesseract.ts` passes only the core DIRECTORY, so the worker resolves the name itself.
Both are reachable; dropping the non-SIMD core would break every non-SIMD environment.
The pruned ORT variants were unreachable — reachability, not size, was the criterion.

### Both execution paths re-verified in a real browser (Rule 13)

Pruning to one binary raises exactly one question worth answering empirically: does the
single artifact still serve WebGPU *and* the CPU fallback? Measured in headless Chromium
over the built extension, not argued:

| Probe | Result |
| --- | --- |
| WebGPU available | `hasWebGPU: true`, `adapter: "available"` |
| OmniParser, probe passed `['webgpu','wasm']` | `omniparser_webgpu: "ok outputs=1"` |
| OmniParser, probe passed `['wasm']` | `omniparser_wasm: "ok outputs=1"` |
| BlazeFace session create on wasm | created (inference itself needs the graph's `conf_threshold` feed, which the probe omitted — the real path is covered green by `face-detection.spec.ts`) |

**What that first OmniParser row does and does not prove.** It proves the single artifact loads
and produces an output tensor when WebGPU is requested. It does **not** prove the graph ran on
the GPU: a two-entry EP list is exactly the case where ORT may fall back to wasm internally and
report nothing about it. The provider has since been changed to attempt **one EP per session**
(`backendAttempts` → `['webgpu','wasm']`, `executionProviders` → a single entry each), so the
successful attempt now *is* the EP in use and a refusal surfaces as `VISION_BACKEND_REJECTED`.
The row above is kept as the historical probe result, read with that caveat; the EP the detector
actually runs on is now reported per run in `benchmark/reports/visual-performance.md`.

### License provenance — every shipped binary traced to a primary source

Written up in full in `extension/public/models/NOTICE.txt` (rewritten this session from
one artifact to all four). Summary:

| Artifact | Direct source of the shipped bytes | License | Redistribution |
| --- | --- | --- | --- |
| `icon-detect-640.onnx` | `onnx-community/OmniParser-icon_detect_640x640` @ `799bd041b5d053ed44651c2237ced04d8fdb2777` — **declares no license** | **AGPL-3.0**, from `microsoft/OmniParser` `icon_detect/` | ⚠️ **obligation undischarged** |
| `blazeface.onnx` | byte-identical (sha256 `564740c5…`) to `manthi4/End-to-end-BlazeFace-Onnx` — **`license: null`** | model is Apache-2.0 upstream (MediaPipe); **these bytes carry no grant** | ⚠️ **unresolved; cheap fix available** |
| `ort/ort-wasm-simd-threaded.jsep.*` | `onnxruntime-web` 1.29.0 | **MIT** | ✅ fine |
| `ocr/*` | `tesseract.js` 6.0.1 + `tesseract.js-core` 6.1.2 + tessdata `eng` | **Apache-2.0** | ✅ fine |

Two findings worth stating plainly:

- **The AGPL is intrinsic, not a labelling error.** `icon_detect` is a fine-tuned
  Ultralytics YOLOv8 and `ultralytics/ultralytics` is itself AGPL-3.0. The model card body
  says verbatim "icon_detect model is under AGPL license" and `icon_detect/LICENSE` is the
  complete unmodified AGPL v3. The repo-level frontmatter `license: mit` is not a
  contradiction to resolve — the card scopes licenses per directory (BLIP2/Florence
  captioners *are* MIT). A re-export grants no rights the weights lack, which is why the
  unlicensed onnx-community intermediary changes nothing. Consequence: any permissive
  replacement must be checked at the FRAMEWORK level — a "YOLOv8"/"YOLO11"/"YOLOv5"
  derivative inherits Ultralytics AGPL whatever its model card advertises, so candidates
  previously recorded as "MIT" (e.g. `laywens/uitag-yolo11s-ui-detect-v1`) are NOT safe on
  that basis. A genuine alternative needs a non-Ultralytics architecture (DETR/RT-DETR, or
  an Apache-2.0 YOLOS variant — and §9p already measured YOLOS-tiny and rejected it on
  accuracy). This is a licensing decision for the project, not a file swap.
- **BlazeFace is the cheap one.** `scripts/fetch-blazeface.sh` already lists MIT-licensed
  `PINTO0309/PINTO_model_zoo` as its PRIMARY source; the committed bytes came from the
  FALLBACK. Re-fetching from the primary and replacing the file resolves it with no code
  change, provided the `[1,3,128,128]` input and graph-baked threshold/NMS contract hold.

`extension/src/perception/visual/models/README.md` claimed `blazeface.onnx` is "NOT
committed — fetch via `scripts/fetch-blazeface.sh`". It **is** committed (staged `A` in
this merge), which turns a developer-fetch into redistribution; corrected.

### Rules and flow re-verified by tracing execution (not file existence)

DOM-first gate → visual only on insufficiency (`service.ts:174`); bounded multi-region
with below-fold bands; OmniParser remains the GENERAL UI detector and BlazeFace a
SPECIALIZED pre-OCR complement — both run over the same raster in a fixed order
(`service.ts:316` vision → `:326` face blur → `:336` OCR/content analyzer), so neither
replaced the other in the merge; Tesseract still owns text; M6 decides what crosses; the
firewall is the sole egress gate; Chromium and Firefox both build.

**One architectural gap, pre-existing and already on the roadmap:** M3 visual findings
reach M4/M5 on the **scan** path (`App.tsx:113` passes `visual` into `PolicySignals`) but
not on the **agent** path (`loop.ts:186` passes `entities` + `visualContext` only, and
`AgentLoopOptions` has no visual dependency). No raw data escapes either way — no pixels
are ever sent — but during agent execution a page whose only PII is painted inside an
image is less protected. This is item 3 of §11 ("Loop hardening"), recorded since §9f, and
the merge neither caused nor worsened it. Left as-is deliberately: wiring perception into
the loop is a feature change, not an audit fix.

### Gates (re-measured after the pruning, 2026-09-05)

| Gate | Command | Result |
| --- | --- | --- |
| Typecheck | `npm run typecheck` | ✅ pass |
| Lint | `npm run lint` | ✅ pass |
| Unit + integration | `npm test` | ✅ **409 / 409** (40 files) |
| Bench | `npm run bench` | ✅ 3 / 3 golden gates |
| Build | `npm run build` | ✅ pass |
| E2E | `npm run e2e` | ✅ **24 / 24** in 28.4 s — incl. real-face detect+blur, both visual-accuracy canvas specs, undescribed-canvas OmniParser |
| Firefox transform | `npm run build:firefox` | ✅ valid `dist-firefox/` (82 MB), gecko id + `sidebar_action` correct |
| Backend | `pytest -q` (throwaway venv, as §9q) | ✅ **20 / 20** |
| Lightweight | `du -sh dist` | ✅ **82 MB** (<100 MB) |

Conflict-marker sweep across the whole repo: clean. The single `=======` hit is the
heading underline at `NOTICE.txt:2`. No unmerged paths; no code references either ORT file
deleted in §9q. Remaining stale references were documentation-only and are fixed here
(`PROJECT_STATUS.md` §00.5/§9l/§9q pointers) or noted for docs (`docs/m3-visual-perception.md:206`).

---

## 11. Next milestone

**M0–M8 are COMPLETE and verified** (M6 §9f, M7 §9g, telemetry dashboard §9h, visual
accuracy §9i, below-fold/navigation/repo organization §9j, gate re-verification §9k,
M7.5 face detection + page classifier §9l, M8 Gemini Flash provider §9m and its side-panel
toggle §9n, M3 model gate §9p — decision: no detector model ships). M7.5 and M8 arrived on
this branch by merge; the gate figures that cover them all together are §9q's, measured on
the merged tree.
The two integration points left open by §9c are closed: the loop assembles a
`RemoteAgentRequest` from `enforcePrivacy` output, and every outbound payload passes the
fail-closed firewall (`extension/src/firewall/inspect.ts`).

Items previously listed here as follow-ups and now DONE: M7 telemetry + leakage sentinel
(§9g/§9h), planner-driven SCROLL for below-fold controls and allowlisted-navigation e2e
coverage (§9j).

The next milestone is **not started** and, per CONTRIBUTING.md §24, will not begin until
explicitly requested. Remaining work, in rough order:

1. **Model licensing decision (§9r)** — now the top item, and it is a project decision, not
   an engineering task. `icon-detect-640.onnx` is AGPL-3.0 by lineage (fine-tuned
   Ultralytics YOLOv8) and this repo declares no license. Either accept AGPL-3.0 for the
   distribution, or replace the detector with a non-Ultralytics architecture — checked at
   the framework level, since YOLO-family model cards advertising MIT are unreliable
   (§9r), and §9p already rejected YOLOS-tiny on measured accuracy. Separately and much
   cheaper: re-fetch `blazeface.onnx` from the MIT PINTO source that
   `scripts/fetch-blazeface.sh` already lists as primary, replacing bytes that currently
   come from an unlicensed mirror.
2. **S4 — remote provider adapter:** Ollama (`qwen2.5vl:7b`) behind
   `AGENT_PROVIDER=remote` (the loud 501 seam in `backend/fastapi/app/agent.py`),
   JSON-schema-constrained actions, retries/timeouts; e2e against the live backend.
   No longer the largest gap: §9m/§9n put a real model (Gemini Flash) on the planning
   path, so this is now about a LOCAL model option rather than about having any model.
3. **Loop hardening:** feed M3 visual/OCR findings into PER-STEP enforcement (they are
   scan-time only today, so a page whose sensitive data lives only in images is
   filled blank — §9f); add visual-only pages to the task-success metric.
4. **Detection depth:** contextual/NLP sensitivity for free-text values with no label
   and no pattern (the documented boundary in `docs/benchmark.md`).
5. **Platform/manual verification:** human Chrome click-through of live capture; Firefox
   run via `web-ext run --source-dir dist-firefox` (Playwright cannot load Firefox
   extensions); CPU/GPU/RAM instrumentation for rubric #4 — now also the honest way to
   answer §9q's uninstrumented two-model memory question.
6. **Navigation settle:** replace the loop's fixed 600 ms post-NAVIGATE delay with a wait
   for the observed origin to change, removing the load-dependent `NO_PROGRESS` flake
   documented in §9o.