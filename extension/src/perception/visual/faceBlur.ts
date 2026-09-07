// M3 — on-device face detection + blurring (BlazeFace via ONNX Runtime Web).
//
// Authoritative milestone: M3 "local visual perception" (PROJECT_STATUS.md §0A). This was
// developed under the working label "M7.5"; it is a SPECIALIZED privacy detector that runs
// alongside — never instead of — the general UI element detector.
//
// PRIVACY & ARCHITECTURE:
//   - Everything runs ON-DEVICE: the ONNX model and the ORT WASM runtime are packaged
//     into the extension; there is no remote call of any kind.
//   - WASM execution provider ONLY (no WebGPU): WebGPU is unstable in MV3 offscreen/
//     extension page contexts and fails silently — see the milestone brief.
//   - The raster is blurred IN PLACE before the OCR analyzer sees it, so painted faces
//     are never handed to any downstream consumer.
//   - Failure is NEVER fatal: a missing/broken model or runtime degrades to zero faces
//     and the perception pipeline continues (fail-open for availability, never for
//     privacy — nothing sensitive is produced by skipping a blur). Availability is
//     remembered so a broken environment is not retried on every scan.
//   - Diagnostics go through `ocrTrace` (counts/codes only, never pixels), keeping the
//     perception modules free of console/network/storage (leakage-test invariant).
//
// WHY THE SIDE PANEL, NOT THE OFFSCREEN DOCUMENT: the M3 split-by-context decision put
// rasterization + analysis in the panel document (the service worker cannot run
// canvas/OffscreenCanvas). The face-blur step consumes THAT raster where it already
// lives; routing it through the (unregistered) offscreen document would add a
// cross-document pixel message path without any capability gain. The offscreen doc
// remains reserved for future workloads the panel genuinely cannot host.
//
// MODEL: MediaPipe BlazeFace front (128×128). Preprocessing is identical for every
// export: RGB, resized to 128×128, normalized x/127.5 - 1.0 → [-1, 1] (NOT [0, 1] —
// the weights derive from the MediaPipe TFLite model, which expects [-1, 1] inputs).
//
// TWO POST-PROCESSING CONTRACTS ARE SUPPORTED, selected from the loaded graph itself:
//
//   (A) END-TO-END export — NCHW `[1,3,128,128]`, extra `conf_threshold`/`iou`/`max`
//       graph inputs, ONE output of post-NMS rows `[N,16]` = normalized
//       (topLeftY, topLeftX, bottomRightY, bottomRightX, 12 landmark coords).
//       Anchor decode, threshold and NMS all live inside the graph → `parseDetections`.
//
//   (B) RAW-HEAD export (e.g. PINTO_model_zoo `face_detection_front_128x128_float32`,
//       MIT) — NHWC `[1,128,128,3]`, a single image input, and FOUR outputs: per-layer
//       scores `[1,512,1]`/`[1,384,1]` and per-layer regressors `[1,512,16]`/`[1,384,16]`.
//       Nothing is baked in, so the SSD post-processing MediaPipe would do in C++ runs
//       here instead → `decodeRawHeads` (896 anchors, sigmoid, box decode, NMS).
//
// Supporting BOTH matters for licensing, not for features: the exact bytes shipped are a
// provenance decision (see `extension/public/models/NOTICE.txt`), and dispatching on the
// graph's own shapes means that decision can change — in either direction — without
// touching this file or re-verifying the pipeline around it.
//
// Model presence is OPTIONAL: the build copies it into dist/ when it exists
// (`scripts/fetch-blazeface.sh`), and a missing file degrades to the honest
// zero-faces path below.

import { ocrTrace } from '../../diag/ocr-trace';

/** Model input edge (MediaPipe BlazeFace front range). */
const MODEL_INPUT_EDGE = 128;
/** Detections below this confidence are suppressed (graph input in (A), applied here in (B)). */
const CONFIDENCE_THRESHOLD = 0.7;
/** NonMaxSuppression cap (faces on a page: tiny). Graph input in (A), applied here in (B). */
const MAX_DETECTIONS = 20;
/** IoU threshold for NMS. Graph input in (A), applied here in (B). */
const IOU_THRESHOLD = 0.3;
/**
 * MediaPipe's `TensorsToDetectionsCalculator` coordinate scale for this model: the
 * regressor outputs are in input-pixel units, so dividing by the 128 input edge maps
 * them back to the normalized [0,1] space the rest of this module works in.
 */
const COORD_SCALE = MODEL_INPUT_EDGE;
/**
 * `score_clipping_thresh` from the same calculator. Clamping before the sigmoid is not
 * cosmetic: `Math.exp` of a large negative logit underflows to a denormal and the
 * unclamped form can produce NaN, which would then be silently dropped as "not finite".
 */
const SCORE_CLIP = 100;
/** ORT WASM runtime files are copied here by the build (`vite.config.ts`). */
const ORT_WASM_DIR = 'ort/';
/** Packaged model path inside the extension (copied by the build when present). */
const MODEL_PATH = 'models/blazeface.onnx';

export interface FaceBlurResult {
  facesDetected: number;
  facesBlurred: number;
}

/** Minimal raster shape (structurally identical to `RasterRegion`). */
export interface BlurRaster {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

/** Minimal session shape — real ORT sessions are wrapped into it; tests fake it. */
export interface FaceSessionLike {
  inputNames: readonly string[];
  /**
   * Declared input shapes, by input name, when the runtime exposes them. Used ONLY to
   * pick the image tensor layout: the two supported exports disagree (NCHW vs NHWC) and
   * feeding the wrong one is a hard ORT dimension error, not a degraded detection.
   * Optional so a faked session (and any runtime without metadata) keeps the NCHW default.
   */
  inputShapes?: Readonly<Record<string, readonly (number | string)[]>>;
  run(feeds: Record<string, OrtValueLike>): Promise<Record<string, OrtValueLike>>;
}

export interface OrtValueLike {
  data: Float32Array | BigInt64Array | Int32Array;
  dims: readonly number[];
}

export interface FaceRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FaceBlurEngine {
  /** Detect faces in the raster and black them out in place. Never throws. */
  blur(raster: BlurRaster): Promise<FaceBlurResult>;
}

export interface FaceBlurEngineOptions {
  /** Session factory — injectable so tests never touch ONNX or the network. */
  createSession?: () => Promise<FaceSessionLike>;
  /** Graph-level detection confidence (milestone brief: 0.7). */
  threshold?: number;
}

/** Image tensor memory layout expected by the loaded graph. */
export type TensorLayout = 'nchw' | 'nhwc';

/**
 * RGBA raster → Float32 image tensor, RGB channels in [-1, 1].
 * `layout` selects between contract (A) `[1,3,128,128]` and contract (B) `[1,128,128,3]`;
 * the pixel values are identical, only the write offset differs.
 */
export function preprocessRaster(raster: BlurRaster, layout: TensorLayout = 'nchw'): Float32Array {
  const output = new Float32Array(3 * MODEL_INPUT_EDGE * MODEL_INPUT_EDGE);
  const plane = MODEL_INPUT_EDGE * MODEL_INPUT_EDGE;
  // Bilinear resize — the same interpolation the model exporter's notebook used
  // (cv2.resize default). Nearest-neighbour downscaling loses the face detail
  // BlazeFace needs and was measured to yield zero detections.
  const scaleX = raster.width / MODEL_INPUT_EDGE;
  const scaleY = raster.height / MODEL_INPUT_EDGE;
  for (let y = 0; y < MODEL_INPUT_EDGE; y++) {
    const sourceY = Math.min(raster.height - 1, Math.max(0, y * scaleY));
    const y0 = Math.floor(sourceY);
    const y1 = Math.min(raster.height - 1, y0 + 1);
    const fy = sourceY - y0;
    for (let x = 0; x < MODEL_INPUT_EDGE; x++) {
      const sourceX = Math.min(raster.width - 1, Math.max(0, x * scaleX));
      const x0 = Math.floor(sourceX);
      const x1 = Math.min(raster.width - 1, x0 + 1);
      const fx = sourceX - x0;

      const i00 = (y0 * raster.width + x0) * 4;
      const i10 = (y0 * raster.width + x1) * 4;
      const i01 = (y1 * raster.width + x0) * 4;
      const i11 = (y1 * raster.width + x1) * 4;

      const pixel = y * MODEL_INPUT_EDGE + x;
      for (const channel of [0, 1, 2]) {
        const v00 = raster.data[i00 + channel] ?? 0;
        const v10 = raster.data[i10 + channel] ?? 0;
        const v01 = raster.data[i01 + channel] ?? 0;
        const v11 = raster.data[i11 + channel] ?? 0;
        const top = v00 * (1 - fx) + v10 * fx;
        const bottom = v01 * (1 - fx) + v11 * fx;
        const value = top * (1 - fy) + bottom * fy;
        const index = layout === 'nhwc' ? pixel * 3 + channel : channel * plane + pixel;
        output[index] = value / 127.5 - 1.0;
      }
    }
  }
  return output;
}

/**
 * Pick the image tensor layout from the graph's declared input shape. NHWC is only
 * chosen on positive evidence (`[…,3]` with a 4-D shape); anything unknown, symbolic or
 * absent keeps the NCHW default, so an unrecognised export behaves exactly as before.
 */
export function pickLayout(shape: readonly (number | string)[] | undefined): TensorLayout {
  if (shape === undefined || shape.length !== 4) return 'nchw';
  return shape[3] === 3 ? 'nhwc' : 'nchw';
}

/**
 * Parse the end-to-end graph output: [N, 16] normalized rows
 * (topLeftY, topLeftX, bottomRightY, bottomRightX, landmarks…). Rows already passed
 * the graph-level 0.7 threshold + NMS. Returns raster-space rects, clamped, with
 * degenerate or out-of-range boxes dropped.
 */
export function parseDetections(
  output: OrtValueLike,
  rasterWidth: number,
  rasterHeight: number,
): FaceRegion[] {
  const dims = output.dims;
  const rows = dims.length >= 2 ? (dims[dims.length - 2] ?? 0) : 0;
  const columns = dims.length >= 2 ? (dims[dims.length - 1] ?? 0) : 0;
  if (columns < 4) return [];

  const regions: FaceRegion[] = [];
  for (let row = 0; row < rows; row++) {
    const base = row * columns;
    const y1 = Number(output.data[base]);
    const x1 = Number(output.data[base + 1]);
    const y2 = Number(output.data[base + 2]);
    const x2 = Number(output.data[base + 3]);
    if (![y1, x1, y2, x2].every((value) => Number.isFinite(value))) continue;
    if ([y1, x1, y2, x2].some((value) => value < 0 || value > 1)) continue;

    const left = Math.min(x1, x2) * rasterWidth;
    const right = Math.max(x1, x2) * rasterWidth;
    const top = Math.min(y1, y2) * rasterHeight;
    const bottom = Math.max(y1, y2) * rasterHeight;
    const width = right - left;
    const height = bottom - top;
    if (width < 1 || height < 1) continue;

    regions.push({
      x: Math.max(0, Math.floor(left)),
      y: Math.max(0, Math.floor(top)),
      width: Math.min(rasterWidth, Math.ceil(width)),
      height: Math.min(rasterHeight, Math.ceil(height)),
    });
  }
  return regions;
}

/** One SSD anchor. `fixed_anchor_size: true` for this model, so width/height are always 1. */
export interface BlazeFaceAnchor {
  xCenter: number;
  yCenter: number;
}

/**
 * The MediaPipe `SsdAnchorsCalculator` table for `face_detection_front` (128×128):
 * strides [8, 16, 16, 16], `anchor_offset` 0.5, `fixed_anchor_size: true`.
 *
 * Layers 1–3 all share stride 16, and the generator MERGES same-stride layers into one
 * feature map with more anchors per cell — which is why the counts are 16×16×2 = 512 and
 * 8×8×6 = 384 rather than four equal layers. Those two numbers are exactly the row counts
 * the raw export reports (`[1,512,·]` / `[1,384,·]`), so a mismatch here would show up as
 * a shape mismatch rather than as quietly wrong boxes.
 *
 * Returned grouped by anchor count so regressor/score tensors can be paired with their
 * anchors by row count alone, without depending on ONNX output names or ordering.
 */
export function buildBlazeFaceAnchors(): Map<number, BlazeFaceAnchor[]> {
  const layers: { stride: number; anchorsPerCell: number }[] = [
    { stride: 8, anchorsPerCell: 2 },
    { stride: 16, anchorsPerCell: 6 },
  ];
  const grouped = new Map<number, BlazeFaceAnchor[]>();
  for (const { stride, anchorsPerCell } of layers) {
    const cells = Math.ceil(MODEL_INPUT_EDGE / stride);
    const anchors: BlazeFaceAnchor[] = [];
    for (let y = 0; y < cells; y++) {
      for (let x = 0; x < cells; x++) {
        const xCenter = (x + 0.5) / cells;
        const yCenter = (y + 0.5) / cells;
        for (let repeat = 0; repeat < anchorsPerCell; repeat++) {
          anchors.push({ xCenter, yCenter });
        }
      }
    }
    grouped.set(anchors.length, anchors);
  }
  return grouped;
}

/** Cached: the table is deterministic and rebuilding it per scan is pure waste. */
const BLAZEFACE_ANCHORS = buildBlazeFaceAnchors();

function sigmoid(logit: number): number {
  const clipped = Math.min(SCORE_CLIP, Math.max(-SCORE_CLIP, logit));
  return 1 / (1 + Math.exp(-clipped));
}

interface ScoredBox {
  score: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

function intersectionOverUnion(a: ScoredBox, b: ScoredBox): number {
  const left = Math.max(a.x1, b.x1);
  const right = Math.min(a.x2, b.x2);
  const top = Math.max(a.y1, b.y1);
  const bottom = Math.min(a.y2, b.y2);
  const overlap = Math.max(0, right - left) * Math.max(0, bottom - top);
  if (overlap <= 0) return 0;
  const areaA = (a.x2 - a.x1) * (a.y2 - a.y1);
  const areaB = (b.x2 - b.x1) * (b.y2 - b.y1);
  const union = areaA + areaB - overlap;
  return union <= 0 ? 0 : overlap / union;
}

/** Greedy IoU suppression, highest score first — the `NonMaxSuppression` node of (A). */
function suppressOverlaps(boxes: ScoredBox[]): ScoredBox[] {
  const kept: ScoredBox[] = [];
  for (const candidate of [...boxes].sort((a, b) => b.score - a.score)) {
    if (kept.length >= MAX_DETECTIONS) break;
    if (kept.some((box) => intersectionOverUnion(box, candidate) > IOU_THRESHOLD)) continue;
    kept.push(candidate);
  }
  return kept;
}

/**
 * Decode contract (B): the four raw SSD heads into raster-space rects.
 *
 * Reimplements what `TensorsToDetectionsCalculator` does for this model — sigmoid over
 * clipped logits, `reverse_output_order: true` so each regressor row is (x, y, w, h)
 * rather than (y, x, h, w), anchor-relative centres, `/128` back to normalized space —
 * then the NMS that contract (A) has baked in.
 *
 * Scores and regressors are paired BY ROW COUNT, because ONNX output names for this
 * export are positional (`Identity:0`…`Identity_3:0`) and carry no meaning. Boxes are
 * clamped into [0,1] rather than dropped when they run past the edge: a face at the frame
 * border is exactly the case where discarding the box would leave a real face unblurred.
 */
export function decodeRawHeads(
  outputs: Record<string, OrtValueLike>,
  rasterWidth: number,
  rasterHeight: number,
  threshold: number,
): FaceRegion[] {
  const scoreTensors: OrtValueLike[] = [];
  const boxTensors: OrtValueLike[] = [];
  for (const tensor of Object.values(outputs)) {
    const dims = tensor.dims;
    if (dims.length !== 3) continue;
    const rows = dims[1] ?? 0;
    if (!BLAZEFACE_ANCHORS.has(rows)) continue;
    if (dims[2] === 1) scoreTensors.push(tensor);
    else if ((dims[2] ?? 0) >= 4) boxTensors.push(tensor);
  }

  const candidates: ScoredBox[] = [];
  for (const scores of scoreTensors) {
    const rows = scores.dims[1] ?? 0;
    const anchors = BLAZEFACE_ANCHORS.get(rows);
    const boxes = boxTensors.find((tensor) => (tensor.dims[1] ?? 0) === rows);
    if (anchors === undefined || boxes === undefined) continue;
    const stride = boxes.dims[2] ?? 0;

    for (let index = 0; index < rows; index++) {
      const score = sigmoid(Number(scores.data[index]));
      if (!Number.isFinite(score) || score < threshold) continue;
      const anchor = anchors[index];
      if (anchor === undefined) continue;

      const base = index * stride;
      const xCenter = Number(boxes.data[base]) / COORD_SCALE + anchor.xCenter;
      const yCenter = Number(boxes.data[base + 1]) / COORD_SCALE + anchor.yCenter;
      const width = Number(boxes.data[base + 2]) / COORD_SCALE;
      const height = Number(boxes.data[base + 3]) / COORD_SCALE;
      if (![xCenter, yCenter, width, height].every((value) => Number.isFinite(value))) continue;
      if (width <= 0 || height <= 0) continue;

      candidates.push({
        score,
        x1: Math.min(1, Math.max(0, xCenter - width / 2)),
        y1: Math.min(1, Math.max(0, yCenter - height / 2)),
        x2: Math.min(1, Math.max(0, xCenter + width / 2)),
        y2: Math.min(1, Math.max(0, yCenter + height / 2)),
      });
    }
  }

  // Reuse contract (A)'s scaling/validation so both paths produce rects identically —
  // one clamping rule, not two that can drift apart.
  const kept = suppressOverlaps(candidates);
  const rows = new Float32Array(kept.length * 4);
  kept.forEach((box, index) => {
    rows[index * 4] = box.y1;
    rows[index * 4 + 1] = box.x1;
    rows[index * 4 + 2] = box.y2;
    rows[index * 4 + 3] = box.x2;
  });
  return parseDetections({ data: rows, dims: [kept.length, 4] }, rasterWidth, rasterHeight);
}

/** True when the loaded graph is a contract (B) raw-head export rather than end-to-end. */
export function hasRawHeads(outputs: Record<string, OrtValueLike>): boolean {
  const anchorRowCounts = new Set<number>();
  for (const tensor of Object.values(outputs)) {
    const rows = tensor.dims.length === 3 ? (tensor.dims[1] ?? 0) : 0;
    if (BLAZEFACE_ANCHORS.has(rows)) anchorRowCounts.add(rows);
  }
  return anchorRowCounts.size === BLAZEFACE_ANCHORS.size;
}


export function blurRegions(raster: BlurRaster, regions: FaceRegion[]): number {
  let blurred = 0;
  for (const region of regions) {
    const xStart = Math.max(0, Math.floor(region.x));
    const yStart = Math.max(0, Math.floor(region.y));
    const xEnd = Math.min(raster.width, Math.ceil(region.x + region.width));
    const yEnd = Math.min(raster.height, Math.ceil(region.y + region.height));
    if (xEnd <= xStart || yEnd <= yStart) continue;
    for (let y = yStart; y < yEnd; y++) {
      for (let x = xStart; x < xEnd; x++) {
        const index = (y * raster.width + x) * 4;
        raster.data[index] = 0;
        raster.data[index + 1] = 0;
        raster.data[index + 2] = 0;
        raster.data[index + 3] = 255;
      }
    }
    blurred++;
  }
  return blurred;
}

function pickInputName(inputNames: readonly string[], keyword: string): string | undefined {
  return inputNames.find((name) => name.toLowerCase().includes(keyword));
}

/**
 * Find the image input. The graph may name it `input` (PINTO-style) or `image`
 * (MediaPipe conversion — the model actually in use). Matching ONLY by the keyword
 * `input` silently missed `image` and made the engine return zero faces; both spellings
 * are accepted, and the confidence/IoU/max-detection inputs are matched separately.
 */
function pickImageInput(inputNames: readonly string[]): string | undefined {
  return inputNames.find((name) => /image|input/i.test(name));
}

/**
 * Default session factory (extension runtime): lazy ONNX WASM session over the
 * packaged model + runtime files. The real ORT session is wrapped into the minimal
 * `FaceSessionLike` shape so the engine logic stays runtime-agnostic and testable.
 * Never called in tests (they inject their own factory).
 */
async function createOrtSession(): Promise<FaceSessionLike> {
  const ort = await import('onnxruntime-web');
  // WASM backend only (milestone brief: WebGPU is unstable in MV3 contexts). The
  // threaded WASM needs cross-origin isolation for multi-threading, which extension
  // pages do not have — pin to a single thread explicitly.
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.wasmPaths = chrome.runtime.getURL(ORT_WASM_DIR);
  const session = await ort.InferenceSession.create(chrome.runtime.getURL(MODEL_PATH), {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all',
  });

  const inputShapes: Record<string, readonly (number | string)[]> = {};
  for (const meta of session.inputMetadata) {
    if (meta.isTensor) inputShapes[meta.name] = meta.shape;
  }

  return {
    inputNames: session.inputNames,
    inputShapes,
    run: async (feeds) => {
      const tensors: Record<string, import('onnxruntime-web').Tensor> = {};
      for (const [name, value] of Object.entries(feeds)) {
        tensors[name] =
          value.data instanceof BigInt64Array
            ? new ort.Tensor('int64', value.data, value.dims)
            : new ort.Tensor('float32', value.data as Float32Array, value.dims);
      }
      const output = await session.run(tensors);
      const wrapped: Record<string, OrtValueLike> = {};
      for (const [name, tensor] of Object.entries(output)) {
        wrapped[name] = { data: tensor.data as Float32Array, dims: tensor.dims };
      }
      return wrapped;
    },
  };
}

export function createFaceBlurEngine(options: FaceBlurEngineOptions = {}): FaceBlurEngine {
  const threshold = options.threshold ?? CONFIDENCE_THRESHOLD;
  let sessionPromise: Promise<FaceSessionLike> | null = null;
  let unavailable = false;

  const getSession = async (): Promise<FaceSessionLike> => {
    if (unavailable) throw new Error('FACE_BLUR_UNAVAILABLE');
    sessionPromise ??= (options.createSession ?? createOrtSession)();
    try {
      return await sessionPromise;
    } catch (error) {
      // Model/runtime unavailable: never retry-spam a broken environment, and never
      // block the pipeline. Counts stay zero (documented honest gap).
      unavailable = true;
      sessionPromise = null;
      ocrTrace('FACE_BLUR_UNAVAILABLE', {
        reason: error instanceof Error ? error.name : 'UNKNOWN',
        detail: error instanceof Error ? error.message.slice(0, 400) : '',
      });
      throw new Error('FACE_BLUR_UNAVAILABLE');
    }
  };

  return {
    async blur(raster: BlurRaster): Promise<FaceBlurResult> {
      try {
        const session = await getSession();

        const feeds: Record<string, OrtValueLike> = {};
        const imageInput = pickImageInput(session.inputNames);
        if (imageInput === undefined) throw new Error('FACE_BLUR_INPUT_MISSING');
        const layout = pickLayout(session.inputShapes?.[imageInput]);
        feeds[imageInput] = {
          data: preprocessRaster(raster, layout),
          dims:
            layout === 'nhwc'
              ? [1, MODEL_INPUT_EDGE, MODEL_INPUT_EDGE, 3]
              : [1, 3, MODEL_INPUT_EDGE, MODEL_INPUT_EDGE],
        };
        // Contract (A) only: absent on a raw-head graph, which takes the image alone.
        const confidenceInput = pickInputName(session.inputNames, 'conf');
        if (confidenceInput !== undefined) {
          feeds[confidenceInput] = { data: new Float32Array([threshold]), dims: [1] };
        }
        const iouInput = pickInputName(session.inputNames, 'iou');
        if (iouInput !== undefined) {
          feeds[iouInput] = { data: new Float32Array([IOU_THRESHOLD]), dims: [1] };
        }
        const maxDetectionsInput = pickInputName(session.inputNames, 'max');
        if (maxDetectionsInput !== undefined) {
          feeds[maxDetectionsInput] = {
            data: new BigInt64Array([BigInt(MAX_DETECTIONS)]),
            dims: [1],
          };
        }

        const outputs = await session.run(feeds);
        // Dispatch on the graph's OWN output shapes, not on a build-time flag: whichever
        // licensed export is packaged, the correct post-processing is selected at runtime.
        let regions: FaceRegion[];
        if (hasRawHeads(outputs)) {
          regions = decodeRawHeads(outputs, raster.width, raster.height, threshold);
        } else {
          const outputName = Object.keys(outputs)[0];
          const output = outputName === undefined ? undefined : outputs[outputName];
          if (!output) return { facesDetected: 0, facesBlurred: 0 };
          regions = parseDetections(output, raster.width, raster.height);
        }

        const facesBlurred = blurRegions(raster, regions);
        ocrTrace('FACE_BLUR_DONE', { facesDetected: regions.length, facesBlurred });
        return { facesDetected: regions.length, facesBlurred };
      } catch {
        // Missing model / runtime / session failure → degrade honestly, continue.
        return { facesDetected: 0, facesBlurred: 0 };
      }
    },
  };
}
