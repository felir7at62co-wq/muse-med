/** Manual project creation and read-only project or original-operation lookup. */
import { JubianError, type JubianClient, type JubianLedger } from '@deepseek-ai/dsh-jubian'
import { buildManuscriptDetailRequest, buildManuscriptProjectCheckRequest, buildProjectCreateRequest, readCreatedProjectId,
  readManuscriptDetail, readManuscriptProjectCheck, readProjectDetail } from '@deepseek-ai/dsh-jubian-api'
import type { ProjectCreateInput, ProjectDetail } from '@deepseek-ai/dsh-jubian-api'
import { need, requireKey } from './write.ts'
import { projectOperation, readProjectOperationReceipt } from './project-operation.ts'

/** Arguments for manual creation, current project details and original operation receipts. */
export interface ProjectArgs {
  method: 'get' | 'create' | 'operation'
  script_id?: number
  manuscript_id?: number
  script_name?: string
  production_type?: 0 | 1
  produce_type?: 1 | 2
  script_style?: number
  episode_count?: number
  storyboard_count_per_episode?: number
  global_config?: Record<string, unknown>
  idempotency_key?: string
}

function positive(value: number | undefined, field: string): number {
  if (value === undefined || !Number.isSafeInteger(value) || value < 1) {
    throw new JubianError('INVALID_ARGUMENT', `${field} must be a positive integer`)
  }
  return value
}

function projectView(project: ProjectDetail): Record<string, unknown> {
  const { snapshot: _snapshot, ...view } = project
  return view
}

/**
 * Read the exact project's identity and current metadata.
 * @param client - Shared authenticated provider client.
 * @param scriptId - Exact remote project ID.
 * @returns Current project data; a response for a different ID is refused.
 */
async function projectAt(client: JubianClient, scriptId: number): Promise<ProjectDetail> {
  const result = await client.request({ method: 'GET', path: `/aigc/script/${scriptId}` })
  const project = readProjectDetail(result.data)
  if (project.script_id !== scriptId) throw new JubianError('CONTRACT_CHANGED', 'Project readback returned a different ID')
  return project
}

/**
 * Refuse another content project when the provider reports an existing manuscript/workbench association.
 * @param client - Current authenticated provider transport.
 * @param manuscriptId - Exact manuscript selected for the new project.
 * @param productionType - Selected storyboard or canvas workbench.
 */
export async function ensureNoManuscriptProject(client: JubianClient, manuscriptId: number,
  productionType: 0 | 1): Promise<void> {
  const response = await client.request(buildManuscriptProjectCheckRequest(manuscriptId, productionType))
  if (readManuscriptProjectCheck(response.data) > 0) {
    throw new JubianError('INVALID_ARGUMENT', 'This manuscript already has a project in the selected workbench. Inspect existing projects instead of creating another; the existence indicator is not a project ID.')
  }
}

function manualCreate(args: ProjectArgs): Record<string, unknown> {
  const productionType = need(args.production_type, 'production_type')
  const produceType = need(args.produce_type, 'produce_type')
  const common = {
    scriptName: need(args.script_name, 'script_name'), createType: 1 as const, productionType,
    ...(args.script_style === undefined ? {} : { scriptStyle: args.script_style }),
    ...(args.episode_count === undefined ? {} : { episodeCount: args.episode_count }),
    ...(args.storyboard_count_per_episode === undefined ? {} : { storyboardCountPerEpisode: args.storyboard_count_per_episode }),
    ...(args.global_config === undefined ? {} : { globalConfig: args.global_config }),
  }
  if (productionType === 0) {
    need(args.script_style, 'script_style')
    need(args.episode_count, 'episode_count')
    need(args.storyboard_count_per_episode, 'storyboard_count_per_episode')
  }
  const input: ProjectCreateInput = produceType === 1
    ? { ...common, produceType, manuscriptId: positive(args.manuscript_id, 'manuscript_id') }
    : { ...common, produceType }
  return buildProjectCreateRequest(input)
}

/**
 * Create a manual project or read its existing identity without starting AI parsing or generation.
 * @param client - Shared authenticated client.
 * @param ledger - Shared write history for retry reconciliation.
 * @param args - Explicit creation settings, existing project identity, or the original operation key.
 * @returns Project metadata or original write evidence; acceptance does not imply content validation.
 */
export async function projectMethod(client: JubianClient, ledger: JubianLedger,
  args: ProjectArgs): Promise<Record<string, unknown>> {
  switch (args.method) {
    case 'operation': return await readProjectOperationReceipt(ledger, requireKey(args.idempotency_key))
    case 'get': return { project: projectView(await projectAt(client, positive(args.script_id, 'script_id'))) }
    case 'create': {
      const key = requireKey(args.idempotency_key)
      const body = manualCreate(args)
      const result = await projectOperation(client, ledger, { key, method: 'project_create',
        ...(args.produce_type === 1 ? { binding: { manuscriptId: positive(args.manuscript_id, 'manuscript_id'),
          productionType: need(args.production_type) } } : {}),
        intent: { action: 'create', body: { ...body, globalConfig: args.global_config ?? null } },
        prepare: async () => {
          if (args.produce_type === 1) {
            const manuscriptId = positive(args.manuscript_id, 'manuscript_id')
            const response = await client.request(buildManuscriptDetailRequest(manuscriptId))
            if (readManuscriptDetail(response.data).manuscript_id !== manuscriptId) {
              throw new JubianError('CONTRACT_CHANGED', 'Manuscript readback returned a different ID; no project was created')
            }
            await ensureNoManuscriptProject(client, manuscriptId, need(args.production_type))
          }
          return { method: 'POST', path: '/aigc/script', body }
        } })
      let scriptId: number | null = null
      let readback: Record<string, unknown> = { status: 'not_read', reason: 'No new project ID was returned on this invocation; reconcile the recorded key before creating again.' }
      if (result.outcome === 'accepted') {
        try { scriptId = readCreatedProjectId(result.data) }
        catch (_error) {
          readback = { status: 'unavailable', reason: 'The accepted response does not prove a scalar project ID. Query the original operation receipt; do not create another project.' }
        }
      }
      if (scriptId !== null && !result.replayed) {
        try { readback = { status: 'read', project: projectView(await projectAt(client, scriptId)) } }
        catch (error) {
          readback = { status: 'unavailable', reason: error instanceof JubianError ? error.message : 'Project readback failed' }
        }
      }
      if (scriptId !== null && result.replayed) readback = { status: 'not_read', reason: 'Project ID recovered from the original operation receipt.' }
      return { method: args.method, script_id: scriptId, ...result, readback,
        original_idempotency_key: args.idempotency_key, ai_parsing_started: false, generation_started: false,
        next: 'Use the verified project ID when available. If the accepted response or readback is unclear, query operation with the original key; do not create another project.' }
    }
    default: throw new JubianError('INVALID_ARGUMENT', 'Unsupported jubian_project method')
  }
}
