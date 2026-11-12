/** Ordinary workers can report only assignments actually consumed by their own Session. */
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from './index.ts'
import type { CoordinationTaskId } from './types.ts'

/** Preset contribution identity. */
export const name = 'muse-coordination-worker'
/** Report registration waits for the optional coordination service. */
export const inject = ['tools']

/**
 * Add the report tool without removing or replacing ordinary execution capabilities.
 * @param ctx - Ordinary worker preset scope.
 */
export async function apply(ctx: Context): Promise<void> {
  const fiber = ctx.inject(['sessionCoordinator'], (scope) => {
    scope.tools.register(defineTool({
      name: 'coordinator_report', description: 'Report only the exact current Main Session assignment and revision whose coordination brief this worker consumed. Never guess a newer revision. If human input changed, Main must inspect and reconcile it first. Use present for final files. Completion is published only after the turn and owned background jobs settle; it is not human acceptance.',
      parameters: {
        task_id: { type: 'string', required: true }, revision: { type: 'integer', required: true },
        outcome: { type: 'string', required: true, enum: ['completed', 'blocked', 'needs-input', 'failed'] },
        summary: { type: 'string', required: true },
      },
      output: { schema: { type: 'string' }, render: (_args, text) => [{ type: 'text', text }] },
      async execute(args, exec) {
        if (exec.agent === undefined) throw new Error('Report requires the execution Session')
        return JSON.stringify(await scope.sessionCoordinator.report(
          exec.agent, brandString<CoordinationTaskId>(args.task_id), args.revision, args.outcome, args.summary,
        ))
      },
    }))
  })
  await fiber.await()
}
