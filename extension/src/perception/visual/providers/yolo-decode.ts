// YOLO detection-head decoding — pure arithmetic, no ONNX, no DOM, no globals.
//
// Split out from the ONNX provider on purpose: every transform between "raw model
// tensor" and "element rectangle in viewport CSS pixels" is a place where a wrong
// sign or a forgotten pad silently produces plausible-looking garbage. Keeping the
// maths here means it can be tested against hand-computed values without loading a
// 12 MB model or a wasm runtime.
//
// The bundled detector (OmniParser `icon_detect`, YOLOv8n) has a SINGLE class:
// "interactable element". Everything downstream therefore gets geometry and a score
// and nothing else — there is no class name to report, and inventing one would be
// fabrication (CONTRIBUTING.md §22).

import type { VisualElementBox, VisualRegion } from '../../../types/contracts';

/** Square input edge the exported graph expects (640x640 static shape). */
export const VISION_INPUT_EDGE = 640;
/** Ultralytics letterbox padding value (grey), 0–255. */
export const LETTERBOX_PAD = 114;
/**
 * Score floor for keeping a detection.
 *
 * OmniParser itself ships a 0.05 box threshold. Measured on this project's own
 * captures, genuine text-line boxes inside a canvas receipt scored 0.12–0.17 while
 * avatar/icon boxes scored 0.43–0.59, so 0.10 keeps the real structure and drops the
 * long tail of sub-0.1 noise. Raising it to 0.25 would silently discard whole
 * regions of true content.
 */
export const DEFAULT_CONFIDENCE = 0.1;
/** IoU above which two boxes are treated as the same element. */
export const NMS_IOU = 0.45;
/**
 * A box covering at least this share of the crop is DISCARDED.
 *
 * On a 48x48 avatar crop the detector correctly reports "this whole thing is one
 * element" — which is information the DOM already gave us, since the crop came from
 * a DOM rect. Keeping it would inflate element counts with restatements.
 */
export const DEGENERATE_AREA_SHARE = 0.75;
/** Hard cap on elements reported per region — bounds memory and downstream work. */
export const MAX_ELEMENTS_PER_REGION = 24;

/** How the source pixels were fitted into the square model input. */
export interface LetterboxGeometry {
  scale: number;
  padX: number;
  padY: number;
}

/** One detection, in SOURCE RASTER pixel space (top-left origin). */
export interface Detection {
  x: number;
  y: number;
  width: number;
  height: number;
  confidence: number;
}

/**
 * Ultralytics letterbox: preserve aspect ratio, centre in a square canvas, pad with
 * grey, scale to 0–1, emit planar RGB (NCHW). No mean/std normalization — the
 * exported model's `preprocessor_config.json` does none.
 */
export function letterbox(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  edge: number = VISION_INPUT_EDGE,
): { tensor: Float32Array; geometry: LetterboxGeometry } {
  const scale = Math.min(edge / width, edge / height);
  const scaledWidth = Math.max(1, Math.round(width * scale));
  const scaledHeight = Math.max(1, Math.round(height * scale));
  const padX = Math.floor((edge - scaledWidth) / 2);
  const padY = Math.floor((edge - scaledHeight) / 2);

  const plane = edge * edge;
  const tensor = new Float32Array(3 * plane).fill(LETTERBOX_PAD / 255);
  for (let y = 0; y < scaledHeight; y++) {
    const sourceY = Math.min(height - 1, Math.floor(y / scale));
    for (let x = 0; x < scaledWidth; x++) {
      const sourceX = Math.min(width - 1, Math.floor(x / scale));
      const source = (sourceY * width + sourceX) * 4;
      const target = (y + padY) * edge + (x + padX);
      tensor[target] = (data[source] ?? 0) / 255;
      tensor[plane + target] = (data[source + 1] ?? 0) / 255;
      tensor[2 * plane + target] = (data[source + 2] ?? 0) / 255;
    }
  }
  return { tensor, geometry: { scale, padX, padY } };
}

/** Intersection-over-union of two detections. 0 when disjoint. */
export function iou(a: Detection, b: Detection): number {
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  const overlap = Math.max(0, right - left) * Math.max(0, bottom - top);
  if (overlap === 0) return 0;
  const union = a.width * a.height + b.width * b.height - overlap;
  return union <= 0 ? 0 : overlap / union;
}

/** Greedy non-maximum suppression, highest score first. Deterministic. */
export function nms(detections: readonly Detection[], threshold: number = NMS_IOU): Detection[] {
  const sorted = [...detections].sort((a, b) =>
    b.confidence !== a.confidence ? b.confidence - a.confidence : a.x - b.x || a.y - b.y,
  );
  const kept: Detection[] = [];
  for (const candidate of sorted) {
    if (kept.some((k) => iou(k, candidate) > threshold)) continue;
    kept.push(candidate);
  }
  return kept;
}

/**
 * Decode a YOLOv8-style head into raster-space boxes.
 *
 * Layout is `[1, 4 + numClasses, anchors]`, channel-major: channel c of anchor a
 * lives at `raw[c * anchors + a]`. The first four channels are `cx, cy, w, h` in
 * MODEL-INPUT pixels; the rest are per-class scores already in 0–1 (the export
 * folds the sigmoid in). The best class score becomes the confidence — with the
 * bundled single-class model there is only ever one.
 *
 * Boxes are un-letterboxed back into source-raster pixels, then suppressed.
 * Anything malformed (bad dims, non-finite numbers, zero-area) is dropped rather
 * than propagated as a fake element.
 */
export function decodeDetections(
  raw: Readonly<Float32Array>,
  dims: readonly number[],
  geometry: LetterboxGeometry,
  confidence: number = DEFAULT_CONFIDENCE,
): Detection[] {
  const channels = dims[1] ?? 0;
  const anchors = dims[2] ?? 0;
  const classes = channels - 4;
  if (dims.length !== 3 || classes < 1 || anchors < 1) return [];
  if (raw.length < channels * anchors) return [];
  if (!Number.isFinite(geometry.scale) || geometry.scale <= 0) return [];

  const detections: Detection[] = [];
  for (let anchor = 0; anchor < anchors; anchor++) {
    let best = 0;
    for (let c = 0; c < classes; c++) {
      const score = raw[(4 + c) * anchors + anchor] ?? 0;
      if (score > best) best = score;
    }
    if (best < confidence) continue;

    const cx = raw[anchor] ?? 0;
    const cy = raw[anchors + anchor] ?? 0;
    const w = raw[2 * anchors + anchor] ?? 0;
    const h = raw[3 * anchors + anchor] ?? 0;
    const width = w / geometry.scale;
    const height = h / geometry.scale;
    if (!(width > 0) || !(height > 0)) continue;

    const x = (cx - w / 2 - geometry.padX) / geometry.scale;
    const y = (cy - h / 2 - geometry.padY) / geometry.scale;
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;

    detections.push({ x, y, width, height, confidence: Math.min(1, best) });
  }
  return nms(detections);
}

/**
 * Drop boxes that merely restate the crop they were found in, and boxes with no
 * meaningful area. Returns detections in the same order.
 */
export function dropDegenerate(
  detections: readonly Detection[],
  rasterWidth: number,
  rasterHeight: number,
  share: number = DEGENERATE_AREA_SHARE,
): Detection[] {
  const cropArea = rasterWidth * rasterHeight;
  if (cropArea <= 0) return [];
  return detections.filter((d) => {
    if (d.width < 1 || d.height < 1) return false;
    return (d.width * d.height) / cropArea < share;
  });
}

/**
 * Map raster-space detections into VIEWPORT CSS pixels, clipped to the region they
 * came from.
 *
 * The raster may have been downscaled OR upscaled relative to the region (see
 * `analysisScale`), so both axes are rescaled independently by the measured ratio
 * rather than by an assumed factor. Highest-confidence elements are kept first, so
 * the cap discards the weakest evidence, not an arbitrary corner of the region.
 */
export function toElementBoxes(
  detections: readonly Detection[],
  region: VisualRegion,
  rasterWidth: number,
  rasterHeight: number,
  max: number = MAX_ELEMENTS_PER_REGION,
): VisualElementBox[] {
  if (rasterWidth <= 0 || rasterHeight <= 0) return [];
  const kx = region.width / rasterWidth;
  const ky = region.height / rasterHeight;

  const boxes: VisualElementBox[] = [];
  for (const d of [...detections].sort((a, b) => b.confidence - a.confidence)) {
    if (boxes.length >= max) break;
    const left = Math.max(region.x, Math.round(region.x + d.x * kx));
    const top = Math.max(region.y, Math.round(region.y + d.y * ky));
    const right = Math.min(region.x + region.width, Math.round(region.x + (d.x + d.width) * kx));
    const bottom = Math.min(region.y + region.height, Math.round(region.y + (d.y + d.height) * ky));
    const width = right - left;
    const height = bottom - top;
    if (width < 1 || height < 1) continue;
    boxes.push({
      x: left,
      y: top,
      width,
      height,
      confidence: Math.round(d.confidence * 1000) / 1000,
    });
  }
  return boxes;
}

