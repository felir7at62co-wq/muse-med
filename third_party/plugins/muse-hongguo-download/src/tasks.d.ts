import type { Agent, AgentRegistry } from '@deepseek-ai/dsh-agent';
import type { Branded } from '@deepseek-ai/dsh-brand';
import type { JobRegistry } from '@deepseek-ai/dsh-jobs';
import type { SessionId } from '@deepseek-ai/dsh-session';
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox';
import type { HongguoDownloadClient, HongguoDownloadConfig, DownloadOptions, DownloadResult, DownloadFailure } from './index.js';

/** Durable outer task identity, distinct from each run and Jobs record. */
export type HongguoTaskId = Branded<'HongguoTaskId'>;
/** One execution generation; controls never act on a different generation. */
export type HongguoRunId = Branded<'HongguoRunId'>;
export type HongguoTaskState = 'queued' | 'running' | 'paused' | 'cancelled' | 'completed' | 'failed' | 'interrupted' | 'blocked';
/** Chat uses a real live Agent; CLI operators may explicitly select an existing Session owner for controls only. */
export type HongguoTaskCaller = { kind: 'session'; agent: Agent } | {
  kind: 'cli'; operatorId: string; cwd: string; policy: SandboxExecutionPolicy; selectedOwnerSessionId?: SessionId;
};
/** Safe task projection; runtime PIDs and private source data are not public. */
export interface HongguoTaskEnvelope {
  id: HongguoTaskId; taskId: HongguoTaskId; kind: 'download'; runId: HongguoRunId | null; jobId: string | null;
  state: HongguoTaskState; owner: { kind: 'session' | 'cli'; id: string }; cwd: string;
  request: DownloadOptions; progress: Record<string, number | string> | null;
  summary: {
    ok: boolean; complete?: boolean; code?: string; path?: string; cleanupPendingPath?: string;
    sourceDiagnostic?: Pick<DownloadFailure, 'sourceStage' | 'retryable' | 'sourceFailures'>;
  } | null;
  createdAt: string; updatedAt: string;
}
/** Control acknowledgement is separate from a request being accepted or timed out. */
export interface HongguoTaskResult {
  ok: boolean; code?: string; message?: string; taskId?: HongguoTaskId; runId?: HongguoRunId | null;
  state?: HongguoTaskState; task?: HongguoTaskEnvelope; downloadTask?: HongguoTaskEnvelope; tasks?: HongguoTaskEnvelope[];
  control?: { state: 'acknowledged' | 'pending' | 'rejected'; requestId: string | null; runId: HongguoRunId | null };
  removed?: boolean; mediaPreserved?: boolean;
}
/** One instance owns live work while a workspace-private store survives restart without replay. */
export class HongguoTasks {
  constructor(config: HongguoDownloadConfig, dependencies: { client: HongguoDownloadClient; jobs?: JobRegistry; agents?: AgentRegistry; resolvePolicy?(agent: Agent): SandboxExecutionPolicy });
  download(args: DownloadOptions & { mode?: 'wait' | 'background' }, caller: HongguoTaskCaller, exec?: {
    signal?: AbortSignal; callId?: string; rootCallId?: string; onProgress?(progress: Record<string, number | string | boolean>): void | Promise<void>;
  }): Promise<HongguoTaskResult | ((DownloadResult | DownloadFailure) & HongguoTaskResult)>;
  control(args: { action: 'list' | 'status' | 'pause' | 'resume' | 'cancel' | 'retry' | 'remove'; taskId?: HongguoTaskId;
    expectedRunId?: HongguoRunId; requestId?: string; mode?: 'wait' | 'background' }, caller: HongguoTaskCaller, signal?: AbortSignal, execMeta?: { callId?: string; rootCallId?: string }): Promise<HongguoTaskResult>;
  /** Hold the stopped task and media writer locks while a same-package consumer owns offline work. */
  withStoppedTask<T>(taskId: HongguoTaskId, caller: HongguoTaskCaller, signal: AbortSignal, operation: (context: { signal: AbortSignal; task: Pick<HongguoTaskEnvelope, 'id' | 'kind' | 'owner' | 'cwd' | 'request' | 'state'> & { sourceIdentity: string | null; checkpointDirectory: string }; cwd: string; policy: SandboxExecutionPolicy; output: { path: string; create(): Promise<void> }; checkpoint: { directory: string; read(): Promise<object | null> } }) => Promise<T>): Promise<T>;
  dispose(): Promise<void>;
}
