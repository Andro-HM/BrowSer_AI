// Persistent encrypted personal-details vault. Values at rest are stored only inside
// an AES-GCM ciphertext envelope; the passphrase-derived key exists only in memory.

import type { AliasBinding, SensitiveCategory } from '../types/contracts';
import {
  createIndexedDbVaultStore,
  type EncryptedVaultEnvelope,
  type EncryptedVaultStore,
} from './indexeddb';

export const PERSISTENT_VAULT_CATEGORIES = [
  'NAME',
  'EMAIL',
  'PHONE',
  'ADDRESS',
  'PASSWORD',
  'PAYMENT',
  'AADHAAR',
  'PAN',
  'UPI',
  'CUSTOM',
] as const satisfies readonly SensitiveCategory[];

export type PersistentVaultCategory = (typeof PERSISTENT_VAULT_CATEGORIES)[number];

export interface PersistentVaultEntryMetadata extends AliasBinding {
  id: string;
  label: string;
}

interface PersistentVaultEntry extends PersistentVaultEntryMetadata {
  value: string;
}

interface VaultPlaintext {
  version: 1;
  entries: PersistentVaultEntry[];
}

export interface AddPersistentDetail {
  label: string;
  category: PersistentVaultCategory;
  value: string;
}

export interface SecurePersistentVault {
  hasVault(): Promise<boolean>;
  create(passphrase: string): Promise<void>;
  unlock(passphrase: string): Promise<boolean>;
  lock(): void;
  isUnlocked(): boolean;
  list(): PersistentVaultEntryMetadata[];
  aliases(): AliasBinding[];
  add(detail: AddPersistentDetail): Promise<PersistentVaultEntryMetadata>;
  replace(id: string, value: string): Promise<void>;
  remove(id: string): Promise<void>;
  resolve(alias: string): Promise<string | undefined>;
}

export interface SecurePersistentVaultOptions {
  store?: EncryptedVaultStore;
  crypto?: Crypto;
  iterations?: number;
  minimumPassphraseLength?: number;
}

const DEFAULT_ITERATIONS = 600_000;
const DEFAULT_MINIMUM_PASSPHRASE_LENGTH = 10;
const MAX_ENTRIES = 50;
const AAD: Uint8Array<ArrayBuffer> = new TextEncoder().encode('PrivAgent secure vault v1');
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function isPersistentCategory(value: unknown): value is PersistentVaultCategory {
  return (PERSISTENT_VAULT_CATEGORIES as readonly unknown[]).includes(value);
}

function isValidEnvelope(value: unknown): value is EncryptedVaultEnvelope {
  if (typeof value !== 'object' || value === null) return false;
  const envelope = value as Record<string, unknown>;
  return (
    envelope['version'] === 1 &&
    envelope['kdf'] === 'PBKDF2-SHA256' &&
    envelope['cipher'] === 'AES-GCM-256' &&
    typeof envelope['iterations'] === 'number' &&
    Number.isSafeInteger(envelope['iterations']) &&
    envelope['iterations'] > 0 &&
    typeof envelope['salt'] === 'string' &&
    typeof envelope['iv'] === 'string' &&
    typeof envelope['ciphertext'] === 'string'
  );
}

function parsePlaintext(value: unknown): VaultPlaintext | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (record['version'] !== 1 || !Array.isArray(record['entries'])) return undefined;
  const entries: PersistentVaultEntry[] = [];
  for (const raw of record['entries']) {
    if (typeof raw !== 'object' || raw === null) return undefined;
    const entry = raw as Record<string, unknown>;
    if (
      typeof entry['id'] !== 'string' ||
      typeof entry['label'] !== 'string' ||
      typeof entry['alias'] !== 'string' ||
      !/^USER_[A-Z]+_[1-9]\d*$/.test(entry['alias']) ||
      !isPersistentCategory(entry['category']) ||
      typeof entry['value'] !== 'string' ||
      entry['value'].length === 0
    ) {
      return undefined;
    }
    entries.push({
      id: entry['id'],
      label: entry['label'],
      alias: entry['alias'],
      category: entry['category'],
      value: entry['value'],
    });
  }
  if (entries.length > MAX_ENTRIES) return undefined;
  return { version: 1, entries };
}

async function deriveKey(
  cryptoApi: Crypto,
  passphrase: string,
  salt: Uint8Array<ArrayBuffer>,
  iterations: number,
): Promise<CryptoKey> {
  const passphraseBytes = encoder.encode(passphrase);
  try {
    const material = await cryptoApi.subtle.importKey(
      'raw',
      passphraseBytes,
      { name: 'PBKDF2' },
      false,
      ['deriveKey'],
    );
    return await cryptoApi.subtle.deriveKey(
      { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
      material,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );
  } finally {
    passphraseBytes.fill(0);
  }
}

export function createSecurePersistentVault(
  options: SecurePersistentVaultOptions = {},
): SecurePersistentVault {
  const store = options.store ?? createIndexedDbVaultStore();
  const cryptoApi = options.crypto ?? crypto;
  const createIterations = options.iterations ?? DEFAULT_ITERATIONS;
  const minimumPassphraseLength =
    options.minimumPassphraseLength ?? DEFAULT_MINIMUM_PASSPHRASE_LENGTH;
  let key: CryptoKey | null = null;
  let entries: PersistentVaultEntry[] = [];
  let salt: Uint8Array<ArrayBuffer> | null = null;
  let iterations = createIterations;

  const discardUnlockedState = (): void => {
    key = null;
    salt = null;
    entries = [];
  };

  const requireUnlocked = (): CryptoKey => {
    if (key === null || salt === null) throw new Error('VAULT_LOCKED');
    return key;
  };

  const persist = async (): Promise<void> => {
    const activeKey = requireUnlocked();
    const iv = cryptoApi.getRandomValues(new Uint8Array(12)) as Uint8Array<ArrayBuffer>;
    const plaintext = encoder.encode(JSON.stringify({ version: 1, entries } satisfies VaultPlaintext));
    try {
      const encrypted = await cryptoApi.subtle.encrypt(
        { name: 'AES-GCM', iv, additionalData: AAD },
        activeKey,
        plaintext,
      );
      await store.write({
        version: 1,
        kdf: 'PBKDF2-SHA256',
        cipher: 'AES-GCM-256',
        iterations,
        salt: bytesToBase64(salt!),
        iv: bytesToBase64(iv),
        ciphertext: bytesToBase64(new Uint8Array(encrypted)),
      });
    } finally {
      plaintext.fill(0);
    }
  };

  return {
    async hasVault() {
      return (await store.read()) !== undefined;
    },

    async create(passphrase) {
      if (passphrase.length < minimumPassphraseLength) throw new Error('PASSPHRASE_TOO_SHORT');
      if (await store.read() !== undefined) throw new Error('VAULT_ALREADY_EXISTS');
      salt = cryptoApi.getRandomValues(new Uint8Array(16)) as Uint8Array<ArrayBuffer>;
      iterations = createIterations;
      key = await deriveKey(cryptoApi, passphrase, salt, iterations);
      entries = [];
      await persist();
    },

    async unlock(passphrase) {
      const envelope = await store.read();
      if (!isValidEnvelope(envelope)) {
        discardUnlockedState();
        return false;
      }
      let decoded: Uint8Array | null = null;
      try {
        const candidateSalt = base64ToBytes(envelope.salt);
        const candidateKey = await deriveKey(
          cryptoApi,
          passphrase,
          candidateSalt,
          envelope.iterations,
        );
        const encrypted = base64ToBytes(envelope.ciphertext);
        const decrypted = await cryptoApi.subtle.decrypt(
          {
            name: 'AES-GCM',
            iv: base64ToBytes(envelope.iv),
            additionalData: AAD,
          },
          candidateKey,
          encrypted,
        );
        decoded = new Uint8Array(decrypted);
        const parsed = parsePlaintext(JSON.parse(decoder.decode(decoded)));
        if (parsed === undefined) throw new Error('VAULT_CORRUPT');
        key = candidateKey;
        salt = candidateSalt;
        iterations = envelope.iterations;
        entries = parsed.entries;
        return true;
      } catch {
        discardUnlockedState();
        return false;
      } finally {
        decoded?.fill(0);
      }
    },

    lock() {
      discardUnlockedState();
    },

    isUnlocked() {
      return key !== null;
    },

    list() {
      if (key === null) return [];
      return entries.map(({ id, label, alias, category }) => ({ id, label, alias, category }));
    },

    aliases() {
      if (key === null) return [];
      return entries.map(({ alias, category }) => ({ alias, category }));
    },

    async add(detail) {
      requireUnlocked();
      const label = detail.label.trim();
      if (label.length === 0 || label.length > 80) throw new Error('INVALID_LABEL');
      if (!isPersistentCategory(detail.category)) throw new Error('INVALID_CATEGORY');
      if (detail.value.length === 0) throw new Error('INVALID_VALUE');
      if (entries.length >= MAX_ENTRIES) throw new Error('VAULT_FULL');
      const prefix = `USER_${detail.category}_`;
      let maximum = 0;
      for (const entry of entries) {
        if (!entry.alias.startsWith(prefix)) continue;
        const suffix = Number(entry.alias.slice(prefix.length));
        if (Number.isSafeInteger(suffix)) maximum = Math.max(maximum, suffix);
      }
      const entry: PersistentVaultEntry = {
        id: cryptoApi.randomUUID(),
        label,
        alias: `${prefix}${maximum + 1}`,
        category: detail.category,
        value: detail.value,
      };
      entries = [...entries, entry];
      await persist();
      const { id, alias, category } = entry;
      return { id, label, alias, category };
    },

    async replace(id, value) {
      requireUnlocked();
      if (value.length === 0) throw new Error('INVALID_VALUE');
      const index = entries.findIndex((entry) => entry.id === id);
      if (index < 0) throw new Error('ENTRY_NOT_FOUND');
      entries = entries.map((entry) => entry.id === id ? { ...entry, value } : entry);
      await persist();
    },

    async remove(id) {
      requireUnlocked();
      if (!entries.some((entry) => entry.id === id)) throw new Error('ENTRY_NOT_FOUND');
      entries = entries.filter((entry) => entry.id !== id);
      await persist();
    },

    async resolve(alias) {
      if (key === null) return undefined;
      return entries.find((entry) => entry.alias === alias)?.value;
    },
  };
}
