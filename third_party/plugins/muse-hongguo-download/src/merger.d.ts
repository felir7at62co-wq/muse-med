import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess';
import type { HongguoDownloadConfig, DownloadFailure } from './index.js';
import type { HongguoTasks, HongguoTaskCaller, HongguoTaskId } from './tasks.js';

/** Only verified episodes from the source task are eligible; omission retains the original task selection. */
export interface HongguoMergeOptions {
  taskId: HongguoTaskId; seriesId?: string; episodes?: number[];
  mode?: 'auto' | 'copy' | 'compatible'; outputFile?: string;
}
/** A published, completely decoded MP4; complete refers only to the declared series episode list. */
export interface HongguoMergedVideo {
  ok: true; path: string; receipt: string; sourceTaskId: HongguoTaskId; seriesId: string; episodes: number[];
  seriesEpisodeCount: number; complete: boolean; requestedMode: 'auto' | 'copy' | 'compatible'; actualMode: 'copy' | 'compatible';
  durationSeconds: number; width: number; height: number; videoCodec: string; bytes: number; sha256: string;
  fullDecodeChecked: true; validationLevel: 'ffprobe-full-decode-sha256';
  sources: { index: number; path: string; bytes: number; sha256: string }[];
}
export type HongguoMergeResult = HongguoMergedVideo | DownloadFailure;
/** Serial offline assembly whose disposal joins all native work and private-file cleanup. */
export class HongguoMerger {
  constructor(dependencies: { tasks: HongguoTasks; subprocess: SubprocessRuntime; config?: HongguoDownloadConfig });
  merge(options: HongguoMergeOptions, caller: HongguoTaskCaller, signal?: AbortSignal): Promise<HongguoMergeResult>;
  dispose(): Promise<void>;
}
