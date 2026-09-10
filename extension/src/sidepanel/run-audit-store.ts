import type { RemoteAgentRequest } from '../types/contracts';
import type { AgentRunResult } from '../agent';
import type {
  AgentProviderLabel,
  AgentRunAuditSink,
  AgentRunAuditSnapshot,
  SafeAliasResolution,
  SafeRunFinding,
} from '../agent/audit';

export interface RunAuditStore extends AgentRunAuditSink {
  begin(runId: string, provider: AgentProviderLabel): void;
  complete(result: AgentRunResult): void;
  fail(reason: string): void;
  getSnapshot(): AgentRunAuditSnapshot;
  subscribe(listener: () => void): () => void;
}

function cloneRequest(request: RemoteAgentRequest): RemoteAgentRequest {
  return JSON.parse(JSON.stringify(request)) as RemoteAgentRequest;
}

export function createRunAuditStore(): RunAuditStore {
  let snapshot: AgentRunAuditSnapshot = {
    runId: null,
    provider: null,
    status: 'idle',
    findings: [],
    resolutions: [],
    outbound: null,
    result: null,
  };
  const listeners = new Set<() => void>();
  const emit = (): void => {
    for (const listener of listeners) listener();
  };
  const update = (next: AgentRunAuditSnapshot): void => {
    snapshot = next;
    emit();
  };

  return {
    begin(runId, provider) {
      update({
        runId,
        provider,
        status: 'running',
        findings: [],
        resolutions: [],
        outbound: null,
        result: null,
      });
    },
    recordFindings(findings) {
      const byKey = new Map<string, SafeRunFinding>();
      for (const finding of [...snapshot.findings, ...findings]) {
        byKey.set(`${finding.id}:${finding.source}:${finding.disposition}`, { ...finding });
      }
      update({ ...snapshot, findings: [...byKey.values()] });
    },
    recordApprovedOutbound(request, provider) {
      const safeRequest = cloneRequest(request);
      const payloadJson = JSON.stringify(safeRequest, null, 2);
      update({
        ...snapshot,
        outbound: {
          request: safeRequest,
          provider,
          payloadJson,
          payloadBytes: new TextEncoder().encode(JSON.stringify(safeRequest)).byteLength,
          rawSensitiveValues: 0,
          rawPixelPayloads: 0,
          aliasCount: safeRequest.aliases.length,
          controlCount: new Set(
            safeRequest.sanitizedPageStructure.map((node) => node.controlId),
          ).size,
        },
      });
    },
    recordAliasResolution(resolution: SafeAliasResolution) {
      update({ ...snapshot, resolutions: [...snapshot.resolutions, { ...resolution }] });
    },
    complete(result) {
      update({ ...snapshot, status: result.status, reason: result.reason, result });
    },
    fail(reason) {
      update({ ...snapshot, status: 'error', reason, result: null });
    },
    getSnapshot() {
      return snapshot;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
