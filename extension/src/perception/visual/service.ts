// M3 visual-perception service: the one orchestrator for local visual observation.
//
// Ordering matters and is enforced here:
//   1. restricted-page check   (never fight browser security)
//   2. DOM-first sufficiency   (usually exits here — no capture, no provider load)
//   3. capability check        (rasterization possible in this context?)
//   4. bounded region select   (≤ MAX_REGIONS, clamped to viewport)
//   5. capture + crop          (raw pixels, local only)
//   6. cache lookup by digest  (unchanged regions are not reprocessed)
//   7. lazy provider analysis  (first heavy work of the entire pipeline)
//
// PRIVACY INVARIANTS UPHELD HERE:
//   - the capture data URL and every raster stay in local variables and are dropped
//     as soon as a region is analysed;
//   - nothing in this file logs page content, pixels, or capture bytes;
//   - only derived VisualObservation labels leave the service.
//
// FAILURE POSTURE: every unexpected condition degrades to a structured
// `unavailable`/`not_required` result. The service never throws at its callers and
// never guesses an observation it did not measure.
//
// INSTRUMENTATION (M10): each heavy stage is wrapped by a stage meter so the run reports
// a real capture/rasterize/vision/face/OCR breakdown plus the EP the detector actually
// ran on and the peak JS heap observed while both ONNX graphs were resident. Timings are
// measured, never derived, and a stage that did not run reports NOTHING rather than 0.

import type {
  DomVisualSnapshot,
  VisualContentFinding,
  VisualContentStatus,
  VisualObservation,
  VisualPerceptionMetrics,
  VisualPerceptionResult,
  VisualRegion,
} from '../../types/contracts';
import { captureScreenshot } from '../screenshot';
import { VisualRegionCache, computeRasterDigest } from './cache';
import { detectVisualCapabilities, preferredBackend } from './capability';
import { decideVisualPerception } from './decision';
import { createBrowserRasterizer } from './raster';
import {
  MAX_ANALYSIS_EDGE,
  MAX_REGIONS,
  OCR_ANALYSIS_EDGE,
  OCR_MIN_ANALYSIS_EDGE,
  selectRegions,
} from './regions';
import { createFaceBlurEngine, type FaceBlurEngine } from './faceBlur';
import { planBelowFoldBands } from './bands';
import {
  disposeVisualProvider,
  resolveVisualProvider,
  visualProviderAnalysisEdge,
} from './providers/registry';
import {
  isVisualContentAnalyzerAvailable,
  resolveVisualContentAnalyzer,
} from './content-analyzer';
import { mapRasterBboxToRegion } from './coords';
import { BROWSER_RESTRICTION_REASON, isRestrictedUrl } from './restricted';
import type { RasterizeFn, VisualCapabilities, VisualProvider } from './types';
import { ocrTrace } from '../../diag/ocr-trace';

// M7.5 — lazy face-blur engine (ONNX WASM, panel context): blurs painted faces in the
// raster BEFORE the OCR analyzer reads it. Never throws; zeros on unavailability.
let faceBlurEngine: FaceBlurEngine | null = null;
function getFaceBlurEngine(): FaceBlurEngine {
  faceBlurEngine ??= createFaceBlurEngine();
  return faceBlurEngine;
}

export interface VisualPerceptionDeps {
  /** Defaults to the M2 screenshot module. Injectable for tests. */
  captureViewport?: () => Promise<string>;
  rasterize?: RasterizeFn;
  capabilities?: VisualCapabilities;
  now?: () => number;
  cache?: VisualRegionCache;
  /**
   * Scroll the inspected viewport to document y `top` (and settle). When provided,
   * the service performs BOUNDED below-the-fold band capture: it scrolls to a few
   * discrete offsets, captures the now-visible viewport at each, and restores the
   * original scroll afterwards. Absent ⇒ only the initially visible viewport is
   * inspected (below-fold images are then not covered — reported honestly, not faked).
   */
  scrollViewport?: (top: number) => Promise<void>;
}

export interface VisualPerceptionService {
  run(snapshot: DomVisualSnapshot): Promise<VisualPerceptionResult>;
  dispose(): Promise<void>;
}

function metrics(partial: Partial<VisualPerceptionMetrics>): VisualPerceptionMetrics {
  return {
    candidatesConsidered: partial.candidatesConsidered ?? 0,
    regionsSelected: partial.regionsSelected ?? 0,
    regionsProcessed: partial.regionsProcessed ?? 0,
    regionsFromCache: partial.regionsFromCache ?? 0,
    durationMs: partial.durationMs ?? 0,
    // Optional fields are FORWARDED, never defaulted: an absent timing means the stage
    // did not run, which a `0` would silently turn into "ran instantly" (M10 §12).
    ...(partial.backend !== undefined ? { backend: partial.backend } : {}),
    ...(partial.captureMs !== undefined ? { captureMs: partial.captureMs } : {}),
    ...(partial.rasterizeMs !== undefined ? { rasterizeMs: partial.rasterizeMs } : {}),
    ...(partial.visionMs !== undefined ? { visionMs: partial.visionMs } : {}),
    ...(partial.faceMs !== undefined ? { faceMs: partial.faceMs } : {}),
    ...(partial.ocrMs !== undefined ? { ocrMs: partial.ocrMs } : {}),
    ...(partial.peakJsHeapBytes !== undefined
      ? { peakJsHeapBytes: partial.peakJsHeapBytes }
      : {}),
  };
}

function defaultNow(): number {
  return typeof performance === 'object' ? performance.now() : 0;
}

/** The five instrumented stages of one visual run. */
type VisualStage = 'capture' | 'rasterize' | 'vision' | 'face' | 'ocr';

/**
 * Accumulating stage timer + heap-peak sampler.
 *
 * Deliberately additive across regions and bands: the reported number is the total time
 * the run spent in that stage, which is what an end-to-end latency budget is made of.
 * Rounded once at read time so repeated accumulation does not drift.
 */
function createStageMeter(now: () => number) {
  const totals: Record<VisualStage, number> = {
    capture: 0,
    rasterize: 0,
    vision: 0,
    face: 0,
    ocr: 0,
  };
  const ran = new Set<VisualStage>();
  let peakHeap = 0;

  /**
   * `performance.memory` is a non-standard Chromium extension to `performance` and is
   * absent in Firefox and in the jsdom test environment — hence the guarded read and the
   * "absent, not zero" contract on `peakJsHeapBytes`.
   */
  const sampleHeap = (): void => {
    const memory = (performance as { memory?: { usedJSHeapSize?: number } } | undefined)?.memory;
    const used = memory?.usedJSHeapSize;
    if (typeof used === 'number' && Number.isFinite(used) && used > peakHeap) peakHeap = used;
  };

  return {
    /** Time one stage invocation, recording it even when the call throws. */
    async time<T>(stage: VisualStage, fn: () => Promise<T>): Promise<T> {
      const from = now();
      ran.add(stage);
      try {
        return await fn();
      } finally {
        totals[stage] += now() - from;
        // Sampled AFTER the stage, when a freshly-loaded ONNX arena is resident.
        sampleHeap();
      }
    },
    sampleHeap,
    /** Only stages that actually ran appear; the rest stay absent. */
    read(): Partial<VisualPerceptionMetrics> {
      const round = (n: number): number => Math.round(n * 100) / 100;
      return {
        ...(ran.has('capture') ? { captureMs: round(totals.capture) } : {}),
        ...(ran.has('rasterize') ? { rasterizeMs: round(totals.rasterize) } : {}),
        ...(ran.has('vision') ? { visionMs: round(totals.vision) } : {}),
        ...(ran.has('face') ? { faceMs: round(totals.face) } : {}),
        ...(ran.has('ocr') ? { ocrMs: round(totals.ocr) } : {}),
        ...(peakHeap > 0 ? { peakJsHeapBytes: peakHeap } : {}),
      };
    },
  };
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/**
 * Reduce a caught error to a SHORT, non-sensitive diagnostic for the trace and result.
 * The value is an API failure string or a structured code (e.g. NO_ACTIVE_TAB) — never
 * pixels — but we still defensively strip anything that looks like image bytes (replacing
 * the whole message with `redactedAs`) and cap the length, so no capture payload can ever
 * ride out through a log line or a result field.
 */
function safeErrorDetail(err: unknown, redactedAs = 'redacted_error'): string {
  const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : 'unknown';
  if (/data:image|base64/i.test(raw)) return redactedAs;
  return raw.slice(0, 120);
}

export function createVisualPerceptionService(
  deps: VisualPerceptionDeps = {},
): VisualPerceptionService {
  const capture = deps.captureViewport ?? (() => captureScreenshot());
  const now = deps.now ?? defaultNow;
  const cache = deps.cache ?? new VisualRegionCache();
  // Capabilities are probed once per service, not once per page.
  const capabilities = deps.capabilities ?? detectVisualCapabilities();
  // The rasterizer closes over the host context; built eagerly but does no work.
  const rasterize = deps.rasterize ?? createBrowserRasterizer();
  const scrollViewport = deps.scrollViewport;

  let inFlight = false;

  async function run(snapshot: DomVisualSnapshot): Promise<VisualPerceptionResult> {
    const startedAt = now();
    const elapsed = (): number => Math.round((now() - startedAt) * 100) / 100;

    if (snapshot === null || typeof snapshot !== 'object') {
      return {
        status: 'unavailable',
        supported: false,
        reason: 'invalid_snapshot',
        observations: [],
        metrics: metrics({ durationMs: elapsed() }),
      };
    }

    // 1. Browser security. Checked before anything else and never bypassed.
    if (isRestrictedUrl(snapshot.url)) {
      return {
        status: 'restricted_page',
        supported: false,
        reason: BROWSER_RESTRICTION_REASON,
        observations: [],
        metrics: metrics({ durationMs: elapsed() }),
      };
    }

    // Reject overlapping runs so repeated triggers cannot stack CPU work.
    if (inFlight) {
      return {
        status: 'running',
        supported: true,
        reason: 'run_in_progress',
        observations: [],
        metrics: metrics({ durationMs: elapsed() }),
      };
    }

    const candidateCount = Array.isArray(snapshot.candidates) ? snapshot.candidates.length : 0;

    // 2. DOM-first gate. The common case returns here: no capture, no provider.
    const decision = decideVisualPerception(snapshot);
    if (!decision.required) {
      return {
        status: 'not_required',
        supported: true,
        reason: decision.reason,
        observations: [],
        metrics: metrics({ candidatesConsidered: candidateCount, durationMs: elapsed() }),
      };
    }

    // 3. Can this context turn a capture into pixels at all?
    if (!capabilities.canRasterize) {
      return {
        status: 'unavailable',
        supported: false,
        reason: 'rasterization_unsupported_in_context',
        observations: [],
        metrics: metrics({ candidatesConsidered: candidateCount, durationMs: elapsed() }),
      };
    }

    // 4. Bounded, deterministic region set for the CURRENTLY VISIBLE viewport.
    const regions = selectRegions(snapshot, decision.candidates);

    // 4b. When a scroller is available, plan a few bounded below-the-fold bands from
    //     the whole-document candidate set, sharing the overall region budget. Absent
    //     scroller ⇒ no bands: only the visible viewport is inspected (honest limit).
    const belowFoldBands = scrollViewport
      ? planBelowFoldBands(snapshot, decision.candidates, MAX_REGIONS - regions.length)
      : [];

    const totalRegions = regions.length + belowFoldBands.reduce((n, b) => n + b.regions.length, 0);
    if (totalRegions === 0) {
      return {
        status: 'not_required',
        supported: true,
        reason: 'no_regions_after_bounding',
        observations: [],
        metrics: metrics({ candidatesConsidered: candidateCount, durationMs: elapsed() }),
      };
    }

    inFlight = true;
    const meter = createStageMeter(now);
    // Baseline before any model is loaded, so the peak reflects this run's allocations.
    meter.sampleHeap();
    let processed = 0;
    let fromCache = 0;
    /** EP the vision model actually ran on, taken from the observations it produced. */
    let activeBackend: VisualPerceptionMetrics['backend'];
    const observations: VisualObservation[] = [];
    const contentFindings: VisualContentFinding[] = [];
    // Honest content-analysis status, escalated as regions are seen: starts unknown
    // (no regions analysed → left absent), becomes 'not_available' when the default
    // engine is used, 'ok' when a real engine ran, 'failed' if one errored.
    let contentStatus: VisualContentStatus | undefined;
    // M7.5 — aggregate face-blur counters across all regions of this run.
    const runFaces = { detected: 0, blurred: 0 };
    const escalate = (next: VisualContentStatus): void => {
      // failed dominates ok dominates not_available (fail closed on any error).
      const rank: Record<VisualContentStatus, number> = { not_available: 0, ok: 1, failed: 2 };
      if (contentStatus === undefined || rank[next] > rank[contentStatus]) contentStatus = next;
    };
    const originalScrollY = Math.max(0, Math.floor(snapshot.scrollY ?? 0));
    let scrolled = false;

    try {
      const backend = preferredBackend(capabilities);
      const viewportWidth = snapshot.viewport?.width ?? 0;
      // A real content engine is registered ⇒ pixel density matters. Otherwise the
      // default analyzer returns `not_available` and extra pixels would buy nothing.
      const ocrPath = isVisualContentAnalyzerAvailable();
      // A registered vision MODEL declares the raster edge it needs (see
      // `VisualProviderRegistration`). Reading it costs nothing — it is registration
      // metadata, not the model — so laziness is preserved.
      const providerEdge = visualProviderAnalysisEdge();
      const maxAnalysisEdge = Math.max(
        ocrPath ? OCR_ANALYSIS_EDGE : MAX_ANALYSIS_EDGE,
        providerEdge ?? 0,
      );
      const minAnalysisEdge = Math.max(ocrPath ? OCR_MIN_ANALYSIS_EDGE : 0, providerEdge ?? 0);

      // The vision provider still loads lazily — on the first region that has real
      // pixels — but the load is memoized for the run and, crucially, CANNOT throw at
      // our caller. A broken provider (missing model asset, refused wasm init, failed
      // dynamic import) is the expected failure mode for any future heavy backend, so
      // it is recorded once and surfaced as a structured `unavailable` result below.
      let provider: VisualProvider | null = null;
      let providerLoadError: string | null = null;
      const loadProvider = async (): Promise<VisualProvider | null> => {
        if (provider !== null) return provider;
        if (providerLoadError !== null) return null;
        try {
          provider = await resolveVisualProvider();
          return provider;
        } catch (err) {
          providerLoadError = safeErrorDetail(err);
          ocrTrace('VISION_PROVIDER_UNAVAILABLE', { detail: providerLoadError });
          return null;
        }
      };

      // Analyse one captured viewport: `entries` pair the pixel-crop rect (band-relative)
      // with the region carrying the geometry everything downstream should see.
      const analyseCapture = async (
        captureDataUrl: string,
        entries: { crop: VisualRegion; region: VisualRegion }[],
      ): Promise<void> => {
        for (const { crop, region } of entries) {
          const raster = await meter.time('rasterize', () =>
            rasterize(captureDataUrl, crop, {
              viewportWidth,
              // OCR needs pixel density; a vision model needs its trained input edge.
              // Both are honoured by taking the larger requirement — the default
              // (no engine, no model) pipeline keeps the original structural budget.
              maxEdge: maxAnalysisEdge,
              // A 48px avatar left at its natural size carries glyphs far below the
              // cap-height Tesseract needs, which is why small regions used to yield zero
              // words. On the OCR path they are UPSCALED to a legible floor.
              ...(minAnalysisEdge > 0 ? { minEdge: minAnalysisEdge } : {}),
            }),
          );
          if (raster === null) continue;

          // Pixels were successfully decoded for this region. Dimensions only — never bytes.
          ocrTrace('PIXEL_DATA_VALID', {
            regionId: region.id,
            width: raster.width,
            height: raster.height,
          });

          // 6. Skip regions whose pixels are byte-identical to the last analysis.
          const digest = computeRasterDigest(raster);
          const cached = cache.get(region.id, digest);
          if (cached !== null) {
            fromCache++;
            observations.push(...cached.observations);
            contentFindings.push(...cached.contentFindings);
            if (cached.contentFindings.length > 0) escalate('ok');
            continue;
          }

          // 7. First heavy work in the pipeline — provider loads lazily, here.
          const vision = await loadProvider();
          // Provider is dead for this whole run: stop, never fabricate observations.
          if (vision === null) return;
          let regionObservations: VisualObservation[];
          try {
            regionObservations = await meter.time('vision', () =>
              vision.analyze(raster, region, backend),
            );
          } catch {
            // Provider loaded but failed on THIS region. Leave the region unanalysed
            // and uncached rather than inventing a label; metrics show it as selected
            // but not processed.
            continue;
          }
          // The EP is read back from the observation the model produced, so the metric
          // records what ran rather than what `preferredBackend` asked for.
          activeBackend ??= regionObservations.find((o) => o.backend !== undefined)?.backend;

          // 7a. M7.5 — face detection + blurring on the raster BEFORE OCR sees it
          //     (ONNX WASM, on-device). Never throws; zeros when the model is absent.
          const faceStats = await meter.time('face', () => getFaceBlurEngine().blur(raster));
          runFaces.detected += faceStats.facesDetected;
          runFaces.blurred += faceStats.facesBlurred;

          // 7b. Genuine OCR/vision content analysis over the SAME raster. With no engine
          //     registered this returns `not_available` and zero findings — never faked.
          //     Raster-pixel bboxes are mapped back into the region's coordinate space so
          //     M4/M5 mask exactly where the value was painted.
          const regionFindings: VisualContentFinding[] = [];
          try {
            const analyzer = await resolveVisualContentAnalyzer();
            ocrTrace('OCR_STARTED', { regionId: region.id, analyzer: analyzer.name });
            const analysis = await meter.time('ocr', () => analyzer.analyze(raster, region, backend));
            escalate(analysis.status);
            // Result carries a status and a finding count only — never recognized text.
            ocrTrace('OCR_RESULT', {
              regionId: region.id,
              status: analysis.status,
              findings: analysis.findings.length,
            });
            if (analysis.status === 'ok') {
              for (const f of analysis.findings) {
                regionFindings.push({
                  regionId: region.id,
                  category: f.category,
                  confidence: clamp01(f.confidence),
                  bbox: mapRasterBboxToRegion(f.bbox, region, raster),
                  ...(typeof f.text === 'string' && f.text.length > 0 ? { text: f.text } : {}),
                  provider: analyzer.name,
                  ...(analyzer.source !== undefined ? { source: analyzer.source } : {}),
                });
              }
            }
          } catch {
            // Engine present but errored — fail closed for this region, fabricate nothing.
            escalate('failed');
          }

          cache.set(region.id, digest, regionObservations, regionFindings);
          observations.push(...regionObservations);
          contentFindings.push(...regionFindings);
          processed++;
        }
      };

      // 5. The visible viewport: one capture serves every region in it (as before).
      if (regions.length > 0) {
        let captureDataUrl: string;
        ocrTrace('CAPTURE_REQUESTED', { band: 'viewport', regions: regions.length });
        try {
          captureDataUrl = await meter.time('capture', () => capture());
        } catch (err) {
          // Capture was refused. This is NOT a crash and NOT necessarily a bug: the
          // browser forbids capturing some surfaces (PDF viewer, other-origin embedded
          // content, a backgrounded/none-active window) even when the top-level URL looked
          // fine. We surface a single deterministic, structured code as the RESULT reason —
          // never the raw error text — but we DO record the short, sanitized API diagnostic
          // in the trace AND on the result so the actual cause is visible to the user.
          const detail = safeErrorDetail(err, 'capture_error');
          ocrTrace('CAPTURE_FAILED', {
            band: 'viewport',
            reason: 'VISUAL_CAPTURE_UNAVAILABLE',
            detail,
          });
          return {
            status: 'unavailable',
            supported: false,
            reason: 'VISUAL_CAPTURE_UNAVAILABLE',
            reasonDetail: detail,
            observations: [],
            metrics: metrics({
              candidatesConsidered: candidateCount,
              regionsSelected: totalRegions,
              durationMs: elapsed(),
              // A refused capture still has a measured cost — reporting it is how a
              // slow-failing surface is distinguishable from an instant refusal.
              ...meter.read(),
            }),
          };
        }
        ocrTrace('CAPTURE_SUCCESS', { band: 'viewport' });
        await analyseCapture(
          captureDataUrl,
          regions.map((region) => ({ crop: region, region })),
        );
      }

      // 5b. Below-the-fold bands: scroll, capture, crop. Each band failure is soft —
      //     that band's regions are simply not covered (never faked). Bounded loop.
      for (const band of belowFoldBands) {
        ocrTrace('CAPTURE_REQUESTED', { band: 'below_fold', regions: band.regions.length });
        try {
          await scrollViewport!(band.scrollY);
          scrolled = true;
          const bandCapture = await meter.time('capture', () => capture());
          ocrTrace('CAPTURE_SUCCESS', { band: 'below_fold' });
          await analyseCapture(
            bandCapture,
            band.regions.map(({ region, cropY }) => ({
              crop: { ...region, y: cropY },
              region,
            })),
          );
        } catch {
          // Could not capture this band — degrade closed for it and continue.
          ocrTrace('CAPTURE_FAILED', { band: 'below_fold', reason: 'band_capture_failed' });
        }
      }

      ocrTrace('OCR_REGION_COUNT', {
        contentFindings: contentFindings.length,
        contentStatus: contentStatus ?? 'none',
        regionsProcessed: processed,
        regionsFromCache: fromCache,
      });

      // The provider could not be constructed and nothing was analysed. Report that
      // plainly instead of a `completed` run with an empty observation list.
      if (providerLoadError !== null && processed === 0) {
        return {
          status: 'unavailable',
          supported: false,
          reason: 'visual_provider_unavailable',
          reasonDetail: providerLoadError,
          observations,
          metrics: metrics({
            candidatesConsidered: candidateCount,
            regionsSelected: totalRegions,
            regionsFromCache: fromCache,
            durationMs: elapsed(),
            ...meter.read(),
          }),
        };
      }

      return {
        status: 'completed',
        supported: true,
        reason: decision.reason,
        observations,
        contentFindings,
        contentStatus,
        faceStats: { facesDetected: runFaces.detected, facesBlurred: runFaces.blurred },
        metrics: metrics({
          candidatesConsidered: candidateCount,
          regionsSelected: totalRegions,
          regionsProcessed: processed,
          regionsFromCache: fromCache,
          durationMs: elapsed(),
          ...(activeBackend !== undefined ? { backend: activeBackend } : {}),
          ...meter.read(),
        }),
      };
    } finally {
      // Always restore the user's original scroll position if we moved it.
      if (scrolled && scrollViewport) {
        try {
          await scrollViewport(originalScrollY);
        } catch {
          // Best-effort restore; never throw from cleanup.
        }
      }
      inFlight = false;
    }
  }

  return {
    run,
    async dispose(): Promise<void> {
      cache.clear();
      await disposeVisualProvider();
    },
  };
}
