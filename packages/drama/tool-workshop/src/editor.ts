/** Stage a single proposed episode revision for review in the Muse script panel. @module */
import type { Context } from '@deepseek-ai/cordis'
import { HarnessError } from '@deepseek-ai/dsh-error'
import { defineTool, ToolArgsError, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { assertNever, type JsonValue } from '@deepseek-ai/dsh-util-values'
import type { WorkshopConnection } from '@deepseek-ai/dsh-workbench-connection'
import { LIMITS } from './finalize.ts'

const ACTIONS = ['list', 'open', 'read', 'propose'] as const
type Report = { action: typeof ACTIONS[number] } & Record<string, JsonValue>
const TITLES = {
  list: '查找剧本草稿',
  open: '查看草稿和分集',
  read: '读取已保存的分集稿',
  propose: '提交单集候选稿',
} satisfies Record<typeof ACTIONS[number], string>

function positive(value: number | undefined, key: string): number {
  if (value === undefined || !Number.isSafeInteger(value) || value < 1) throw new ToolArgsError([key + ' 必须是正整数'])
  return value
}

function requiredText(value: string | undefined, key: string, limit: number): string {
  if (value === undefined || value.trim() === '' || value.length > limit) {
    throw new ToolArgsError([key + ' 必须是 1 到 ' + String(limit) + ' 字的非空内容'])
  }
  return value
}

/** Read and stage script drafts as the signed-in Muse member.
 * @param workshop - Authenticated draft access for the current Muse user.
 * @returns The tool definition; proposed text never changes the saved episode.
 */
export function scriptEditorTool(workshop: Pick<WorkshopConnection, 'scriptDrafts' | 'scriptDraft' | 'scriptDraftEpisode' | 'stageScriptDraftCandidate'>): ToolDefinition {
  return defineTool({
    name: 'workshop_script_editor',
    description: '在 Muse 中查找、阅读和精修云端剧本草稿。先打开目标草稿取得分集和项目设定，再读取本轮涉及的集。只为用户指定的一集提交候选稿，由编辑在「剧本」面板审核采纳。',
    parameters: {
      action: { type: 'string', enum: ACTIONS, required: true, description: 'list 按名称查找；open 看分集和设定；read 读一集；propose 提交候选稿。' },
      query: { type: 'string', description: 'list 按草稿标题搜索，可省略。' },
      offset: { type: 'integer', description: 'list 分页，用上次返回的 next_offset。' },
      draft_id: { type: 'integer', description: 'open、read 和 propose 使用 list 返回的草稿编号。' },
      episode: { type: 'integer', description: 'read 和 propose 使用实际集号。阅读相关前后集做承接核对，提交时只写用户指定的一集。' },
      read_candidate: { type: 'boolean', description: 'read 时，用户要求继续改待审候选稿才设为 true。' },
      base_revision: { type: 'string', description: 'propose 必填。原样使用目标集刚读取的 revision。' },
      content: { type: 'string', description: 'propose 必填。该集完整正文，沿用当前稿件格式并保留用户指定的人物、情节和对白。' },
      summary: { type: 'string', description: 'propose 必填。简要说明改动，供编辑审阅。' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: { action: { type: 'string', enum: ACTIONS, required: true } } },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    isConcurrencySafe: args => args.action !== 'propose',
    async execute(args, exec): Promise<Report> {
      if (!exec.agent) throw new HarnessError('请在 Muse 会话中编辑剧本。', 'WORKSHOP_SESSION_REQUIRED')
      exec.signal.throwIfAborted()
      switch (args.action) {
        case 'list': {
          const query = args.query?.trim()
          const offset = args.offset ?? 0
          if (query !== undefined && query.length > 100) throw new ToolArgsError(['query 最多 100 字'])
          if (!Number.isSafeInteger(offset) || offset < 0) throw new ToolArgsError(['offset 必须是不小于 0 的整数'])
          const page = await workshop.scriptDrafts({ ...(query === undefined ? {} : { query }), offset, limit: 10 })
          exec.signal.throwIfAborted()
          return { action: 'list', drafts: page.items.map(draft => ({
            id: draft.id, title: draft.title, status: draft.status, episode_count: draft.episodeCount,
          })), next_offset: page.nextOffset }
        }
        case 'open': {
          const draft = await workshop.scriptDraft({ draftId: positive(args.draft_id, 'draft_id') })
          exec.signal.throwIfAborted()
          return { action: 'open', draft_id: draft.id, title: draft.title, status: draft.status,
            episodes: draft.episodes.map(episode => ({ episode: episode.episode, title: episode.title })),
            context: { ...draft.context } }
        }
        case 'read': {
          const saved = await workshop.scriptDraftEpisode({ draftId: positive(args.draft_id, 'draft_id'), episode: positive(args.episode, 'episode') })
          exec.signal.throwIfAborted()
          const candidate = args.read_candidate === true ? saved.candidate : null
          return { action: 'read', draft_id: saved.draftId, episode: saved.episode, title: saved.title,
            revision: saved.revision, version: saved.version, content: saved.content, pending_candidate_id: saved.candidate?.id ?? null,
            ...(candidate === null ? {} : { candidate: {
              base_revision: candidate.baseRevision, content: candidate.content, summary: candidate.summary,
            } }) }
        }
        case 'propose': {
          const draftId = positive(args.draft_id, 'draft_id')
          const episode = positive(args.episode, 'episode')
          const candidate = await workshop.stageScriptDraftCandidate({
            draftId, episode, baseRevision: requiredText(args.base_revision, 'base_revision', 128),
            content: requiredText(args.content, 'content', LIMITS.episodeChars),
            summary: requiredText(args.summary, 'summary', 1000),
          }, exec.signal)
          return { action: 'propose', draft_id: draftId, episode, candidate_id: candidate.id, base_revision: candidate.baseRevision,
            status: 'pending_review', summary: candidate.summary, review_in: '在「剧本 → 草稿」打开目标草稿，选中这一集查看和采纳候选。' }
        }
        /* v8 ignore next -- schema admits the handled actions */
        default: return assertNever(args.action)
      }
    },
    presentCall: args => ({
      card: 'generic', kind: args.action === 'propose' ? 'other' : 'read',
      title: TITLES[args.action] + (args.episode === undefined ? '' : ' · 第 ' + String(args.episode) + ' 集'),
      ...(args.action === 'propose' ? { rawInput: { draft_id: args.draft_id ?? null, episode: args.episode ?? null, summary: args.summary ?? null } } : {}),
    }),
    presentResult: (args, result) => args.action === 'propose' && !result.isError
      ? {
        card: 'generic', title: '候选稿待审阅 · 第 ' + String(args.episode) + ' 集',
        content: [{ type: 'text', text: '在「剧本 → 草稿」打开这份稿件，选择第 ' + String(args.episode) + ' 集审阅。' }],
      } : undefined,
  })
}

/** Register the editor tool only while the Host provides authenticated Workshop access.
 * @param ctx - Tool registry and Workshop service context.
 */
export function applyScriptEditor(ctx: Context): void {
  ctx.inject(['workshopConnection'], (scope) => {
    scope.effect(() => scope.tools.register(scriptEditorTool(scope.workshopConnection)))
  })
}
