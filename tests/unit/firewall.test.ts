import { describe, expect, it } from 'vitest';
import { createPrivacyFirewall } from '../../extension/src/firewall';
import type { RemoteAgentRequest, SanitizedNode } from '../../extension/src/types/contracts';

function node(partial: Partial<SanitizedNode> & { control: string }): SanitizedNode {
  return { tag: 'input', filled: false, disabled: false, ...partial };
}

function cleanRequest(partial: Partial<RemoteAgentRequest> = {}): RemoteAgentRequest {
  return {
    taskObjective: 'fill the form and submit',
    sanitizedPageStructure: [node({ control: 'CONTROL_1', inputType: 'email', label: 'Email' })],
    sanitizedVisibleText: 'Email [SET] — welcome to the demo form',
    aliases: [{ alias: 'USER_EMAIL_1', category: 'EMAIL' }],
    availableActions: ['CLICK', 'TYPE', 'SELECT', 'SCROLL', 'NAVIGATE'],
    policy: { privacyMode: 'strict', navigationAllowlist: [] },
    ...partial,
  };
}

describe('privacy firewall', () => {
  it('allows a well-formed, clean request', async () => {
    const verdict = await createPrivacyFirewall().inspect(cleanRequest());
    expect(verdict).toEqual({ allowed: true, reason: 'OK' });
  });

  it('blocks when sanitized text still contains detectable PII (canary)', async () => {
    const verdict = await createPrivacyFirewall().inspect(
      cleanRequest({ sanitizedVisibleText: 'contact CANARY_EMAIL_001@example.test today' }),
    );
    expect(verdict).toEqual({ allowed: false, reason: 'FIREWALL_PII_DETECTED' });
  });

  it('blocks when a node label contains detectable PII', async () => {
    const verdict = await createPrivacyFirewall().inspect(
      cleanRequest({
        sanitizedPageStructure: [
          node({ control: 'CONTROL_1', label: 'Owner: 555-123-4567' }),
        ],
      }),
    );
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toBe('FIREWALL_PII_DETECTED');
  });

  it('blocks a detectable payment card in any scanned string', async () => {
    const verdict = await createPrivacyFirewall().inspect(
      cleanRequest({
        sanitizedVisibleText: 'card on file 4111 1111 1111 1111',
      }),
    );
    expect(verdict.allowed).toBe(false);
  });

  it('fails closed on unexpected extra fields', async () => {
    const request = cleanRequest() as unknown as Record<string, unknown>;
    request['screenshot'] = 'data:image/png;base64,AAAA';
    const verdict = await createPrivacyFirewall().inspect(request as unknown as RemoteAgentRequest);
    expect(verdict.reason).toBe('FIREWALL_UNEXPECTED_FIELD');
  });

  it('fails closed on malformed input and missing keys', async () => {
    const firewall = createPrivacyFirewall();
    expect((await firewall.inspect(null as unknown as RemoteAgentRequest)).allowed).toBe(false);
    const partial = { taskObjective: 'x' } as unknown as RemoteAgentRequest;
    expect((await firewall.inspect(partial)).reason).toBe('FIREWALL_MALFORMED');
  });

  it('refuses selector fields and malformed opaque controls', async () => {
    const selectorSmuggle = cleanRequest() as unknown as { sanitizedPageStructure: Record<string, unknown>[] };
    selectorSmuggle.sanitizedPageStructure[0]!['selector'] = '[name="alice@example.test"]';
    expect((await createPrivacyFirewall().inspect(selectorSmuggle as unknown as RemoteAgentRequest)).reason)
      .toBe('FIREWALL_MALFORMED');

    const badControl = cleanRequest({
      sanitizedPageStructure: [{ tag: 'input', control: '#email', filled: false, disabled: false }],
    });
    expect((await createPrivacyFirewall().inspect(badControl)).reason).toBe('FIREWALL_MALFORMED');
  });

  it('fails closed on bad alias grammar and bad availableActions', async () => {
    const firewall = createPrivacyFirewall();
    const badAlias = cleanRequest({ aliases: [{ alias: 'SECRET_VALUE_7', category: 'EMAIL' }] });
    expect((await firewall.inspect(badAlias)).reason).toBe('FIREWALL_BAD_ALIAS');
    const badActions = cleanRequest({ availableActions: ['EVAL' as never] });
    expect((await firewall.inspect(badActions)).reason).toBe('FIREWALL_BAD_ACTIONS');
  });

  it('accepts an optional origin-only pageOrigin and rejects full URLs', async () => {
    const firewall = createPrivacyFirewall();
    const withOrigin = cleanRequest({ pageOrigin: 'https://privagent.test' });
    expect((await firewall.inspect(withOrigin)).allowed).toBe(true);

    const fullPath = cleanRequest({ pageOrigin: 'https://privagent.test/form?x=1' });
    expect((await firewall.inspect(fullPath)).reason).toBe('FIREWALL_MALFORMED');
  });

  it('accepts alias strings without false-positiving the PII scan', async () => {
    const verdict = await createPrivacyFirewall().inspect(
      cleanRequest({ sanitizedVisibleText: 'Email USER_EMAIL_1 · Phone USER_PHONE_1' }),
    );
    expect(verdict.allowed).toBe(true);
  });

  // The task privacy contract is validated field-by-field, not merely "an object with a
  // string in it": an undefined regime, a non-string allowlist entry, or a smuggled extra
  // contract field all fail closed. A caller cannot ask for weaker treatment.
  it('fails closed on a task privacy contract it cannot honour', async () => {
    const firewall = createPrivacyFirewall();
    const contract = (policy: unknown): RemoteAgentRequest =>
      ({ ...cleanRequest(), policy } as unknown as RemoteAgentRequest);

    expect((await firewall.inspect(contract({ privacyMode: 'permissive', navigationAllowlist: [] }))).reason)
      .toBe('FIREWALL_MALFORMED');
    expect((await firewall.inspect(contract({ privacyMode: '', navigationAllowlist: [] }))).allowed).toBe(false);
    expect((await firewall.inspect(contract({ navigationAllowlist: [] }))).allowed).toBe(false);
    expect(
      (await firewall.inspect(contract({ privacyMode: 'strict', navigationAllowlist: ['https://a.test', 7] })))
        .allowed,
    ).toBe(false);
    expect(
      (
        await firewall.inspect(
          contract({ privacyMode: 'strict', navigationAllowlist: [], allowRawValues: true }),
        )
      ).allowed,
    ).toBe(false);

    // …and the contract the loop actually builds still passes.
    expect(
      (await firewall.inspect(contract({ privacyMode: 'strict', navigationAllowlist: ['https://a.test'] })))
        .allowed,
    ).toBe(true);
  });
});
