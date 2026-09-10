import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPinnedTabSession, pinActiveTab } from '../../extension/src/sidepanel/tab-session';

afterEach(() => vi.unstubAllGlobals());

describe('pinned tab session', () => {
  it('resolves the target once and includes it plus observation identity on every operation', async () => {
    const messages: unknown[] = [];
    vi.stubGlobal('chrome', {
      runtime: {
        sendMessage: vi.fn(async (message: Record<string, unknown>) => {
          messages.push(message);
          if (message.type === 'RESOLVE_ACTIVE_TAB') return { tabId: 41 };
          if (message.type === 'SCAN_PAGE') {
            return {
              pageText: 'safe',
              structure: [],
              snapshot: null,
              observationEpoch: 'observation-41',
              documentGeneration: 'document-41',
            };
          }
          if (message.type === 'CAPTURE_VIEWPORT') return { dataUrl: 'data:image/png;base64,AAAA' };
          if (message.type === 'SCROLL_VIEWPORT') return { scrollY: 100 };
          return { ok: true, code: 'OK' };
        }),
      },
    });

    const pinned = await pinActiveTab();
    expect(pinned).toEqual({ tabId: 41 });
    const session = createPinnedTabSession(pinned.tabId as number);
    const observation = {
      observationEpoch: 'observation-41',
      documentGeneration: 'document-41',
    };

    await session.scan();
    await session.capture(observation);
    await session.scroll(100, observation);
    await session.execute({ action: 'CLICK', target: 'CONTROL_1' }, observation);

    expect(messages).toEqual([
      { type: 'RESOLVE_ACTIVE_TAB' },
      { type: 'SCAN_PAGE', targetTabId: 41 },
      { type: 'CAPTURE_VIEWPORT', targetTabId: 41, ...observation },
      { type: 'SCROLL_VIEWPORT', targetTabId: 41, top: 100, ...observation },
      {
        type: 'EXECUTE_ACTION',
        targetTabId: 41,
        action: { action: 'CLICK', target: 'CONTROL_1' },
        ...observation,
      },
    ]);
  });
});
