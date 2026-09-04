// M3 — region bounding, capping, and minimal-resolution scaling.

import { describe, expect, it } from 'vitest';
import {
  MAX_ANALYSIS_EDGE,
  MAX_REGIONS,
  MAX_UPSCALE,
  OCR_ANALYSIS_EDGE,
  OCR_MIN_ANALYSIS_EDGE,
  analysisScale,
  selectRegions,
} from '../../extension/src/perception/visual/regions';
import type { DomVisualCandidate, DomVisualSnapshot } from '../../extension/src/types/contracts';

const snapshot: DomVisualSnapshot = {
  url: 'https://example.test/',
  viewport: { width: 1000, height: 800 },
  domTextLength: 0,
  candidates: [],
};

function candidate(x: number, y: number, width: number, height: number): DomVisualCandidate {
  return { kind: 'image', rect: { x, y, width, height }, hasAccessibleText: false, domTextLength: 0 };
}

describe('selectRegions', () => {
  it('caps the number of analysed regions', () => {
    const many = Array.from({ length: 12 }, (_, i) => candidate(i * 10, i * 10, 200, 200));
    expect(selectRegions(snapshot, many)).toHaveLength(MAX_REGIONS);
  });

  it('keeps the largest regions first and is deterministic', () => {
    const regions = selectRegions(snapshot, [
      candidate(0, 0, 100, 100),
      candidate(0, 0, 300, 300),
      candidate(0, 0, 200, 200),
    ]);
    expect(regions.map((r) => r.width)).toEqual([300, 200, 100]);
    expect(selectRegions(snapshot, [candidate(0, 0, 300, 300)])).toEqual(
      selectRegions(snapshot, [candidate(0, 0, 300, 300)]),
    );
  });

  it('clips regions that overhang the viewport', () => {
    const [region] = selectRegions(snapshot, [candidate(900, 700, 400, 400)]);
    expect(region).toBeDefined();
    expect(region?.x).toBe(900);
    expect(region?.width).toBe(100);
    expect(region?.height).toBe(100);
  });

  it('drops regions fully outside the viewport', () => {
    expect(selectRegions(snapshot, [candidate(5000, 5000, 200, 200)])).toEqual([]);
  });

  it('drops regions that become too small after clipping', () => {
    expect(selectRegions(snapshot, [candidate(990, 0, 200, 200)])).toEqual([]);
  });

  it('returns nothing when the viewport has no area', () => {
    const zero = { ...snapshot, viewport: { width: 0, height: 0 } };
    expect(selectRegions(zero, [candidate(0, 0, 200, 200)])).toEqual([]);
  });

  it('handles negative offsets from scrolled-up elements', () => {
    const [region] = selectRegions(snapshot, [candidate(-50, -50, 200, 200)]);
    expect(region?.x).toBe(0);
    expect(region?.y).toBe(0);
    expect(region?.width).toBe(150);
  });
});

// The measured cause of the "only ~1 region analysed" report on a real chat UI: a
// full-bleed backdrop plus a wrapper/image duplicate pair ate a 4-region budget while
// every 48px avatar was below the old area floor. These lock in the fix.
describe('selectRegions on a dense, realistic UI', () => {
  const chat: DomVisualSnapshot = {
    url: 'https://chat.example.test/',
    viewport: { width: 1280, height: 800 },
    domTextLength: 350,
    candidates: [],
  };

  /** 8 sidebar avatars (48px), 3 thread canvases, 1 sticker — as a chat UI paints them. */
  const dense = [
    ...Array.from({ length: 8 }, (_, i) => candidate(14, 66 + i * 69, 48, 48)),
    candidate(430, 397, 420, 151),
    candidate(730, 148, 300, 201),
    candidate(730, 595, 260, 171),
    candidate(730, 300, 96, 96),
  ];

  it('selects MANY independent regions, not one collapsed region', () => {
    const regions = selectRegions(chat, dense);
    expect(regions).toHaveLength(MAX_REGIONS);
    expect(new Set(regions.map((r) => r.id)).size).toBe(regions.length);
  });

  it('keeps 48px avatars as regions of their own', () => {
    const regions = selectRegions(chat, dense);
    const avatars = regions.filter((r) => r.width === 48 && r.height === 48);
    expect(avatars.length).toBeGreaterThan(0);
    // Distinct y positions ⇒ genuinely separate elements, not one merged strip.
    expect(new Set(avatars.map((r) => r.y)).size).toBe(avatars.length);
  });

  it('ranks a viewport-sized backdrop behind ordinary content regions', () => {
    const backdrop = candidate(0, 0, 1280, 800);
    const regions = selectRegions(chat, [backdrop, ...dense]);
    const backdropIndex = regions.findIndex((r) => r.width === 1280 && r.height === 800);
    // Present or dropped by the cap — but never ahead of real content.
    if (backdropIndex >= 0) expect(backdropIndex).toBe(regions.length - 1);
    expect(regions.filter((r) => r.width === 48)).not.toHaveLength(0);
  });

  it('collapses a wrapper/image duplicate pair into one region', () => {
    const image = candidate(730, 148, 300, 200);
    const wrapper = candidate(730, 148, 302, 202);
    const regions = selectRegions(chat, [image, wrapper]);
    expect(regions).toHaveLength(1);
  });

  it('keeps genuinely distinct overlapping regions separate', () => {
    // A badge sitting on a card overlaps it, but is its own element.
    const card = candidate(100, 100, 300, 200);
    const badge = candidate(360, 260, 60, 60);
    expect(selectRegions(chat, [card, badge])).toHaveLength(2);
  });
});

describe('analysisScale', () => {
  it('never upscales small regions', () => {
    expect(analysisScale(50, 40)).toBe(1);
  });

  it('downscales so the longest edge fits the analysis budget', () => {
    const scale = analysisScale(1000, 500);
    expect(Math.round(1000 * scale)).toBe(MAX_ANALYSIS_EDGE);
    expect(scale).toBeLessThan(1);
  });

  it('is safe for degenerate input', () => {
    expect(analysisScale(0, 0)).toBe(1);
  });

  // OCR path only: sub-legible crops are the reason a 48px avatar returned zero words.
  it('upscales a small crop to the OCR floor when minEdge is given', () => {
    const scale = analysisScale(48, 48, OCR_ANALYSIS_EDGE, OCR_MIN_ANALYSIS_EDGE);
    expect(scale).toBe(MAX_UPSCALE);
    expect(48 * scale).toBeGreaterThanOrEqual(48 * MAX_UPSCALE);
  });

  it('caps interpolation at MAX_UPSCALE instead of blurring without limit', () => {
    expect(analysisScale(16, 16, OCR_ANALYSIS_EDGE, OCR_MIN_ANALYSIS_EDGE)).toBe(MAX_UPSCALE);
  });

  it('reaches the OCR floor exactly when it is within the cap', () => {
    const scale = analysisScale(256, 128, OCR_ANALYSIS_EDGE, OCR_MIN_ANALYSIS_EDGE);
    expect(Math.round(256 * scale)).toBe(OCR_MIN_ANALYSIS_EDGE);
  });

  it('still downscales an oversized crop even on the OCR path', () => {
    const scale = analysisScale(4000, 2000, OCR_ANALYSIS_EDGE, OCR_MIN_ANALYSIS_EDGE);
    expect(Math.round(4000 * scale)).toBe(OCR_ANALYSIS_EDGE);
  });

  it('leaves a crop already inside the band untouched', () => {
    expect(analysisScale(700, 300, OCR_ANALYSIS_EDGE, OCR_MIN_ANALYSIS_EDGE)).toBe(1);
  });
});
