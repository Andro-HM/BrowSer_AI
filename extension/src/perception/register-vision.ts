// Production VISION wiring — the ONE place the real local model is installed.
//
// Mirrors `register-ocr.ts` deliberately: same lazy contract, same "tests never
// import this" rule. Registering costs nothing — the 12 MB ONNX graph and the ORT
// wasm runtime are pulled in by a dynamic import inside the factory, which the
// pipeline only calls after the DOM-first gate has already decided that pixels are
// genuinely needed for this page.
//
// The two engines are independent and complementary, and both stay local:
//   Vision (here)  → WHERE separable UI elements are inside a targeted region.
//   OCR (Tesseract)→ WHAT TEXT those pixels contain.
// Installing this does not touch, wrap, or replace the OCR path.

import { registerVisualProvider } from './visual/providers/registry';
import { VISION_INPUT_EDGE } from './visual/providers/yolo-decode';

let installed = false;

/** Idempotently install the production local vision model as the M3 provider. */
export function installVisionEngine(): void {
  if (installed) return;
  installed = true;
  registerVisualProvider(
    async () => {
      const module = await import('./visual/providers/vision-onnx');
      return module.createVisionOnnxProvider();
    },
    // The graph has a static 640x640 input; anything smaller is letterboxed into a
    // corner and the detector goes silent (measured: 33 elements at 640, 0 at 192).
    { analysisEdge: VISION_INPUT_EDGE },
  );
}
