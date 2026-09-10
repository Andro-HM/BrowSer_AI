import { useState } from 'react';
import { createSecurePersistentVault } from '../vault';
import { AgentTask } from './AgentTask';
import { DeveloperDiagnostics } from './DeveloperDiagnostics';
import { PrivacyAudit } from './PrivacyAudit';
import { createRunAuditStore } from './run-audit-store';
import { SecureVault } from './SecureVault';

type PrimaryTab = 'agent' | 'audit' | 'vault';

const TABS: readonly { id: PrimaryTab; label: string }[] = [
  { id: 'agent', label: 'Run Agent' },
  { id: 'audit', label: 'Privacy Audit' },
  { id: 'vault', label: 'Secure Vault' },
];

export function App() {
  const [activeTab, setActiveTab] = useState<PrimaryTab>('agent');
  const [secureVault] = useState(() => createSecurePersistentVault());
  const [auditStore] = useState(() => createRunAuditStore());

  return (
    <main className="min-h-screen bg-white p-4 text-sm text-neutral-900">
      <header>
        <h1 className="text-lg font-semibold">PrivAgent</h1>
        <p className="mt-1 text-xs text-neutral-500">Private browser automation, locally protected</p>
      </header>

      <nav className="mt-4 grid grid-cols-3 gap-1 rounded-lg bg-neutral-100 p-1" aria-label="Primary" role="tablist">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            id={`tab-${tab.id}`}
            role="tab"
            aria-selected={activeTab === tab.id}
            aria-controls={`panel-${tab.id}`}
            className={`rounded-md px-2 py-2 text-xs font-medium ${
              activeTab === tab.id
                ? 'bg-white text-blue-700 shadow-sm'
                : 'text-neutral-600 hover:text-neutral-900'
            }`}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      <div className="mt-5">
        <section id="panel-agent" role="tabpanel" aria-labelledby="tab-agent" hidden={activeTab !== 'agent'}>
          <AgentTask secureVault={secureVault} auditStore={auditStore} />
        </section>
        <section id="panel-audit" role="tabpanel" aria-labelledby="tab-audit" hidden={activeTab !== 'audit'}>
          <PrivacyAudit store={auditStore} diagnostics={<DeveloperDiagnostics />} />
        </section>
        <section id="panel-vault" role="tabpanel" aria-labelledby="tab-vault" hidden={activeTab !== 'vault'}>
          <SecureVault vault={secureVault} />
        </section>
      </div>
    </main>
  );
}
