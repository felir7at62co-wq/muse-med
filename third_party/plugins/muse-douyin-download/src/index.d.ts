/** Deployment settings for the bundled Python downloader. */
export interface DouyinConfig {
  pythonExecutable?: string | null;
  ffprobeExecutable?: string | null;
  ffmpegExecutable?: string | null;
  settingsHome?: string | null;
  requestTimeoutMs?: number;
  timeoutMs?: number;
  maxDownloadBytes?: number;
  graceMs?: number;
  maxVideos?: number;
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
export function downloadCommand(config: Required<DouyinConfig>, args: DouyinArgs, workspace: string): string[];
export function runDownloader(subprocess: object, config: Required<DouyinConfig>, argv: string[], workspace: string, signal?: AbortSignal): Promise<object>;
export function apply(ctx: object, config?: DouyinConfig): void;
