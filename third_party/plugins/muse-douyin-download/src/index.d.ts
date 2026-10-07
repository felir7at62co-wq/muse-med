/** Deployment settings for the bundled Python downloader. */
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

}
export const name: 'muse-douyin-download';
export const inject: readonly ['agents', 'tools', 'subprocess'];
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
