// M3 — e2e: REAL face detection + pre-OCR blurring, end-to-end in the extension.
// (Developed under the working label "M7.5"; authoritative milestone is M3, per
// PROJECT_STATUS.md §0A. BlazeFace is a specialized privacy detector, not the general
// UI element detector.)
//
// This is the test that exercises the face stage with an ACTUAL face: BlazeFace
// (ONNX WASM, on-device) must detect the face in the raster and black it out BEFORE
// the OCR analyzer reads it.
//   - faceStats.facesDetected === 1  → the one face on the page is found ONCE. The
//     shipped Apache-2.0 export emits raw SSD heads, so the 896-anchor decode, threshold
//     and NMS run in `faceBlur.ts`; a broken NMS shows up here as duplicate boxes on a
//     single face, which "≥ 1" would have hidden.
//   - faceStats.facesBlurred  >= 1  → the in-place black-out happened (service order:
//     faceBlur.blur(raster) runs before analyzer.analyze(raster, …))
//   - contentStatus === 'ok'        → the OCR pass still ran after the blur (pipeline
//     continuity)
//
// The image is a real photographed face, which is what BlazeFace is trained to detect. A
// cartoon "synthetic face" would not be detected, and asserting otherwise would be
// fabrication.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from './fixtures';
import { openTestPage } from './fixtures';

test.describe.configure({ mode: 'serial' });

const FACE_B64 = readFileSync(
  join(process.cwd(), 'tests', 'e2e', 'assets', 'face-person.jpg'),
).toString('base64');

const FACE_PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0">
  <p>Profile preview</p>
  <img class="bench-face" src="data:image/jpeg;base64,${FACE_B64}" width="480" height="360" style="display:block">
</body></html>`;

interface FaceStatsSeam {
  faceStats?: { facesDetected: number; facesBlurred: number };
  contentStatus?: string;
}

test('BlazeFace detects and blurs a real face before OCR (on-device WASM)', async ({
  extContext,
  panel,
}) => {
  await openTestPage(extContext, FACE_PAGE);

  await panel.getByRole('button', { name: 'Run Visual Check' }).dispatchEvent('click');
  await expect(panel.getByText('OCR: OCR/vision engine ran')).toBeVisible({ timeout: 30_000 });

  const stats = (await panel.evaluate(() => window.__PRIVAGENT_VISUAL__)) as FaceStatsSeam | null;
  expect(stats, 'visual stats seam must be populated').toBeTruthy();
  expect(stats?.contentStatus, 'OCR must still run after the blur').toBe('ok');
  expect(stats?.faceStats, 'faceStats must be populated by the face engine').toBeTruthy();
  expect(
    stats?.faceStats?.facesDetected,
    'the one face on the page must be detected exactly once (anchor decode + NMS)',
  ).toBe(1);
  expect(
    stats?.faceStats?.facesBlurred,
    'the detected face must be blacked out before OCR',
  ).toBeGreaterThanOrEqual(1);
});