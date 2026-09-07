// M10 — e2e: measured CLIENT PERFORMANCE of the local perception path (rubric #4/#5).
//
// WHY THIS IS AN E2E TEST AND NOT PART OF THE BENCH SUITE
//
// `tests/benchmark/rubric.bench.ts` measures the DOM-only pipeline in Node: detection,
// redaction, leakage and text-path latency. It cannot measure the visual half at all —
// there is no `captureVisibleTab`, no WebGPU adapter, no ONNX runtime and no JS heap that
// resembles the extension's. Every number below therefore comes from the REAL extension
// running in a REAL Chromium, read back from the value-free `__PRIVAGENT_VISUAL__` seam
// the panel already populates after each run.
//
// WHAT IS MEASURED (master §12 — "if a metric cannot yet be measured, instrument it")
//   A. DOM-sufficient run cost   — the gate's saving, measured rather than asserted
//   B. Visual-fallback run cost  — total plus capture/rasterize/vision/face/OCR
//   C. Execution provider        — the EP the detector ACTUALLY ran on, not the request
//   D. Combined ONNX peak heap   — both graphs resident, sampled at stage boundaries
//   E. Agent-loop latency        — the whole local loop, from the panel's own stage timings
//
// WHAT IS DELIBERATELY NOT CLAIMED
//   - These are single-run wall-clock numbers from one machine. They are RECORDED as
//     measurements, never asserted as thresholds: the only assertions here are structural
//     (a stage that ran reported a time; the parts never exceed the whole; the
//     DOM-sufficient path really did skip the models), because a latency threshold on
//     shared CI hardware fails for reasons that have nothing to do with this code.
//   - The WebGPU-vs-wasm split is reported for whichever EP THIS host actually provided.
//     A headless CI Chromium usually exposes no adapter, so the wasm figure is the one
//     that appears; the other row is left as "not measured on this host" rather than
//     estimated from it.
//   - `peakJsHeapBytes` comes from Chromium's non-standard `performance.memory` and is
//     coarse. It is reported when present and absent otherwise — never inferred.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { expect, openTestPage, runVisualCheck, test } from './fixtures';
// Imported for the `Window.__PRIVAGENT_VISUAL__` global augmentation as much as for the
// type: the seam's shape is asserted against the panel's own declaration, so a field
// renamed in the extension breaks this spec at typecheck rather than at midnight on CI.
import type { VisualStatsSnapshot } from '../../extension/src/sidepanel/visual-stats';
import type { VisualPerceptionMetrics } from '../../extension/src/types/contracts';

// A measurement run, not a stress test: serial keeps the timings interpretable.
test.describe.configure({ mode: 'serial' });

const REPORTS_DIR = join(process.cwd(), 'benchmark', 'reports');

/** Text-rich page with a DESCRIBED canvas: the DOM-first gate must short-circuit. */
const DOM_SUFFICIENT = `<!doctype html><html><head><meta charset="utf-8"></head><body>
  <h1>Quarterly report</h1>
  <p>${'This paragraph gives the DOM plenty of readable text for the sufficiency gate. '.repeat(6)}</p>
  <canvas id="chart" width="400" height="300" aria-label="Quarterly revenue chart"></canvas>
</body></html>`;

/**
 * Visual-only page: the values exist ONLY as committed PNG pixels, so the DOM collector
 * sees nothing and the full capture → rasterize → vision → face → OCR path must run. The
 * same deterministic assets `visual-accuracy.spec.ts` uses, so the accuracy report and
 * this performance report describe the same work on the same input.
 */
function visualOnlyPage(): string {
  const assetsDir = join(process.cwd(), 'tests', 'e2e', 'assets');
  const tags = ['email', 'phone']
    .map((name) => {
      const base64 = readFileSync(join(assetsDir, `bench-${name}.png`)).toString('base64');
      return `<img src="data:image/png;base64,${base64}" width="860" height="110" style="display:block; margin:8px 0">`;
    })
    .join('\n');
  return `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0">
  <p>Membership profile</p>
  ${tags}
</body></html>`;
}

/** A DOM form the deterministic planner can complete — for the agent-loop timing. */
const AGENT_PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body>
  <p>Registration — Contact PERF_EMAIL_001@example.test · Phone 555-010-0011</p>
  <form>
    <label for="name">Full name</label><input id="name" type="text" placeholder="Full name">
    <label for="email">Email</label><input id="email" type="email" placeholder="Email">
    <label for="phone">Phone</label><input id="phone" type="tel" placeholder="Phone">
    <button id="submit" type="button">Submit</button>
  </form>
  <script>
    document.getElementById('submit').addEventListener('click', () => {
      document.body.dataset.submitted = 'true';
      document.getElementById('submit').disabled = true;
    });
  </script>
</body></html>`;

interface Report {
  generatedAt: string;
  metric: string;
  note: string;
  domSufficient?: VisualPerceptionMetrics;
  visualFallback?: VisualPerceptionMetrics & {
    contentStatus?: string;
    facesDetected?: number;
    facesBlurred?: number;
  };
  /** Stage name → p50 ms, straight from the panel's telemetry table. */
  agentLoop?: Record<string, number>;
}

const report: Report = {
  generatedAt: new Date().toISOString(),
  metric: 'rubric #4 (client resource utilization) + #5 (end-to-end latency)',
  note:
    'Single-run wall-clock from one machine, measured in a real Chromium running the ' +
    'built extension. Recorded as measurements, not thresholds. Fields that this host ' +
    'could not measure are absent and are never estimated.',
};

/** Reads the value-free stats seam the panel writes after every visual run. */
async function readSeam(panel: Page): Promise<VisualStatsSnapshot | undefined> {
  return panel.evaluate(() => window.__PRIVAGENT_VISUAL__);
}

test('A — DOM-sufficient page: the gate skips every model, and the saving is measured', async ({
  extContext,
  panel,
}) => {
  await openTestPage(extContext, DOM_SUFFICIENT);
  await runVisualCheck(panel);

  const seam = await readSeam(panel);
  const metrics = seam?.metrics;
  expect(metrics, 'the seam must carry the run metrics').toBeDefined();
  report.domSufficient = metrics;

  // The whole point of the gate. These stages are ABSENT (never ran) rather than 0 —
  // asserting ABSENCE is what proves the expensive path was skipped rather than merely
  // being fast on this machine.
  expect(metrics?.captureMs, 'DOM-sufficient run must not capture').toBeUndefined();
  expect(metrics?.rasterizeMs, 'DOM-sufficient run must not rasterize').toBeUndefined();
  expect(metrics?.visionMs, 'DOM-sufficient run must not run the UI detector').toBeUndefined();
  expect(metrics?.faceMs, 'DOM-sufficient run must not run the face detector').toBeUndefined();
  expect(metrics?.ocrMs, 'DOM-sufficient run must not run OCR').toBeUndefined();
  expect(metrics?.backend, 'no model ran, so no EP may be reported').toBeUndefined();
  expect(metrics?.regionsProcessed).toBe(0);
});

test('B/C/D — visual fallback: per-stage latency, the real EP, and combined peak heap', async ({
  extContext,
  panel,
}) => {
  await openTestPage(extContext, visualOnlyPage());
  await panel.getByRole('button', { name: 'Run Visual Check' }).dispatchEvent('click');
  // Two regions through wasm OCR is slow under CI load — wait for the status the panel
  // renders when the content pass has finished, not a fixed sleep.
  await expect(panel.getByText(/OCR:/)).toBeVisible({ timeout: 60_000 });

  const seam = await readSeam(panel);
  const metrics = seam?.metrics;
  expect(metrics, 'the seam must carry the run metrics').toBeDefined();
  expect(
    metrics?.regionsProcessed,
    'the visual path must have processed at least one region for these numbers to mean anything',
  ).toBeGreaterThan(0);

  report.visualFallback = {
    ...(metrics as VisualPerceptionMetrics),
    ...(seam?.contentStatus !== undefined ? { contentStatus: seam.contentStatus } : {}),
    ...(seam?.faceStats !== undefined
      ? { facesDetected: seam.faceStats.facesDetected, facesBlurred: seam.faceStats.facesBlurred }
      : {}),
  };

  // Every stage on this path ran, so every stage must have reported a real, finite,
  // non-negative time. A missing one means the meter lost a stage.
  for (const stage of ['captureMs', 'rasterizeMs', 'visionMs', 'faceMs', 'ocrMs'] as const) {
    const value = metrics?.[stage];
    expect(typeof value, `${stage} must be measured on the visual path`).toBe('number');
    expect(Number.isFinite(value as number), `${stage} must be finite`).toBe(true);
    expect(value as number).toBeGreaterThanOrEqual(0);
  }

  // The parts cannot exceed the whole. This is the one relationship that holds on any
  // hardware, so it is the one worth asserting: it catches a meter that double-counts (a
  // stage wrapped twice) without pinning a machine-specific number. The 1 ms slack covers
  // the independent rounding of the total and of each stage.
  const staged =
    (metrics?.captureMs ?? 0) +
    (metrics?.rasterizeMs ?? 0) +
    (metrics?.visionMs ?? 0) +
    (metrics?.faceMs ?? 0) +
    (metrics?.ocrMs ?? 0);
  expect(staged, 'stage times must not exceed the run total').toBeLessThanOrEqual(
    (metrics?.durationMs ?? 0) + 1,
  );

  // C — the EP the ONNX session was actually created with. Every WebGPU-vs-wasm claim
  // rests on this value, so on a run where the detector demonstrably executed it must be
  // one of the three real backends and never absent.
  expect(['webgpu', 'wasm', 'cpu']).toContain(metrics?.backend);

  // D — combined footprint of both ONNX graphs. Chromium exposes `performance.memory`, so
  // this is normally present here. It is REPORTED rather than bounded: a heap ceiling
  // picked for shared CI hardware would be a guess dressed up as a limit.
  if (metrics?.peakJsHeapBytes !== undefined) {
    expect(metrics.peakJsHeapBytes).toBeGreaterThan(0);
  }
});

test('E — agent-loop latency through the same shared perception service', async ({
  extContext,
  panel,
}) => {
  const tab = await openTestPage(extContext, AGENT_PAGE);
  await panel.getByPlaceholder(/fill the form/).fill('fill the form with my details and submit');
  // Same invariant as the other agent specs: the web page, not the panel tab, must be the
  // active tab the background worker resolves.
  await tab.bringToFront();
  // Offline run on the deterministic planner, so the measured time is LOCAL work only —
  // no backend RTT is folded into the number.
  await panel.getByTestId('use-gemini').uncheck();
  await panel.getByRole('button', { name: 'Run agent task' }).dispatchEvent('click');
  await expect(panel.getByTestId('agent-result')).toContainText('Task completed');

  // The loop's own stage timings, read from the telemetry table the panel renders. That
  // table is value-free by construction (the recorder's allowlist-copy makes a raw value
  // impossible there), so reading it costs nothing in privacy terms.
  const rows = await panel.evaluate(() =>
    Array.from(
      document.querySelectorAll('[data-testid="telemetry-timings"] tbody tr'),
    ).map((row) => {
      const cells = Array.from(row.querySelectorAll('td')).map((cell) => cell.textContent ?? '');
      return { name: cells[0] ?? '', p50: Number(cells[2] ?? '') };
    }),
  );

  const parsed: Record<string, number> = {};
  for (const row of rows) {
    if (row.name.startsWith('agent.') && Number.isFinite(row.p50)) parsed[row.name] = row.p50;
  }
  expect(Object.keys(parsed), 'the loop must publish its stage timings').toContain('agent.total');
  report.agentLoop = parsed;
});

test('writes the performance report', async () => {
  expect(report.domSufficient, 'the DOM-sufficient measurement must have run').toBeDefined();
  expect(report.visualFallback, 'the visual-fallback measurement must have run').toBeDefined();

  mkdirSync(REPORTS_DIR, { recursive: true });
  writeFileSync(join(REPORTS_DIR, 'visual-performance.json'), JSON.stringify(report, null, 2));

  const ms = (value: number | undefined): string =>
    value === undefined ? 'not measured' : `${value.toFixed(1)} ms`;
  const mb = (value: number | undefined): string =>
    value === undefined
      ? 'not measured (host does not expose `performance.memory`)'
      : `${(value / 1024 / 1024).toFixed(1)} MB`;

  const dom = report.domSufficient;
  const visual = report.visualFallback;
  const ep = visual?.backend;
  /** The EP row this host could not produce — stated as unmeasured, never extrapolated. */
  const otherEp = ep === 'webgpu' ? 'wasm' : 'webgpu';

  const lines = [
    '# Client performance — local perception path (rubric #4 / #5)',
    '',
    `Generated: ${report.generatedAt}`,
    '',
    report.note,
    '',
    '## Run cost by path (rubric #5)',
    '',
    '| Path | Total | Regions processed | Models loaded |',
    '| --- | --- | --- | --- |',
    `| DOM sufficient (gate short-circuits) | ${ms(dom?.durationMs)} | ${dom?.regionsProcessed ?? 0} | none |`,
    `| Visual fallback (full pipeline) | ${ms(visual?.durationMs)} | ${visual?.regionsProcessed ?? 0} | UI detector + face detector + OCR |`,
    '',
    'The first row is the measured cost of the common case: the DOM-first gate returns',
    'before any capture happens, which is why its capture/vision/OCR stages are absent',
    'rather than zero.',
    '',
    '## Visual-fallback stage breakdown (rubric #5)',
    '',
    '| Stage | Measured |',
    '| --- | --- |',
    `| Capture (\`captureVisibleTab\`, viewport + bands) | ${ms(visual?.captureMs)} |`,
    `| Rasterize + crop/scale | ${ms(visual?.rasterizeMs)} |`,
    `| UI element detector (ONNX, ${ep ?? 'unknown EP'}) | ${ms(visual?.visionMs)} |`,
    `| Face detector + blur (ONNX wasm) | ${ms(visual?.faceMs)} |`,
    `| OCR (Tesseract wasm) | ${ms(visual?.ocrMs)} |`,
    '',
    `Content-analysis status: \`${visual?.contentStatus ?? 'not reported'}\` · faces detected: ` +
      `${visual?.facesDetected ?? 0}, blurred before OCR: ${visual?.facesBlurred ?? 0}.`,
    '',
    '## Execution provider (rubric #4)',
    '',
    `| EP | UI detector latency |`,
    '| --- | --- |',
    `| ${ep ?? 'unknown'} (used on this host) | ${ms(visual?.visionMs)} |`,
    `| ${otherEp} | not measured on this host |`,
    '',
    'The EP above is the one the ONNX session was actually created with, not the one the',
    'capability probe preferred — the provider attempts one EP per session so the attempt',
    'that succeeds is the EP in use. A headless CI Chromium generally exposes no WebGPU',
    'adapter, so only the fallback row is populated there; the missing row is left',
    'unmeasured rather than extrapolated from the one that ran.',
    '',
    '## Peak resource use (rubric #4)',
    '',
    `Peak JS heap with both ONNX graphs resident: **${mb(visual?.peakJsHeapBytes)}**.`,
    '',
    'Sampled at every stage boundary from Chromium `performance.memory`. Both graphs',
    'allocate their arenas in this heap, so this is a measured combined footprint — it',
    'replaces the earlier claim that a worker cap of 2 was itself evidence of memory',
    'safety, which bounded concurrency rather than memory.',
    '',
    '## Agent-loop latency (deterministic planner, fully local)',
    '',
    '| Stage | p50 |',
    '| --- | --- |',
    ...Object.entries(report.agentLoop ?? {})
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, value]) => `| \`${name}\` | ${ms(value)} |`),
    '',
    'Measured with the Gemini toggle off, so no network RTT is included: this is the cost',
    'of scan → visual gate → policy/enforce → plan → execute on this machine.',
    '',
  ];
  writeFileSync(join(REPORTS_DIR, 'visual-performance.md'), lines.join('\n'));
});
