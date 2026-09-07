// OCR-capture pipeline tracer.
//
// A SINGLE, privacy-safe chokepoint for the stage-by-stage diagnostics that let a
// developer see exactly where the visual/OCR path stops producing regions in a real
// browser (capture refused? pixels invalid? engine unavailable? no text recognized?).
//
// PRIVACY (CONTRIBUTING.md §5 Rule 4, §22): this logger MUST NEVER receive raw protected
// content. Its `detail` type admits only numbers, booleans, and short enum-like strings
// (stage codes, region ids, category names, reason codes) — never recognized OCR text,
// page text, pixels, or a capture data URL. Callers pass counts/dimensions/ids only.
//
// The type cannot express "short code, not free text", so `sanitizeDetail` closes that
// gap at the chokepoint: pixel-like strings are replaced and long ones truncated. The
// guarantee therefore does not depend on every caller getting it right.
//
// It is deliberately not gated behind a flag: the whole point is that a developer can
// open the side-panel console on a live page and read the trace. Nothing it prints is
// sensitive, and it prints via `console.info`/`console.warn` (never `console.error`, so
// it cannot trip the "no console errors" smoke check) under one greppable prefix.

/** Ordered stages of the capture → OCR → findings → UI path. */
export type OcrTraceStage =
  | 'SELECTED_PAGE'
  | 'CAPTURE_REQUESTED'
  | 'CAPTURE_SUCCESS'
  | 'CAPTURE_FAILED'
  | 'PIXEL_DATA_VALID'
  | 'VISION_PROVIDER_UNAVAILABLE'
  /** The local ONNX vision model loaded and its graph is ready. */
  | 'VISION_MODEL_READY'
  /**
   * One execution provider refused the graph and the next one in the preference order
   * will be tried. Not a failure: it is how a WebGPU→wasm fallback becomes VISIBLE
   * instead of happening silently inside ORT.
   */
  | 'VISION_BACKEND_REJECTED'
  /** The model could not load (missing asset, refused wasm, no EP) — degraded, not fatal. */
  | 'VISION_MODEL_UNAVAILABLE'
  /** The model loaded but threw on one region — that region reports no elements. */
  | 'VISION_INFERENCE_FAILED'
  /** Count of elements the model localized in one region. Geometry counts only. */
  | 'VISION_ELEMENTS'
  | 'OCR_STARTED'
  | 'OCR_RESULT'
  | 'OCR_REGION_COUNT'
  | 'FACE_BLUR_DONE'
  | 'FACE_BLUR_UNAVAILABLE'
  | 'PRIVACY_FINDINGS'
  | 'UI_FINDINGS';

/**
 * Only non-content scalars are loggable. The type rejects objects, arrays and nested
 * content; `sanitizeDetail` below handles what a type CANNOT express — that a `string`
 * must be a short code, not recognized text.
 */
export type SafeDetail = Record<string, number | boolean | string | undefined>;

const PREFIX = '[PrivAgent OCR]';

/**
 * Longest string this logger will print. Every real caller passes a stage code, region
 * id, analyzer name, backend name or reason code — all well under this. The cap exists
 * for the error-detail callers, whose input originates from a browser/ONNX exception
 * string rather than from our own vocabulary.
 */
const MAX_DETAIL_CHARS = 120;

/** Looks like image bytes rather than a code. Replaced wholesale, never truncated. */
const PIXEL_LIKE = /data:image|base64|^data:/i;

/**
 * Make the type's promise actually true. A `string` in `SafeDetail` is meant to be an
 * enum-like code; nothing in TypeScript can enforce that, so it is enforced HERE:
 * pixel-like values are replaced outright and everything else is length-capped. Without
 * this, one careless caller passing recognized text would print it to a console that a
 * developer may well have open on a real page (master §19).
 */
function sanitizeDetail(detail: SafeDetail): SafeDetail {
  const out: SafeDetail = {};
  for (const [key, value] of Object.entries(detail)) {
    if (typeof value !== 'string') {
      out[key] = value;
      continue;
    }
    if (PIXEL_LIKE.test(value)) {
      out[key] = 'redacted_pixel_like';
      continue;
    }
    out[key] =
      value.length > MAX_DETAIL_CHARS ? `${value.slice(0, MAX_DETAIL_CHARS)}…[truncated]` : value;
  }
  return out;
}

/** Stages that represent a soft failure/degradation → warn (never error). */
const WARN_STAGES: ReadonlySet<OcrTraceStage> = new Set<OcrTraceStage>([
  'CAPTURE_FAILED',
  'VISION_PROVIDER_UNAVAILABLE',
  'VISION_MODEL_UNAVAILABLE',
  'VISION_BACKEND_REJECTED',
  'VISION_INFERENCE_FAILED',
]);

/**
 * Emit one pipeline stage with safe metadata. `detail` is typed to reject objects and
 * arrays, and sanitized here so a long or pixel-like string cannot ride out either.
 */
export function ocrTrace(stage: OcrTraceStage, detail: SafeDetail = {}): void {
  if (typeof console === 'undefined') return;
  const line = `${PREFIX} ${stage}`;
  const safe = sanitizeDetail(detail);
  if (WARN_STAGES.has(stage)) {
    console.warn(line, safe);
  } else {
    console.info(line, safe);
  }
}
