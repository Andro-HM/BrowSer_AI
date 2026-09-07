// Local vision MODEL provider — ONNX Runtime Web over a bundled YOLOv8n UI detector.
//
// This is the M3 "Vision" stage: it answers WHERE separable UI elements are inside a
// targeted region. It does not read text (that is the OCR analyzer's job, unchanged)
// and it does not classify sensitivity (that is M4's job).
//
// MODEL: OmniParser `icon_detect` (Microsoft), YOLOv8n backbone, single class
// "interactable element", 640x640 static input, exported to ONNX by onnx-community.
// The weights are AGPL-3.0 (see docs/m3-visual-perception.md §12) and are BUNDLED as
// an extension asset — nothing is ever fetched from the network at runtime, so
// inference is local by construction and no pixels can leave the device.
//
// RUNTIME: WebGPU when the capability probe found it, otherwise the wasm/CPU build of
// the SAME model. Threads are pinned to 1 and no blob-URL worker is used, because
// MV3's CSP (`script-src 'self' 'wasm-unsafe-eval'`) blocks blob: workers — the same
// constraint that shaped the Tesseract wiring.
//
// The coarse structural label still comes from the pixel-statistics provider: the
// detector has one class, so deriving `text_like_content` from it would be
// fabrication. Vision ADDS element geometry; it does not relabel the region.

import type { VisualBackend, RasterRegion, VisualProvider } from '../types';
import type { VisualElementBox, VisualObservation, VisualRegion } from '../../../types/contracts';
import { ocrTrace } from '../../../diag/ocr-trace';
import { createPixelStatsProvider } from './pixel-stats';
import {
  DEFAULT_CONFIDENCE,
  VISION_INPUT_EDGE,
  decodeDetections,
  dropDegenerate,
  letterbox,
  toElementBoxes,
} from './yolo-decode';

/** Bundled model asset, relative to the extension root. */
export const VISION_MODEL_ASSET = 'models/icon-detect-640.onnx';
/**
 * Directory holding the ONNX Runtime wasm binaries, relative to the extension root.
 *
 * `dist/ort/` is populated at build time from `node_modules/onnxruntime-web/dist` by the
 * `copy-onnx-assets` plugin (vite.config.ts) and is SHARED with the face-blur engine
 * (`faceBlur.ts`) — one ORT runtime copy per package, not one per consumer. Before this
 * was shared, two independent copy paths shipped the same 27.8 MB binary twice.
 */
export const VISION_WASM_DIR = 'ort/';
/** Name reported in observations and diagnostics. */
export const VISION_MODEL_NAME = 'omniparser-icon-detect-640';

/**
 * Minimal structural view of the parts of ORT this provider touches.
 *
 * Exported so tests can supply a runtime that returns a KNOWN detection head, which
 * is how the decode → element-geometry path is verified without a 12 MB download.
 * The real runtime satisfies this shape structurally.
 */
export interface VisionTensor {
  readonly data: unknown;
  readonly dims: readonly number[];
}
export interface VisionSession {
  readonly inputNames: readonly string[];
  readonly outputNames: readonly string[];
  run(feeds: Record<string, unknown>): Promise<Record<string, VisionTensor>>;
  release?(): Promise<void>;
}
export interface VisionRuntime {
  env: { wasm: { wasmPaths?: string; numThreads?: number; proxy?: boolean }; logLevel?: string };
  Tensor: new (type: 'float32', data: Float32Array, dims: readonly number[]) => unknown;
  InferenceSession: {
    create(path: string | Uint8Array, options?: Record<string, unknown>): Promise<VisionSession>;
  };
}

export interface VisionOnnxOptions {
  /**
   * Where to get the graph. In the extension this is the bundled asset's
   * `chrome-extension://` URL (the default). Raw bytes are also accepted so the real
   * weights can be exercised outside a browser, where `fetch` cannot read a file path.
   */
  modelUrl?: string | Uint8Array;
  /** Absolute URL of the directory holding the ORT wasm binaries. */
  wasmDir?: string;
  /** Score floor for keeping a detection. */
  confidence?: number;
  /** Injected for tests: supplies the runtime instead of importing `onnxruntime-web`. */
  loadRuntime?: () => Promise<VisionRuntime>;
}

/** Honest, inspectable state of the model for diagnostics and tests. */
export type VisionModelState = 'idle' | 'loading' | 'ready' | 'failed';

function extensionUrl(path: string): string | null {
  if (typeof chrome === 'undefined' || chrome.runtime?.getURL === undefined) return null;
  try {
    return chrome.runtime.getURL(path);
  } catch {
    return null;
  }
}

/**
 * Backends to attempt, in order, for a given capability decision.
 *
 * A WebGPU-capable context still keeps wasm as the fallback — the capability probe can
 * only report that the adapter EXISTS, not that ORT will accept it for this graph.
 * `cpu` is ORT's wasm build too, so it maps to a wasm attempt rather than a second
 * download; the SAME model artifact serves every attempt.
 */
export function backendAttempts(backend: VisualBackend): VisualBackend[] {
  return backend === 'webgpu' ? ['webgpu', 'wasm'] : ['wasm'];
}

/**
 * Execution providers for ONE attempt — deliberately a single entry.
 *
 * Handing ORT `['webgpu', 'wasm']` lets it fall back INTERNALLY and silently: the created
 * session gives no indication which EP it settled on, so a run that quietly executed on
 * wasm was indistinguishable from a real WebGPU run and `activeBackend` was reporting the
 * REQUEST, not the fact. Attempting one EP at a time makes the attempt that succeeds the
 * EP actually in use — which is what the observation reports and what M10's
 * WebGPU-vs-wasm latency split measures. The fallback is not lost, it just moved up one
 * level (`backendAttempts` above), where it is observable.
 */
export function executionProviders(backend: VisualBackend): string[] {
  return backend === 'webgpu' ? ['webgpu'] : ['wasm'];
}

/**
 * Build the vision provider.
 *
 * Construction is free: no import, no fetch, no wasm. The 12 MB graph loads on the
 * first `analyze` call and only for the run that needs it, which is what keeps a
 * DOM-sufficient page at zero model cost.
 */
export function createVisionOnnxProvider(options: VisionOnnxOptions = {}): VisualProvider {
  const structural = createPixelStatsProvider();
  const confidence = options.confidence ?? DEFAULT_CONFIDENCE;

  let state: VisionModelState = 'idle';
  let session: VisionSession | null = null;
  let ort: VisionRuntime | null = null;
  let pending: Promise<VisionSession | null> | null = null;
  /**
   * EP the session was actually created with — the attempt that succeeded, never the one
   * that was requested. See `executionProviders` for why those can differ.
   */
  let activeBackend: VisualBackend | null = null;

  const loadSession = async (backend: VisualBackend): Promise<VisionSession | null> => {
    if (session !== null) return session;
    if (state === 'failed') return null;
    if (pending !== null) return pending;

    pending = (async (): Promise<VisionSession | null> => {
      state = 'loading';
      try {
        const modelUrl = options.modelUrl ?? extensionUrl(VISION_MODEL_ASSET);
        if (modelUrl === null) throw new Error('model asset URL unavailable');

        const runtime =
          options.loadRuntime !== undefined
            ? await options.loadRuntime()
            : ((await import('onnxruntime-web')) as unknown as VisionRuntime);

        const wasmDir = options.wasmDir ?? extensionUrl(VISION_WASM_DIR);
        // Bundled binaries only. A CDN default would be a silent network dependency.
        if (wasmDir !== null) runtime.env.wasm.wasmPaths = wasmDir;
        // Single-threaded: SharedArrayBuffer needs COOP/COEP headers the panel does
        // not have, and the threaded worker is a blob: URL that MV3's CSP refuses.
        runtime.env.wasm.numThreads = 1;
        runtime.env.wasm.proxy = false;
        runtime.env.logLevel = 'error';

        // One EP per attempt, in preference order, so the attempt that succeeds IS the
        // EP in use. The fallback re-reads the bundled asset, which is a local
        // extension-URL read and only happens when WebGPU was refused.
        let created: VisionSession | null = null;
        let used: VisualBackend | null = null;
        let lastError: unknown = null;
        for (const attempt of backendAttempts(backend)) {
          try {
            created = await runtime.InferenceSession.create(modelUrl, {
              executionProviders: executionProviders(attempt),
              graphOptimizationLevel: 'all',
            });
            used = attempt;
            break;
          } catch (err) {
            lastError = err;
            // Not a failure yet — the next attempt may well succeed. Recorded because a
            // WebGPU refusal is invisible otherwise, and "why is this run on wasm?" is
            // the first question a perf number raises.
            ocrTrace('VISION_BACKEND_REJECTED', {
              model: VISION_MODEL_NAME,
              backend: attempt,
              detail: err instanceof Error ? err.name : 'unknown',
            });
          }
        }
        if (created === null || used === null) {
          throw lastError instanceof Error ? lastError : new Error('no execution provider');
        }

        ort = runtime;
        session = created;
        activeBackend = used;
        state = 'ready';
        ocrTrace('VISION_MODEL_READY', {
          model: VISION_MODEL_NAME,
          // The EP the session was created with, not the one that was asked for.
          backend: used,
          requested: backend,
          inputs: created.inputNames.length,
          outputs: created.outputNames.length,
        });
        return created;
      } catch (err) {
        state = 'failed';
        // Structured, non-fatal: the region still gets its honest structural label,
        // and `elements` stays ABSENT so nothing pretends a detector looked.
        ocrTrace('VISION_MODEL_UNAVAILABLE', {
          model: VISION_MODEL_NAME,
          detail: err instanceof Error ? err.name : 'unknown',
        });
        return null;
      } finally {
        pending = null;
      }
    })();
    return pending;
  };

  const detect = async (
    raster: RasterRegion,
    region: VisualRegion,
    backend: VisualBackend,
  ): Promise<VisualElementBox[] | null> => {
    const active = await loadSession(backend);
    if (active === null || ort === null) return null;

    const inputName = active.inputNames[0];
    const outputName = active.outputNames[0];
    if (inputName === undefined || outputName === undefined) return null;

    const { tensor, geometry } = letterbox(raster.data, raster.width, raster.height);
    const output = await active.run({
      [inputName]: new ort.Tensor('float32', tensor, [1, 3, VISION_INPUT_EDGE, VISION_INPUT_EDGE]),
    });
    const head = output[outputName];
    if (head === undefined || !(head.data instanceof Float32Array)) return null;

    const decoded = decodeDetections(head.data, head.dims, geometry, confidence);
    const real = dropDegenerate(decoded, raster.width, raster.height);
    return toElementBoxes(real, region, raster.width, raster.height);
  };

  return {
    name: VISION_MODEL_NAME,
    source: 'vision',

    async analyze(
      raster: RasterRegion,
      region: VisualRegion,
      backend: VisualBackend,
    ): Promise<VisualObservation[]> {
      // Structural label first: it is cheap, dependency-free, and stays correct even
      // if the model is unavailable. Vision then ADDS geometry to it.
      const base = await structural.analyze(raster, region, backend);
      // The heuristics refused to describe these pixels (malformed/degenerate raster).
      // Running a detector over them and reporting boxes would be asserting more than
      // the weaker analysis was willing to assert, so report nothing.
      if (base.length === 0) return base;

      let elements: VisualElementBox[] | null = null;
      try {
        elements = await detect(raster, region, backend);
      } catch (err) {
        ocrTrace('VISION_INFERENCE_FAILED', {
          regionId: region.id,
          detail: err instanceof Error ? err.name : 'unknown',
        });
        elements = null;
      }
      // Model never ran ⇒ report exactly what the heuristics found, nothing more.
      if (elements === null) return base;

      ocrTrace('VISION_ELEMENTS', { regionId: region.id, elements: elements.length });

      const observation = base[0];
      const labels = observation?.observations ?? [];
      return [
        {
          type: 'visual_observation',
          source: 'vision',
          region,
          observations: elements.length > 0 ? [...labels, 'ui_elements'] : [...labels],
          confidence: observation?.confidence ?? 0,
          local: true,
          elements,
          model: VISION_MODEL_NAME,
          ...(activeBackend !== null ? { backend: activeBackend } : {}),
        },
      ];
    },

    async dispose(): Promise<void> {
      const active = session;
      session = null;
      ort = null;
      activeBackend = null;
      state = 'idle';
      if (active?.release !== undefined) {
        try {
          await active.release();
        } catch {
          // Releasing a dead session must never surface as a pipeline error.
        }
      }
      await structural.dispose?.();
    },
  };
}

