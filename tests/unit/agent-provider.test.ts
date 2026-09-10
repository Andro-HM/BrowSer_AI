import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  REMOTE_PLAN_ENDPOINT,
  providerForPlannerMode,
  timeoutForPlannerMode,
} from '../../extension/src/agent/provider-options';
import { createPrivacyFirewall } from '../../extension/src/firewall';
import type { RemoteAgentRequest } from '../../extension/src/types/contracts';

const REPO = resolve(__dirname, '../..');

describe('planner provider options (Zen addition)', () => {
  it('maps UI modes to backend provider hints, preserving existing modes', () => {
    expect(providerForPlannerMode('local')).toBe('ollama');
    expect(providerForPlannerMode('gemini')).toBe('gemini');
    expect(providerForPlannerMode('zen')).toBe('zen');
  });

  it('keeps all remote traffic on the local FastAPI endpoint', () => {
    expect(REMOTE_PLAN_ENDPOINT).toBe('http://localhost:8000/v1/plan');
  });

  it('gives Zen headroom over Gemini without touching the Ollama budget', () => {
    expect(timeoutForPlannerMode('gemini')).toBe(35_000);
    expect(timeoutForPlannerMode('zen')).toBe(40_000);
    expect(timeoutForPlannerMode('local')).toBe(95_000);
    expect(timeoutForPlannerMode('offline')).toBe(35_000);
  });

  it('passes a zen-hinted request through the firewall', async () => {
    const request: RemoteAgentRequest = {
      taskObjective: 'click the submit button',
      sanitizedPageStructure: [
        { tag: 'button', controlId: 'CONTROL_1', label: 'Submit', filled: false, disabled: false },
      ],
      sanitizedVisibleText: 'Order form',
      aliases: [],
      availableActions: ['CLICK'],
      policy: { privacyMode: 'strict', navigationAllowlist: [] },
      provider: 'zen',
    };
    expect((await createPrivacyFirewall().inspect(request)).allowed).toBe(true);
  });

  it('keeps vendor secrets and domains out of the extension', () => {
    // No Zen key in extension source; the backend alone owns the credential.
    // No direct-to-vendor fetch: the panel only knows the localhost endpoint.
    const sources = [
      'extension/src/agent/provider-options.ts',
      'extension/src/agent/remote.ts',
      'extension/src/sidepanel/AgentTask.tsx',
      'extension/src/types/contracts.ts',
      'extension/src/firewall/inspect.ts',
    ].map((rel) => readFileSync(resolve(REPO, rel), 'utf8'));
    const zenFiles = sources.filter((text) => text.includes('opencode.ai'));
    expect(zenFiles).toHaveLength(0);
    const keyFiles = sources.filter((text) => text.includes('OPENCODE_ZEN_API_KEY'));
    expect(keyFiles).toHaveLength(0);
    const manifest = readFileSync(resolve(REPO, 'extension/manifest.ts'), 'utf8');
    expect(manifest).not.toContain('opencode.ai');
    expect(manifest).not.toContain('OPENCODE_ZEN_API_KEY');
  });
});
