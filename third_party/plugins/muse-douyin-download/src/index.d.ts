/** Deployment settings for the bundled downloader and private resumable task registry. */
import type { Branded } from '@deepseek-ai/dsh-brand';
import type { JobId } from '@deepseek-ai/dsh-jobs';
import type {} from '@deepseek-ai/dsh-sandbox-policy';

declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap { 'douyin-download': 'douyin-download' }
}

export interface DouyinConfig {
  pythonExecutable?: string | null;
  ffprobeExecutable?: string | null;
  ffmpegExecutable?: string | null;
  settingsHome?: string | null;
  requestTimeoutMs?: number;
  timeoutMs?: number;
  /** Independent native transfer and complete local verification budgets; default 30 minutes. */
  nativeTimeoutMs?: number;
  maxDownloadBytes?: number;
  graceMs?: number;
  maxVideos?: number;
  /** Deadline for one normally authorized page-data read. */
  dataTimeoutMs?: number;
  /** Maximum comment items returned from one observed page. */
  maxComments?: number;
  taskMaxTasks?: number;
  taskRegistryMaxBytes?: number;
  taskLockTimeoutMs?: number;
  taskLockPollMs?: number;
  taskReceiptMaxBytes?: number;
  taskOutputMaxBytes?: number;
}
/** Model input for selected works' page data and optional verified media acquisition. */
export interface DouyinDataArgs {
  url?: string;
  urls?: string[];
  source?: 'auto' | 'public' | 'creator';
  includeComments?: boolean;
  commentCursor?: string;
  commentLimit?: number;
  download?: boolean;
}
/** Explicit initiating-session selection passed to the Desktop data service. */
export interface DouyinDataRequest {
  url: string;
  source: 'auto' | 'public' | 'creator';
  comments: { enabled: boolean; cursor?: string; count: number };
  timeoutMs: number;
}
/** Explicit batch options resolved before any service lookup. */
export interface ResolvedDouyinDataArgs {
  urls: string[];
  single: boolean;
  source: DouyinDataRequest['source'];
  comments: DouyinDataRequest['comments'];
  timeoutMs: number;
  download: boolean;
}
export interface DouyinArgs {
  url?: string;
  urls?: string[];
  publicOnly?: boolean;
  /** Wait preserves synchronous results; background accepts a durable task detached from the completed tool call. */
  mode?: 'wait' | 'background';
}
/** Durable plugin task identity deliberately differs from the browser's native DouyinTaskId brand. */
export type DouyinTaskId = Branded<'DouyinDownloadTaskId'>;
export type DouyinTaskState = 'queued' | 'running' | 'completed' | 'waiting_user' | 'waiting_source' | 'interrupted' | 'cancelled' | 'failed';
export type DouyinTaskControl = { action: 'list'; taskId?: never } | { action: 'status' | 'resume' | 'cancel'; taskId: string };
/** Persistent identity is distinct from the native-browser UUID and the process-local Jobs ID. */
export interface DouyinDownloadTask { id: DouyinTaskId; state: DouyinTaskState; jobId: JobId | null }
/** These files passed verification but their item transaction did not commit; they are not durable completed entries. */
export interface DouyinUnrecordedReceipt extends DouyinVerifiedReceipt { index: number }
/** A source-backed file result; successful records are rechecked against actual media and source.json bytes. */
export interface DouyinVerifiedReceipt {
  status: 'downloaded'; path: string; receipt: string; source: string; bytes: number; sha256: string;
  duration_seconds: number; full_decode_verified: true;
  width?: number; height?: number; authentication?: string; retrieved_at?: string;
  taskId?: Branded<'DouyinTaskId'>; targetVideoId?: Branded<'DouyinVideoId'>; evidence?: object;
}
export interface DouyinTaskItem {
  index: number; url: string; videoId: string | null;
  state: 'pending' | 'running' | 'completed' | 'waiting_user' | 'waiting_source' | 'interrupted';
  result?: DouyinVerifiedReceipt | { status: 'blocked'; code: string; message: string };
  error?: { code: string; message: string };
  reused?: true; reusedFromIndex?: number;
}
export interface DouyinTaskRecord {
  id: DouyinTaskId; schemaVersion: 1; revision: number; ownerSessionId: Branded<'SessionId'>;
  acceptanceKey: string; cwd: string;
  selection: { urls: string[]; single: boolean; publicOnly: boolean };
  state: DouyinTaskState; jobId: JobId | null; createdAt: string; updatedAt: string;
  items: DouyinTaskItem[]; error?: { code: string; message: string };
}
export const name: 'muse-douyin-download';
export const inject: readonly ['agents', 'tools', 'subprocess', 'jobs', 'sandboxPolicy'];
export function resolveConfig(config?: DouyinConfig): Required<DouyinConfig>;
export function runtimeUnavailable(config: Required<DouyinConfig>): { status: 'blocked'; code: 'RUNTIME_UNAVAILABLE'; message: string } | null;
export function validateArgs(value: unknown): DouyinArgs;
/** @param value Tool JSON. @param settings Resolved deployment settings. @returns Explicit data selection. */
export function resolveDataArgs(value: unknown, settings: Required<DouyinConfig>): ResolvedDouyinDataArgs;
/** @param value Sanitized Host answer. @param request Explicit request. @returns Bounded, credential-free tool data. */
export function projectDataResult(value: unknown, request: DouyinDataRequest): object;
export function downloadCommand(config: Required<DouyinConfig>, args: DouyinArgs, workspace: string): string[];
export function runDownloader(subprocess: object, config: Required<DouyinConfig>, argv: string[], workspace: string, signal?: AbortSignal): Promise<object>;
export function apply(ctx: object, config?: DouyinConfig): void;
