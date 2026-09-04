// Region selection + bounding for M3.
//
// Enforces the "targeted, bounded, minimal resolution" rule: we never process a
// full page, never process more than MAX_REGIONS areas, and never analyse pixels
// at a higher resolution than the analysis actually needs.

import type { DomVisualCandidate, DomVisualSnapshot, VisualRegion } from '../../types/contracts';
import { MIN_CANDIDATE_EDGE } from './decision';

/**
 * Hard cap on regions analysed per run — bounds CPU and memory.
 *
 * Raised from 4 to 8 in M3: a real chat/media UI presents many independent small
 * regions (avatars, thumbnails, stickers), and a cap of 4 combined with pure
 * area-descending ranking let one or two large surfaces consume the whole budget —
 * the measured cause of "only ~1 region analysed" on a busy page. The cap is still
 * a HARD bound and is surfaced honestly: `metrics.regionsSelected` reports what was
 * selected, never a pretend total (see docs/m3-visual-perception.md §8).
 */
export const MAX_REGIONS = 8;
/** Analysis raster is downscaled so its longest edge is at most this many px. */
export const MAX_ANALYSIS_EDGE = 192;
/**
 * Analysis raster edge for regions that will also be fed to an OCR/vision CONTENT
 * analyzer: pattern recognition needs real pixel density, and the structural
 * `MAX_ANALYSIS_EDGE` budget shrinks 28px text to unreadable ~8px. Used ONLY when a
 * content analyzer is registered, so the default pipeline is unchanged.
 */
export const OCR_ANALYSIS_EDGE = 1024;
/**
 * Lower bound on the longest edge of a raster handed to an OCR/vision engine.
 * Tesseract needs roughly 30px of glyph cap-height to recognise a word; a 48x48
 * avatar or a 96x24 badge cropped at native size reaches it far below that and
 * yields zero words — an `ok` status with no findings, which reads as "OCR found
 * nothing" when the truth is "OCR was handed unreadable pixels". Upscaling is
 * interpolation, not invention: it adds no information, it only stops throwing the
 * information away.
 */
export const OCR_MIN_ANALYSIS_EDGE = 512;
/** Ceiling on interpolation. Beyond this an upscale is pure blur, so we stop. */
export const MAX_UPSCALE = 4;
/**
 * A single region covering more than this share of the viewport is usually a
 * backdrop/wallpaper rather than a discrete piece of content. It is NOT dropped —
 * it is ranked after the ordinary regions so it cannot starve them of budget.
 */
export const OVERSIZED_VIEWPORT_SHARE = 0.6;
/**
 * Intersection-over-union at or above which two candidate rects are treated as the
 * same region. Deliberately strict: a wrapper element and the image inside it share
 * geometry almost exactly, while genuinely distinct-but-overlapping regions (a badge
 * on a card) stay separate.
 */
export const NEAR_DUPLICATE_IOU = 0.95;

/** Clamp a candidate rect into the visible viewport, in integer CSS pixels. */
function clampToViewport(
  rect: DomVisualCandidate['rect'],
  viewport: DomVisualSnapshot['viewport'],
): { x: number; y: number; width: number; height: number } | null {
  const vw = Math.max(0, Math.floor(viewport?.width ?? 0));
  const vh = Math.max(0, Math.floor(viewport?.height ?? 0));
  if (vw === 0 || vh === 0) return null;

  const left = Math.max(0, Math.floor(rect.x));
  const top = Math.max(0, Math.floor(rect.y));
  const right = Math.min(vw, Math.ceil(rect.x + rect.width));
  const bottom = Math.min(vh, Math.ceil(rect.y + rect.height));

  const width = right - left;
  const height = bottom - top;
  if (width < MIN_CANDIDATE_EDGE || height < MIN_CANDIDATE_EDGE) return null;

  return { x: left, y: top, width, height };
}

type Rect = { x: number; y: number; width: number; height: number };

/** Intersection-over-union of two rects. 0 when they do not overlap. */
function iou(a: Rect, b: Rect): number {
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  const overlap = Math.max(0, right - left) * Math.max(0, bottom - top);
  if (overlap === 0) return 0;
  const union = a.width * a.height + b.width * b.height - overlap;
  return union <= 0 ? 0 : overlap / union;
}

/**
 * Turn accepted candidates into a bounded, deterministic set of regions.
 *
 * Off-screen and sub-threshold candidates are dropped. Near-identical rects (a
 * wrapper element and the image it contains) collapse to one so a duplicate cannot
 * spend budget twice. Ordinary regions are ranked ahead of viewport-sized backdrops,
 * then by area descending; ordering is stable so caching is reproducible across runs.
 */
export function selectRegions(
  snapshot: DomVisualSnapshot,
  candidates: readonly DomVisualCandidate[],
): VisualRegion[] {
  const clamped: Rect[] = [];

  for (const candidate of candidates) {
    const rect = clampToViewport(candidate.rect, snapshot.viewport);
    if (rect !== null) clamped.push(rect);
  }

  const viewportArea =
    Math.max(0, snapshot.viewport?.width ?? 0) * Math.max(0, snapshot.viewport?.height ?? 0);
  // Tier 1 = covers most of the viewport (likely decorative backdrop) ⇒ ranked last.
  const tier = (rect: Rect): number =>
    viewportArea > 0 && (rect.width * rect.height) / viewportArea > OVERSIZED_VIEWPORT_SHARE ? 1 : 0;

  clamped.sort((a, b) => {
    const tierDelta = tier(a) - tier(b);
    if (tierDelta !== 0) return tierDelta;
    const areaDelta = b.width * b.height - a.width * a.height;
    if (areaDelta !== 0) return areaDelta;
    if (a.y !== b.y) return a.y - b.y;
    return a.x - b.x;
  });

  // Deduplicate AFTER ranking so the better-ranked rect of a duplicate pair survives.
  const kept: Rect[] = [];
  for (const rect of clamped) {
    if (kept.length >= MAX_REGIONS) break;
    if (kept.some((existing) => iou(existing, rect) >= NEAR_DUPLICATE_IOU)) continue;
    kept.push(rect);
  }

  return kept.map((rect) => ({
    id: `r-${rect.x}-${rect.y}-${rect.width}x${rect.height}`,
    ...rect,
  }));
}

/**
 * Scale factor for the analysis raster.
 *
 * Downscales whenever the longest edge exceeds `maxEdge`. When `minEdge` is given
 * (the OCR path) a crop SMALLER than that is upscaled up to `MAX_UPSCALE`, because an
 * OCR engine handed sub-legible pixels returns nothing at all. Without `minEdge` the
 * behaviour is unchanged: never upscale.
 */
export function analysisScale(
  width: number,
  height: number,
  maxEdge: number = MAX_ANALYSIS_EDGE,
  minEdge?: number,
): number {
  const longest = Math.max(width, height);
  if (longest <= 0) return 1;
  if (longest > maxEdge) return maxEdge / longest;
  if (minEdge !== undefined && minEdge > longest) {
    return Math.min(minEdge / longest, MAX_UPSCALE);
  }
  return 1;
}
