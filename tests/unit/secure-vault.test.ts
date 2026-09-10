import { describe, expect, it } from 'vitest';
import {
  createLayeredVault,
  createLocalVault,
  createSecurePersistentVault,
  type EncryptedVaultEnvelope,
  type EncryptedVaultStore,
} from '../../extension/src/vault';

const CANARY = 'VAULT_CANARY_9237@example.test';
const PASSPHRASE = 'synthetic-passphrase';

function memoryStore(): EncryptedVaultStore & { envelope?: EncryptedVaultEnvelope } {
  return {
    envelope: undefined,
    async read() {
      return this.envelope === undefined ? undefined : structuredClone(this.envelope);
    },
    async write(envelope) {
      this.envelope = structuredClone(envelope);
    },
  };
}

function vault(store: EncryptedVaultStore) {
  return createSecurePersistentVault({
    store,
    iterations: 1_000,
    minimumPassphraseLength: 1,
  });
}

describe('AES-GCM persistent Secure Vault', () => {
  it('creates ciphertext that contains no plaintext', async () => {
    const store = memoryStore();
    const secure = vault(store);
    await secure.create(PASSPHRASE);
    await secure.add({ label: 'Primary email', category: 'EMAIL', value: CANARY });

    expect(store.envelope).toMatchObject({
      version: 1,
      kdf: 'PBKDF2-SHA256',
      cipher: 'AES-GCM-256',
    });
    expect(JSON.stringify(store.envelope)).not.toContain(CANARY);
    expect(JSON.stringify(store.envelope)).not.toContain('Primary email');
  });

  it('unlocks with the correct passphrase and fails closed with a wrong one', async () => {
    const store = memoryStore();
    const first = vault(store);
    await first.create(PASSPHRASE);
    const saved = await first.add({ label: 'Primary email', category: 'EMAIL', value: CANARY });
    first.lock();

    expect(await first.unlock('wrong-passphrase')).toBe(false);
    expect(first.isUnlocked()).toBe(false);
    expect(await first.resolve(saved.alias)).toBeUndefined();
    expect(await first.unlock(PASSPHRASE)).toBe(true);
    expect(await first.resolve(saved.alias)).toBe(CANARY);
  });

  it('discards the usable key and decrypted entries when locked', async () => {
    const secure = vault(memoryStore());
    await secure.create(PASSPHRASE);
    const saved = await secure.add({ label: 'Primary email', category: 'EMAIL', value: CANARY });
    secure.lock();

    expect(secure.isUnlocked()).toBe(false);
    expect(secure.list()).toEqual([]);
    expect(await secure.resolve(saved.alias)).toBeUndefined();
  });

  it('survives a store reopen and decrypts only after re-unlock', async () => {
    const store = memoryStore();
    const first = vault(store);
    await first.create(PASSPHRASE);
    const saved = await first.add({ label: 'Primary email', category: 'EMAIL', value: CANARY });
    first.lock();

    const reopened = vault(store);
    expect(await reopened.hasVault()).toBe(true);
    expect(await reopened.resolve(saved.alias)).toBeUndefined();
    expect(await reopened.unlock(PASSPHRASE)).toBe(true);
    expect(await reopened.resolve(saved.alias)).toBe(CANARY);
  });

  it('adds, replaces, lists safe metadata, and deletes without exposing plaintext', async () => {
    const secure = vault(memoryStore());
    await secure.create(PASSPHRASE);
    const saved = await secure.add({ label: 'Primary email', category: 'EMAIL', value: CANARY });

    expect(secure.list()).toEqual([saved]);
    expect(JSON.stringify(secure.list())).not.toContain(CANARY);
    await secure.replace(saved.id, 'replacement_7821@example.test');
    expect(await secure.resolve(saved.alias)).toBe('replacement_7821@example.test');
    await secure.remove(saved.id);
    expect(secure.list()).toEqual([]);
  });

  it('never offers OTP as a persistent category', async () => {
    const secure = vault(memoryStore());
    await secure.create(PASSPHRASE);
    await expect(secure.add({
      label: 'One time code',
      category: 'OTP' as never,
      value: '123456',
    })).rejects.toThrow('INVALID_CATEGORY');
  });

  it('keeps transient and persistent aliases separate and clearSession preserves persistent data', async () => {
    const secure = vault(memoryStore());
    await secure.create(PASSPHRASE);
    const saved = await secure.add({ label: 'Primary email', category: 'EMAIL', value: CANARY });
    const layered = createLayeredVault(createLocalVault(), secure);

    await layered.put({
      alias: 'USER_EMAIL_2',
      category: 'EMAIL',
      sessionId: 'page-session',
      createdAt: 1,
    }, 'PAGE_CANARY_1042@example.test');
    expect(layered.persistentAliases()).toEqual([{ alias: 'USER_EMAIL_1', category: 'EMAIL' }]);
    expect(await layered.resolve('USER_EMAIL_2')).toBe('PAGE_CANARY_1042@example.test');
    await layered.clearSession('page-session');
    expect(await layered.resolve('USER_EMAIL_2')).toBeUndefined();
    expect(await layered.resolve(saved.alias)).toBe(CANARY);
    await expect(layered.put({
      alias: saved.alias,
      category: 'EMAIL',
      sessionId: 'page-session',
      createdAt: 2,
    }, 'collision@example.test')).rejects.toThrow('ALIAS_COLLISION');
  });
});
