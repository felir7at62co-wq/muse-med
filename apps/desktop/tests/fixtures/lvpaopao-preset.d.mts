/** Public-test declarations for the source-only Lvpaopao composition fixture. */
import type { Context } from '@deepseek-ai/cordis'

/** Return the actual source modules for the test Loader. */
export function lvpaopaoModules(): Map<string, unknown>
/** Whether the Host service loaded a private connection file. */
export function bridgeConfigured(ctx: Context): boolean
/** Exercise the actual shared service after consumer disposal. */
export function requestBridgeStatus(ctx: Context, signal: AbortSignal): Promise<unknown>
