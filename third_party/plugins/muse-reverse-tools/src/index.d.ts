import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-tools';

/** Deployment limits for read-only inspection and bundled methodology resources. */
export interface ReverseConfig {
  assetRoot?: string;
  maxFileBytes?: number;
  maxSymbols?: number;
  maxSymbolNameBytes?: number;
  timeoutMs?: number;
}
export const name: 'muse-reverse-tools';
export const inject: readonly ['tools', 'agents'];
/** Validate all settings and the installed resource directory before activation. */
export function resolveConfig(config?: ReverseConfig): Readonly<Required<ReverseConfig>>;
/** Register tools on the owning context and await active reads on disposal. */
export function apply(ctx: Context, config?: ReverseConfig): void;
