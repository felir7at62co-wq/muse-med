import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { WorkbenchHttpError, type ScriptDraftEpisode } from '@deepseek-ai/dsh-workbench-connection'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { scriptEditorTool } from '../src/editor.ts'

const DRAFT = { id: 12, title: '雨巷', status: 'draft', episodeCount: 2, updatedAt: '2026-11-22T09:00:00Z' }
const EPISODE = { draftId: 12, episode: 2, title: '查账', revision: 'saved-2', version: 2, content: '林晚打开账本。', candidate: null }
const PROPOSAL = { id: 'candidate-12', baseRevision: EPISODE.revision, content: '林晚在雨声里打开账本。', summary: '保留发现账本的情节。', createdAt: '2026-11-22T09:20:00Z' }

async function bench() {
  const workshop = {
    scriptDrafts: vi.fn(async () => ({ items: [DRAFT], nextOffset: 10 })),
    scriptDraft: vi.fn(async () => ({
      ...DRAFT, episodes: [{ episode: 1, title: '回家' }, { episode: 2, title: '查账' }],
      context: { outline: '{"episodes":[{"episode":2,"required":"发现账本"}]}', storyBible: null },
      revision: 'draft-2', canFinalize: true,
    })),
    scriptDraftEpisode: vi.fn(async (): Promise<ScriptDraftEpisode> => EPISODE),
    stageScriptDraftCandidate: vi.fn(async () => PROPOSAL),
  }
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  const tool = scriptEditorTool(workshop)
  await ctx.plugin({
    name: 'script-editor-fixture', inject: ['tools'],
    apply: (scope: Context) => { scope.effect(() => scope.tools.register(tool)) },
  })
  const call = (args: unknown, agent = true) => executeToolFixture(ctx, {
    name: tool.name, arguments: args, callId: ToolCallId('editor-call'), signal: new AbortController().signal,
    ...(agent ? { agent: { session: { id: 'session-1' } } as never } : {}),
  })
  return { workshop, call, tool }
}

describe('workshop_script_editor', () => {
  it('finds drafts and reads the selected episode with its saved revision', async () => {
    const { call, workshop } = await bench()
    expect((await call({ action: 'list', query: ' 雨巷 ', offset: 0 })).value).toEqual({
      action: 'list', drafts: [{ id: 12, title: '雨巷', status: 'draft', episode_count: 2 }], next_offset: 10,
    })
    expect(workshop.scriptDrafts).toHaveBeenCalledWith({ query: '雨巷', offset: 0, limit: 10 })
    const opened = (await call({ action: 'open', draft_id: 12 })).value
    expect(opened).toMatchObject({ episodes: [{ episode: 1 }, { episode: 2 }] })
    expect((opened as { context: { outline: string } }).context.outline).toContain('发现账本')
    expect((await call({ action: 'read', draft_id: 12, episode: 2 })).value).toMatchObject({
      draft_id: 12, episode: 2, content: EPISODE.content, revision: EPISODE.revision, pending_candidate_id: null,
    })
    expect(workshop.scriptDraftEpisode).toHaveBeenCalledWith({ draftId: 12, episode: 2 })
  })

  it('stages one exact episode without echoing the whole proposal', async () => {
    const { call, workshop } = await bench()
    const result = await call({
      action: 'propose', draft_id: 12, episode: 2, base_revision: EPISODE.revision, content: PROPOSAL.content, summary: PROPOSAL.summary,
    })
    expect(result.isError).toBe(false)
    expect(result.value).toEqual({
      action: 'propose', draft_id: 12, episode: 2, base_revision: EPISODE.revision, candidate_id: PROPOSAL.id,
      summary: PROPOSAL.summary, status: 'pending_review',
      review_in: '在「剧本 → 草稿」打开目标草稿，选中这一集查看和采纳候选。',
    })
    expect(workshop.stageScriptDraftCandidate).toHaveBeenCalledWith(
      { draftId: 12, episode: 2, baseRevision: EPISODE.revision, content: PROPOSAL.content, summary: PROPOSAL.summary },
      expect.any(AbortSignal),
    )
  })

  it('requires a conversation and an explicit saved revision before staging', async () => {
    const { call, workshop } = await bench()
    const proposal = { action: 'propose', draft_id: 12, episode: 2, content: PROPOSAL.content, summary: PROPOSAL.summary }
    expect((await call(proposal)).error?.message).toContain('base_revision')
    expect((await call({ ...proposal, base_revision: EPISODE.revision }, false)).error?.message).toContain('Muse 会话')
    expect(workshop.stageScriptDraftCandidate).not.toHaveBeenCalled()
  })

  it('starts an unfiltered draft search and rejects invalid bounds before contacting Workshop', async () => {
    const { call, workshop } = await bench()
    await expect(call({ action: 'list' })).resolves.toMatchObject({ isError: false, value: { next_offset: 10 } })
    expect(workshop.scriptDrafts).toHaveBeenCalledExactlyOnceWith({ offset: 0, limit: 10 })
    for (const [args, field] of [
      [{ action: 'list', query: 'x'.repeat(101) }, 'query'],
      [{ action: 'list', offset: -1 }, 'offset'],
      [{ action: 'open', draft_id: 0 }, 'draft_id'],
      [{ action: 'read', draft_id: 12, episode: 0 }, 'episode'],
      [{ action: 'propose', draft_id: 12, episode: 2, base_revision: EPISODE.revision, content: ' ', summary: 'Update' }, 'content'],
    ] as const) expect((await call(args)).error?.message).toContain(field)
    expect(workshop.scriptDrafts).toHaveBeenCalledOnce()
    expect(workshop.scriptDraft).not.toHaveBeenCalled()
    expect(workshop.scriptDraftEpisode).not.toHaveBeenCalled()
    expect(workshop.stageScriptDraftCandidate).not.toHaveBeenCalled()
  })

  it('presents the candidate review without exposing its text or presenting a stale result as ready', async () => {
    const { call, tool, workshop } = await bench()
    const args = { action: 'propose', draft_id: 12, episode: 2, base_revision: EPISODE.revision, content: PROPOSAL.content, summary: PROPOSAL.summary }
    const reading = { action: 'read', draft_id: 12, episode: 2 }
    expect(tool.isConcurrencySafe?.(reading)).toBe(true)
    expect(tool.isConcurrencySafe?.(args)).toBe(false)
    expect(tool.presentCall?.({ action: 'list' })).toMatchObject({ title: '查找剧本草稿', kind: 'read' })
    expect(tool.presentCall?.(args)).toEqual({ card: 'generic', kind: 'other', title: '提交单集候选稿 · 第 2 集',
      rawInput: { draft_id: 12, episode: 2, summary: PROPOSAL.summary } })
    expect(tool.presentCall?.({ action: 'propose' })).toMatchObject({ rawInput: { draft_id: null, episode: null, summary: null } })

    const accepted = await call(args)
    expect(tool.presentResult?.(args, accepted)?.title).toBe('候选稿待审阅 · 第 2 集')
    expect(JSON.stringify(tool.presentResult?.(args, accepted))).not.toContain(PROPOSAL.content)
    expect(tool.presentResult?.(reading, await call(reading))).toBeUndefined()
    workshop.stageScriptDraftCandidate.mockRejectedValueOnce(new WorkbenchHttpError(409, 'SCRIPT_EDITOR_VERSION_CHANGED', '请重新读取。'))
    expect(tool.presentResult?.(args, await call(args))).toBeUndefined()
  })

  it('reads a pending candidate only when requested and surfaces a stale saved revision', async () => {
    const { call, workshop } = await bench()
    const reading = { action: 'read', draft_id: 12, episode: 2 }
    workshop.scriptDraftEpisode.mockResolvedValue({ ...EPISODE, candidate: PROPOSAL })
    expect((await call(reading)).value).not.toHaveProperty('candidate')
    expect((await call({ ...reading, read_candidate: true })).value).toMatchObject({
      candidate: { base_revision: PROPOSAL.baseRevision, content: PROPOSAL.content },
    })
    workshop.stageScriptDraftCandidate.mockRejectedValueOnce(new WorkbenchHttpError(409, 'SCRIPT_EDITOR_VERSION_CHANGED', '这一集已有新的保存版本，请重新核对后再修改。'))
    const result = await call({
      action: 'propose', draft_id: 12, episode: 2, base_revision: EPISODE.revision, content: PROPOSAL.content, summary: PROPOSAL.summary,
    })
    expect(result.error?.info).toMatchObject({ code: 'SCRIPT_EDITOR_VERSION_CHANGED' })
    expect(result.error?.message).toContain('已有新的保存版本')
    expect(workshop.stageScriptDraftCandidate).toHaveBeenCalledOnce()
  })
})
