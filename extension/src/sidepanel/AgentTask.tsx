// M6 — side-panel agent task UI.
//
// Thin view over `runAgentLoop`: a task input, a run button, and the structured step
// log (action kind + target + outcome code). The panel NEVER renders raw page content —
// step records are alias-level by contract (`AgentStepRecord.action` holds aliases, and
// alias→value resolution happens inside the bridge at execution time, on-device).

import { useState, useSyncExternalStore } from 'react';
import { runAgentLoop, type AgentRunResult, type AgentStepRecord } from '../agent';
import { createRemoteHttpAgentGateway } from '../agent/remote';
import { createActionBridge } from '../actions';
import { createPrivacyFirewall } from '../firewall';
import { createDeterministicPlanner } from '../agent/planner';
import { createSessionNavigationPolicy } from '../agent/session-policy';
import {
  REMOTE_PLAN_ENDPOINT,
  providerForPlannerMode,
  timeoutForPlannerMode,
  type PlannerMode,
} from '../agent/provider-options';
import { DEFAULT_ACTION_POLICY } from '../actions/validate';
import { createLayeredVault, createLocalVault, type SecurePersistentVault } from '../vault';
import type { AgentProviderLabel } from '../agent/audit';
import { recordEvent, sessionTelemetry } from './telemetry-session';
import { createPinnedVisualService } from './visual-service';
import { recordVisualStats } from './visual-stats';
import { createPinnedTabSession, pinActiveTab } from './tab-session';
import { tryAcquirePanelOperation, usePanelOperationBusy } from './operation-lock';
import type { RunAuditStore } from './run-audit-store';

type RunState = 'idle' | 'running' | 'done';

interface AgentTaskProps {
  secureVault: SecurePersistentVault;
  auditStore: RunAuditStore;
}

/** Backend planner endpoint (AGENT_PROVIDER=gemini on the FastAPI service). */
export { REMOTE_PLAN_ENDPOINT };

const STATUS_TEXT: Record<AgentRunResult['status'], string> = {
  completed: '✓ Task completed',
  max_steps: '⏹ Step budget reached',
  blocked: '⛔ Blocked — critical data on page (fail-closed)',
  restricted: '⚠️ Restricted page',
  not_enforced: '⚠️ Could not fully sanitize this page — stopped',
  firewall_blocked: '🛡 Firewall blocked the outbound request',
  error: '✕ Task failed',
};

export function taskNeedsSavedDetails(task: string): boolean {
  return /\b(saved|my (?:details|email|phone|name|address|password|card|payment|pan|aadhaar|upi))\b/i.test(task);
}

function auditProvider(mode: PlannerMode): AgentProviderLabel {
  if (mode === 'local') return 'ollama';
  return mode;
}

export function AgentTask({ secureVault, auditStore }: AgentTaskProps) {
  const [task, setTask] = useState('');
  const [plannerMode, setPlannerMode] = useState<PlannerMode>('local');
  const [state, setState] = useState<RunState>('idle');
  const [result, setResult] = useState<AgentRunResult | null>(null);
  const operationBusy = usePanelOperationBusy();
  const audit = useSyncExternalStore(
    auditStore.subscribe,
    auditStore.getSnapshot,
    auditStore.getSnapshot,
  );

  const run = async () => {
    if (task.trim().length === 0) return;
    const release = tryAcquirePanelOperation('agent');
    if (release === null) return;
    setState('running');
    setResult(null);
    const sessionId = `agent-${Date.now()}`;
    auditStore.begin(sessionId, auditProvider(plannerMode));
    try {
      const persistentExists = await secureVault.hasVault();
      if (persistentExists && !secureVault.isUnlocked() && taskNeedsSavedDetails(task)) {
        const lockedResult: AgentRunResult = {
          status: 'error',
          reason: 'VAULT_LOCKED',
          steps: [],
          actionsExecuted: 0,
          stageMs: { scanMs: 0, visualMs: 0, enforceMs: 0, planMs: 0, executeMs: 0, totalMs: 0 },
        };
        auditStore.fail('VAULT_LOCKED');
        setResult(lockedResult);
        setState('done');
        return;
      }
      const target = await pinActiveTab();
      if (target.restricted === true || target.tabId === undefined) {
        setResult({
          status: target.restricted === true ? 'restricted' : 'error',
          reason: target.error,
          steps: [],
          actionsExecuted: 0,
          stageMs: { scanMs: 0, visualMs: 0, enforceMs: 0, planMs: 0, executeMs: 0, totalMs: 0 },
        });
        auditStore.fail(target.error ?? 'RESTRICTED');
        setState('done');
        return;
      }
      const tabSession = createPinnedTabSession(target.tabId);
      const visualService = createPinnedVisualService(tabSession);

      // NAVIGATE allowlist: user-configured via storage (settings surface later);
      // default EMPTY — the loop then falls back to same-origin-only navigation.
      const stored = (await chrome.storage.sync.get('navigationAllowlist')) as {
        navigationAllowlist?: unknown;
      };
      const allowlist = Array.isArray(stored.navigationAllowlist)
        ? (stored.navigationAllowlist as string[])
        : [];

      // ONE vault shared by enforcement (writes aliases) and the bridge (resolves them) —
      // the alias→value mapping lives only here, in memory, for this run.
      const vault = createLayeredVault(createLocalVault(), secureVault);
      const availableAliases = vault.persistentAliases();
      const navigationPolicy = createSessionNavigationPolicy();
      // ONE firewall shared by the loop gate and the remote gateway's pre-transmit gate.
      const firewall = createPrivacyFirewall();
      // Planner mode: Local AI (Ollama), Gemini, and Zen go through the backend over
      // the SAME fail-closed firewall; Offline uses the in-extension deterministic
      // planner (no network at all). The provider hint lets the backend pick per
      // run without a restart.
      // Optional backend bearer token (build-time `VITE_PRIVAGENT_API_KEY`).
      // Absent = dev mode: requests go without an Authorization header.
      const apiKey = import.meta.env.VITE_PRIVAGENT_API_KEY as string | undefined;
      // Timeouts must cover the backend wait: Gemini 30s, Zen 35s, Ollama 90s.
      const timeoutMs = timeoutForPlannerMode(plannerMode);
      const gateway =
        plannerMode === 'offline'
          ? createDeterministicPlanner()
          : createRemoteHttpAgentGateway({
              endpoint: REMOTE_PLAN_ENDPOINT,
              firewall,
              timeoutMs,
              ...(apiKey !== undefined && apiKey.length > 0 ? { apiKey } : {}),
            });
      const provider = plannerMode === 'offline' ? undefined : providerForPlannerMode(plannerMode);

      const runResult = await runAgentLoop({
        task,
        sessionId,
        vault,
        gateway,
        provider,
        navigationAllowlist: allowlist,
        navigationPolicy,
        availableAliases,
        audit: auditStore,
        bridge: createActionBridge({
          vault,
          policy: () => ({ ...DEFAULT_ACTION_POLICY, navigationAllowlist: [...navigationPolicy.get()] }),
          sendToPage: tabSession.execute,
          onAliasResolved: (alias, target, action) => {
            recordEvent({ type: 'ALIAS_RESOLVED', alias });
            auditStore.recordAliasResolution({ alias, target, action });
          },
        }),
        firewall,
        scan: tabSession.scan,
        observeVisual: async (snapshot, observation) => {
          const visual = await visualService.run(snapshot, observation);
          recordVisualStats(visual);
          return visual;
        },
      });
      const { stageMs } = runResult;
      for (const [name, ms] of [
        ['agent.scan', stageMs.scanMs],
        ['agent.visual', stageMs.visualMs],
        ['agent.enforce', stageMs.enforceMs],
        ['agent.plan', stageMs.planMs],
        ['agent.execute', stageMs.executeMs],
        ['agent.total', stageMs.totalMs],
      ] as const) {
        sessionTelemetry.timing(name, ms);
      }
      recordEvent({ type: 'TASK_RESULT' });
      auditStore.complete(runResult);
      setResult(runResult);
      setState('done');
    } catch {
      auditStore.fail('LOOP_CRASHED');
      setState('done');
      setResult({
        status: 'error',
        reason: 'LOOP_CRASHED',
        steps: [],
        actionsExecuted: 0,
        stageMs: { scanMs: 0, visualMs: 0, enforceMs: 0, planMs: 0, executeMs: 0, totalMs: 0 },
      });
    } finally {
      release();
    }
  };

  return (
    <section aria-label="Agent task">
      <h2 className="text-sm font-semibold">Agent task</h2>
      <p className="mt-1 text-xs text-neutral-500">
        The planner sees sanitized aliases only; values are resolved locally at execution.
      </p>

      <input
        className="mt-2 w-full rounded border border-neutral-300 px-2 py-1 text-sm"
        placeholder="e.g. fill the form with my details and submit"
        value={task}
        onChange={(event) => setTask(event.target.value)}
        disabled={operationBusy}
      />

      <fieldset className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-neutral-600">
        <legend className="sr-only">Planner mode</legend>
        <label className="flex items-center gap-1">
          <input
            data-testid="planner-mode-local"
            type="radio"
            name="planner-mode"
            checked={plannerMode === 'local'}
            onChange={() => setPlannerMode('local')}
            disabled={operationBusy}
          />
          Local AI (Ollama)
        </label>
        <label className="flex items-center gap-1">
          <input
            data-testid="planner-mode-gemini"
            type="radio"
            name="planner-mode"
            checked={plannerMode === 'gemini'}
            onChange={() => setPlannerMode('gemini')}
            disabled={operationBusy}
          />
          Gemini
        </label>
        <label className="flex items-center gap-1">
          <input
            data-testid="planner-mode-zen"
            type="radio"
            name="planner-mode"
            checked={plannerMode === 'zen'}
            onChange={() => setPlannerMode('zen')}
            disabled={operationBusy}
          />
          Zen (GPT-5.6 Luna)
        </label>
        <label className="flex items-center gap-1">
          <input
            data-testid="planner-mode-offline"
            type="radio"
            name="planner-mode"
            checked={plannerMode === 'offline'}
            onChange={() => setPlannerMode('offline')}
            disabled={operationBusy}
          />
          Offline
        </label>
      </fieldset>

      <button
        className="mt-2 px-4 py-1.5 bg-emerald-600 text-white rounded text-sm disabled:opacity-50"
        onClick={run}
        disabled={operationBusy || task.trim().length === 0}
      >
        {state === 'running' ? 'Running…' : 'Run agent task'}
      </button>

      {state === 'done' && result !== null && (
        <div className="mt-3" data-testid="agent-result">
          <p
            className={
              result.status === 'completed'
                ? 'font-medium text-green-700'
                : 'font-medium text-red-600'
            }
          >
            {STATUS_TEXT[result.status]}
          </p>
          <p className="text-xs text-neutral-500">
            {result.actionsExecuted} action{result.actionsExecuted === 1 ? '' : 's'} executed
            {result.reason === 'VAULT_LOCKED'
              ? ' · Secure Vault is locked — unlock it to use saved details.'
              : result.reason !== undefined && result.status !== 'completed'
                ? ` · ${result.reason}`
                : ''}
            {` · ${(result.stageMs.totalMs / 1000).toFixed(1)}s local`}
          </p>
          {result.steps.length > 0 && (
            <ul className="mt-2 space-y-1 text-xs text-neutral-700" data-testid="agent-steps">
              {result.steps.map((step: AgentStepRecord) => (
                <li key={step.index} className="font-mono">
                  {step.action === null ? (
                    <span>#{step.index} — planner: no further action</span>
                  ) : (
                    <span>
                      #{step.index} — {step.action.action}{' '}
                      {step.action.action === 'SCROLL'
                        ? `(${step.action.amount})`
                        : step.action.action === 'NAVIGATE'
                          ? `(allowlisted url)`
                          : `(${step.action.target})`}{' '}
                      → {step.outcome}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {state !== 'idle' && (
        <div className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-900" data-testid="run-privacy-status">
          <p className="font-medium">Local privacy {state === 'running' ? 'running…' : '✓'}</p>
          <p>{audit.findings.length} sensitive item{audit.findings.length === 1 ? '' : 's'} protected</p>
          {audit.outbound !== null && (
            <p>Raw values sent to planner: {audit.outbound.rawSensitiveValues}</p>
          )}
        </div>
      )}

      {result !== null && (
        <details className="mt-3 text-xs text-neutral-600">
          <summary className="cursor-pointer">Stage timings</summary>
          <p className="mt-1">
            Scan {result.stageMs.scanMs.toFixed(1)} ms · Visual {result.stageMs.visualMs.toFixed(1)} ms · Enforce {result.stageMs.enforceMs.toFixed(1)} ms · Plan {result.stageMs.planMs.toFixed(1)} ms · Execute {result.stageMs.executeMs.toFixed(1)} ms
          </p>
        </details>
      )}
    </section>
  );
}
