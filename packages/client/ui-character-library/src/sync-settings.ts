/** Shared synchronization validation for the Host projection and browser reader. */
import z from '@deepseek-ai/schemastery'

/** Host configuration entry exposed to the browser settings reader. */
export const SETTINGS_NAMESPACE = 'ui-character-library'

/** Whole milliseconds between completed catalog reads. */
export const syncIntervalField = z.number().step(1).min(1000).max(300_000).default(30_000)
