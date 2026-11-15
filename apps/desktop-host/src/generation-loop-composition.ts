/** Desktop automatic continuation preserves the configured Agent driver options. */
import { z } from 'zod'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'

/**
 * Enable durable input claims without replacing unrelated driver configuration.
 * @param entries - Effective profile entries before the product continuation override.
 * @returns The complete retained Agent driver configuration with durable claims enabled.
 */
export function generationLoopLayer(entries: readonly { id?: string; config?: unknown }[]): PatchOptions[] {
  const entry = entries.find(row => row.id === 'agent-loop')
  if (entry === undefined) throw new Error('muse-med: profile has no agent-loop row')
  const config = z.record(z.string(), z.unknown()).parse(entry.config ?? {})
  return [{ id: 'agent-loop', config: { ...config, durableInboxClaims: true } }]
}
