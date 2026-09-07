// M3 → agent-loop integration (master §3): the agent path must perceive on the SAME
// DOM-first terms as a manual scan, and its visual signals must reach M4/M5 without any
// pixel or recognized-text ever entering the outbound request.
//
// These tests drive the REAL `createVisualPerceptionService` — not a stub of it — with a
// spy on `captureViewport`. That is the point: a stub could not prove that the DOM-first
// gate prevents capture, only that the loop called something. The spy makes "no visual
// models ran" an observed fact rather than an assertion about intent.

import { describe, expect, it, vi } from 'vitest';
import { runAgentLoop } from '../../../extension/src/agent/loop';
import { createDeterministicPlanner } from '../../../extension/src/agent/planner';
import { createActionBridge } from '../../../extension/src/actions';
import { createPrivacyFirewall } from '../../../extension/src/firewall';
import { createLocalVault } from '../../../extension/src/vault';
import { createVisualPerceptionService } from '../../../extension/src/perception/visual';
import type {
  DomVisualSnapshot,
  RemoteAgentRequest,
  VisualPerceptionResult,
} from '../../../extension/src/types/contracts';
import type { FieldStructure, ScanPageResponse } from '../../../extension/src/types/messages';

const OCR_CANARY = 'CANARY_EMAIL_001@example.test';

/** Enough DOM text + described candidates that `decideVisualPerception` says `dom_sufficient`. */
function domSufficientSnapshot(): DomVisualSnapshot {
  return {
    url: 'https://shop.example.test/checkout',
    viewport: { width: 1280, height: 800 },
    domTextLength: 4200,
    candidates: [
      {
        kind: 'image',
        rect: { x: 10, y: 10, width: 300, height: 200 },
        hasAccessibleText: true,
        domTextLength: 24,
      },
    ],
  };
}

/** A large undescribed canvas: `visual_only_content_present`, so the gate opens. */
function domInsufficientSnapshot(): DomVisualSnapshot {
  return {
    url: 'https://app.example.test/board',
    viewport: { width: 1280, height: 800 },
    domTextLength: 12,
    candidates: [
      {
        kind: 'canvas',
        rect: { x: 0, y: 0, width: 900, height: 600 },
        hasAccessibleText: false,
        domTextLength: 0,
      },
    ],
  };
}

const STRUCTURE: FieldStructure[] = [
  { tag: 'button', selector: '#continue', label: 'Continue', disabled: false },
];

function scanReturning(snapshot: DomVisualSnapshot | null) {
  return async (): Promise<ScanPageResponse> => ({
    pageText: 'Checkout — review your order and continue.',
    snapshot,
    structure: STRUCTURE,
  });
}

/**
 * Runs the loop with an injected visual observer, capturing every outbound request.
 * `maxSteps: 1` keeps the assertions about ONE observation.
 */
async function runWith(
  scan: () => Promise<ScanPageResponse>,
  observeVisual?: (snapshot: DomVisualSnapshot) => Promise<VisualPerceptionResult>,
) {
  const requests: RemoteAgentRequest[] = [];
  const events: { type: string; code: string }[] = [];
  const vault = createLocalVault();
  const planner = createDeterministicPlanner();
  const result = await runAgentLoop({
    task: 'continue to the next page',
    maxSteps: 1,
    sessionId: 'visual-integration',
    vault,
    gateway: {
      plan: async (request) => {
        requests.push(request);
        return planner.plan(request);
      },
    },
    bridge: createActionBridge({ vault, sendToPage: async () => ({ ok: true, code: 'OK' }) }),
    firewall: createPrivacyFirewall(),
    scan,
    observeVisual,
    onEvent: (event) => events.push({ type: event.type, code: event.code }),
  });
  return { result, requests, events };
}

describe('M3 → agent loop (master §3)', () => {
  it('does NOT capture or run any visual model when the DOM is sufficient', async () => {
    const captureViewport = vi.fn();
    const service = createVisualPerceptionService({ captureViewport });

    const { result, events } = await runWith(scanReturning(domSufficientSnapshot()), (snapshot) =>
      service.run(snapshot),
    );

    // The gate ran and answered "no" — the expensive path was never entered.
    expect(captureViewport).not.toHaveBeenCalled();
    expect(events).toContainEqual({ type: 'VISUAL', code: 'dom_sufficient' });
    expect(result.status).not.toBe('error');
    service.dispose();
  });

  it('invokes the visual service when the DOM is insufficient, and stays local', async () => {
    // Rasterization is declared available (jsdom has neither ImageBitmap nor
    // OffscreenCanvas, so the real probe would short-circuit before capture), and the
    // rasterizer yields null — a supported outcome. Together that exercises the gate →
    // capture → region path WITHOUT loading ONNX, which is what this test is about.
    const captureViewport = vi.fn(async () => 'data:image/png;base64,iVBORw0KGgo=');
    const service = createVisualPerceptionService({
      captureViewport,
      capabilities: { backends: ['cpu'], canRasterize: true, hasDocument: false },
      rasterize: async () => null,
    });

    const { requests } = await runWith(scanReturning(domInsufficientSnapshot()), (snapshot) =>
      service.run(snapshot),
    );

    expect(captureViewport).toHaveBeenCalledTimes(1);
    // Whatever the outcome of analysis, NOTHING image-derived reached the request.
    const serialized = JSON.stringify(requests);
    expect(serialized).not.toContain('data:image');
    expect(serialized).not.toContain('base64');
    service.dispose();
  });

  it('reports rasterization_unsupported rather than silently skipping the gate', async () => {
    // The real capability probe in this environment: the gate said YES, the context
    // cannot rasterize, so M3 degrades to a structured `unavailable` — NOT to
    // `not_required`, which would misreport a capability failure as a DOM-first saving.
    const captureViewport = vi.fn();
    const service = createVisualPerceptionService({ captureViewport });

    const { events } = await runWith(scanReturning(domInsufficientSnapshot()), (snapshot) =>
      service.run(snapshot),
    );

    expect(events).toContainEqual({
      type: 'VISUAL',
      code: 'rasterization_unsupported_in_context',
    });
    expect(captureViewport).not.toHaveBeenCalled();
    service.dispose();
  });

  it('passes visual findings into the policy signals (they reach M4, not the request)', async () => {
    // A completed result carrying an OCR finding WITH geometry: policy must see the
    // category, and the recognized text must not survive into the outbound request.
    const observeVisual = async (): Promise<VisualPerceptionResult> => ({
      status: 'completed',
      supported: true,
      observations: [],
      contentStatus: 'ok',
      contentFindings: [
        {
          regionId: 'r1',
          category: 'EMAIL',
          confidence: 0.94,
          source: 'OCR',
          provider: 'test-ocr',
          text: OCR_CANARY,
          bbox: [12, 40, 220, 28],
        },
      ],
      metrics: {
        candidatesConsidered: 1,
        regionsSelected: 1,
        regionsProcessed: 1,
        regionsFromCache: 0,
        durationMs: 42,
      },
    });

    const { result, requests, events } = await runWith(
      scanReturning(domInsufficientSnapshot()),
      observeVisual,
    );

    expect(events).toContainEqual({ type: 'VISUAL', code: 'completed' });
    // The finding had a bbox, so M5 neutralised it by masking — the loop keeps going.
    expect(result.status).not.toBe('not_enforced');
    // Reaching the gateway proves enforcement PASSED with the visual signal present,
    // rather than the assertion above passing because the run died earlier.
    expect(requests).not.toHaveLength(0);
    // The OCR text itself never crosses. This is the leakage assertion that matters.
    expect(JSON.stringify(requests)).not.toContain('CANARY_EMAIL_001');
    expect(result.stageMs.visualMs).toBeGreaterThanOrEqual(0);
  });

  it('the visual signal genuinely gates egress: an OCR-only password blocks the run', async () => {
    // The differential half of the test above, and the load-bearing one. This finding
    // exists ONLY in the visual channel — the DOM text carries no password whatsoever —
    // so if `signals.visual` were being dropped on the floor the run would sail straight
    // through to the gateway. Instead M4 sees a critical category and M5 fails closed.
    const { result, requests } = await runWith(
      scanReturning(domInsufficientSnapshot()),
      async () => ({
        status: 'completed',
        supported: true,
        observations: [],
        contentStatus: 'ok',
        contentFindings: [
          {
            regionId: 'r1',
            category: 'PASSWORD',
            confidence: 0.97,
            source: 'OCR',
            provider: 'test-ocr',
            bbox: [0, 0, 0, 0],
          },
        ],
        metrics: {
          candidatesConsidered: 1,
          regionsSelected: 1,
          regionsProcessed: 1,
          regionsFromCache: 0,
          durationMs: 12,
        },
      }),
    );

    expect(result.status).toBe('blocked');
    expect(requests).toHaveLength(0);
  });

  it('stops the run when visual perception reports a restricted surface', async () => {
    const { result, requests } = await runWith(
      scanReturning(domInsufficientSnapshot()),
      async () => ({
        status: 'restricted_page',
        supported: true,
        reason: 'browser_security_restriction',
        observations: [],
        metrics: {
          candidatesConsidered: 0,
          regionsSelected: 0,
          regionsProcessed: 0,
          regionsFromCache: 0,
          durationMs: 1,
        },
      }),
    );

    expect(result.status).toBe('restricted');
    expect(requests).toHaveLength(0);
  });

  it('fails CLOSED on observer failure: no bypass, no raw fallback', async () => {
    const { result, requests, events } = await runWith(
      scanReturning(domInsufficientSnapshot()),
      async () => {
        throw new Error('onnx session init failed');
      },
    );

    // A structured status, not a crash…
    expect(events).toContainEqual({ type: 'VISUAL', code: 'VISUAL_OBSERVER_FAILED' });
    expect(result.status).not.toBe('error');
    // …and enforcement still gated egress on the DOM findings alone.
    expect(JSON.stringify(requests)).not.toContain('onnx session init failed');
  });

  it('runs DOM-only when no observer is wired (supported state, not a degradation)', async () => {
    const { result, events } = await runWith(scanReturning(domInsufficientSnapshot()));

    expect(events.filter((event) => event.type === 'VISUAL')).toHaveLength(0);
    expect(result.stageMs.visualMs).toBe(0);
    expect(result.status).not.toBe('error');
  });

  it('never calls the observer when the scan yields no snapshot', async () => {
    const observeVisual = vi.fn();
    await runWith(scanReturning(null), observeVisual);
    expect(observeVisual).not.toHaveBeenCalled();
  });
});
