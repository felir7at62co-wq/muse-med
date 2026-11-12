import type { Context } from '@deepseek-ai/cordis';
import type { HongguoDownloadClient, HongguoDownloadConfig, DownloadOptions } from './index.js';
import type { HongguoMerger } from './merger.js';
import type { HongguoTasks, HongguoTaskId, HongguoRunId } from './tasks.js';

/** Commands accepted by the model-free profile consumer. */
export type CliCommand = 'info' | 'download' | 'list' | 'status' | 'pause' | 'resume' | 'cancel' | 'retry' | 'remove' | 'merge';
/** Parsed CLI values; execution still uses the shared library's argument and permission checks. */
export interface CliRequest {
  command: CliCommand;
  download: Partial<DownloadOptions>;
  taskId?: HongguoTaskId;
  merge?: Parameters<HongguoMerger['merge']>[0];
  permissionMode: 'workspace-write' | 'read-only' | 'danger-full-access';
  selectedOwnerSessionId?: string;
  expectedRunId?: HongguoRunId;
  requestId?: string;
}
export const name: 'muse-hongguo-cli';
export const inject: readonly ['cmdlineArgs', 'subprocess', 'sandboxPolicy'];
/** Parse an immutable argument snapshot without filesystem or network effects. */
export function parseCliArguments(args: readonly string[]): CliRequest | { command: 'help' };
/** Read or exclusively create the dedicated profile's operator UUID; invalid records fail without replacement. */
export function readCliOperator(profileDirectory: string): Promise<string>;
/** Dispatch through the same catalog and task implementations as Muse's chat tools. */
export function executeCliCommand(
  request: CliRequest,
  client: HongguoDownloadClient,
  tasks: HongguoTasks,
  caller: Parameters<HongguoTasks['download']>[1],
  signal: AbortSignal,
  onProgress?: (progress: object) => void | Promise<void>,
  merger?: HongguoMerger,
): Promise<object>;
/** Mount only under a dsh launcher; disposal aborts and joins all owned work. */
export function apply(ctx: Context, config?: HongguoDownloadConfig): void;
