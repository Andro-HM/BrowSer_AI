import { useSyncExternalStore, type ReactNode } from 'react';
import type { RunAuditStore } from './run-audit-store';

interface PrivacyAuditProps {
  store: RunAuditStore;
  diagnostics: ReactNode;
}

export function PrivacyAudit({ store, diagnostics }: PrivacyAuditProps) {
  const audit = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);

  return (
    <section aria-label="Privacy Audit" className="space-y-4">
      <div className="rounded-lg border border-neutral-200 bg-neutral-50 p-3">
        <p className="font-medium">Most recent agent run</p>
        <p className="mt-1 text-xs text-neutral-600">
          {audit.status === 'idle' ? 'No agent run captured yet.' : `Status: ${audit.status}`}
          {audit.provider !== null ? ` · Provider: ${audit.provider}` : ''}
        </p>
      </div>

      <section>
        <h2 className="text-sm font-semibold">On-device findings</h2>
        {audit.findings.length === 0 ? (
          <p className="mt-2 text-xs text-neutral-500">No protected findings recorded for this run.</p>
        ) : (
          <ul className="mt-2 space-y-2" data-testid="audit-findings">
            {audit.findings.map((finding, index) => (
              <li key={`${finding.id}-${finding.source}-${index}`} className="rounded border border-neutral-200 p-2 text-xs">
                <span className="font-medium">{finding.category}</span>
                {' → '}
                <span className="font-mono">{finding.id}</span>
                <span className="text-neutral-500"> · {finding.source} · {finding.disposition}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="text-sm font-semibold">Outbound privacy boundary</h2>
        {audit.outbound === null ? (
          <p className="mt-2 text-xs text-neutral-500">No firewall-approved planner payload recorded.</p>
        ) : (
          <div className="mt-2 space-y-1 rounded border border-emerald-200 bg-emerald-50 p-3 text-xs" data-testid="outbound-audit">
            <p>Provider: <strong>{audit.outbound.provider}</strong></p>
            <p>Sanitized payload size: <strong>{audit.outbound.payloadBytes} bytes</strong></p>
            <p>Raw sensitive values in outbound payload: <strong>{audit.outbound.rawSensitiveValues}</strong></p>
            <p>Raw pixels/images in outbound payload: <strong>{audit.outbound.rawPixelPayloads}</strong></p>
            <p>Aliases: <strong>{audit.outbound.aliasCount}</strong> · Opaque controls: <strong>{audit.outbound.controlCount}</strong></p>
            <details className="pt-2">
              <summary className="cursor-pointer font-medium text-blue-700">View sanitized outbound payload</summary>
              <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-all rounded bg-neutral-950 p-2 text-[11px] text-neutral-100" data-testid="sanitized-payload">{audit.outbound.payloadJson}</pre>
            </details>
          </div>
        )}
      </section>

      <section>
        <h2 className="text-sm font-semibold">Local fill audit</h2>
        {audit.resolutions.length === 0 ? (
          <p className="mt-2 text-xs text-neutral-500">No aliases were resolved during this run.</p>
        ) : (
          <ul className="mt-2 space-y-1 text-xs" data-testid="resolution-audit">
            {audit.resolutions.map((resolution, index) => (
              <li key={`${resolution.alias}-${resolution.target}-${index}`} className="font-mono">
                {resolution.alias} → {resolution.target} · resolved on-device
              </li>
            ))}
          </ul>
        )}
      </section>

      {audit.result !== null && (
        <section>
          <h2 className="text-sm font-semibold">Measured run timings</h2>
          <p className="mt-2 text-xs text-neutral-600">
            Scan {audit.result.stageMs.scanMs.toFixed(1)} ms · Visual {audit.result.stageMs.visualMs.toFixed(1)} ms · Enforce {audit.result.stageMs.enforceMs.toFixed(1)} ms · Plan {audit.result.stageMs.planMs.toFixed(1)} ms · Execute {audit.result.stageMs.executeMs.toFixed(1)} ms · Total {audit.result.stageMs.totalMs.toFixed(1)} ms
          </p>
        </section>
      )}

      <details className="border-t border-neutral-200 pt-3">
        <summary className="cursor-pointer text-xs font-medium text-neutral-600">Developer diagnostics</summary>
        <div className="mt-3">{diagnostics}</div>
      </details>
    </section>
  );
}
