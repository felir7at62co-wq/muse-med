/** Main Session presentation tools over owner-verified receipts and one display Skill. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { brandString } from '@deepseek-ai/dsh-brand'
import { defineTool, ToolContextUnavailableError } from '@deepseek-ai/dsh-tools'
import { isModelInvocable } from '@deepseek-ai/dsh-skill'
import type { SessionCoordinator } from './index.ts'
import type { CoordinationTaskId } from './types.ts'

const reportSchema = {
  type: 'object', additionalProperties: false, properties: {
    version: { type: 'integer', const: 1, required: true },
    owner: { type: 'string', required: true },
    total: { type: 'integer', required: true },
    truncated: { type: 'boolean', required: true },
    tasks: { type: 'array', required: true, items: {
      type: 'object', additionalProperties: false, properties: {
        id: { type: 'string', required: true }, title: { type: 'string', required: true },
        revision: { type: 'integer', required: true }, sessionId: { type: 'string', required: true },
        cwd: { type: 'string', required: true },
        status: { type: 'string', required: true, enum: ['dispatching', 'reconciling', 'accepted', 'running', 'finishing', 'needs-report',
          'interrupted', 'stopping', 'stopped', 'completed', 'blocked', 'needs-input', 'failed'] },
        issue: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
        report: { required: true, oneOf: [{ type: 'null' }, {
          type: 'object', additionalProperties: false, properties: {
            outcome: { type: 'string', required: true, enum: ['completed', 'blocked', 'needs-input', 'failed'] },
            summary: { type: 'string', required: true }, throughSeq: { type: 'integer', required: true },
            files: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
              path: { type: 'string', required: true }, description: { type: 'string' },
            } } },
          },
        }] },
      },
    } },
  },
} as const

function caller(agent: Agent | undefined): Agent {
  if (agent === undefined) throw new ToolContextUnavailableError('Display requires the live Main Session')
  return agent
}

/**
 * Register card presentation without enabling general Skill loading or business execution.
 * @param ctx - Actual Main preset scope.
 * @param service - Owner-verifying task service.
 */
export function installDisplayTools(ctx: Context, service: SessionCoordinator): void {
  ctx.tools.register(defineTool({
    name: 'coordinator_show_report',
    description: 'Show an inline report card for this Main Session’s real tasks. Pass task_ids or omit for recent tasks. Status, revision, worker and presented files come from Host receipts, never model-supplied progress. Completion is not human acceptance.',
    parameters: { task_ids: { type: 'array', items: { type: 'string' }, description: 'Owned task IDs. Empty selects recent tasks; the configured search limit applies.' } },
    output: {
      schema: reportSchema,
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      presentationMeta: (_args, value) => ({ museCoordinationReport: value }),
    },
    async execute(args, exec) {
      const receipt = await service.displayReport(caller(exec.agent), args.task_ids?.map(id => brandString<CoordinationTaskId>(id)))
      return { ...receipt, tasks: receipt.tasks.map(task => ({ ...task,
        report: task.report === null ? null : { ...task.report, files: task.report.files.map(file => ({
          path: file.path, ...(file.description === undefined ? {} : { description: file.description }),
        })) },
      })) }
    },
    presentCall: () => ({ card: 'generic', title: 'Task report', kind: 'read' }),
    presentResult: (_args, { content }) => ({ card: 'generic', title: 'Task report', content, kind: 'read' }),
  }))
  ctx.tools.register(defineTool({
    name: 'coordinator_display_skill',
    description: 'Load the visualize authoring instructions before the first visualize call. This fixed display-only entry cannot load any other Skill. Use show_view for structured views and coordinator_show_report for authoritative task cards.',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_args, content) => [{ type: 'text', text: content }] },
    async execute(_args, exec) {
      const main = caller(exec.agent)
      await service.requireMain(main)
      const skills = ctx.get('skills')
      if (skills === undefined) throw new ToolContextUnavailableError('The display Skill service is unavailable')
      const skill = await skills.get('visualize', { scope: main, signal: exec.signal, cwd: main.session.header.cwd })
      if (skill === undefined || !isModelInvocable(skill)) throw new ToolContextUnavailableError('The visualize display Skill is unavailable')
      return skill.content
    },
  }))
}
