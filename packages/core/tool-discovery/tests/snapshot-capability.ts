/** Deterministic capability for the shipped-profile discovery replay. */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

/** Snapshot fixture plugin name. */
export const name = 'snapshot-discovery-capability'
/** Tool registry used by the fixture. */
export const inject = ['tools']

/** Register a normal capability whose definition starts deferred.
 * @param ctx - Snapshot composition context.
 */
export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({ name: 'snapshot_ping', description: 'Return pong.', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async () => 'pong',
  }))
}
