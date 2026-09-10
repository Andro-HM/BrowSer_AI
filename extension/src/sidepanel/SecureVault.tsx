import { useEffect, useState } from 'react';
import {
  PERSISTENT_VAULT_CATEGORIES,
  type PersistentVaultCategory,
  type PersistentVaultEntryMetadata,
  type SecurePersistentVault,
} from '../vault';

interface SecureVaultProps {
  vault: SecurePersistentVault;
}

function safeError(error: unknown): string {
  const code = error instanceof Error ? error.message : '';
  if (code === 'PASSPHRASE_TOO_SHORT') return 'Use a passphrase with at least 10 characters.';
  if (code === 'VAULT_LOCKED') return 'Secure Vault is locked.';
  if (code === 'VAULT_FULL') return 'The vault has reached its 50-detail limit.';
  return 'The vault operation could not be completed.';
}

export function SecureVault({ vault }: SecureVaultProps) {
  const [exists, setExists] = useState<boolean | null>(null);
  const [unlocked, setUnlocked] = useState(vault.isUnlocked());
  const [entries, setEntries] = useState<PersistentVaultEntryMetadata[]>(vault.list());
  const [passphrase, setPassphrase] = useState('');
  const [label, setLabel] = useState('');
  const [category, setCategory] = useState<PersistentVaultCategory>('EMAIL');
  const [value, setValue] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [replacement, setReplacement] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void vault.hasVault().then((hasVault) => {
      if (active) setExists(hasVault);
    }).catch(() => {
      if (active) setMessage('Secure Vault storage is unavailable.');
    });
    return () => {
      active = false;
      // Closing/reloading the panel destroys the only in-memory decryption capability.
      vault.lock();
    };
  }, [vault]);

  const refresh = (): void => {
    setUnlocked(vault.isUnlocked());
    setEntries(vault.list());
  };

  const openVault = async (create: boolean) => {
    if (passphrase.length === 0) return;
    setBusy(true);
    setMessage(null);
    try {
      if (create) {
        await vault.create(passphrase);
        setExists(true);
        setMessage('Vault created and unlocked.');
      } else if (!(await vault.unlock(passphrase))) {
        setMessage('Incorrect passphrase or unreadable vault.');
      } else {
        setMessage('Vault unlocked locally.');
      }
      refresh();
    } catch (error) {
      setMessage(safeError(error));
      refresh();
    } finally {
      setPassphrase('');
      setBusy(false);
    }
  };

  const addDetail = async () => {
    if (label.trim().length === 0 || value.length === 0) return;
    setBusy(true);
    setMessage(null);
    try {
      await vault.add({ label, category, value });
      setLabel('');
      setValue('');
      setMessage('Detail encrypted and saved.');
      refresh();
    } catch (error) {
      setMessage(safeError(error));
    } finally {
      setBusy(false);
    }
  };

  const replaceDetail = async (id: string) => {
    if (replacement.length === 0) return;
    setBusy(true);
    setMessage(null);
    try {
      await vault.replace(id, replacement);
      setReplacement('');
      setEditingId(null);
      setMessage('Stored value replaced without revealing the previous value.');
      refresh();
    } catch (error) {
      setMessage(safeError(error));
    } finally {
      setBusy(false);
    }
  };

  const deleteDetail = async (id: string) => {
    setBusy(true);
    setMessage(null);
    try {
      await vault.remove(id);
      setMessage('Detail deleted.');
      refresh();
    } catch (error) {
      setMessage(safeError(error));
    } finally {
      setBusy(false);
    }
  };

  const lock = () => {
    vault.lock();
    setPassphrase('');
    setValue('');
    setReplacement('');
    setEditingId(null);
    setMessage('Vault locked. The decryption key was discarded.');
    refresh();
  };

  if (!unlocked) {
    return (
      <section aria-label="Secure Vault" className="space-y-3">
        <div className="rounded-lg border border-neutral-200 bg-neutral-50 p-3">
          <p className="font-medium">🔒 Secure Vault locked</p>
          <p className="mt-1 text-xs text-neutral-600">
            AES-GCM encrypted at rest. Your passphrase and key are never stored.
          </p>
        </div>
        <label className="block text-xs font-medium text-neutral-700">
          Vault passphrase
          <input
            className="mt-1 w-full rounded border border-neutral-300 px-3 py-2 text-sm"
            type="password"
            autoComplete="off"
            value={passphrase}
            onChange={(event) => setPassphrase(event.target.value)}
            disabled={busy || exists === null}
          />
        </label>
        <button
          className="rounded bg-blue-600 px-4 py-2 text-sm text-white disabled:opacity-50"
          disabled={busy || exists === null || passphrase.length === 0}
          onClick={() => void openVault(exists === false)}
        >
          {exists === false ? 'Create Vault' : 'Unlock'}
        </button>
        {message !== null && <p className="text-xs text-neutral-600" role="status">{message}</p>}
      </section>
    );
  }

  return (
    <section aria-label="Secure Vault" className="space-y-4">
      <div className="flex items-start justify-between gap-3 rounded-lg border border-emerald-200 bg-emerald-50 p-3">
        <div>
          <p className="font-medium text-emerald-800">🔓 Vault unlocked locally</p>
          <p className="mt-1 text-xs text-emerald-700">{entries.length} encrypted detail{entries.length === 1 ? '' : 's'}</p>
        </div>
        <button className="rounded border border-emerald-700 px-3 py-1 text-xs text-emerald-800" onClick={lock}>
          Lock
        </button>
      </div>

      <fieldset className="space-y-2 rounded-lg border border-neutral-200 p-3" disabled={busy}>
        <legend className="px-1 text-sm font-medium">Add detail</legend>
        <input
          aria-label="Detail label"
          className="w-full rounded border border-neutral-300 px-3 py-2 text-sm"
          placeholder="Label"
          value={label}
          onChange={(event) => setLabel(event.target.value)}
        />
        <select
          aria-label="Detail category"
          className="w-full rounded border border-neutral-300 px-3 py-2 text-sm"
          value={category}
          onChange={(event) => setCategory(event.target.value as PersistentVaultCategory)}
        >
          {PERSISTENT_VAULT_CATEGORIES.map((item) => <option key={item}>{item}</option>)}
        </select>
        <input
          aria-label="Detail value"
          className="w-full rounded border border-neutral-300 px-3 py-2 text-sm"
          type="password"
          autoComplete="off"
          placeholder="Value is hidden after save"
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
        <button
          className="rounded bg-blue-600 px-4 py-2 text-sm text-white disabled:opacity-50"
          disabled={label.trim().length === 0 || value.length === 0}
          onClick={() => void addDetail()}
        >
          Encrypt and save
        </button>
      </fieldset>

      <ul className="space-y-2" aria-label="Stored details">
        {entries.map((entry) => (
          <li key={entry.id} className="rounded-lg border border-neutral-200 p-3">
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="font-medium">{entry.label}</p>
                <p className="font-mono text-xs text-neutral-600">{entry.alias} · {entry.category}</p>
              </div>
              <div className="flex gap-2 text-xs">
                <button className="text-blue-700 underline" onClick={() => { setEditingId(entry.id); setReplacement(''); }}>Replace</button>
                <button className="text-red-700 underline" onClick={() => void deleteDetail(entry.id)}>Delete</button>
              </div>
            </div>
            {editingId === entry.id && (
              <div className="mt-2 flex gap-2">
                <input
                  aria-label={`Replacement value for ${entry.label}`}
                  className="min-w-0 flex-1 rounded border border-neutral-300 px-2 py-1 text-sm"
                  type="password"
                  autoComplete="off"
                  placeholder="New value"
                  value={replacement}
                  onChange={(event) => setReplacement(event.target.value)}
                />
                <button
                  className="rounded bg-neutral-800 px-3 py-1 text-xs text-white disabled:opacity-50"
                  disabled={replacement.length === 0 || busy}
                  onClick={() => void replaceDetail(entry.id)}
                >
                  Save
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
      {entries.length === 0 && <p className="text-sm text-neutral-500">No saved details yet.</p>}
      {message !== null && <p className="text-xs text-neutral-600" role="status">{message}</p>}
    </section>
  );
}
