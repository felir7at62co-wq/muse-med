/** Production coordinates reconstructed only from recorded structured tool results. */
import { z } from 'zod'
import type { SessionVideoProduction } from './types.ts'

const id = z.number().int().positive()
/** Validated production facts retained in the private, disposable projection cache. */
export const productionSchema = z.object({
  scriptId: id, episodeId: id.optional(), episodeNumber: id.optional(), packageIndex: id.optional(),
  storyboardId: id.optional(), taskId: id.optional(), subtaskId: id.optional(), shotNumbers: z.array(id).optional(),
  shotRanges: z.array(z.object({ shotNumber: id, startSeconds: z.number().nonnegative(), endSeconds: z.number().positive() })
    .refine(range => range.endSeconds > range.startSeconds)).optional(),
})

/** Version-bound production metadata retained in tool results and the private source projection. */
export const videoBindingSchema = z.object({ key: z.string(), sourceVersion: z.string(), production: productionSchema })
type ProductionFact = z.infer<typeof productionSchema>

/** Recorded request coordinates used only to correlate a successful result. */
export interface ProductionCall {
  readonly name: string
  readonly taskId: number | null
  readonly subtaskId?: number | undefined
  readonly scriptId?: number | undefined
  readonly storyboardId?: number | undefined
  readonly method?: string | undefined
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function positive(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

function rows(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.flatMap((item) => { const row = object(item); return row === undefined ? [] : [row] }) : []
}

function parse(value: unknown): ProductionFact | undefined {
  const result = productionSchema.safeParse(value)
  return result.success ? result.data : undefined
}

/**
 * Retain validated request IDs without treating names or episode labels as identities.
 * @param args - Parsed durable tool arguments.
 * @returns Optional request coordinates needed to correlate a successful result.
 */
export function productionRequest(args: Record<string, unknown> | undefined): Omit<ProductionCall, 'name' | 'taskId'> {
  const scriptId = positive(args?.script_id), storyboardId = positive(args?.storyboard_id), subtaskId = positive(args?.subtask_id)
  return { ...(typeof args?.method === 'string' ? { method: args.method } : {}),
    ...(scriptId === undefined ? {} : { scriptId }), ...(storyboardId === undefined ? {} : { storyboardId }),
    ...(subtaskId === undefined ? {} : { subtaskId }) }
}

function unique(values: readonly (number | undefined)[]): number | undefined {
  const present = [...new Set(values.filter((value): value is number => value !== undefined))]
  return present.length === 1 ? present[0] : undefined
}

/**
 * Read exact project, episode, card and task associations from successful tool output.
 * @param call - Recorded request that owns this result.
 * @param result - Parsed structured result; assistant text is never accepted.
 * @returns Production associations without inferring episode numbers from IDs or names.
 */
export function productionFacts(call: ProductionCall, result: Record<string, unknown>): ProductionFact[] {
  const facts: ProductionFact[] = []
  const add = (value: unknown) => { const fact = parse(value); if (fact !== undefined) facts.push(fact) }
  if (['jubian_model', 'jubian_catalog'].includes(call.name) && call.method === 'episodes' && call.scriptId !== undefined) {
    for (const row of rows(object(result.episodes)?.rows)) {
      if (positive(row.episode_id) !== undefined && positive(row.episode_count) !== undefined) {
        add({ scriptId: call.scriptId, episodeId: row.episode_id, episodeNumber: row.episode_count })
      }
    }
  }
  if (call.name === 'muse_production' && ['preview', 'read', 'update'].includes(String(result.method))) {
    const scriptId = positive(result.script_id), episodeNumber = positive(result.episode)
    if (scriptId !== undefined && episodeNumber !== undefined) {
      const packages = [...rows(result.package_index), ...(result.section === 'packages' ? rows(result.rows) : [])]
      for (const pack of packages) {
        if (positive(pack.storyboard_id) === undefined || positive(pack.index) === undefined) continue
        add({ scriptId, episodeNumber, storyboardId: pack.storyboard_id, packageIndex: pack.index,
          ...(Array.isArray(pack.shots) ? { shotNumbers: pack.shots } : {}) })
      }
    }
  }
  if (call.name === 'jubian_storyboard' && call.method === 'read') {
    const board = object(result.storyboard), snapshot = object(board?.snapshot)
    const scriptId = positive(board?.script_id), storyboardId = positive(board?.storyboard_id)
    if (scriptId !== undefined && storyboardId !== undefined && (call.storyboardId === undefined || call.storyboardId === storyboardId)) {
      add({ scriptId, storyboardId, ...(positive(snapshot?.episodeId) === undefined ? {} : { episodeId: snapshot?.episodeId }) })
    }
  }
  if (call.name === 'jubian_video') {
    const task = object(result.task)
    if (positive(task?.task_id) !== undefined && positive(task?.script_id) !== undefined
      && (call.taskId === null || task?.task_id === call.taskId)) {
      add({ scriptId: task?.script_id, taskId: task?.task_id,
        ...(positive(task?.episode_id) === undefined ? {} : { episodeId: task?.episode_id }) })
    }
    const source = object(result.sources)
    const scriptId = positive(source?.script_id), storyboardId = positive(source?.storyboard_id)
    if (scriptId !== undefined && storyboardId !== undefined
      && (call.scriptId === undefined || call.scriptId === scriptId)
      && (call.storyboardId === undefined || call.storyboardId === storyboardId)) {
      for (const row of rows(source?.sources)) if (positive(row.task_id) !== undefined) {
        add({ scriptId, storyboardId, taskId: row.task_id })
      }
    }
  }
  return facts
}

/**
 * Associate one generated video with its recorded project or original provider task.
 * @param call - Recorded video or download call.
 * @param result - Its successful structured result.
 * @param row - Exact successful provider child result, when present.
 * @param facts - Bounded production facts from this same Session.
 * @returns Direct source coordinates, or undefined without an unambiguous project.
 */
export function videoProduction(call: ProductionCall, result: Record<string, unknown>, row: Record<string, unknown> | undefined,
  facts: readonly SessionVideoProduction[]): ProductionFact | undefined {
  const source = object(result.sources)
  const taskId = positive(row?.task_id) ?? positive(row?.parent_task_id) ?? positive(call.taskId)
  const project = unique(facts.filter(fact => taskId !== undefined && fact.taskId === taskId).map(fact => fact.scriptId))
  const scriptId = positive(source?.script_id) ?? project
  if (scriptId === undefined || source !== undefined && call.scriptId !== undefined && scriptId !== call.scriptId) return undefined
  const storyboardId = positive(source?.storyboard_id)
  if (storyboardId !== undefined && call.storyboardId !== undefined && storyboardId !== call.storyboardId) return undefined
  const subtaskId = positive(row?.subtask_id) ?? positive(call.subtaskId)
  return parse({ scriptId, ...(storyboardId === undefined ? {} : { storyboardId }),
    ...(taskId === undefined ? {} : { taskId }),
    ...(subtaskId === undefined ? {} : { subtaskId }) })
}

/**
 * Enrich a source from unique, recorded task, storyboard and episode associations.
 * @param source - Exact source coordinates captured with its video result.
 * @param facts - Bounded structured facts owned by the same Session projection.
 * @returns Safe production fields; conflicting optional associations are omitted.
 */
export function resolveVideoProduction(source: SessionVideoProduction | undefined,
  facts: readonly SessionVideoProduction[]): ProductionFact | undefined {
  if (source === undefined) return undefined
  const project = facts.filter(fact => fact.scriptId === source.scriptId)
  const task = project.filter(fact => source.taskId !== undefined && fact.taskId === source.taskId)
  const storyboardId = unique([source.storyboardId, ...task.map(fact => fact.storyboardId)])
  const cards = project.filter(fact => storyboardId !== undefined && fact.storyboardId === storyboardId)
  const linked = [source, ...task, ...cards]
  const episodeId = unique(linked.map(fact => fact.episodeId))
  const episodeConflict = new Set(linked.flatMap(fact => fact.episodeId === undefined ? [] : [fact.episodeId])).size > 1
  const episodes = project.filter(fact => episodeId !== undefined && fact.episodeId === episodeId
    && fact.storyboardId === undefined && fact.taskId === undefined)
  const episodeNumber = episodeConflict ? undefined : unique([...linked, ...episodes].map(fact => fact.episodeNumber))
  const packageIndex = unique([source, ...cards].map(fact => fact.packageIndex))
  const shotLists = [source, ...cards].flatMap(fact => fact.shotNumbers === undefined ? [] : [fact.shotNumbers])
  const shotNumbers = shotLists.length > 0 && shotLists.every(shots => JSON.stringify(shots) === JSON.stringify(shotLists[0]))
    ? shotLists[0] : undefined
  return { scriptId: source.scriptId, ...(source.taskId === undefined ? {} : { taskId: source.taskId }),
    ...(source.subtaskId === undefined ? {} : { subtaskId: source.subtaskId }),
    ...(storyboardId === undefined ? {} : { storyboardId }), ...(episodeId === undefined ? {} : { episodeId }),
    ...(episodeNumber === undefined ? {} : { episodeNumber }), ...(packageIndex === undefined ? {} : { packageIndex }),
    ...(shotNumbers === undefined ? {} : { shotNumbers: [...shotNumbers] }),
    ...(source.shotRanges === undefined ? {} : { shotRanges: source.shotRanges.map(range => ({ ...range })) }) }
}
