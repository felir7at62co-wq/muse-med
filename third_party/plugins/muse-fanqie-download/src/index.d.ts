import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-tools';
import type {} from '@deepseek-ai/dsh-subprocess';

/** Validated deployment limits; runtime credentials and identities are not configuration fields. */
export interface FanqieConfig {
  pythonExecutable?: string;
  requestTimeoutMs?: number;
  callTimeoutMs?: number;
  graceMs?: number;
  maxBooks?: number;
  batchSize?: number;
  maxResponseBytes?: number;
  maxChapterBytes?: number;
  maxBookBytes?: number;
  maxOutputBytes?: number;
}
export const name: 'muse-fanqie-download';
export const inject: readonly ['tools', 'agents', 'subprocess'];
/** Register tools through context effects; disposal awaits subprocess exit and cleanup. */
export function apply(ctx: Context, config?: FanqieConfig): void;
