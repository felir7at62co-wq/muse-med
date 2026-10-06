import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-tools';
import type {} from '@deepseek-ai/dsh-subprocess';
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess';

/** Deployment fields never store signing credentials. */
export interface HongguoDownloadConfig {
  sourceMode?: 'legacy' | 'manifest' | 'public'; legacyAppDir?: string; signServer?: string;
  signTokenEnv?: string; catalogPath?: string; outputRoot?: string; mediaHosts?: string[]; mediaPorts?: number[];
  pythonExecutable?: string; ffmpegExecutable?: string; ffprobeExecutable?: string;
  javaExecutable?: string; signerStartupTimeoutMs?: number; signerHeapMb?: number;
  signerPollIntervalMs?: number; signerPortAttempts?: number;
  bootstrapDevices?: boolean; deviceBootstrapTimeoutMs?: number;
  mediaUserAgent?: string; retryDelayMs?: number;
  requestTimeoutMs?: number; downloadTimeoutMs?: number; callTimeoutMs?: number;
  mediaProcessGraceMs?: number;
  maxResponseBytes?: number; maxEpisodeBytes?: number; maxSeries?: number; concurrency?: number; retries?: number;
}
export interface DownloadOptions {
  seriesIds: string[]; sourceMode?: 'legacy' | 'manifest' | 'public'; episodes?: number[]; outputDir?: string;
}
export interface DownloadedEpisode {
  index: number; title: string; path: string; durationSeconds: number | null; bytes: number; sha256: string;
  sourceBytes: number; sourceSha256: string; encryptedSource: boolean;
  format: 'mp4'; validationLevel: 'ffprobe-full-decode-sha256'; fullDecodeChecked: true;
}
export interface DownloadFailure { ok: false; complete: false; code: string; message: string }
export interface DownloadResult {
  ok: true; sourceMode: 'legacy' | 'manifest' | 'public'; complete: boolean; path: string; validatedBytes: number;
  validationLevel: 'ffprobe-full-decode-sha256'; fullDecodeChecked: true; note: string;
  items: { seriesId: string; title: string; source: string; episodeCount: number; downloadedEpisodeCount: number; complete: boolean; path: string; episodes: DownloadedEpisode[] }[];
}
export interface DownloadInfo {
  ok: true; sourceMode: 'legacy' | 'manifest' | 'public'; verifiedDownload: false; note: string;
  items: { seriesId: string; title: string; source: string; episodeCount: number; accessibleEpisodeCount: number;
    completeCatalog: boolean; downloaded: false; fullSeriesAvailable: boolean }[];
}
/** Standalone downloads require a managed subprocess provider and an explicit workspace; Muse supplies both. */
export class HongguoDownloadClient {
  constructor(config?: HongguoDownloadConfig, dependencies?: { subprocess?: SubprocessRuntime });
  readonly config: Readonly<Required<HongguoDownloadConfig>>;
  info(options: Pick<DownloadOptions, 'seriesIds' | 'sourceMode'>, signal?: AbortSignal): Promise<DownloadInfo | DownloadFailure>;
  download(options: DownloadOptions, signal?: AbortSignal, workspace?: string): Promise<DownloadResult | DownloadFailure>;
  dispose(): Promise<void>;
}
export const name: 'muse-hongguo-download';
export const inject: readonly ['tools', 'agents', 'subprocess'];
export function resolveConfig(config?: HongguoDownloadConfig): Readonly<Required<HongguoDownloadConfig>>;
/** Register tools on the owning Cordis context; its effects dispose owned downloads on unload. */
export function apply(ctx: Context, config?: HongguoDownloadConfig): void;
