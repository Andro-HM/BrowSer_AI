// One shared side-panel visual service for manual scans and agent runs.

import { createVisualPerceptionService, type VisualPerceptionService } from '../perception/visual';
import type { DomVisualSnapshot, VisualPerceptionResult } from '../types/contracts';
import type { ObservationContext } from '../types/messages';
import type { PinnedTabSession } from './tab-session';

export interface PinnedVisualService {
  run(snapshot: DomVisualSnapshot, observation: ObservationContext): Promise<VisualPerceptionResult>;
}

let activeBinding: { session: PinnedTabSession; observation: ObservationContext } | null = null;
let sharedService: VisualPerceptionService | null = null;

function getSharedService(): VisualPerceptionService {
  sharedService ??= createVisualPerceptionService({
    captureViewport: () => {
      if (activeBinding === null) throw new Error('OBSERVATION_REQUIRED');
      return activeBinding.session.capture(activeBinding.observation);
    },
    scrollViewport: (top) => {
      if (activeBinding === null) throw new Error('OBSERVATION_REQUIRED');
      return activeBinding.session.scroll(top, activeBinding.observation);
    },
  });
  return sharedService;
}

export function createPinnedVisualService(session: PinnedTabSession): PinnedVisualService {
  return {
    async run(snapshot, observation): Promise<VisualPerceptionResult> {
      if (activeBinding !== null) throw new Error('VISUAL_RUN_IN_PROGRESS');
      activeBinding = { session, observation };
      try {
        return await getSharedService().run(snapshot);
      } finally {
        activeBinding = null;
      }
    },
  };
}
