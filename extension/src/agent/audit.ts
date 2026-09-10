import type {
  AgentActionKind,
  RemoteAgentRequest,
  SensitiveCategory,
  PerceptionSource,
} from '../types/contracts';
import type { AgentRunResult } from './loop';

export type AgentProviderLabel = 'offline' | 'gemini' | 'ollama' | 'zen';

export interface SafeRunFinding {
  id: string;
  category: SensitiveCategory;
  source: PerceptionSource;
  disposition: 'aliased' | 'masked' | 'blocked';
}

export interface SafeAliasResolution {
  alias: string;
  target: string;
  action: Extract<AgentActionKind, 'TYPE' | 'SELECT'>;
}

export interface ApprovedOutboundAudit {
  request: RemoteAgentRequest;
  provider: AgentProviderLabel;
  payloadJson: string;
  payloadBytes: number;
  rawSensitiveValues: 0;
  rawPixelPayloads: 0;
  aliasCount: number;
  controlCount: number;
}

export interface AgentRunAuditSink {
  recordFindings(findings: readonly SafeRunFinding[]): void;
  recordApprovedOutbound(request: RemoteAgentRequest, provider: AgentProviderLabel): void;
  recordAliasResolution(resolution: SafeAliasResolution): void;
}

export interface AgentRunAuditSnapshot {
  runId: string | null;
  provider: AgentProviderLabel | null;
  status: 'idle' | 'running' | AgentRunResult['status'];
  reason?: string;
  findings: SafeRunFinding[];
  resolutions: SafeAliasResolution[];
  outbound: ApprovedOutboundAudit | null;
  result: AgentRunResult | null;
}
