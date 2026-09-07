// M3 vision provider — runtime lifecycle, EP selection, and failure behaviour.
//
// The ONNX runtime is INJECTED here so these cases stay fast and deterministic; the
// decoding maths is the real implementation, and the real model/real runtime are
// exercised separately in tests/integration/vision-model.test.ts. What is asserted
// here is the part a real graph cannot show cheaply: that a missing model degrades
// honestly instead of fabricating elements, that the graph loads once for a whole
// run, and that the structural label survives either way.

import { describe, expect, it, vi } from 'vitest';
import {
  backendAttempts,
  createVisionOnnxProvider,
  executionProviders,
} from '../../extension/src/perception/visual/providers/vision-onnx';
import type {
  VisionRuntime,
  VisionSession,
} from '../../extension/src/perception/visual/providers/vision-onnx';
import { VISION_INPUT_EDGE } from '../../extension/src/perception/visual/providers/yolo-decode';
import type { RasterRegion } from '../../extension/src/perception/visual/types';
import type { VisualRegion } from '../../extension/src/types/contracts';

const ANCHORS = 4;

function region(id: string, x: number, y: number): VisualRegion {
  return { id, x, y, width: 200, height: 100 };
}

/** A text-like raster: alternating dark/light rows so pixel-stats has real structure. */
function raster(width = 200, height = 100): RasterRegion {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const ink = y % 4 < 2 && x % 3 !== 0;
      const value = ink ? 20 : 240;
      const i = (y * width + x) * 4;
      data[i] = value;
      data[i + 1] = value;
      data[i + 2] = value;
      data[i + 3] = 255;
    }
  }
  return { width, height, data };
}

/** Channel-major `[1, 5, ANCHORS]` head containing `boxes` model-space detections. */
function headTensor(boxes: { cx: number; cy: number; w: number; h: number; score: number }[]) {
  const raw = new Float32Array(5 * ANCHORS);
  boxes.forEach((box, i) => {
    raw[i] = box.cx;
    raw[ANCHORS + i] = box.cy;
    raw[2 * ANCHORS + i] = box.w;
    raw[3 * ANCHORS + i] = box.h;
    raw[4 * ANCHORS + i] = box.score;
  });
  return { data: raw, dims: [1, 5, ANCHORS] as const };
}

interface FakeRuntime {
  module: VisionRuntime;
  /** Session creations — must be 1 per run no matter how many regions are analysed. */
  creates(): number;
  runs(): number;
  released(): number;
  lastOptions(): Record<string, unknown> | undefined;
  /** Every create's options, in order — the EP attempt sequence. */
  allOptions(): Record<string, unknown>[];
}

/** Minimal stand-in for onnxruntime-web that returns a fixed detection head. */
function fakeRuntime(
  boxes: { cx: number; cy: number; w: number; h: number; score: number }[],
  behaviour: { failCreate?: boolean; failRun?: boolean; rejectEP?: string } = {},
): FakeRuntime {
  let creates = 0;
  let runs = 0;
  let released = 0;
  const optionsLog: Record<string, unknown>[] = [];

  const module: VisionRuntime = {
    env: { wasm: {} },
    Tensor: class {
      constructor(
        readonly type: 'float32',
        readonly data: Float32Array,
        readonly dims: readonly number[],
      ) {}
    } as unknown as VisionRuntime['Tensor'],
    InferenceSession: {
      create(_path: string | Uint8Array, options?: Record<string, unknown>) {
        creates++;
        if (options !== undefined) optionsLog.push(options);
        if (behaviour.failCreate === true) {
          return Promise.reject(new Error('no available backend found'));
        }
        const requested = (options?.executionProviders ?? []) as string[];
        if (behaviour.rejectEP !== undefined && requested.includes(behaviour.rejectEP)) {
          // Exactly how ORT reports an EP it cannot honour for this graph.
          return Promise.reject(new Error(`backend not found: ${behaviour.rejectEP}`));
        }
        return Promise.resolve<VisionSession>({
          inputNames: ['images'],
          outputNames: ['output0'],
          run: () => {
            runs++;
            if (behaviour.failRun === true) return Promise.reject(new Error('inference failed'));
            return Promise.resolve({ output0: headTensor(boxes) });
          },
          release: () => {
            released++;
            return Promise.resolve();
          },
        });
      },
    },
  };

  return {
    module,
    creates: () => creates,
    runs: () => runs,
    released: () => released,
    lastOptions: () => optionsLog[optionsLog.length - 1],
    allOptions: () => optionsLog,
  };
}

function provider(runtime: FakeRuntime, confidence = 0.1) {
  return createVisionOnnxProvider({
    modelUrl: 'chrome-extension://test/models/icon-detect-640.onnx',
    wasmDir: 'chrome-extension://test/models/',
    confidence,
    loadRuntime: () => Promise.resolve(runtime.module),
  });
}

describe('backend attempts and execution providers', () => {
  it('tries WebGPU first and keeps wasm as the fallback for the SAME model', () => {
    expect(backendAttempts('webgpu')).toEqual(['webgpu', 'wasm']);
  });

  it('uses the wasm build for both wasm and cpu decisions — no second download', () => {
    expect(backendAttempts('wasm')).toEqual(['wasm']);
    expect(backendAttempts('cpu')).toEqual(['wasm']);
  });

  it('gives ORT ONE ep per attempt so the successful attempt IS the active EP', () => {
    // A two-entry list lets ORT fall back internally and silently, which would make
    // `observation.backend` (and every WebGPU-vs-wasm latency number built on it) a
    // record of what was REQUESTED rather than what ran.
    expect(executionProviders('webgpu')).toEqual(['webgpu']);
    expect(executionProviders('wasm')).toEqual(['wasm']);
    expect(executionProviders('cpu')).toEqual(['wasm']);
  });
});

describe('vision provider — model lifecycle', () => {
  it('constructs without loading anything', async () => {
    const runtime = fakeRuntime([]);
    provider(runtime);
    await Promise.resolve();
    expect(runtime.creates()).toBe(0);
  });

  it('loads the graph ONCE and reuses it across every region of a run', async () => {
    const runtime = fakeRuntime([{ cx: 320, cy: 320, w: 60, h: 20, score: 0.8 }]);
    const vision = provider(runtime);

    for (const id of ['a', 'b', 'c']) {
      await vision.analyze(raster(), region(id, 0, 0), 'wasm');
    }

    expect(runtime.creates()).toBe(1);
    expect(runtime.runs()).toBe(3);
  });

  it('passes the capability decision through as a single-EP attempt', async () => {
    const runtime = fakeRuntime([]);
    await provider(runtime).analyze(raster(), region('a', 0, 0), 'webgpu');
    expect(runtime.lastOptions()?.executionProviders).toEqual(['webgpu']);
    expect(runtime.creates()).toBe(1);
  });

  it('falls back to wasm when ORT refuses WebGPU, and REPORTS wasm — not the request', async () => {
    // The case the old two-EP list hid: ORT declined WebGPU, ran on wasm, and the
    // observation still said `webgpu`. Here the refusal is a distinct failed attempt,
    // so the EP that answered is a fact rather than an assumption.
    const runtime = fakeRuntime([{ cx: 320, cy: 320, w: 128, h: 64, score: 0.62 }], {
      rejectEP: 'webgpu',
    });
    const [observation] = await provider(runtime).analyze(raster(), region('r', 0, 0), 'webgpu');

    expect(runtime.allOptions().map((o) => o.executionProviders)).toEqual([['webgpu'], ['wasm']]);
    expect(observation?.backend).toBe('wasm');
    // The fallback is a real session: elements still come back.
    expect(observation?.elements).toHaveLength(1);
  });

  it('does not re-attempt WebGPU per region after it was refused once', async () => {
    const runtime = fakeRuntime([], { rejectEP: 'webgpu' });
    const vision = provider(runtime);
    for (const id of ['a', 'b', 'c']) {
      await vision.analyze(raster(), region(id, 0, 0), 'webgpu');
    }
    // 2 = one refused WebGPU attempt + one successful wasm session, cached thereafter.
    expect(runtime.creates()).toBe(2);
    expect(runtime.runs()).toBe(3);
  });

  it('degrades honestly when EVERY attempt is refused', async () => {
    const runtime = fakeRuntime([], { rejectEP: 'wasm' });
    const [observation] = await provider(runtime).analyze(raster(), region('r', 0, 0), 'wasm');
    expect(observation?.elements).toBeUndefined();
    expect(observation?.backend).toBeUndefined();
    expect(observation?.observations).toEqual(['text_like_content']);
  });

  it('pins wasm to a single thread and no proxy worker (MV3 CSP)', async () => {
    const runtime = fakeRuntime([]);
    await provider(runtime).analyze(raster(), region('a', 0, 0), 'wasm');
    expect(runtime.module.env.wasm.numThreads).toBe(1);
    expect(runtime.module.env.wasm.proxy).toBe(false);
    // Bundled binaries only — never a CDN.
    expect(runtime.module.env.wasm.wasmPaths).toBe('chrome-extension://test/models/');
  });

  it('feeds a 640x640 NCHW tensor named after the graph input', async () => {
    const runtime = fakeRuntime([]);
    const feeds: Record<string, unknown>[] = [];
    const spy = vi.spyOn(runtime.module.InferenceSession, 'create');
    spy.mockImplementation(() =>
      Promise.resolve<VisionSession>({
        inputNames: ['images'],
        outputNames: ['output0'],
        run: (f) => {
          feeds.push(f);
          return Promise.resolve({ output0: headTensor([]) });
        },
      }),
    );

    await provider(runtime).analyze(raster(), region('a', 0, 0), 'wasm');

    const tensor = feeds[0]?.images as { dims: readonly number[]; data: Float32Array };
    expect(tensor.dims).toEqual([1, 3, VISION_INPUT_EDGE, VISION_INPUT_EDGE]);
    expect(tensor.data).toHaveLength(3 * VISION_INPUT_EDGE * VISION_INPUT_EDGE);
  });

  it('releases the session on dispose', async () => {
    const runtime = fakeRuntime([]);
    const vision = provider(runtime);
    await vision.analyze(raster(), region('a', 0, 0), 'wasm');
    await vision.dispose?.();
    expect(runtime.released()).toBe(1);

    // A disposed provider reloads rather than reusing a released graph.
    await vision.analyze(raster(), region('a', 0, 0), 'wasm');
    expect(runtime.creates()).toBe(2);
  });
});

describe('vision provider — observation shape', () => {
  it('reports localized elements in VIEWPORT coordinates alongside the structural label', async () => {
    // 200x100 raster ⇒ letterbox scale 3.2, padX 0, padY 160. A model box centred at
    // (320,320) sized 128x64 is raster x=(320-64)/3.2=80, y=(320-32-160)/3.2=40, 40x20,
    // which lands at the region's origin + that offset because raster:region is 1:1 here.
    const runtime = fakeRuntime([{ cx: 320, cy: 320, w: 128, h: 64, score: 0.62 }]);
    const [observation] = await provider(runtime).analyze(raster(), region('r-50-30', 50, 30), 'wasm');

    expect(observation?.source).toBe('vision');
    expect(observation?.local).toBe(true);
    expect(observation?.model).toBe('omniparser-icon-detect-640');
    expect(observation?.backend).toBe('wasm');
    // The pixel-stats label is preserved — the detector does not relabel the region.
    expect(observation?.observations).toContain('text_like_content');
    expect(observation?.observations).toContain('ui_elements');
    expect(observation?.elements).toEqual([
      { x: 50 + 80, y: 30 + 40, width: 40, height: 20, confidence: 0.62 },
    ]);
  });

  it('keeps independent elements separate — the multi-element case, not one merged blob', async () => {
    const runtime = fakeRuntime([
      { cx: 100, cy: 200, w: 40, h: 20, score: 0.7 },
      { cx: 400, cy: 200, w: 40, h: 20, score: 0.6 },
      { cx: 250, cy: 400, w: 60, h: 20, score: 0.5 },
    ]);
    const [observation] = await provider(runtime).analyze(raster(), region('r', 0, 0), 'wasm');

    expect(observation?.elements).toHaveLength(3);
    const xs = (observation?.elements ?? []).map((e) => e.x);
    expect(new Set(xs).size).toBe(3);
  });

  it('reports NO `ui_elements` label when the model genuinely found nothing', async () => {
    const runtime = fakeRuntime([{ cx: 320, cy: 320, w: 40, h: 20, score: 0.01 }]);
    const [observation] = await provider(runtime).analyze(raster(), region('r', 0, 0), 'wasm');

    expect(observation?.observations).not.toContain('ui_elements');
    // Present-but-empty: a detector DID look and localized nothing. Distinct from absent.
    expect(observation?.elements).toEqual([]);
  });

  it('discards a box that merely restates the whole crop', async () => {
    // Exactly the 48px-avatar case measured on a real chat UI: the crop IS the icon.
    const runtime = fakeRuntime([{ cx: 320, cy: 320, w: 640, h: 320, score: 0.31 }]);
    const [observation] = await provider(runtime).analyze(raster(), region('r', 0, 0), 'wasm');
    expect(observation?.elements).toEqual([]);
  });
});

describe('vision provider — failure is honest, never fabricated', () => {
  it('degrades to the structural label when the model cannot load', async () => {
    const runtime = fakeRuntime([], { failCreate: true });
    const [observation] = await provider(runtime).analyze(raster(), region('r', 0, 0), 'wasm');

    expect(observation?.observations).toEqual(['text_like_content']);
    // ABSENT, not empty: no detector looked, so no claim is made either way.
    expect(observation?.elements).toBeUndefined();
    expect(observation?.model).toBeUndefined();
  });

  it('does not retry a failed load on every region', async () => {
    const runtime = fakeRuntime([], { failCreate: true });
    const vision = provider(runtime);
    await vision.analyze(raster(), region('a', 0, 0), 'wasm');
    await vision.analyze(raster(), region('b', 0, 0), 'wasm');
    expect(runtime.creates()).toBe(1);
  });

  it('degrades for the region that threw, without failing the pipeline', async () => {
    const runtime = fakeRuntime([], { failRun: true });
    const observations = await provider(runtime).analyze(raster(), region('r', 0, 0), 'wasm');

    expect(observations).toHaveLength(1);
    expect(observations[0]?.elements).toBeUndefined();
    expect(observations[0]?.observations).toEqual(['text_like_content']);
  });

  it('reports nothing at all for a malformed raster', async () => {
    const runtime = fakeRuntime([{ cx: 320, cy: 320, w: 40, h: 20, score: 0.9 }]);
    const empty: RasterRegion = { width: 0, height: 0, data: new Uint8ClampedArray(0) };
    expect(await provider(runtime).analyze(empty, region('r', 0, 0), 'wasm')).toEqual([]);
  });
});


