import { describe, expect, it, vi } from 'vitest';
import {
  blurRegions,
  buildBlazeFaceAnchors,
  createFaceBlurEngine,
  decodeRawHeads,
  hasRawHeads,
  parseDetections,
  pickLayout,
  preprocessRaster,
  type FaceSessionLike,
  type OrtValueLike,
} from '../../../../extension/src/perception/visual/faceBlur';

function raster(width = 64, height = 64): { width: number; height: number; data: Uint8ClampedArray } {
  return { width, height, data: new Uint8ClampedArray(width * height * 4).fill(200) };
}

function detectionRow(y1: number, x1: number, y2: number, x2: number): number[] {
  return [y1, x1, y2, x2, ...new Array(12).fill(0.5)];
}

function sessionWithRows(rows: number[][]): FaceSessionLike {
  const output: OrtValueLike = { data: new Float32Array(rows.flat()), dims: [1, rows.length, 16] };
  return {
    inputNames: ['image', 'conf_threshold', 'max_detections', 'iou_threshold'],
    run: vi.fn(async () => ({ selectedBoxes: output })),
  };
}

/**
 * Contract (B) fixture: the four raw SSD heads. `hits` places a face at a given anchor
 * index within the given layer, expressed the way the model would — a logit plus
 * anchor-relative offsets in input-pixel (128) units.
 */
function rawHeadOutputs(
  hits: {
    rows: 512 | 384;
    index: number;
    logit: number;
    box: readonly [number, number, number, number];
  }[],
): Record<string, OrtValueLike> {
  const make = (rows: number): { scores: Float32Array; boxes: Float32Array } => ({
    scores: new Float32Array(rows).fill(-20), // sigmoid(-20) ≈ 2e-9 → background
    boxes: new Float32Array(rows * 16),
  });
  const layers = { 512: make(512), 384: make(384) };
  for (const hit of hits) {
    const layer = layers[hit.rows];
    layer.scores[hit.index] = hit.logit;
    layer.boxes.set(hit.box, hit.index * 16);
  }
  return {
    'Identity:0': { data: layers[512].scores, dims: [1, 512, 1] },
    'Identity_1:0': { data: layers[384].scores, dims: [1, 384, 1] },
    'Identity_2:0': { data: layers[512].boxes, dims: [1, 512, 16] },
    'Identity_3:0': { data: layers[384].boxes, dims: [1, 384, 16] },
  };
}

describe('preprocessRaster', () => {
  it('produces NCHW [1,3,128,128] with [-1,1] RGB normalization', () => {
    const input = raster(2, 2);
    input.data[0] = 255; // first pixel red=255 → (255/127.5)-1 = 1.0
    input.data[1] = 0;
    input.data[2] = 0;
    const tensor = preprocessRaster(input);
    expect(tensor.length).toBe(3 * 128 * 128);
    expect(tensor[0]).toBeCloseTo(1.0); // R plane, first pixel
    expect(tensor[128 * 128]).toBeCloseTo(-1.0); // G plane, first pixel
    expect(tensor[2 * 128 * 128]).toBeCloseTo(-1.0); // B plane, first pixel
  });

  it('interleaves the same values for the NHWC contract instead of planing them', () => {
    const input = raster(2, 2);
    input.data[0] = 255;
    input.data[1] = 0;
    input.data[2] = 0;
    const tensor = preprocessRaster(input, 'nhwc');
    expect(tensor.length).toBe(3 * 128 * 128);
    expect(tensor[0]).toBeCloseTo(1.0); // R of first pixel
    expect(tensor[1]).toBeCloseTo(-1.0); // G of first pixel — adjacent, not a plane away
    expect(tensor[2]).toBeCloseTo(-1.0); // B of first pixel
  });
});

describe('pickLayout', () => {
  it('chooses NHWC only on positive evidence and defaults to NCHW otherwise', () => {
    expect(pickLayout([1, 128, 128, 3])).toBe('nhwc');
    expect(pickLayout([1, 3, 128, 128])).toBe('nchw');
    // An unknown/symbolic/absent shape must not silently flip the layout: guessing wrong
    // is a hard ORT dimension error, so the conservative default is the shipped one.
    expect(pickLayout(undefined)).toBe('nchw');
    expect(pickLayout(['batch', 3, 128, 128])).toBe('nchw');
    expect(pickLayout([1, 128, 128, 'channels'])).toBe('nchw');
    expect(pickLayout([1, 3, 128])).toBe('nchw');
  });
});

describe('parseDetections', () => {
  it('scales normalized boxes into raster space', () => {
    const output: OrtValueLike = {
      data: new Float32Array(detectionRow(0.0, 0.0, 0.5, 0.5)),
      dims: [1, 1, 16],
    };
    const regions = parseDetections(output, 100, 200);
    expect(regions).toEqual([{ x: 0, y: 0, width: 50, height: 100 }]);
  });

  it('drops out-of-range and degenerate boxes instead of guessing', () => {
    const output: OrtValueLike = {
      data: new Float32Array([...detectionRow(0.9, 0.9, 1.5, 1.5), ...detectionRow(0.5, 0.5, 0.5, 0.5)]),
      dims: [1, 2, 16],
    };
    expect(parseDetections(output, 100, 100)).toEqual([]);
  });
});

describe('buildBlazeFaceAnchors', () => {
  it('reproduces the MediaPipe face_detection_front table (896 anchors, 512 + 384)', () => {
    const anchors = buildBlazeFaceAnchors();
    expect([...anchors.keys()].sort((a, b) => a - b)).toEqual([384, 512]);
    // 896 total is the number the raw export's row counts must add up to; if this drifts,
    // every decoded box would be attributed to the wrong grid cell.
    expect((anchors.get(512)?.length ?? 0) + (anchors.get(384)?.length ?? 0)).toBe(896);
    // Stride 8 → 16×16 grid, 2 anchors per cell, centres at (col+0.5)/16.
    expect(anchors.get(512)?.[0]).toEqual({ xCenter: 0.03125, yCenter: 0.03125 });
    expect(anchors.get(512)?.[1]).toEqual({ xCenter: 0.03125, yCenter: 0.03125 });
    expect(anchors.get(512)?.[2]?.xCenter).toBeCloseTo(3 / 32);
    // Stride 16 → 8×8 grid, 6 anchors per cell.
    expect(anchors.get(384)?.[0]).toEqual({ xCenter: 0.0625, yCenter: 0.0625 });
    expect(anchors.get(384)?.[5]).toEqual({ xCenter: 0.0625, yCenter: 0.0625 });
    expect(anchors.get(384)?.[6]?.xCenter).toBeCloseTo(3 / 16);
  });
});

describe('hasRawHeads', () => {
  it('separates the raw-head export from the end-to-end one by output shape alone', () => {
    expect(hasRawHeads(rawHeadOutputs([]))).toBe(true);
    expect(hasRawHeads({ selectedBoxes: { data: new Float32Array(16), dims: [1, 1, 16] } })).toBe(
      false,
    );
    // A partial match is NOT the raw contract — decoding half the anchors would silently
    // miss every face in the other layer.
    expect(
      hasRawHeads({
        'Identity:0': { data: new Float32Array(512), dims: [1, 512, 1] },
        'Identity_2:0': { data: new Float32Array(512 * 16), dims: [1, 512, 16] },
      }),
    ).toBe(false);
  });
});

describe('decodeRawHeads (contract B — SSD post-processing done here, not in the graph)', () => {
  // Anchor 272 is cell (row 8, col 8) of the stride-8 grid → centre (0.53125, 0.53125);
  // the -4px offsets pull it to (0.5, 0.5) and 32px → a 0.25-wide normalized box.
  const centreFace = { rows: 512 as const, index: 272, logit: 3, box: [-4, -4, 32, 32] as const };
  // Anchor 54 is cell (row 1, col 1) of the stride-16 grid → centre (0.1875, 0.1875).
  const cornerFace = { rows: 384 as const, index: 54, logit: 2, box: [0, 0, 16, 16] as const };

  it('decodes an anchor-relative box into raster space', () => {
    const regions = decodeRawHeads(rawHeadOutputs([{ ...centreFace }]), 100, 100, 0.7);
    expect(regions).toEqual([{ x: 37, y: 37, width: 25, height: 25 }]);
  });

  it('applies the confidence threshold to sigmoid(logit), not to the raw logit', () => {
    // sigmoid(0.5) ≈ 0.62 — below 0.7, but a naive `logit < threshold` test would keep it.
    const weak = rawHeadOutputs([{ ...centreFace, logit: 0.5 }]);
    expect(decodeRawHeads(weak, 100, 100, 0.7)).toEqual([]);
    // The same logit passes a threshold it genuinely clears.
    expect(decodeRawHeads(weak, 100, 100, 0.6)).toHaveLength(1);
  });

  it('suppresses a duplicate detection of the same face', () => {
    const duplicate = { ...centreFace, index: 273, logit: 2, box: [-4, -4, 33, 33] as const };
    const regions = decodeRawHeads(rawHeadOutputs([{ ...centreFace }, duplicate]), 100, 100, 0.7);
    expect(regions).toHaveLength(1);
  });

  it('keeps two separate faces found in different anchor layers', () => {
    const regions = decodeRawHeads(
      rawHeadOutputs([{ ...centreFace }, { ...cornerFace }]),
      100,
      100,
      0.7,
    );
    expect(regions).toEqual([
      { x: 37, y: 37, width: 25, height: 25 },
      { x: 12, y: 12, width: 13, height: 13 },
    ]);
  });

  it('clamps a face at the frame edge instead of dropping it', () => {
    // Anchor 0 sits at (0.03125, 0.03125); a 0.25-wide box there extends to -0.09375.
    // Dropping it would leave a real, partly-visible face unblurred — the privacy failure
    // this path exists to prevent.
    const edge = { rows: 512 as const, index: 0, logit: 3, box: [0, 0, 32, 32] as const };
    expect(decodeRawHeads(rawHeadOutputs([edge]), 100, 100, 0.7)).toEqual([
      { x: 0, y: 0, width: 16, height: 16 },
    ]);
  });

  it('reports no faces for an all-background frame', () => {
    expect(decodeRawHeads(rawHeadOutputs([]), 100, 100, 0.7)).toEqual([]);
  });

  it('ignores NaN regressor values rather than emitting a garbage rect', () => {
    const broken = rawHeadOutputs([{ ...centreFace, box: [Number.NaN, -4, 32, 32] as const }]);
    expect(decodeRawHeads(broken, 100, 100, 0.7)).toEqual([]);
  });
});

describe('blurRegions', () => {
  it('blacks out exactly the clamped region pixels', () => {
    const input = raster(10, 10);
    const blurred = blurRegions(input, [{ x: 2, y: 2, width: 4, height: 4 }]);
    expect(blurred).toBe(1);
    expect(input.data[(2 * 10 + 2) * 4]).toBe(0);
    expect(input.data[(2 * 10 + 2) * 4 + 3]).toBe(255); // alpha kept inside the region
    expect(input.data[(6 * 10 + 6) * 4]).toBe(200); // outside is untouched
    expect(input.data[(1 * 10 + 2) * 4]).toBe(200); // row above untouched
  });
});

describe('face-blur engine (mocked ONNX session — WASM cannot run in Vitest)', () => {
  it('blurs every detected face reported by the session', async () => {
    const engine = createFaceBlurEngine({
      createSession: async () => sessionWithRows([detectionRow(0, 0, 0.5, 0.5), detectionRow(0.5, 0.5, 1, 1)]),
    });
    const input = raster(100, 100);
    const result = await engine.blur(input);
    expect(result).toEqual({ facesDetected: 2, facesBlurred: 2 });
    expect(input.data[(75 * 100 + 75) * 4]).toBe(0); // inside second face rect
  });

  it('feeds the 0.7 confidence threshold to the graph input', async () => {
    const session = sessionWithRows([]);
    const engine = createFaceBlurEngine({ createSession: async () => session });
    await engine.blur(raster());
    const firstCall = (session.run as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] ?? {};
    const feeds = firstCall as Record<string, OrtValueLike>;
    expect(Number(feeds['conf_threshold']?.data[0])).toBeCloseTo(0.7);
  });

  it('continues the pipeline with zero faces when the model fails to load', async () => {
    const engine = createFaceBlurEngine({
      createSession: async () => {
        throw new Error('model file missing');
      },
    });
    const input = raster(32, 32);
    const result = await engine.blur(input);
    expect(result).toEqual({ facesDetected: 0, facesBlurred: 0 });
    expect(input.data[0]).toBe(200); // raster untouched
    // Subsequent calls degrade instantly (availability remembered, no retry spam).
    expect(await engine.blur(input)).toEqual({ facesDetected: 0, facesBlurred: 0 });
  });

  it('drives a raw-head NHWC model through the same public API and blurs the face', async () => {
    // The licence-driven model swap must be invisible above this seam: same engine, same
    // result shape, same in-place blur — only the graph contract differs.
    const run = vi.fn(async (_feeds: Record<string, OrtValueLike>) =>
      rawHeadOutputs([{ rows: 512, index: 272, logit: 3, box: [-4, -4, 32, 32] }]),
    );
    const engine = createFaceBlurEngine({
      createSession: async () => ({
        inputNames: ['input:0'],
        inputShapes: { 'input:0': [1, 128, 128, 3] },
        run,
      }),
    });
    const input = raster(100, 100);
    expect(await engine.blur(input)).toEqual({ facesDetected: 1, facesBlurred: 1 });
    expect(input.data[(50 * 100 + 50) * 4]).toBe(0); // centre of the decoded face
    expect(input.data[(5 * 100 + 5) * 4]).toBe(200); // outside it

    // The image tensor was fed NHWC, and no conf/iou/max feeds were invented for a graph
    // that does not declare them.
    const feeds = (run.mock.calls[0]?.[0] ?? {}) as Record<string, OrtValueLike>;
    expect(Object.keys(feeds)).toEqual(['input:0']);
    expect(feeds['input:0']?.dims).toEqual([1, 128, 128, 3]);
  });
});
