// M7 — visual-context stats seam (rubric #1: accuracy of visual context).
//
// After a visual perception run, the panel records a NON-CONTENT aggregate on its own
// window: the content-analysis status and per-CATEGORY counts of OCR/vision findings.
// Deliberately NOT exposed: recognized text, bboxes, region ids, pixels — the agent
// never receives those either, so category counts are exactly the accuracy surface
// that matters. Value-free by construction (CONTRIBUTING.md §5 Rule 4).

import type {
  SensitiveCategory,
  VisualContentStatus,
  VisualPerceptionMetrics,
  VisualPerceptionResult,
} from '../types/contracts';

export interface VisualStatsSnapshot {
  contentStatus?: VisualContentStatus;
  categories: Partial<Record<SensitiveCategory, number>>;
  regionsProcessed: number;
  /** M7.5 — faces found + blacked in the raster before OCR (counts only). */
  faceStats?: { facesDetected: number; facesBlurred: number };
  /**
   * M10 — the run's measured performance metrics, forwarded verbatim.
   *
   * Timings, counters, an EP name and a heap size: numbers about the RUN, not about the
   * page, so this stays value-free in the same way the category counts do. Exposing them
   * here is what lets an e2e benchmark read real per-stage latency out of a live browser
   * instead of a bench harness inventing it. Fields the run did not measure are absent.
   */
  metrics?: VisualPerceptionMetrics;
  capturedAt: number;
}

declare global {
  interface Window {
    __PRIVAGENT_VISUAL__?: VisualStatsSnapshot;
  }
}

export function recordVisualStats(result: VisualPerceptionResult): void {
  const categories: Partial<Record<SensitiveCategory, number>> = {};
  for (const finding of result.contentFindings ?? []) {
    categories[finding.category] = (categories[finding.category] ?? 0) + 1;
  }
  window.__PRIVAGENT_VISUAL__ = {
    contentStatus: result.contentStatus,
    categories,
    regionsProcessed: result.metrics.regionsProcessed,
    faceStats: result.faceStats,
    metrics: result.metrics,
    capturedAt: Date.now(),
  };
}
