/** Source-plane types for the fixture that installs the actual JavaScript Bot tools. */
import type { Context } from '@deepseek-ai/cordis'

export const name: string
export const inject: string[]
export function apply(ctx: Context): void
