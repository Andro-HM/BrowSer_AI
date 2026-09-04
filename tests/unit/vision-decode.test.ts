// M3 vision — detection-head decoding, tested against hand-computed values.
//
// These are the transforms that turn a model tensor into a rectangle on screen. A
// wrong sign or a dropped pad here produces boxes that LOOK plausible and are wrong,
// which is exactly the failure a test must catch, so every expectation below is
// derived by hand rather than snapshotted from the implementation.

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONFIDENCE,
  LETTERBOX_PAD,
  VISION_INPUT_EDGE,
  decodeDetections,
  dropDegenerate,
  iou,
  letterbox,
  nms,
  toElementBoxes,
} from '../../extension/src/perception/visual/providers/yolo-decode';
import type { Detection } from '../../extension/src/perception/visual/providers/yolo-decode';
import type { VisualRegion } from '../../extension/src/types/contracts';

const REGION: VisualRegion = { id: 'r-100-200-400x300', x: 100, y: 200, width: 400, height: 300 };

/** Solid-colour RGBA raster. */
function raster(width: number, height: number, rgb: [number, number, number]): Uint8ClampedArray {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = rgb[0];
    data[i * 4 + 1] = rgb[1];
    data[i * 4 + 2] = rgb[2];
    data[i * 4 + 3] = 255;
  }
  return data;
}

/** Build a `[1, 4+nc, anchors]` channel-major head from explicit boxes. */
function head(
  boxes: { cx: number; cy: number; w: number; h: number; score: number }[],
  anchors = 8,
  classes = 1,
): { raw: Float32Array; dims: number[] } {
  const channels = 4 + classes;
  const raw = new Float32Array(channels * anchors);
  boxes.forEach((box, index) => {
    raw[index] = box.cx;
    raw[anchors + index] = box.cy;
    raw[2 * anchors + index] = box.w;
    raw[3 * anchors + index] = box.h;
    raw[4 * anchors + index] = box.score;
  });
  return { raw, dims: [1, channels, anchors] };
}

describe('letterbox', () => {
  it('preserves aspect ratio and centres the image with grey padding', () => {
    // 320x160 → scale 2 → 640x320 → 160px of padding above and below.
    const { tensor, geometry } = letterbox(raster(320, 160, [255, 0, 0]), 320, 160);

    expect(geometry.scale).toBe(2);
    expect(geometry.padX).toBe(0);
    expect(geometry.padY).toBe(160);
    expect(tensor).toHaveLength(3 * VISION_INPUT_EDGE * VISION_INPUT_EDGE);

    const plane = VISION_INPUT_EDGE * VISION_INPUT_EDGE;
    // A row inside the padding band is untouched grey on all three channels.
    const padIndex = 10 * VISION_INPUT_EDGE + 10;
    expect(tensor[padIndex]).toBeCloseTo(LETTERBOX_PAD / 255, 6);
    expect(tensor[plane + padIndex]).toBeCloseTo(LETTERBOX_PAD / 255, 6);

    // A pixel inside the image band is pure red, planar RGB, scaled to 0–1.
    const imageIndex = (160 + 5) * VISION_INPUT_EDGE + 5;
    expect(tensor[imageIndex]).toBe(1);
    expect(tensor[plane + imageIndex]).toBe(0);
    expect(tensor[2 * plane + imageIndex]).toBe(0);
  });

  it('upscales a small crop rather than leaving it in a corner', () => {
    const { geometry } = letterbox(raster(64, 32, [0, 0, 0]), 64, 32);
    expect(geometry.scale).toBe(10);
    expect(geometry.padY).toBe(160);
  });
});

describe('decodeDetections', () => {
  it('un-letterboxes centre-form boxes back into raster pixels', () => {
    // 320x160 source ⇒ scale 2, padY 160. A model box centred at (200, 260) with
    // size 80x40 is, in source pixels: x = (200-40-0)/2 = 80, y = (260-20-160)/2 = 40.
    const { raw, dims } = head([{ cx: 200, cy: 260, w: 80, h: 40, score: 0.9 }]);
    const decoded = decodeDetections(raw, dims, { scale: 2, padX: 0, padY: 160 }, 0.1);

    expect(decoded).toHaveLength(1);
    // Float32 round-trip: geometry is exact, the score carries fp32 error.
    expect(decoded[0]?.x).toBe(80);
    expect(decoded[0]?.y).toBe(40);
    expect(decoded[0]?.width).toBe(40);
    expect(decoded[0]?.height).toBe(20);
    expect(decoded[0]?.confidence).toBeCloseTo(0.9, 6);
  });

  it('keeps every distinct element and drops sub-threshold anchors', () => {
    const { raw, dims } = head([
      { cx: 50, cy: 50, w: 20, h: 20, score: 0.8 },
      { cx: 300, cy: 120, w: 40, h: 10, score: 0.4 },
      { cx: 500, cy: 400, w: 30, h: 30, score: 0.02 },
    ]);
    const decoded = decodeDetections(raw, dims, { scale: 1, padX: 0, padY: 0 }, DEFAULT_CONFIDENCE);

    expect(decoded).toHaveLength(2);
    expect(decoded[0]?.confidence).toBeCloseTo(0.8, 6);
    expect(decoded[1]?.confidence).toBeCloseTo(0.4, 6);
  });

  it('suppresses duplicate anchors on the same element', () => {
    const { raw, dims } = head([
      { cx: 100, cy: 100, w: 50, h: 50, score: 0.9 },
      { cx: 102, cy: 101, w: 50, h: 50, score: 0.7 },
    ]);
    expect(decodeDetections(raw, dims, { scale: 1, padX: 0, padY: 0 }, 0.1)).toHaveLength(1);
  });

  it('returns nothing for a malformed head instead of inventing boxes', () => {
    const { raw, dims } = head([{ cx: 10, cy: 10, w: 10, h: 10, score: 0.9 }]);
    expect(decodeDetections(raw, [1, 8400], { scale: 1, padX: 0, padY: 0 })).toEqual([]);
    expect(decodeDetections(raw, [1, 3, 8], { scale: 1, padX: 0, padY: 0 })).toEqual([]);
    expect(decodeDetections(new Float32Array(4), dims, { scale: 1, padX: 0, padY: 0 })).toEqual([]);
    expect(decodeDetections(raw, dims, { scale: 0, padX: 0, padY: 0 })).toEqual([]);
  });

  it('drops zero-area anchors', () => {
    const { raw, dims } = head([{ cx: 100, cy: 100, w: 0, h: 20, score: 0.9 }]);
    expect(decodeDetections(raw, dims, { scale: 1, padX: 0, padY: 0 }, 0.1)).toEqual([]);
  });
});

describe('iou / nms', () => {
  const box = (x: number, y: number, s: number, confidence = 0.5): Detection => ({
    x,
    y,
    width: s,
    height: s,
    confidence,
  });

  it('is 0 for disjoint boxes and 1 for identical ones', () => {
    expect(iou(box(0, 0, 10), box(100, 100, 10))).toBe(0);
    expect(iou(box(0, 0, 10), box(0, 0, 10))).toBe(1);
  });

  it('computes a known partial overlap', () => {
    // 10x10 boxes offset by 5 in both axes: overlap 25, union 175.
    expect(iou(box(0, 0, 10), box(5, 5, 10))).toBeCloseTo(25 / 175, 6);
  });

  it('keeps independent boxes and is order-independent', () => {
    const independent = [box(0, 0, 10, 0.4), box(50, 50, 10, 0.9), box(200, 10, 10, 0.6)];
    expect(nms(independent)).toHaveLength(3);
    expect(nms([...independent].reverse()).map((d) => d.confidence)).toEqual([0.9, 0.6, 0.4]);
  });
});

describe('dropDegenerate', () => {
  it('discards a box that merely restates the crop', () => {
    // The crop came from a DOM rect, so "one element filling the crop" is not news.
    const full: Detection = { x: 0, y: 0, width: 192, height: 196, confidence: 0.31 };
    const real: Detection = { x: 10, y: 10, width: 40, height: 12, confidence: 0.2 };
    expect(dropDegenerate([full, real], 192, 196)).toEqual([real]);
  });

  it('keeps a large-but-not-total box', () => {
    const half: Detection = { x: 0, y: 0, width: 100, height: 50, confidence: 0.3 };
    expect(dropDegenerate([half], 200, 100)).toEqual([half]);
  });

  it('drops sub-pixel boxes and handles a degenerate crop', () => {
    expect(dropDegenerate([{ x: 1, y: 1, width: 0.4, height: 9, confidence: 0.9 }], 100, 100)).toEqual([]);
    expect(dropDegenerate([{ x: 1, y: 1, width: 5, height: 5, confidence: 0.9 }], 0, 100)).toEqual([]);
  });
});

describe('toElementBoxes', () => {
  it('maps raster pixels into viewport CSS pixels for a DOWNSCALED raster', () => {
    // 400x300 region rastered to 200x150 ⇒ every raster pixel is 2 CSS px.
    const boxes = toElementBoxes(
      [{ x: 10, y: 20, width: 30, height: 15, confidence: 0.42 }],
      REGION,
      200,
      150,
    );
    expect(boxes).toEqual([{ x: 120, y: 240, width: 60, height: 30, confidence: 0.42 }]);
  });

  it('maps raster pixels back for an UPSCALED raster', () => {
    // A 48x48 region upscaled 4x to 192x192 ⇒ every raster pixel is 0.25 CSS px.
    const small: VisualRegion = { id: 'r-12-78-48x48', x: 12, y: 78, width: 48, height: 48 };
    const boxes = toElementBoxes(
      [{ x: 40, y: 80, width: 80, height: 40, confidence: 0.3 }],
      small,
      192,
      192,
    );
    expect(boxes).toEqual([{ x: 22, y: 98, width: 20, height: 10, confidence: 0.3 }]);
  });

  it('clips to the region and never reports outside it', () => {
    const boxes = toElementBoxes(
      [{ x: -50, y: -50, width: 1000, height: 1000, confidence: 0.5 }],
      REGION,
      400,
      300,
    );
    expect(boxes).toEqual([{ x: 100, y: 200, width: 400, height: 300, confidence: 0.5 }]);
  });

  it('keeps the strongest evidence when capping', () => {
    const many: Detection[] = Array.from({ length: 30 }, (_, i) => ({
      x: i * 10,
      y: 5,
      width: 8,
      height: 8,
      confidence: (i + 1) / 100,
    }));
    const boxes = toElementBoxes(many, REGION, 400, 300, 5);
    expect(boxes).toHaveLength(5);
    expect(boxes.map((b) => b.confidence)).toEqual([0.3, 0.29, 0.28, 0.27, 0.26]);
  });

  it('reports geometry and confidence ONLY — no label, no text, no ids', () => {
    const [box] = toElementBoxes([{ x: 1, y: 1, width: 20, height: 20, confidence: 0.5 }], REGION, 400, 300);
    expect(Object.keys(box ?? {}).sort()).toEqual(['confidence', 'height', 'width', 'x', 'y']);
  });

  it('returns nothing for a degenerate raster', () => {
    expect(toElementBoxes([{ x: 0, y: 0, width: 5, height: 5, confidence: 0.5 }], REGION, 0, 0)).toEqual([]);
  });
});

