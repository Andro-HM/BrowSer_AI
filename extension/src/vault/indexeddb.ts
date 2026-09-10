// Ciphertext-only IndexedDB adapter for the persistent personal-details vault.
// Plaintext entries, passphrases, and CryptoKeys are never accepted by this layer.

export interface EncryptedVaultEnvelope {
  version: 1;
  kdf: 'PBKDF2-SHA256';
  cipher: 'AES-GCM-256';
  iterations: number;
  salt: string;
  iv: string;
  ciphertext: string;
}

export interface EncryptedVaultStore {
  read(): Promise<EncryptedVaultEnvelope | undefined>;
  write(envelope: EncryptedVaultEnvelope): Promise<void>;
}

const DATABASE_NAME = 'privagent-secure-vault';
const STORE_NAME = 'encrypted-vault';
const RECORD_KEY = 'primary';

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('VAULT_STORAGE_FAILED'));
  });
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('VAULT_STORAGE_FAILED'));
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(STORE_NAME, mode);
    const completed = new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(new Error('VAULT_STORAGE_FAILED'));
      transaction.onabort = () => reject(new Error('VAULT_STORAGE_FAILED'));
    });
    const result = await requestResult(operation(transaction.objectStore(STORE_NAME)));
    await completed;
    return result;
  } finally {
    database.close();
  }
}

export function createIndexedDbVaultStore(): EncryptedVaultStore {
  return {
    async read() {
      const value = await withStore<unknown>('readonly', (store) => store.get(RECORD_KEY));
      return value as EncryptedVaultEnvelope | undefined;
    },
    async write(envelope) {
      await withStore<IDBValidKey>('readwrite', (store) => store.put(envelope, RECORD_KEY));
    },
  };
}
