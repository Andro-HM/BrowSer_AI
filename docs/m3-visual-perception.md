# M3 — Lightweight Local Visual Perception

Status: implemented, including the local vision model. Last updated 2026-09-04.

This document records what M3 does, what it deliberately does **not** do, which local model
ships and why, and the exact place OCR and the ONNX detector plug in.

- §1–§4 — purpose, pipeline order, content-driven decision, privacy invariants
- §5 — the two engine seams and how production wires them
- §6–§8 — measured cost, test coverage, honest limitations
- §9 — the FIRST model gate: YOLOS-tiny measured and **rejected**
- §10–§13 — the model that **ships** (OmniParser `icon_detect`), its real-inference
  evidence, the unresolved license question, and WebGPU verification

---

## 1. What M3 is for

M3 supplies **local visual observations** that M4 (multimodal fusion) can consume when the
DOM alone is not enough. It answers three questions about a bounded screen region:

- does information appear to live here that the DOM cannot describe?
- what kind of information does it look like — text-like, graphic, or empty?
- **where inside the region are the separable interactive elements?** (the model, §10)

M3 is **not** the sensitive-data detector. It does not classify PII, does not decide
sensitivity, and does not transcribe text.

---

## 2. Pipeline order

The ordering is enforced in `service.ts` and is the whole point of the design — each step
exists to avoid doing the next, more expensive one.

| # | Step | Module | Exit status if it stops here |
|---|------|--------|------------------------------|
| 1 | Restricted-page check | `restricted.ts` | `restricted_page` |
| 2 | DOM-first sufficiency | `decision.ts` | `not_required` |
| 3 | Capability check | `capability.ts` | `unavailable` |
| 4 | Bounded region select | `regions.ts` | `not_required` |
| 5 | Capture + crop (visible viewport, then ≤ `MAX_CAPTURE_BANDS` below-fold bands) | `../screenshot`, `raster.ts` | `unavailable` |
| 6 | Unchanged-region cache | `cache.ts` | — (serves cached labels) |
| 7a | Lazy provider analysis — pixel-stats label **+ local ONNX element boxes** | `providers/` | `completed` |
| 7b | Content analysis — local Tesseract OCR | `content-analyzer.ts` | `completed` |

Step 2 is the common case. On an ordinary text page the pipeline performs **no capture, no
rasterization, loads no provider, and never touches the 11.68 MB graph** — asserted directly by
`tests/integration/vision-model.test.ts` (`loads === 0`).

### Where each part runs

An MV3 service worker has no document, no canvas and no WebGPU, so it cannot rasterize or
analyse. Therefore:

- **Background worker** (`background/visual-messages.ts`) — brokers cheap DOM metadata only.
- **Side panel** (`sidepanel/VisualStatus.tsx`) — owns capture, cropping and analysis, because
  it is a document context.

Messaging reuses the existing `chrome.runtime.onMessage` channel with a `type` discriminator
(`COLLECT_VISUAL_CANDIDATES`), added as a second listener so M1's worker code stays untouched.
No new transport was introduced.

---

## 3. Content-driven, not website-driven

There is **no site list** anywhere in the decision path. `decision.ts` never looks at the URL.
It uses only structural facts:

- a candidate qualifies when it is ≥ 32 px on both edges, ≥ 64×64 px in area, has no
  `alt`/`aria-label`/`title`, and exposes no inner text;
- a text-sparse page (< 200 chars) whose candidates paint ≥ 15 % of the viewport qualifies via
  the painted-area fallback (this is what catches canvas/WebGL-rendered apps).

`restricted.ts` *does* contain a short host/scheme list. That is a **browser capability check**,
not a content policy: those are surfaces where the browser forbids extension scripting and tab
capture outright, so behaviour there cannot differ by choice. It is also fail-closed — an
unparseable or unreadable URL counts as restricted.

---

## 4. Privacy properties

| Invariant | How it is enforced |
|-----------|--------------------|
| Raw visual data stays local | Captures and rasters live only in `service.ts` locals; nothing returns them |
| **Model inference is local** | The graph and the ORT wasm are bundled extension assets; `wasmPaths` points at `models/`, never a CDN. No weights are fetched, no pixels are uploaded |
| No raw data in results | `VisualObservation` carries labels, geometry, confidence, element boxes — no pixels, no text |
| No logging of visual data | Zero `console.*` statements in `perception/visual/**`, asserted by a source scan test; model diagnostics go through `ocr-trace.ts`, whose `SafeDetail` type admits only `number \| boolean \| string \| undefined` |
| No network egress | Nothing in the pipeline performs remote I/O; the only `fetch` is a `data:` URL decode |
| Bounded exposure | ≤ `MAX_REGIONS` (8) regions/run, ≤ `MAX_ELEMENTS_PER_REGION` (24) boxes/region, one capture per band |
| Cache holds no pixels | Only a 32-bit digest + derived labels |
| M3 additions stay internal | The M4/M5 handoff test asserts the serialized enforcement result contains no `ui_elements`, no `"elements"`, and not the model name |

Verified by `tests/integration/visual-leakage.test.ts`. Those assertions were
**mutation-tested**: injecting a `console.log` of the capture, and placing capture bytes into
the result, each caused the expected failures.

`chrome.tabs.captureVisibleTab` only returns whole visible tabs — Chrome has no partial-capture
API. Cropping therefore happens immediately after decode in `raster.ts`, and the full capture is
never handed to a provider.

---

## 5. OCR / model integration point

**Two independent seams, both now filled by real bundled local engines.** They answer
different questions and neither replaces the other.

| Seam | Registry | Status |
|------|----------|--------|
| Content analysis — WHAT TEXT the pixels contain | `content-analyzer.ts` | **Tesseract.js (bundled, local)** — M7 |
| Element localization — WHERE separable elements are | `providers/registry.ts` | **OmniParser `icon_detect` ONNX (bundled, local)** — see §10 |
| Coarse structural label for a region | composed inside the vision provider | `pixel-stats` heuristic (unchanged) |

### Why the detector must be bundled

- MV3 forbids remote code, so a model **and** its runtime ship as extension assets:
  `extension/public/models/icon-detect-640.onnx` (11.68 MB) plus the ORT jsep wasm.
- Fetching weights at runtime would add an outbound network path to a privacy-critical
  extension (threat model R11). Nothing is fetched; `wasmPaths` points at bundled files only.
- The first candidate detector was **measured and rejected** (§9). The one that ships was
  measured too (§11) — the difference is evidence, not preference.

### The three layers, and what each is allowed to claim

`providers/pixel-stats.ts` — dependency-free analyzer over actual pixels (luminance variance,
horizontal edge density, row-brightness transitions) returning a coarse structural label with
confidence capped at **0.75**. The vision provider takes this observation as its base and
**adds** geometry to it, so the label M4 already consumed is unchanged.

`providers/vision-onnx.ts` — the local ONNX detector. Contributes `elements[]` (boxes +
confidence, in viewport CSS pixels) and the `ui_elements` marker, and **only** when the model
genuinely returned something. Single-class model ⇒ no class name is reported, because there is
none to report.

**DOM candidate geometry** still supplies the regions themselves; **Tesseract's word/line
boxes** still supply WHERE + EXACT TEXT inside a region (`wordsFromResult`,
`perception/ocr/tesseract.ts`).

### How the seams are wired in production

`sidepanel/main.tsx` calls `installVisionEngine()` and `installOcrEngine()` — the only two
places either engine is installed. Both register a **factory**, so registering costs nothing
and the heavy artifacts load on first genuine need:

```ts
// extension/src/perception/register-vision.ts
registerVisualProvider(
  async () => {
    const module = await import('./visual/providers/vision-onnx'); // lazy chunk
    return module.createVisionOnnxProvider();
  },
  { analysisEdge: VISION_INPUT_EDGE }, // the graph's static 640 input; see §11
);
```

The registration carries `analysisEdge` because a provider must be able to state the raster
size it needs: at 192 px this model returns **zero** elements (§11). The service takes the
maximum of the OCR budget and the provider's declared edge, so one raster serves both.

```ts
// extension/src/perception/register-ocr.ts — unchanged by the vision work
registerVisualContentAnalyzer(async () => createTesseractContentAnalyzer());
```

With nothing registered, both seams are inert: `resolveVisualProvider()` yields the
pixel-stats analyzer and `recognize()` returns `[]`.

> The earlier scaffold returned a hard-coded `'Sample OCR Text'` for any input. M3 removed it.
> Fabricated transcription would become fabricated evidence for M4's sensitivity decisions and
> could mask a real leak. `tests/unit/ocr.test.ts` asserts that string can never come back.

**Anything registered here inherits the privacy obligations:** model and OCR output are derived
from page pixels and must be treated as raw protected content — local only, never logged, and
never placed on a remote payload without sanitization and the privacy firewall (M5/M7).

---

## 6. Measured cost

From `npm run build` (real output, before → after M3):

| Artifact | Before | After | Δ |
|----------|--------|-------|---|
| Side panel chunk | 191.21 kB | 201.41 kB | +10.20 kB |
| Side panel (gzip) | 60.32 kB | 63.88 kB | +3.56 kB |
| Service worker | 0.51 kB | 2.02 kB | +1.51 kB |
| `pixel-stats` (lazy chunk) | — | 1.49 kB | new, on-demand |
| Total `dist` | 200.28 kB | 214.87 kB | +14.59 kB |

No new npm dependency; no model downloaded. The separate `pixel-stats` chunk is the build
proving laziness — the analyzer is not in the panel's initial bundle.

> These figures are the original M3 build, before Tesseract.js and before the detector. The
> current measured `dist/` total is **80.43 MB** (26.51 MB ORT wasm ×2 — one bundled copy plus
> one Vite-emitted copy that runtime never fetches — 11.68 MB detector, ~15.3 MB Tesseract core
> + language data, ~0.7 MB app). Detector-attributable chunks from the current build:
>
> | Chunk | Size | When it loads |
> |---|---|---|
> | `assets/vision-onnx-*.js` | 2.78 kB | first region needing pixels |
> | `assets/pixel-stats-*.js` | 1.49 kB | with the vision chunk |
> | `assets/ort.bundle.min-*.js` | 402.91 kB | first session create |
> | `ort/ort-wasm-simd-threaded.jsep.wasm` | 26.51 MB | first session create |
> | `models/icon-detect-640.onnx` | 11.68 MB | first session create |
>
> Removing the vision re-export from the `perception/visual` barrel moved the detector out of
> the panel chunk (253.71 → 250.14 kB) and silenced rollup's `INEFFECTIVE_DYNAMIC_IMPORT`
> warning — the build itself now proves the model is lazy.
>
> Layout note: the ORT wasm moved from `models/` to `ort/` when both ONNX consumers converged
> on one runtime copy (PROJECT_STATUS §9q), and only the `jsep` variant now ships (§9r). After
> BlazeFace and the ORT-variant prune the current total is **82 MB**; see §9r for the
> per-variant reachability evidence and the full `dist/` composition.

Runtime cost is bounded by construction: ≤ `MAX_REGIONS` (8) regions per run, one capture per
band (visible viewport + ≤ `MAX_CAPTURE_BANDS` below-fold bands), each region downscaled to
≤ 192 px on its longest edge — or, when an OCR engine is registered, resampled into the
1024/512 px legibility band (`OCR_ANALYSIS_EDGE` / `OCR_MIN_ANALYSIS_EDGE`, upscaling capped at
`MAX_UPSCALE` = 4) — and unchanged regions skipped entirely by pixel digest.

---

## 7. Test coverage, and what is not yet verified

Executed and green (see PROJECT_STATUS.md for current numbers):

- `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, `npm run e2e`.
- The M3 suites: `tests/unit/visual-{regions,decision,restricted,provider,coords,bands}.test.ts`,
  `tests/unit/visual-content-analyzer.test.ts`, and
  `tests/integration/visual-{perception,content-findings,leakage,belowfold}.test.ts`.
- The detector suites: `tests/unit/vision-decode.test.ts` (19 tests, hand-computed letterbox /
  NMS / un-letterbox arithmetic), `tests/unit/vision-provider.test.ts` (16 tests, lifecycle and
  failure paths against an injected runtime), and **`tests/integration/vision-model.test.ts`
  (9 tests, the REAL 11.68 MB graph through the REAL ORT wasm runtime — no mocked inference)**.

> The original M3 write-up recorded E2E as "written but never executed" because Chromium could
> not be spawned in the dev environment. That blocker is gone — the suite runs. Do not trust
> the old sentence; run the gates.

Still open, and honestly so:

1. **`captureVisibleTab` from the side panel** needed a fix, not a workaround: the panel's own
   `WINDOW_ID_CURRENT` (-2) does not resolve to the page's window, so capture is brokered
   through the background worker with the tab's real `windowId` (`sidepanel/capture.ts`).
   Genuine refusals (PDF viewer, protected content) still degrade to
   `unavailable` / `VISUAL_CAPTURE_UNAVAILABLE` with the browser's own diagnostic surfaced.
2. **No labelled-dataset accuracy figure** for either the pixel-stats structural labels or the
   detector's boxes. What exists is measured behaviour on this project's own surfaces (§11):
   box counts, scores, latency, an anti-fabrication control on blank pixels, and EP parity.
   Neither mAP nor precision/recall against ground-truth UI annotations is claimed.
3. **WebGPU is unverified in Node** — it needs a real adapter, so the automated suite exercises
   the wasm EP only. The WebGPU path was measured separately in a headed Chromium (§13).

---

## 8. Limitations (honest)

- **The structural provider reads no text.** `text_like_content` means "looks like rendered
  text", not "contains X". Reading text is Tesseract's job, through the separate
  content-analyzer seam.
- **Heuristic, unbenchmarked accuracy.** No accuracy figure is claimed for the pixel-stats
  labels; no labelled dataset was used. Confidence is capped at 0.75 to reflect this.
- **The detector localizes, it does not name.** OmniParser `icon_detect` has exactly ONE class
  ("interactable element"), so `elements[]` carries geometry and a score and nothing else. It
  cannot say "this is a credential field", and no such label is invented from it (§10).
- **Detector latency is real.** ~87–650 ms per region on the wasm EP, plus a one-time
  ~1.2–1.4 s session create; ~87–110 ms per region on WebGPU after a ~300 ms create (§11, §13).
  On a page with 8 targeted regions the wasm path is the dominant cost of a scan.
- **Bounded below-fold coverage, not full-page.** `captureVisibleTab` sees only the visible
  viewport, so below-fold images are covered by at most `MAX_CAPTURE_BANDS` scroll-and-capture
  bands, and only when a `scrollViewport` dependency is injected. Regions outside those bands
  are not analysed and are never reported as if they were. Cross-origin iframe interiors are
  opaque to the DOM collector, and DRM/protected video may capture black.
- **A provider that cannot start yields `unavailable`,** not a guess: the run reports
  `visual_provider_unavailable` with the sanitized load error and zero observations.
- **Not universal.** Chromium (Chrome/Edge/Brave) is the target. Firefox needs MV3 + `sidePanel`
  review; Safari is a separate port. No cross-browser claim is made beyond capability detection
  and graceful degradation.
- **Restricted surfaces are genuinely unsupported**, not worked around.
- **Scroll-dependent region ids.** Region identity includes viewport coordinates, so scrolling
  changes ids and forfeits cache reuse. Acceptable for now; revisit if it costs measurable work.
- **Concurrency is rejected, not queued.** An overlapping `run()` returns `running` rather than
  waiting.

---

## 9. Model gate — YOLOS-tiny evaluated on real inference, then REJECTED

**Decision: REJECT.** A bundled ONNX detector (`hustvl/yolos-tiny`, 26.2 MB fp32) was
implemented end-to-end, measured with real inference on real pixels, and removed. The generic
provider interfaces it exercised were kept, so a future feasible detector needs no call-site
change.

### Method (no mocks)

A scratch harness rendered a realistic chat-UI fixture in Chromium, ran **this project's own
shipped code** over it — `collectVisualCandidatesInPage` → `decideVisualPerception` →
`selectRegions` → `analysisScale` → `preprocess` → `decodeDetections` — and then ran the real
bundled ONNX graph over the resulting region rasters: in Node (ORT WASM/CPU) and in a headed
Chromium on `http://localhost` (ORT WebGPU, then WASM). A **control experiment** ran the same
model file and the same project code over a real COCO photograph.

### Results

| Check | Result |
|-------|--------|
| Model loads | ✅ session create 409–453 ms (Node WASM) |
| Real inference | ✅ 333–381 ms per region (Node WASM) |
| WebGPU | ✅ `create 1814 ms · cold 1576 ms · warm 123 ms` (real adapter, secure context) |
| WASM/CPU fallback | ✅ `create 494 ms · cold 373 ms · warm 347 ms` |
| Real boxes + confidences | ✅ non-degenerate on photographs |
| EP parity | ✅ WebGPU and WASM returned identical top-5, matching Node |
| Multiple regions | ✅ **8 regions** selected from 14 candidates (`visual_only_content_present`) |
| Useful on browser UI | ❌ see below |

**Control (proves the code is correct):** on a 810×1080 COCO photo the pipeline returned
`person 1.00, bus 1.00, person 1.00, person 0.99, bus 0.99` with sensible boxes. Preprocess,
letterbox, softmax, and box decode are therefore **correct** — the UI outcome is a
domain-transfer limit, not a bug.

**On browser UI surfaces the same model is useless:**

| Region (ground truth) | Model's top classes |
|---|---|
| 48 px avatar | `cup 0.78`, `stop sign 0.74`, `frisbee 0.21` |
| photo canvas (laptop + person) | `stop sign 0.89` (person only 0.08) |
| terminal screenshot containing `API_KEY=…` | `microwave 0.69` |
| receipt canvas containing a card number | `cell phone 0.59`, `book 0.28` |
| sticker | nothing (`airplane 0.01`) |

Kept boxes were whole-region or degenerate (e.g. `[7,2,626,632]` of a 640×640 raster), and
detections appeared at input edge 320 yet vanished at 512 — so it is **not** a resolution
problem. After the project's honest COCO→UI collapse (`labelForClass`), 7 of 8 kept labels were
the information-free `visual_element`.

### Why that is disqualifying

1. Its boxes cannot drive targeted OCR — they reproduce the rectangle the DOM already gave us.
2. Its labels carry zero UI information once COCO names are not fabricated into UI claims.
3. Cost: 26.2 MB weights + 27.8 MB ORT WASM ≈ **54 MB**, and ~350 ms × 8 regions ≈ **2.8 s**
   per run on the WASM path — paid for nothing.

### Alternatives evaluated, and why each was rejected

| Candidate | Verdict |
|---|---|
| ScreenParser (YOLO11-L @1280, 55 web-UI classes, Apache-2.0) | Right domain, **no ONNX artifact and no small variant** |
| UI-DETR-1 / CU-1 (RF-DETR-M @1600, MIT) | **`model.pth` only**, malformed config, 2,656 training images |
| wedetect-tiny-onnx | 317 MB and **GPL-3.0** |
| OmniParser `icon_detect` | AGPL, and **no Microsoft-published ONNX** — but a community ONNX export exists; re-examined in §11, and it is what ships |
| `windows-ui-synth` (YOLO11s, MIT repo) | **`.pt` only**, Windows-desktop domain, synthetic-only validation |
| MobileNetV3-small GUI classifier | Classifier, not a localizer — barred as a standalone detector |
| GUIrilla-See-0.7B / GoClick 230M / pix2act | Far over budget or wrong task |
| TinyCLIP / CLIP-family | Global image-text similarity gives no per-element boxes |

Also recorded: ORT-Web's WebGPU EP rejects `AveragePool ceil_mode=1`, a real portability hazard
for CNN exports.

### What this gate settled

Not "no detector" — **not that detector**. A COCO-domain object detector cannot describe browser
UI, and the provider/registry seam it exercised was kept precisely so a *UI-domain* detector
could be dropped in without touching call sites. §10 is that detector; §11 is its evidence.
The one line of the earlier write-up that is now wrong is the claim that nothing ships: the
`onnxruntime-web` dependency, `providers/vision-onnx.ts`, `register-vision.ts` and
`extension/public/models/` are all back, and `VisualObservation.elements` is back in the
contract with a real producer.

---

## 10. The detector that ships — OmniParser `icon_detect` (ONNX)

| Property | Value |
|---|---|
| Model | OmniParser v1 `icon_detect` — YOLOv8n backbone, ONNX export by `onnx-community` |
| Task | Single-class detection: "interactable element". **No class names.** |
| Artifact | `extension/public/models/icon-detect-640.onnx`, **11.68 MB** fp32 |
| Graph | input `images` `[1,3,640,640]` (static) → output `output0` `[1,5,8400]` |
| Runtime | `onnxruntime-web@1.29.0` (exact-pinned), jsep wasm build, bundled |
| EPs | `['webgpu','wasm']`, falling back to `['wasm']` — **same file, same graph** |
| License | **AGPL-3.0** (weights) — unresolved, see §12 |

**Why this one.** It is trained on browser/GUI screenshots, which is the domain the rejected
candidate failed at; it localizes rather than classifies; a real ONNX artifact exists and loads
in ORT-Web unmodified; it is 11.68 MB against a <100 MB budget; and it survives the honesty
test that matters — on blank pixels it returns nothing.

**Why fp32 and not int8.** Measured, not assumed: int8 session create was 264 ms (wasm) /
209 ms (WebGPU) versus fp32's 1374 ms / 304 ms, but int8 **inference on WebGPU was slower**
(925 ms vs 304 ms on the whole-viewport case) and fp16 changed box counts (34 vs 33 on one
region) for no latency win. fp32 is the artifact whose numbers in §11 are the shipped numbers.

**What it is allowed to contribute.** `elements[]` (boxes + confidence in viewport CSS pixels)
and the `ui_elements` marker — added *on top of* the pixel-stats observation, never replacing
it. Because the model has one class, `VisualElementBox` carries **no label**: inventing "button"
or "credential field" from a single-class score would be fabrication (CONTRIBUTING.md §22).

**Decode constants** (`providers/yolo-decode.ts`), each with a measured reason:
`VISION_INPUT_EDGE=640` (static graph input), `LETTERBOX_PAD=114` (Ultralytics grey),
`DEFAULT_CONFIDENCE=0.1` (genuine receipt text-line boxes scored **0.124–0.17**; 0.25 would
silently delete whole true regions, and OmniParser itself ships 0.05), `NMS_IOU=0.45`,
`DEGENERATE_AREA_SHARE=0.75` (a 48×48 avatar crop yields one box covering the whole crop —
a restatement of the DOM rect that was already known), `MAX_ELEMENTS_PER_REGION=24`.

---

## 11. Gate 2 — real inference, this project's own code, real surfaces

**Method (no mocks, no model-card claims).** A scratch harness (`.m3-gate2/`, deleted after its
numbers were recorded here) rendered surfaces in a **headed Chromium on `http://localhost`** and
ran **this project's shipped code** over them — `collectVisualCandidatesInPage` →
`decideVisualPerception` → `selectRegions` → `analysisScale` → `letterbox` →
`decodeDetections` → `dropDegenerate` → `toElementBoxes` — against the real ONNX graph on the
real ORT-Web runtime, on **both** EPs, at two input edges, in fp32 / fp16 / int8.

### Surface A — chat-UI replica (WhatsApp-Web-like: avatar column, message list, image
### attachment, composer). 1280×900, dSF 1

`gpu=true`, inputs `['images']`, outputs `['output0']`, `domTextLength=0`, **15 candidates**,
decision `visual_only_content_present`, **8 regions selected** (the `MAX_REGIONS` cap).

| Region | Raster @640 | Elements | wasm | WebGPU |
|---|---|---|---|---|
| `r-322-78-840x302` (message list) | `[640,230]` | **33** | 646 ms | 1010 ms |
| `r-794-407-486x343` (receipt image) | `[640,452]` | 3 | 543 ms | 110 ms |
| `r-322-776-600x124` (composer) | `[640,132]` | 3 | 522 ms | 87 ms |
| 5 × `r-12-*-48x49` (avatars) | `[192,196]` | 1 each | 537–546 ms | 98–103 ms |
| **total** | | **44 boxes / 8 regions** | | |

Receipt scores 0.17 / 0.156 / 0.124 — the measurement `DEFAULT_CONFIDENCE=0.1` exists for.
The avatar boxes are exactly the degenerate case: one box covering ~96–110 % of a 48 px crop,
now dropped by `DEGENERATE_AREA_SHARE` because the DOM rect already said that.

**The input-edge finding, and why the registry carries `analysisEdge`.** The same 8 regions at
edge 192 returned **13** boxes instead of 44, and the message list — the richest region on the
page — returned **0**. A raster below the graph's static 640 does not degrade this model, it
**silences** it. That is why `register-vision.ts` declares `analysisEdge: 640` and the service
takes `max(OCR budget, provider edge)`.

### Surface B — `tests/fixtures/sensitive-sample.html`

`gpu=true`, 2 candidates, `domTextLength=330`, **0 regions selected**. The project's own
DOM-primary gate legitimately declined: both candidates were sub-threshold and the DOM already
described the page. This surface therefore exercises the **gate**, not the model — recorded here
because "0 regions" on a sensitive fixture reads like a failure and is not one.

### Whole-viewport control — EP parity is exact

One 1280×900 viewport raster `[640,450]`, dims `[1,5,8400]`, **51 boxes on both EPs**:

| EP | Inference | Boxes | Top scores |
|---|---|---|---|
| wasm | 563 ms | 51 | 0.594, 0.529, 0.526, 0.515, 0.511, 0.493 |
| WebGPU | **108 ms** | 51 | 0.594, 0.529, 0.526, 0.515, 0.511, 0.493 |

All 51 CSS rects identical, **max score delta 0.000**. The fallback is not a different model or
a degraded path — it is the same graph on a different EP, 5.2× slower and bit-identical.

### Session-create latency (measured, per artifact/EP)

| Artifact | wasm | WebGPU |
|---|---|---|
| fp32 (**ships**) | 1374 ms | 304 ms |
| fp16 | 395 ms | 199 ms |
| int8 | 264 ms | 209 ms |

### Automated proof in the repo — `tests/integration/vision-model.test.ts`

The gate harness is gone; the guarantees it established are now permanent tests that load the
**real 11.68 MB graph** through the **real ORT wasm runtime** (no mocked inference):

1. graph shape is the single-class head the decoder was written for (`[1,5,8400]`, input `images`);
2. real localization on painted pixels, every box inside the painted card, none on blank margin;
3. **zero elements on a blank raster from the same loaded session** — the anti-fabrication
   control, and the one assertion a decoder that manufactured boxes from noise could not pass;
4. determinism — identical pixels ⇒ identical geometry;
5. per-region coordinates from one shared session (translation, not re-derivation);
6. DOM sufficient ⇒ the graph is **never loaded** (`loads === 0`);
7. DOM insufficient ⇒ every targeted region analysed, **one** load, raster sized to 640;
8. Vision (WHERE) + Tesseract-seam OCR (WHAT) over the **same** raster, `maxEdge` 1024 /
   `minEdge` 640;
9. real M2 → M3 → M4 → M5 handoff whose serialized output contains no canary, no
   `ui_elements`, no `"elements"`, and not the model name.

---

## 12. License — the unresolved item

The OmniParser `icon_detect` **weights are AGPL-3.0**, and this is stated by upstream rather
than inferred from a conflict:

- The `microsoft/OmniParser` model card BODY says verbatim "icon_detect model is under AGPL
  license" (and separately that the BLIP2/Florence captioners are MIT), then directs readers
  to "the LICENSE file in the folder of each model".
- `icon_detect/LICENSE` in that repository is the complete, unmodified GNU AGPL v3 text.
- The card's YAML frontmatter `license: mit` is therefore **not a contradiction to resolve**:
  it is one repo-level field on a repository that ships components under different licenses,
  and the card scopes them per directory. Card and LICENSE agree.
- Root cause, and why no re-export can change it: `icon_detect` is a fine-tuned Ultralytics
  YOLOv8, and `ultralytics/ultralytics` is itself AGPL-3.0. The copyleft is intrinsic to the
  lineage. The shipped ONNX comes from `onnx-community/OmniParser-icon_detect_640x640`
  (revision `799bd041b5d053ed44651c2237ced04d8fdb2777`), which declares **no license at
  all** — and an intermediary cannot grant more rights than the weights it re-exported.

This repository is `private: true` with no declared license. Bundling AGPL weights in a
distributed extension has consequences that are a **project decision, not a technical one**,
and it is recorded rather than glossed: see `extension/public/models/NOTICE.txt`.

Alternatives must be judged at the **framework** level, not by their repo tag — a
"YOLOv8"/"YOLO11"/"YOLOv5" derivative carries Ultralytics AGPL-3.0 however its model card is
labelled. The permissive-looking candidates found are also PyTorch-only, so adopting one means
owning an export step and re-measuring everything in §11:

| Alternative | Tagged | Actual framework risk | Size | Blocker |
|---|---|---|---|---|
| Salesforce/GPA-GUI-Detector | permissive | needs framework check before trusting | 38.69 MB | `.pt` only |
| laywens/uitag-yolo11s | MIT | ⚠️ **YOLO11s = Ultralytics → AGPL by lineage; the MIT tag is not dispositive** | 18.31 MB | `.pt` only |

A genuinely permissive replacement therefore needs a non-Ultralytics architecture (DETR/RT-DETR,
or an Apache-2.0 YOLOS variant — §9p of PROJECT_STATUS measured YOLOS-tiny and rejected it on
accuracy).

**Status: unresolved.** M3 is technically complete; the license question is open and must be
settled before any public distribution.

---

## 13. WebGPU — verified, but not in the automated suite

WebGPU needs a real GPU adapter, which Node does not have, so `npm test` exercises the **wasm**
EP only. The WebGPU path was verified separately in a **headed Chromium on `http://localhost`**
(secure context) against this project's own surfaces: `gpu=true`, session create 304 ms (fp32),
per-region inference 87–110 ms, and the exact-parity result above.

The fallback ordering itself IS covered by CI, at the level above ORT. The provider attempts
**one EP per session-create**: `backendAttempts('webgpu')` → `['webgpu', 'wasm']` is the attempt
sequence, and `executionProviders()` returns a single-entry list for each attempt
(`['webgpu']`, then `['wasm']`). Handing ORT a two-entry list would let it fall back *internally
and silently*, which is exactly what it used to do here — the created session reports nothing
about the EP it settled on, so a run that quietly executed on wasm was indistinguishable from a
real WebGPU run and `observation.backend` recorded the **request** rather than the fact. With one
EP per attempt, the attempt that succeeds *is* the active EP, a refusal is logged as
`VISION_BACKEND_REJECTED`, and the M10 WebGPU-vs-wasm latency split has something real to stand
on. Unit tests cover both the attempt sequence and the case where ORT refuses WebGPU (the
observation must then say `wasm`).

**What this means honestly:** the WebGPU → WASM fallback is verified end-to-end by hand and, for
its control flow, by unit test — but not by an automated GPU test. A regression in the WebGPU EP
would not be caught by `npm test`; it would show up as the wasm path continuing to work, which
is the point of using one artifact for both, and as `backend: 'wasm'` in the M10 performance
report where a GPU host previously reported `webgpu`.

