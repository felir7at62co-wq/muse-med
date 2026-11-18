/** Review the exact video prompts and shot scope before a generation request. */
import { HarnessError } from '@deepseek-ai/dsh-error'
import type { JingliuSession } from '@deepseek-ai/dsh-jingliu-connection'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { isFields } from './catalog.ts'
type Fields = Record<string, JsonValue>

/**
 * Read the current locked text of each requested shot.
 * @param session - Authenticated studio.
 * @param project - Exact production ID.
 * @param args - Requested shots or episode.
 * @param signal - Tool cancellation.
 * @returns The explicit shot IDs and each locked prompt for confirmation.
 */
export async function reviewedShots(
  session: JingliuSession, project: string, args: Fields, signal: AbortSignal,
): Promise<{ ids: string[]; prompts: string[] }> {
  const read = (name: string, fields: Fields) => session.request('/desktop-agent/tool', { method: 'POST', signal, body: { name, project_id: project, args: fields } })
  let ids = args.shot_ids
  if (!Array.isArray(ids) || !ids.length) {
    const data = await read('list_shots', { project_id: project, ...(args.episode !== undefined && { episode: args.episode }), limit: 10000 })
    if (!isFields(data) || data.ok !== true || data.truncated !== false || !Array.isArray(data.shots) || data.total !== data.shots.length) throw new HarnessError('无法确认整批镜头，请按集查看或指定镜头。', 'JINGLIU_SHOT_SCOPE')
    ids = data.shots.filter(row => isFields(row) && row.special !== true).map(row => isFields(row) ? row.id ?? null : null)
  }
  if (!Array.isArray(ids) || !ids.length || !ids.every((id): id is string => typeof id === 'string' && /^[\w-]+$/u.test(id))) throw new HarnessError('请选择有效镜头。', 'JINGLIU_SHOT_SCOPE')
  const shots = [...new Set(ids)]
  const prompts: string[] = []
  for (const id of shots) {
    const shot = await read('get_shot', { shot_id: id })
    if (!isFields(shot) || shot.ok !== true || shot.id !== id || shot.stale === true || shot.prompt_state !== 'manual' ||
        !isFields(shot.override) || typeof shot.override.prompt !== 'string' || !shot.override.prompt.trim() || shot.override.prompt !== shot.gen_prompt) {
      throw new HarnessError('镜头 ' + id + ' 尚未锁定有效的审校稿。核对剧本、资产与引用后，用 set_shot_prompt 的 lock=true 写回。', 'JINGLIU_SHOT_REVIEW_REQUIRED')
    }
    prompts.push(id + '\n' + shot.override.prompt)
  }
  return { ids: shots, prompts }
}
