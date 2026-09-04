// M3 — the REAL vision model, the REAL ONNX runtime, real inference.
//
// Nothing here is mocked: it loads the 12 MB graph that ships in
// extension/public/models/, runs it through onnxruntime-web's wasm build (the same
// artifact the extension falls back to when WebGPU is absent), and asserts on what
// the model actually returns for pixels painted here in the test.
//
// The control case is the important one. The SAME session over a blank raster must
// return zero elements: that is what distinguishes real inference from a decoder that
// would happily manufacture plausible boxes from noise.
//
// WebGPU cannot be reached from Node — it needs a real GPU adapter in a browser. That
// path was measured separately in a headed Chromium against this project's own
// captures; see docs/m3-visual-perception.md §13.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createVisionOnnxProvider } from '../../extension/src/perception/visual/providers/vision-onnx';
import {
  MAX_ELEMENTS_PER_REGION,
  VISION_INPUT_EDGE,
} from '../../extension/src/perception/visual/providers/yolo-decode';
import { createVisualPerceptionService } from '../../extension/src/perception/visual/service';
import { OCR_ANALYSIS_EDGE } from '../../extension/src/perception/visual/regions';
import {
  isVisualProviderLoaded,
  registerVisualProvider,
  resetVisualProviders,
  visualProviderAnalysisEdge,
} from '../../extension/src/perception/visual/providers/registry';
import {
  registerVisualContentAnalyzer,
  resetVisualContentAnalyzer,
} from '../../extension/src/perception/visual/content-analyzer';
import { detectPII } from '../../extension/src/perception/pii';
import { enforcePrivacy } from '../../extension/src/sanitizer';
import { createLocalVault } from '../../extension/src/vault';
import type {
  RasterRegion,
  RasterizeOptions,
  VisualCapabilities,
  VisualProvider,
} from '../../extension/src/perception/visual/types';
import type { VisionRuntime } from '../../extension/src/perception/visual/providers/vision-onnx';
import type {
  DomVisualCandidate,
  DomVisualSnapshot,
  VisualElementBox,
  VisualRegion,
} from '../../extension/src/types/contracts';

const MODEL_PATH = new URL('../../extension/public/models/icon-detect-640.onnx', import.meta.url);
const WASM_DIR = new URL('../../node_modules/onnxruntime-web/dist/', import.meta.url).href;

/** Real inference on a CPU is slow; these are measured-latency budgets, not guesses. */
const LOAD_TIMEOUT = 120_000;
const RUN_TIMEOUT = 60_000;

const WIDTH = 400;
const HEIGHT = 300;

function blank(): Uint8ClampedArray {
  const data = new Uint8ClampedArray(WIDTH * HEIGHT * 4).fill(255);
  return data;
}

function paint(
  data: Uint8ClampedArray,
  x: number,
  y: number,
  width: number,
  height: number,
  rgb: readonly [number, number, number],
): void {
  for (let row = y; row < y + height; row++) {
    for (let column = x; column < x + width; column++) {
      const i = (row * WIDTH + column) * 4;
      data[i] = rgb[0];
      data[i + 1] = rgb[1];
      data[i + 2] = rgb[2];
      data[i + 3] = 255;
    }
  }
}

/**
 * A painted sign-in card: title glyph run, two bordered fields with text runs, and a
 * primary + secondary button. Synthetic pixels, no real data, no screenshot on disk.
 */
function paintedUi(): RasterRegion {
  const data = blank();
  paint(data, 20, 20, 360, 40, [247, 248, 250]);
  for (let k = 0; k < 6; k++) paint(data, 30 + k * 22, 34, 16, 10, [30, 30, 30]);

  for (const top of [90, 160]) {
    paint(data, 20, top, 360, 44, [255, 255, 255]);
    paint(data, 20, top, 360, 2, [209, 213, 219]);
    paint(data, 20, top + 42, 360, 2, [209, 213, 219]);
    paint(data, 20, top, 2, 44, [209, 213, 219]);
    paint(data, 378, top, 2, 44, [209, 213, 219]);
    for (let k = 0; k < 10; k++) paint(data, 32 + k * 14, top + 15, 9, 12, [17, 17, 17]);
  }

  paint(data, 20, 230, 120, 40, [29, 78, 216]);
  paint(data, 160, 230, 120, 40, [255, 255, 255]);
  paint(data, 160, 230, 120, 2, [29, 78, 216]);
  paint(data, 160, 268, 120, 2, [29, 78, 216]);
  return { width: WIDTH, height: HEIGHT, data };
}

function flatRaster(): RasterRegion {
  return { width: WIDTH, height: HEIGHT, data: blank() };
}

function region(id: string, x = 0, y = 0): VisualRegion {
  return { id, x, y, width: WIDTH, height: HEIGHT };
}

let weights: Uint8Array;

beforeAll(async () => {
  weights = new Uint8Array(await readFile(fileURLToPath(MODEL_PATH)));
});

async function realRuntime(): Promise<VisionRuntime> {
  return (await import('onnxruntime-web')) as unknown as VisionRuntime;
}

/** The provider under test, wired to the REAL runtime and the REAL bundled weights. */
function realProvider(): VisualProvider {
  return createVisionOnnxProvider({ modelUrl: weights, wasmDir: WASM_DIR, loadRuntime: realRuntime });
}

/**
 * Non-white pixels inside a reported box. A detector that fabricated a rectangle from
 * noise would happily place it on the blank margin; a real one cannot.
 */
function paintedPixels(raster: RasterRegion, box: VisualElementBox): number {
  const x0 = Math.max(0, Math.floor(box.x));
  const y0 = Math.max(0, Math.floor(box.y));
  const x1 = Math.min(raster.width, Math.ceil(box.x + box.width));
  const y1 = Math.min(raster.height, Math.ceil(box.y + box.height));
  let count = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      if ((raster.data[(y * raster.width + x) * 4] ?? 255) < 250) count++;
    }
  }
  return count;
}

/** The painted card's bounds — nothing outside this rect has any structure at all. */
const CARD = { x: 20, y: 20, right: 380, bottom: 270 };

function intersectsCard(box: VisualElementBox): boolean {
  return (
    box.x < CARD.right && box.x + box.width > CARD.x && box.y < CARD.bottom && box.y + box.height > CARD.y
  );
}

describe('the real ONNX graph', () => {
  it('is the single-class YOLO detection head this decoder was written for', async () => {
    const ort = await realRuntime();
    ort.env.wasm.wasmPaths = WASM_DIR;
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.proxy = false;
    const session = await ort.InferenceSession.create(weights, { executionProviders: ['wasm'] });

    expect(session.inputNames).toEqual(['images']);
    const feeds = {
      images: new ort.Tensor(
        'float32',
        new Float32Array(3 * VISION_INPUT_EDGE * VISION_INPUT_EDGE).fill(114 / 255),
        [1, 3, VISION_INPUT_EDGE, VISION_INPUT_EDGE],
      ),
    };
    const output = await session.run(feeds);
    const head = output[session.outputNames[0] ?? ''];

    // 4 box channels + exactly ONE class score. There is no second class to read, which
    // is precisely why `VisualElementBox` carries no label.
    expect(head?.dims).toEqual([1, 5, 8400]);
    expect(head?.data).toBeInstanceOf(Float32Array);
    await session.release?.();
  }, LOAD_TIMEOUT);
});

describe('real inference through the provider', () => {
  let vision: VisualProvider;

  beforeAll(() => {
    // ONE provider for the whole block: the graph loads once and every case below
    // shares that session, which is also what the extension does across a run.
    vision = realProvider();
  });
  afterAll(async () => {
    await vision.dispose?.();
  });

  it('localizes real elements and reports them in viewport coordinates', async () => {
    const raster = paintedUi();
    const [observation] = await vision.analyze(raster, region('r-ui'), 'wasm');

    expect(observation?.source).toBe('vision');
    expect(observation?.local).toBe(true);
    expect(observation?.model).toBe('omniparser-icon-detect-640');
    expect(observation?.backend).toBe('wasm');
    expect(observation?.observations).toContain('ui_elements');

    const elements = observation?.elements ?? [];
    expect(elements.length).toBeGreaterThan(0);
    expect(elements.length).toBeLessThanOrEqual(MAX_ELEMENTS_PER_REGION);

    for (const box of elements) {
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(WIDTH);
      expect(box.y + box.height).toBeLessThanOrEqual(HEIGHT);
      expect(box.confidence).toBeGreaterThan(0);
      expect(box.confidence).toBeLessThanOrEqual(1);
      // Every box overlaps the painted card. Nothing is reported on the blank margin.
      expect(intersectsCard(box)).toBe(true);
    }

    // The strongest detection sits on pixels that were actually painted.
    const strongest = [...elements].sort((a, b) => b.confidence - a.confidence)[0]!;
    expect(paintedPixels(raster, strongest)).toBeGreaterThan(0);
  }, LOAD_TIMEOUT);

  it('returns ZERO elements for a blank raster — the anti-fabrication control', async () => {
    const [observation] = await vision.analyze(flatRaster(), region('r-blank'), 'wasm');

    // Present-but-empty: the SAME loaded session looked at these pixels and localized
    // nothing. A decoder inventing boxes from noise could not produce this.
    expect(observation?.elements).toEqual([]);
    expect(observation?.observations).not.toContain('ui_elements');
    expect(observation?.model).toBe('omniparser-icon-detect-640');
  }, RUN_TIMEOUT);

  it('is deterministic — identical pixels produce identical geometry', async () => {
    const first = await vision.analyze(paintedUi(), region('r-ui'), 'wasm');
    const second = await vision.analyze(paintedUi(), region('r-ui'), 'wasm');
    expect(second[0]?.elements).toEqual(first[0]?.elements);
  }, RUN_TIMEOUT);

  it('reports each region in ITS OWN coordinates from one shared session', async () => {
    const raster = paintedUi();
    const atOrigin = await vision.analyze(raster, region('r-a', 0, 0), 'wasm');
    const offset = await vision.analyze(raster, region('r-b', 300, 500), 'wasm');

    const base = atOrigin[0]?.elements ?? [];
    expect(base.length).toBeGreaterThan(0);
    // Same pixels, different region origin ⇒ the SAME geometry translated, not re-derived.
    expect(offset[0]?.elements).toEqual(base.map((b) => ({ ...b, x: b.x + 300, y: b.y + 500 })));
  }, RUN_TIMEOUT);
});

// ---------------------------------------------------------------------------
// The pipeline the milestone actually specifies: DOM first, then targeted regions,
// then the local model, then the existing OCR content stage, then M4/M5.
// ---------------------------------------------------------------------------

const CAPABILITIES: VisualCapabilities = { backends: ['wasm'], canRasterize: true, hasDocument: true };
/** Injected rasterize means no real capture is needed; the value is never decoded. */
const SYNTHETIC_CAPTURE = 'data:image/png;base64,SYNTHETIC';
/** Synthetic, non-routable. Must never appear in anything M5 hands downstream. */
const CANARY = 'm3-canary-vision@example.invalid';

function paintedCandidate(x: number, y: number): DomVisualCandidate {
  return {
    kind: 'canvas',
    rect: { x, y, width: WIDTH, height: HEIGHT },
    hasAccessibleText: false,
    domTextLength: 0,
  };
}

function snapshot(candidates: DomVisualCandidate[], domTextLength = 0): DomVisualSnapshot {
  return {
    url: 'https://example.test/app',
    viewport: { width: 1280, height: 900 },
    domTextLength,
    candidates,
  };
}

/** The OCR seam the real Tesseract engine registers through (register-ocr.ts). It needs
 *  a DOM + worker, so the ENGINE here is a stand-in while the MODEL stays real. */
function registerStubOcr(): void {
  registerVisualContentAnalyzer(() => ({
    name: 'stub-ocr',
    source: 'OCR',
    analyze: () =>
      Promise.resolve({
        status: 'ok' as const,
        findings: [
          {
            category: 'EMAIL' as const,
            confidence: 0.9,
            bbox: [20, 90, 200, 44] as [number, number, number, number],
            text: CANARY,
          },
        ],
      }),
  }));
}

describe('service integration — DOM-primary, model second', () => {
  let loads = 0;
  const rasterOptions: RasterizeOptions[] = [];

  beforeEach(() => {
    loads = 0;
    rasterOptions.length = 0;
    registerVisualProvider(
      () => {
        loads++;
        return realProvider();
      },
      { analysisEdge: VISION_INPUT_EDGE },
    );
  });

  afterEach(async () => {
    await resetVisualProviders();
    await resetVisualContentAnalyzer();
  });

  /** A service whose capture/raster steps are injected, so the MODEL is the real part. */
  function serviceOverPaintedUi(): ReturnType<typeof createVisualPerceptionService> {
    return createVisualPerceptionService({
      capabilities: CAPABILITIES,
      captureViewport: () => Promise.resolve(SYNTHETIC_CAPTURE),
      rasterize: (_capture, _region, options) => {
        rasterOptions.push(options);
        return Promise.resolve(paintedUi());
      },
      now: () => 0,
    });
  }

  it('never loads the 12 MB graph when the DOM already describes the page', async () => {
    const service = createVisualPerceptionService({
      capabilities: CAPABILITIES,
      captureViewport: () => Promise.reject(new Error('capture must not run')),
      rasterize: () => Promise.reject(new Error('rasterize must not run')),
      now: () => 0,
    });
    const described: DomVisualCandidate = {
      ...paintedCandidate(0, 0),
      hasAccessibleText: true,
      domTextLength: 140,
    };

    const result = await service.run(snapshot([described], 5_000));

    expect(result.status).toBe('not_required');
    expect(result.reason).toBe('dom_sufficient');
    expect(loads).toBe(0);
    expect(isVisualProviderLoaded()).toBe(false);
    await service.dispose();
  });

  it('runs the real model on EVERY targeted region, at the edge the model declared', async () => {
    const service = serviceOverPaintedUi();

    const result = await service.run(snapshot([paintedCandidate(0, 0), paintedCandidate(600, 0)]));

    expect(result.status).toBe('completed');
    expect(result.reason).toBe('visual_only_content_present');
    expect(result.metrics.regionsSelected).toBe(2);
    expect(result.metrics.regionsProcessed).toBe(2);
    // One graph for the whole run, however many regions it serves.
    expect(loads).toBe(1);
    // The registry's declared edge is what sized the raster — 192 would silence the model.
    expect(visualProviderAnalysisEdge()).toBe(VISION_INPUT_EDGE);
    expect(rasterOptions.map((o) => o.maxEdge)).toEqual([VISION_INPUT_EDGE, VISION_INPUT_EDGE]);

    // Two INDEPENDENT regions stay two regions — never collapsed into one generic one.
    expect(new Set(result.observations.map((o) => o.region.id)).size).toBe(2);
    for (const observation of result.observations) {
      expect(observation.model).toBe('omniparser-icon-detect-640');
      expect(observation.backend).toBe('wasm');
      expect((observation.elements ?? []).length).toBeGreaterThan(0);
    }
    await service.dispose();
  }, LOAD_TIMEOUT);

  it('combines the model (WHERE) with the OCR content stage (WHAT) over the same raster', async () => {
    registerStubOcr();
    const service = serviceOverPaintedUi();

    const result = await service.run(snapshot([paintedCandidate(0, 0)]));

    expect(result.status).toBe('completed');
    expect(result.contentStatus).toBe('ok');
    // WHAT: one categorized finding, mapped back into the region's coordinates.
    expect(result.contentFindings?.[0]?.category).toBe('EMAIL');
    expect(result.contentFindings?.[0]?.source).toBe('OCR');
    expect(result.contentFindings?.[0]?.provider).toBe('stub-ocr');
    // WHERE: the model's element geometry, in the SAME result, from the SAME pixels.
    expect((result.observations[0]?.elements ?? []).length).toBeGreaterThan(0);
    expect(result.observations[0]?.observations).toContain('ui_elements');
    // OCR wants pixel density, the model wants its trained edge: the larger budget wins.
    expect(rasterOptions[0]?.maxEdge).toBe(OCR_ANALYSIS_EDGE);
    expect(rasterOptions[0]?.minEdge).toBe(VISION_INPUT_EDGE);
    await service.dispose();
  }, LOAD_TIMEOUT);

  it('hands the combined result to the REAL M4 policy and M5 enforcement', async () => {
    registerStubOcr();
    const service = serviceOverPaintedUi();
    const visual = await service.run(snapshot([paintedCandidate(0, 0)]));
    await service.dispose();

    const pageText = `Support contact: ${CANARY} — please respond.`;
    const entities = detectPII(pageText); // real M2, unchanged
    expect(entities).toHaveLength(1);

    const enforcement = await enforcePrivacy({
      signals: { entities, visual, restricted: false },
      pageText,
      sessionId: 'm3-vision-integration',
      vault: createLocalVault(),
      now: () => 1_767_225_600_000,
    });

    expect(enforcement.local).toBe(true);
    expect(enforcement.aliases.map((a) => a.alias)).toEqual(['USER_EMAIL_1']);
    expect(enforcement.sanitizedText).toContain('USER_EMAIL_1');
    expect(enforcement.sanitizedText).not.toContain(CANARY);
    // The visual region reached M5 as maskable geometry, not as pixels.
    expect(enforcement.visualMasks.length).toBeGreaterThan(0);
    expect(enforcement.findings.every((f) => f.disposition !== 'inaccessible')).toBe(true);

    // The M3 additions are INTERNAL. Neither the model, nor its element boxes, nor the
    // text the OCR stage recognized may appear in what M5 produces for downstream use.
    const serialized = JSON.stringify(enforcement);
    expect(serialized).not.toContain(CANARY);
    expect(serialized).not.toContain('ui_elements');
    expect(serialized).not.toContain('"elements"');
    expect(serialized).not.toContain('omniparser');
  }, LOAD_TIMEOUT);
});
