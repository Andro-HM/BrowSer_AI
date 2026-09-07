// Shared M3 visual-perception service for the side panel.
//
// ONE instance serves BOTH consumers — the scan path (`App.tsx`) and the agent loop
// (`AgentTask.tsx`). That is deliberate and load-bearing:
//   - one capability probe (WebGPU vs wasm) per panel document, not one per caller;
//   - one `VisualRegionCache`, so a region already analysed by a scan is not
//     re-analysed by the agent's next step (pixel-digest hit, zero inference);
//   - ONE privacy path. A second service would be a second place where pixels are
//     handled, which is exactly what CONTRIBUTING.md §5 forbids.
//
// Created on FIRST USE, never at import time, so simply opening the panel loads no
// ONNX runtime and no model. Capture and analysis must run in this document context
// (the service worker cannot rasterize), which is why this lives under sidepanel/.

import { createVisualPerceptionService } from '../perception/visual';
import type { VisualPerceptionService } from '../perception/visual';
import { captureViaBackground, scrollViaBackground } from './capture';

let visualService: VisualPerceptionService | null = null;

export function getVisualService(): VisualPerceptionService {
  visualService ??= createVisualPerceptionService({
    captureViewport: captureViaBackground,
    scrollViewport: scrollViaBackground,
  });
  return visualService;
}
