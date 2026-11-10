import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-tools';
import type {} from '@deepseek-ai/dsh-subprocess';
import type {} from '@deepseek-ai/dsh-sandbox-policy';
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox';
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess';

/** Deployment fields never store signing credentials. */
export interface HongguoDownloadConfig {
  legacyBackend?: 'v1' | 'v2'; v2RuntimeDir?: string; v2StateDir?: string; v2Quality?: '1080p' | '720p' | '540p' | '480p' | '360p';
  v2PollIntervalMs?: number; v2RequestTimeoutMs?: number; v2StartupTimeoutMs?: number; v2ShutdownTimeoutMs?: number;
  v2MaxLineBytes?: number; v2MaxPendingRequests?: number; v2MaxEpisodesPerJob?: number; v2EpisodesAtOnce?: number; v2ConnectionsPerFile?: number;
  sourceMode?: 'legacy' | 'manifest' | 'public'; legacyAppDir?: string; signServer?: string;
  signTokenEnv?: string; catalogPath?: string; outputRoot?: string; mediaHosts?: string[]; mediaPorts?: number[];
  pythonExecutable?: string; ffmpegExecutable?: string; ffprobeExecutable?: string;
  javaExecutable?: string; signerStartupTimeoutMs?: number; signerHeapMb?: number;
  signerPollIntervalMs?: number; signerPortAttempts?: number;
  bootstrapDevices?: boolean; deviceBootstrapTimeoutMs?: number;
  mediaUserAgent?: string; retryDelayMs?: number;
  mediaRequestIntervalMs?: number; mediaIdleTimeoutMs?: number; mediaBatchSize?: number;
  mediaConnections?: number; mediaConnectionLimit?: number; mediaSegmentMinBytes?: number;
  emptySourceCooldownMs?: number; resumeSearchDepth?: number; resumeSearchEntries?: number;
  requestTimeoutMs?: number; downloadTimeoutMs?: number; callTimeoutMs?: number;
  mediaProcessGraceMs?: number;
  maxResponseBytes?: number; maxEpisodeBytes?: number; maxSeries?: number; concurrency?: number; retries?: number;
}
export interface DownloadOptions {
  seriesIds: string[]; sourceMode?: 'legacy' | 'manifest' | 'public'; episodes?: number[]; outputDir?: string;
}
export interface DownloadedEpisode {
  index: number; title: string; path: string; durationSeconds: number | null; bytes: number; sha256: string;
  sourceBytes: number | null; sourceSha256: string | null; encryptedSource: boolean | null; origin?: 'engine-output';
  format: 'mp4'; validationLevel: 'ffprobe-full-decode-sha256'; fullDecodeChecked: true;
}
export interface DownloadFailure {
  ok: false; complete: false; code: string; message: string; sourceBackend?: 'v2';
  safeReason?: string; freeUsed?: number; freeLimit?: number;
  upstreamCode?: number; sourceStage?: 'catalog' | 'video_model' | 'source_api'; retryable?: false;
  httpStatus?: number; responseBytes?: number;
  path?: string; checkpoint?: string; retainedEpisodeCount?: number; reusedEpisodeCount?: number;
  remainingEpisodeCount?: number; discoveryTruncated?: boolean; resume?: DownloadOptions;
}
export interface DownloadResult {
  ok: true; sourceBackend?: 'v2'; sourceMode: 'legacy' | 'manifest' | 'public'; complete: boolean; path: string; validatedBytes: number;
  checkpoint: string; retainedEpisodeCount: number; reusedEpisodeCount: number; remainingEpisodeCount: number;
  newlyDownloadedEpisodeCount: number; discoveryTruncated: boolean; sourceIdentity: string | null;
  validationLevel: 'ffprobe-full-decode-sha256'; fullDecodeChecked: true; note: string;
  items: { seriesId: string; title: string; source: string; episodeCount: number; downloadedEpisodeCount: number; complete: boolean; path: string; episodes: DownloadedEpisode[] }[];
}
export interface DownloadInfo {
  ok: true; sourceBackend?: 'v2'; sourceMode: 'legacy' | 'manifest' | 'public'; verifiedDownload: false; note: string;
  items: { seriesId: string; title: string; source: string; episodeCount: number; accessibleEpisodeCount: number | null;
    completeCatalog: boolean; downloaded: false; mediaUrlsVerified: false; fullSeriesAvailable: false | null }[];
}
export interface DownloadHealthFailure {
  ok: false; code: string; message: string; sourceBackend?: 'v1' | 'v2';
  authorization: 'not_checked'; mediaAvailability: 'not_tested'; verifiedDownload: false;
}
export interface DownloadHealth {
  ok: true; sourceBackend: 'v2'; scope: 'local' | 'catalog'; sourceIdentity: string;
  checks: { runtimeIntegrity: 'passed'; physicalDevice: 'matched'; engineHandshake: 'passed'; licenseBrokerHandshake: 'passed'; localLicenseStatus: 'read'; catalog: 'not_requested' | 'passed'; shutdown: 'confirmed' };
  engine: { engineVersion: string; protocol: 2; build: number };
  localLicenseStatus: { mode: string; reason: string; refreshed: false };
  authorization: 'not_checked'; mediaAvailability: 'not_tested'; verifiedDownload: false;
  items?: { seriesId: string; title: string; episodeCount: number; completeCatalog: boolean; mediaUrlsVerified: false; fullSeriesAvailable: null }[];
}
/** Downloads require a managed subprocess provider and workspace; external destinations additionally require full-access policy. */
export class HongguoDownloadClient {
  constructor(config?: HongguoDownloadConfig, dependencies?: { subprocess?: SubprocessRuntime });
  readonly config: Readonly<Required<HongguoDownloadConfig>>;
  info(options: Pick<DownloadOptions, 'seriesIds' | 'sourceMode'>, signal?: AbortSignal): Promise<DownloadInfo | DownloadFailure>;
  download(options: DownloadOptions, signal?: AbortSignal, workspace?: string, filePolicy?: SandboxExecutionPolicy): Promise<DownloadResult | DownloadFailure>;
  health(options?: { seriesIds?: string[] }, signal?: AbortSignal): Promise<DownloadHealth | DownloadHealthFailure>;
  dispose(): Promise<void>;
}
export const name: 'muse-hongguo-download';
export const inject: readonly ['tools', 'agents', 'subprocess'];
export function resolveConfig(config?: HongguoDownloadConfig): Readonly<Required<HongguoDownloadConfig>>;
/** Register tools on the owning Cordis context; its effects dispose owned downloads on unload. */
export function apply(ctx: Context, config?: HongguoDownloadConfig): void;
