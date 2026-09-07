import { defineConfig } from '@playwright/test';

// E2E runs the BUILT extension in a real Chromium profile. Extensions require a
// persistent context, so each test launches its own via the fixtures in
// tests/e2e/fixtures.ts rather than using the built-in `browser`/`page` fixtures.
//
// Prerequisite: `npm run build` (the fixture fails loudly if dist/ is absent).
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  // Each test launches its own Chromium profile with the unpacked extension, and every
  // profile now loads BlazeFace (ONNX WASM), the OmniParser vision model and the
  // Tesseract wasm core. Above ~2 concurrent profiles the panel page is killed
  // mid-check ("session closed", blank-panel flake) — measured on this tree:
  // `npm run e2e` at unbounded local parallelism failed
  // `visual-perception.spec.ts:65` 2 runs out of 2, and passed 24/24 at `--workers=2`
  // with no retries and no wall-clock cost (38.2s vs 35.9s — the tests are inference-
  // bound, not scheduling-bound). Retries stay CI-only so a local failure is never
  // masked.
  workers: 2,
  retries: process.env.CI ? 1 : 0,
  reporter: 'list',
  // Launching Chromium with an unpacked extension is slower than a plain page load.
  timeout: 60_000,
  expect: { timeout: 10_000 },
});
