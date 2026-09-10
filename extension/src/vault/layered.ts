import type { AliasBinding } from '../types/contracts';
import type { LocalVault } from './index';
import type { SecurePersistentVault } from './secure';

export interface LayeredVault extends LocalVault {
  persistentAliases(): AliasBinding[];
}

/**
 * Transient page aliases remain session-scoped. Persistent aliases are read-only through
 * this facade, and clearSession deliberately clears only the transient layer.
 */
export function createLayeredVault(
  transient: LocalVault,
  persistent: SecurePersistentVault,
): LayeredVault {
  return {
    async put(record, actualValue) {
      if (persistent.aliases().some((binding) => binding.alias === record.alias)) {
        throw new Error('ALIAS_COLLISION');
      }
      await transient.put(record, actualValue);
    },
    async resolve(alias) {
      const transientValue = await transient.resolve(alias);
      return transientValue ?? persistent.resolve(alias);
    },
    async clearSession(sessionId) {
      await transient.clearSession(sessionId);
    },
    persistentAliases() {
      return persistent.aliases();
    },
  };
}
