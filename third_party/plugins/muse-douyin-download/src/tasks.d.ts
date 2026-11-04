/** Persistent selected-video task controller; runtime resources remain owned until disposal settles. */
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { DouyinArgs, DouyinConfig, DouyinDownloadTask, DouyinTaskControl, DouyinTaskRecord } from './index.js';
import type {} from '@deepseek-ai/dsh-jobs';
import type {} from '@deepseek-ai/dsh-sandbox-policy';

export class DouyinTasks {
  /** @param ctx Real agent registry, jobs and sandbox policy. @param settings Complete deployment settings. @param dependencies Existing verified acquisition and optional clock. */
  constructor(ctx: Context, settings: Required<DouyinConfig>, dependencies: {
    acquireVideo(agent: Agent, url: string, publicOnly: boolean, signal: AbortSignal, transport: { background: boolean }): Promise<object>;
    now?: () => number;
  });
  /** @returns Private registry initialization; persisted business work never replays automatically. */
  ready(): Promise<void>;
  /** @param args Selected official URLs and explicit wait/background mode. @param agent Exact live owner. @param exec Logged tool identity and pre-acceptance/caller cancellation. @returns Legacy result fields with a durable task receipt, or a queued acceptance. */
  download(args: DouyinArgs, agent: Agent, exec: { callId: string; signal?: AbortSignal }): Promise<object>;
  /** @param args One Session-owned task action. @param agent Exact live caller. @param signal Control-call cancellation, detached after successful resume acceptance. @returns Owned task state, list or stable queued acceptance. */
  control(args: DouyinTaskControl, agent: Agent, signal?: AbortSignal): Promise<{ downloadTask: DouyinDownloadTask; task?: DouyinTaskRecord } | { tasks: { downloadTask: DouyinDownloadTask; task: DouyinTaskRecord }[]; count: number; complete: true }>;
  /** @returns Completion after subprocess/native I/O, durable final state and private leases settle. */
  dispose(): Promise<void>;
}
