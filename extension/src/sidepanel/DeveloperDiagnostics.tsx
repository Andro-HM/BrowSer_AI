import { useState } from 'react';
import { detectPII } from '../perception/pii';
import { classifyPage } from '../perception/visual/pageClassifier';
import { buildScanSummary, type ScanFindingView, type ScanSummary } from '../scan';
import { enforcePrivacy } from '../sanitizer';
import { toSensitiveCategory } from '../sanitizer/alias';
import type { PolicySignals } from '../types/contracts';
import { createLocalVault } from '../vault';
import { ocrTrace } from '../diag/ocr-trace';
import { tryAcquirePanelOperation, usePanelOperationBusy } from './operation-lock';
import { createPinnedTabSession, pinActiveTab } from './tab-session';
import { recordEvent, sessionTelemetry } from './telemetry-session';
import { TelemetryPanel } from './TelemetryPanel';
import { createPinnedVisualService } from './visual-service';
import { recordVisualStats } from './visual-stats';
import { VisualStatus } from './VisualStatus';

type ScanState = 'idle' | 'scanning' | 'done' | 'restricted' | 'error';

function findingDescription(finding: ScanFindingView): string {
  const source = finding.source === undefined ? '' : ` · ${finding.source}`;
  const section = finding.section === undefined ? '' : ` · section ${finding.section}`;
  return `${finding.label} · ${finding.displayId}${source}${section}`;
}

export function DeveloperDiagnostics() {
  const [state, setState] = useState<ScanState>('idle');
  const [summary, setSummary] = useState<ScanSummary | null>(null);
  const operationBusy = usePanelOperationBusy();

  const runScan = async () => {
    const release = tryAcquirePanelOperation('scan');
    if (release === null) return;
    setState('scanning');
    setSummary(null);
    try {
      const target = await pinActiveTab();
      if (target.restricted === true) {
        setState('restricted');
        return;
      }
      if (target.tabId === undefined) {
        setState('error');
        return;
      }
      const tabSession = createPinnedTabSession(target.tabId);
      const response = await tabSession.scan();
      if (
        response.restricted === true ||
        response.error !== undefined ||
        typeof response.pageText !== 'string' ||
        response.snapshot == null ||
        typeof response.observationEpoch !== 'string' ||
        typeof response.documentGeneration !== 'string'
      ) {
        setState(response.restricted === true ? 'restricted' : 'error');
        return;
      }
      const startedAt = performance.now();
      const detectStartedAt = performance.now();
      const entities = detectPII(response.pageText);
      sessionTelemetry.timing('scan.detect', performance.now() - detectStartedAt);
      for (const category of new Set(entities.map((entity) => entity.category))) {
        recordEvent({ type: 'DETECTED', entityCategory: toSensitiveCategory(category) });
      }
      const visualStartedAt = performance.now();
      const visual = await createPinnedVisualService(tabSession).run(response.snapshot, {
        observationEpoch: response.observationEpoch,
        documentGeneration: response.documentGeneration,
      });
      sessionTelemetry.timing('scan.visual', performance.now() - visualStartedAt);
      recordVisualStats(visual);
      const signals: PolicySignals = {
        entities,
        visual,
        visualContext: classifyPage(response.structure, response.pageText),
        restricted: false,
      };
      const enforceStartedAt = performance.now();
      const result = await enforcePrivacy({
        signals,
        pageText: response.pageText,
        sessionId: 'diagnostic-scan',
        vault: createLocalVault(),
      });
      sessionTelemetry.timing('scan.enforce', performance.now() - enforceStartedAt);
      sessionTelemetry.timing('scan.total', performance.now() - startedAt);
      if (result.aliases.length > 0) recordEvent({ type: 'SANITIZED' });
      if (result.blocked) recordEvent({ type: 'BLOCKED' });
      ocrTrace('PRIVACY_FINDINGS', {
        findings: result.findings.length,
        visualMasks: result.visualMasks.length,
        aliases: result.aliases.length,
        blocked: result.blocked,
      });
      setSummary(buildScanSummary(result, response.snapshot.viewport?.height));
      setState('done');
    } catch {
      setState('error');
    } finally {
      release();
    }
  };

  return (
    <div className="space-y-4">
      <section>
        <button
          className="rounded bg-neutral-700 px-3 py-1.5 text-xs text-white disabled:opacity-50"
          onClick={() => void runScan()}
          disabled={operationBusy}
        >
          {state === 'scanning' ? 'Scanning…' : summary === null ? 'Scan Page' : 'Scan Again'}
        </button>
        {state === 'done' && summary !== null && (
          <section aria-label="Scan findings" className="mt-3 rounded border border-neutral-200 p-3">
            <p className="text-xs font-medium text-neutral-800">Scan: ✓ Complete</p>
            <p className="mt-1 text-xs text-neutral-600">
              Sensitive items: {summary.total} · Text regions: {summary.textCount} · Image/OCR regions: {summary.imageCount}
            </p>
            {summary.blocked && (
              <p className="mt-1 text-xs font-medium text-red-700">Critical risk detected · outbound blocked</p>
            )}
            <ul className="mt-2 space-y-1" data-testid="findings">
              {summary.findings.map((finding) => (
                <li key={`${finding.kind}:${finding.displayId}`} className="text-xs text-neutral-700">
                  {findingDescription(finding)}
                </li>
              ))}
            </ul>
          </section>
        )}
        {state === 'restricted' && <p className="mt-2 text-xs text-amber-700">Restricted page.</p>}
        {state === 'error' && <p className="mt-2 text-xs text-red-700">Could not scan this page.</p>}
      </section>
      <VisualStatus />
      <TelemetryPanel />
    </div>
  );
}
