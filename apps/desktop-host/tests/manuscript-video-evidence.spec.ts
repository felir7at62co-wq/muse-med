/** Real filesystem, cached attachments and author-loop dispatch verify saved-draft evidence admission. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Llm, { createUserMessage, IMAGE_OFFLOAD_REQUIRED_CODE, type StreamChunk } from '@deepseek-ai/dsh-llm'
import Sessions, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local'
import * as BashEnv from '@deepseek-ai/dsh-shell-env'
import * as ToolBash from '@deepseek-ai/dsh-tool-bash'
import { afterEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { MockAdapter, textResponse, toolCallResponse } from '../../../packages/core/agent-loop/tests/mock-adapter.ts'
import * as RevisionPlugin from '../src/manuscript-revisions.ts'
import * as ToolFs from '../../../packages/fs/tool-fs/src/index.ts'
import { installReviewState, VideoReviewId, reviewsOf, saveReview } from '../../../packages/perception/tool-video-inspect/src/review-state.ts'
import { manuscriptDeclaredOutputs, manuscriptEpisodeNumber, manuscriptSourceWindows } from '../src/manuscript-video-evidence.ts'
import { manuscriptScenes } from '../src/manuscript-scenes.ts'
import { readVideoSourceTimeline } from '@deepseek-ai/dsh-tool-video-inspect'
import * as ImageOffload from '@deepseek-ai/dsh-compaction-image-offload'
import { FsVersion } from '@deepseek-ai/dsh-fs'

const materialSchema = z.object({ manuscript_video_evidence: z.object({ advisory: z.boolean(), semantic_assessment: z.string(),
  changed_scenes: z.number(), returned_scenes: z.number(), not_returned_scenes: z.number(), remaining_image_scenes: z.number(),
  output_association: z.object({ basis: z.string() }),
  receipt: z.object({ path: z.string(), evidence_key: z.string(), source_material_sha256: z.string(),
    returned_frames: z.array(z.object({ frame_id: z.string() })) }),
  scenes: z.array(z.object({ source_alignment: z.string(), semantic_assessment: z.string().optional(),
    manuscript: z.object({ current: z.object({ text: z.string() }),
      previous: z.object({ text: z.string() }).nullable(), next: z.object({ text: z.string() }).nullable() }),
    anchors: z.array(z.object({ source_text: z.string() })).default([]),
    source: z.object({ episode: z.string() }).default({ episode: '' }),
    source_candidates: z.array(z.unknown()).default([]),
    speech_unavailable: z.object({ reference: z.object({ path: z.string() }) }).optional(),
    images: z.object({ returned: z.number(), returned_frame_ids: z.array(z.string()), not_returned_from_selected_windows: z.number() })
      .default({ returned: 0, returned_frame_ids: [], not_returned_from_selected_windows: 0 }),
  })) }) })

const fixtures: { ctx: Context; root: string }[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const { ctx, root } of fixtures.splice(0)) { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) }
})

async function fixture(script = [textResponse('已完成。')], config: Partial<RevisionPlugin.Config> = {}, imageCapable = true) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'muse-local-evidence-'))), ctx = new Context()
  fixtures.push({ ctx, root })
  await ctx.plugin(Llm); await ctx.plugin(Sessions); await ctx.plugin(SessionProjections)
  await ctx.plugin(SystemPrompt); await ctx.plugin(Tools); await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(LocalFileSystem, { cwd: root })
  await ctx.plugin(LocalAttachmentStore, { dshHome: join(root, '.state') })
  ctx.provide('sandboxPolicy', { resolve: () => ({ mode: 'danger-full-access', workspaceRoot: root }) } as never)
  await ctx.plugin(ToolFs)
  await ctx.plugin(RevisionPlugin, config)
  installReviewState(ctx)
  class MaterialAdapter extends MockAdapter {
    override async resolveModel(provider: string, model: string) {
      return { ...await super.resolveModel(provider, model), inputModalities: imageCapable
        ? ['text', 'image'] as const : ['text'] as const }
    }
  }
  const adapter = new MaterialAdapter([...script, ...Array.from({ length: 16 }, () => textResponse('继续完成。'))])
  ctx.llm.registerAdapter(['mock'], adapter)
  const agent = await ctx.agentLoop.create(SessionId('local-video-evidence'), { provider: 'mock', model: 'mock' }, { cwd: root })
  const image = await ctx.attachments.saveImage({ mediaType: 'image/png',
    data: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWNgZGIGAAAOAAeCcsnOAAAAAElFTkSuQmCC', 'base64') })
  const addReview = async (episode: string, name = `episode-${episode}.mp4`) => {
    const path = join(root, name), transcript = join(root, `${name}.json`)
    await writeFile(path, 'fixture source bytes; no decoder runs in the material reader')
    const text = JSON.stringify([{ start: 1, end: 2, text: '你好。', speaker_id: '1' },
      { start: 10, end: 11, text: '回来。', speaker_id: '1' }])
    await writeFile(transcript, text)
    const signal = new AbortController().signal
    const source = await ctx.fs.resolve(path, { signal }), sourceInfo = await ctx.fs.stat(source, signal)
    const asr = await ctx.fs.resolve(transcript, { signal }), asrInfo = await ctx.fs.stat(asr, signal)
    if (!sourceInfo || !asrInfo) throw Error('Missing fixture sources')
    const id = VideoReviewId(name)
    agent.session.append('video/review', { kind: 'start', review: { id, episode, path, source_version: sourceInfo.version,
      duration: 16, scanned_until: 16, scan_complete: true,
      transcript_reference: { path: transcript, version: asrInfo.version, sha256: createHash('sha256').update(text).digest('hex') },
      frames: [0, 4, 8, 12, 16].map((time, index) => ({ id: `F${String(index + 1).padStart(5, '0')}`, time,
        reasons: [index === 0 ? 'opening' : 'appearance_change'], image, exposed: true,
        observation: { visible: `合成测试画面中的物体在第${time}秒保持可见。`, change: `测试序列第${index}次状态记录。`, uncertainty: '' } })) } })
    return { path, transcript, id }
  }
  const run = async (message = '请处理这集。') => {
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: message }] }))
    await agent.whenIdle()
  }
  const evidence = () => agent.session.deriveMessages().flatMap(message => message.role === 'user' && message.source.kind === 'muse-manuscript'
    ? message.content.flatMap(block => block.type === 'text' && block.text.startsWith('{"manuscript_video_evidence":')
      ? [materialSchema.parse(JSON.parse(block.text)).manuscript_video_evidence] : []) : [])
  return { root, ctx, agent, adapter, addReview, run, evidence }
}

it.each([['第 四 集', '4'], ['EP004', '4'], ['八十', '80'], ['第十集', '10'], ['4', '4'],
  ['4-1', undefined], ['episode4', undefined], ['第4集与第5集', undefined]])('normalizes only explicit episode labels: %s', (value, expected) => {
  expect(manuscriptEpisodeNumber(value)).toBe(expected)
})

it('automatically admits real cached images and exact source rows after a normal successful write without a bind call', async () => {
  const manuscript = '第4集\n4-1 家 日 内\n甲：你好。\n4-2 门口 日 外\n▲她走向门口。\n甲：回来。'
  const f = await fixture([toolCallResponse('write-draft', 'write', { file_path: 'draft.md', content: manuscript }), textResponse('已完成。')])
  await f.addReview('第4集')
  await f.run()
  const material = f.evidence()[0]
  expect(material).toMatchObject({ advisory: true, semantic_assessment: 'not_performed', changed_scenes: 2, returned_scenes: 2,
    receipt: { path: join(f.root, 'draft.md') } })
  expect(material?.scenes[0]?.source_alignment).toBe('literal_asr_text_candidates')
  expect(material?.scenes[0]?.anchors[0]?.source_text).toBe('你好。')
  expect(material?.scenes[0]?.manuscript.next?.text).toContain('她走向门口')
  expect(material?.scenes[1]?.manuscript.previous?.text).toContain('甲：你好')
  const request = f.adapter.requests[1]
  expect(JSON.stringify(request)).toContain('model_authored_observation')
  const imageBlocks = request?.messages.flatMap(message => message.content.filter(block => block.type === 'image'))
  expect(imageBlocks?.length).toBeGreaterThan(0)
  const before = JSON.stringify(reviewsOf(f.ctx, f.agent.session))
  await f.run('继续。')
  expect(f.evidence()).toHaveLength(1)
  expect(f.evidence()[0]?.remaining_image_scenes).toBeGreaterThan(0)
  await f.run('继续。')
  expect(f.evidence()).toHaveLength(1)
  expect(JSON.stringify(reviewsOf(f.ctx, f.agent.session))).toBe(before)
  await writeFile(join(f.root, 'draft.md'), manuscript.replace('她走向门口', '她停在门边'))
  await f.run('继续。')
  expect(f.evidence()).toHaveLength(2)
  expect(f.evidence()[1]?.changed_scenes).toBe(1)
  expect(f.evidence()[1]?.scenes[0]?.manuscript.current.text).toContain('她停在门边')
  expect(f.evidence()[1]?.scenes[0]?.manuscript.previous?.text).toContain('你好')
})

it('keeps different episode sources separate inside one file and reports unreturned scenes and images', async () => {
  const f = await fixture([toolCallResponse('write-series', 'write', {
    file_path: 'series.md', content: '第4集\n4-1 家 日 内\n甲：你好。\n第5集\n5-1 门口 日 外\n甲：回来。',
  }), textResponse('交付。')], { videoEvidenceMaxFrames: 1, videoEvidenceMaxScenes: 1 })
  await f.addReview('第4集'); await f.addReview('EP05')
  await f.run()
  const result = f.evidence()[0]
  expect(result).toMatchObject({ changed_scenes: 2, returned_scenes: 1, not_returned_scenes: 1 })
  expect(result?.scenes[0]?.source.episode).toBe('第4集')
  expect(result?.scenes[0]?.images.returned).toBe(1)
  expect(result?.scenes[0]?.images.not_returned_from_selected_windows).toBeGreaterThan(0)
  await f.run('继续。')
  expect(f.evidence()[1]?.scenes[0]?.source.episode).toBe('EP05')
  expect(f.evidence()[1]?.not_returned_scenes).toBe(0)
})

it('reports ambiguous sources without choosing the latest review or blocking the author response', async () => {
  const f = await fixture([toolCallResponse('write-draft', 'write', { file_path: 'draft.md', content: '第4集\n4-1 家 日 内\n甲：你好。' }), textResponse('照常交付。')])
  await f.addReview('第4集', 'a.mp4'); await f.addReview('EP04', 'b.mp4')
  await f.run()
  expect(f.evidence()[0]?.scenes[0]).toMatchObject({ source_alignment: 'ambiguous_episode_sources',
    semantic_assessment: 'not_performed' })
  expect(f.evidence()[0]?.scenes[0]?.source_candidates).toHaveLength(2)
  expect(f.adapter.requests[1]?.messages.flatMap(message => message.content.filter(block => block.type === 'image'))).toHaveLength(0)
  expect(JSON.stringify(f.agent.session.deriveMessages().at(-1))).toContain('照常交付')
})

it('retains explicit ASR failure and source-order uncertainty while returning valid visual materials', async () => {
  const f = await fixture([toolCallResponse('write-draft', 'write', { file_path: 'draft.md', content: '第4集\n4-1 家 日 内\n▲她走向门口。' }), textResponse('已完成。')])
  const source = await f.addReview('第4集')
  await writeFile(source.transcript, 'changed ASR')
  await f.run()
  expect(f.evidence()[0]?.scenes[0]).toMatchObject({ source_alignment: 'source_order_not_aligned',
    speech_unavailable: { reference: { path: source.transcript } } })
  expect(f.evidence()[0]?.scenes[0]?.images.returned).toBeGreaterThan(0)
})

it('never marks a changed source or an oversized material return as reviewed', async () => {
  const f = await fixture([toolCallResponse('write-draft', 'write', { file_path: 'draft.md', content: '第4集\n4-1 家 日 内\n甲：你好。' }), textResponse('仍可继续。')],
    { videoEvidenceMaxBytes: 1 })
  await f.addReview('第4集')
  await f.run()
  expect(f.evidence()).toHaveLength(0)
  expect(JSON.stringify(f.adapter.requests[1])).toContain('VIDEO_TIMELINE_SIZE')
  expect(JSON.stringify(f.adapter.requests[1])).toContain('不阻止继续')
})

it('tracks a registered future path written outside the file tools without assuming a shell command is a draft', async () => {
  const f = await fixture([toolCallResponse('bind-future', 'manuscript_work', { action: 'bind', task_key: 'video', mode: 'transcribe',
    source_paths: ['source.txt'], candidate_paths: ['future.md'] }), textResponse('登记完成。')])
  await writeFile(join(f.root, 'source.txt'), '原始来源材料。')
  await f.addReview('第4集')
  await f.run()
  expect(f.evidence()).toHaveLength(0)
  await writeFile(join(f.root, 'future.md'), '第4集\n4-1 家 日 内\n甲：你好。')
  await f.run('继续。')
  expect(f.evidence()[0]?.receipt.path).toBe(join(f.root, 'future.md'))
  expect(f.evidence()[0]?.scenes[0]?.manuscript.current.text).toContain('甲：你好。')
})

it('prioritizes a recorded uncertain frame once without automatically replaying all remaining cached originals', async () => {
  const f = await fixture([toolCallResponse('write-draft', 'write', { file_path: 'draft.md',
    content: '第4集\n4-1 家 日 内\n▲她走向门口。' }), textResponse('已完成。')], { videoEvidenceMaxFrames: 1 })
  const source = await f.addReview('第4集'), old = reviewsOf(f.ctx, f.agent.session)[source.path]
  assert.ok(old, 'The fixture must publish its source review before modifying the observation')
  saveReview(f.ctx, f.agent.session, { ...old, frames: old.frames.map(frame => frame.id === 'F00005'
    ? { ...frame, observation: { visible: '合成测试画面中的物体仍然可见。', change: '物体离开原位置。', uncertainty: '物体是否已离开画面不清楚。' } }
    : frame) })
  await f.run()
  expect(f.evidence()[0]?.scenes[0]?.images.returned_frame_ids).toEqual(['F00005'])
  await f.run('继续。')
  expect(f.evidence()).toHaveLength(1)
  expect(f.evidence()[0]?.remaining_image_scenes).toBe(1)
})

it('invalidates stale visual source evidence without preventing an ordinary final response', async () => {
  const f = await fixture([toolCallResponse('write-draft', 'write', { file_path: 'draft.md',
    content: '第4集\n4-1 家 日 内\n甲：你好。' }), textResponse('继续交付。')])
  const source = await f.addReview('第4集')
  await writeFile(source.path, 'a different source revision')
  await f.run()
  expect(f.evidence()).toHaveLength(0)
  expect(JSON.stringify(f.adapter.requests[1])).toContain('VIDEO_REVIEW_SOURCE_CHANGED')
  expect(JSON.stringify(f.agent.session.deriveMessages().at(-1))).toContain('继续交付')
})

it('discovers a real shell-written six-episode output list from the original user declaration without a bind instruction', async () => {
  const command = "mkdir -p output\nfor episode in 04 05 08 09 12 13; do printf '第%s集\\n%s-1 家 日 内\\n甲：你好。\\n' \"$episode\" \"$episode\" > \"output/EP$episode.md\"; done"
  const f = await fixture([toolCallResponse('write-shell', 'bash', { command, description: '保存本次六集正文' }), textResponse('已完成。')],
    { videoEvidenceMaxScenes: 1 })
  await f.ctx.plugin(LocalSubprocessRuntime)
  await f.ctx.plugin(BashEnv, { dshHome: join(f.root, '.state') })
  await f.ctx.plugin(LocalBashExecutor, { cwd: f.root, timeoutMs: 10_000 })
  await f.ctx.plugin(ToolBash)
  for (const episode of ['4', '5', '8', '9', '12', '13']) await f.addReview(`第${episode}集`)
  const request = '保留原文件，分别保存为output/EP04.md、EP05.md、EP08.md、EP09.md、EP12.md、EP13.md，再提供一份合并Markdown稿。'
    + '已有视频和转写可直接使用，本次不重新下载、不提交转写或媒体生成。完成后给我文件和简要说明。'
  await f.run(request)
  expect(f.evidence()).toHaveLength(6)
  expect(f.evidence().map(result => result.receipt.path)).toEqual(['04', '05', '08', '09', '12', '13']
    .map(episode => join(f.root, 'output', `EP${episode}.md`)))
  expect(f.evidence()[0]?.output_association.basis).toBe('literal_user_output_path')
  expect(f.evidence()[1]?.output_association.basis).toBe('parallel_output_directory_candidates')
})

it('does not infer an output from source quotations and does not choose between two existing directory candidates', async () => {
  const user = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text',
    text: '> 保存为quoted.md\n```python\nsave to example.md\n```\n请查看source.md。' }] })
  expect(manuscriptDeclaredOutputs([user], '/workspace')).toEqual([])
  const f = await fixture()
  await f.addReview('第5集')
  await mkdir(join(f.root, 'output'))
  await writeFile(join(f.root, 'EP05.md'), '第5集\n5-1 家 日 内\n甲：你好。')
  await writeFile(join(f.root, 'output/EP05.md'), '第5集\n5-1 家 日 内\n甲：回来。')
  await f.run('分别保存为output/EP04.md、EP05.md。')
  expect(f.evidence()).toHaveLength(0)
  expect(JSON.stringify(f.adapter.requests[0])).toContain('ambiguous_not_selected')
})

it('keeps text-only model requests usable and identifies images that were not returned', async () => {
  const f = await fixture([toolCallResponse('write-draft', 'write', { file_path: 'draft.md',
    content: '第4集\n4-1 家 日 内\n甲：你好。' }), textResponse('仍然交付。')], {}, false)
  await f.addReview('第4集')
  await f.run()
  expect(f.evidence()[0]?.scenes[0]?.images.returned).toBe(0)
  expect(JSON.stringify(f.adapter.requests[1])).toContain('text_only_or_unknown_no_images_returned')
  expect(f.adapter.requests[1]?.messages.flatMap(message => message.content.filter(block => block.type === 'image'))).toHaveLength(0)
  expect(JSON.stringify(f.agent.session.deriveMessages().at(-1))).toContain('仍然交付')
})

it('retains silent source windows between dialogue anchors instead of filtering them out', async () => {
  const f = await fixture(), source = await f.addReview('第4集')
  const material = await readVideoSourceTimeline(f.ctx, f.agent.session, source.id, {
    windowSeconds: 4, maxBytes: 100_000, maxFrames: 4, maxTranscriptBytes: 4096,
  }, new AbortController().signal)
  const scene = manuscriptScenes('第4集\n4-1 家 日 内\n甲：你好。\n▲她走向门口。\n甲：回来。')[0]
  assert.ok(scene, 'The fixture manuscript must contain a complete scene')
  const location = manuscriptSourceWindows(scene, material.timeline)
  expect(location.anchors).toHaveLength(2)
  expect(location.windows.map(window => window.start_seconds)).toEqual([0, 4, 8, 12])
  expect(location.windows.find(window => window.start_seconds === 4)?.speech_segment_ids).toEqual([])
})

it('does not return an earlier drama source merely because a new output task uses the same episode label', async () => {
  const f = await fixture([toolCallResponse('write-first', 'write', { file_path: 'first.md',
    content: '第4集\n4-1 家 日 内\n甲：你好。' }), textResponse('旧项目已完成。'),
  toolCallResponse('write-second', 'write', { file_path: 'second.md', content: '第4集\n4-1 学校 日 外\n乙：回来。' }),
  textResponse('新项目已完成。')])
  await f.addReview('第4集')
  await f.run('先处理第一部剧。')
  expect(f.evidence()).toHaveLength(1)
  await f.run('现在处理另一部剧的第4集，保存到second.md。')
  expect(f.evidence()).toHaveLength(2)
  expect(f.evidence()[1]?.receipt.path).toBe(join(f.root, 'second.md'))
  expect(f.evidence()[1]?.scenes[0]?.source_alignment).toBe('no_current_task_video_source')
  expect(f.evidence()[1]?.scenes[0]?.images.returned).toBe(0)
  expect(f.evidence()[1]?.scenes[0]?.source_candidates).toHaveLength(1)
})

it('does not repeatedly parse an unchanged historical tool argument when later natural steps refresh evidence', async () => {
  const args = { file_path: 'draft.md', content: '第4集\n4-1 家 日 内\n甲：你好。' }
  const f = await fixture([toolCallResponse('write-draft', 'write', args), textResponse('完成。')])
  await f.addReview('第4集'); await f.run()
  const parse = vi.spyOn(JSON, 'parse')
  await f.run('继续。'); await f.run('继续。')
  expect(parse.mock.calls.filter(call => call[0] === JSON.stringify(args))).toHaveLength(0)
})

it('reports image offload without forcing another turn or repeatedly retrying the same returned cache frames', async () => {
  const offload: StreamChunk[] = [{ type: 'finish', reason: { kind: 'error', failure: {
    code: IMAGE_OFFLOAD_REQUIRED_CODE, message: 'Synthetic image budget', offloadImages: 4,
  } } }]
  const f = await fixture([toolCallResponse('write-draft', 'write', { file_path: 'draft.md',
    content: '第4集\n4-1 家 日 内\n甲：你好。' }), offload, textResponse('首次交付完成。')])
  await f.ctx.plugin(ImageOffload).await()
  await f.addReview('第4集'); await f.run()
  expect(f.adapter.requests).toHaveLength(3)
  expect(JSON.stringify(f.agent.session.deriveMessages().at(-1))).toContain('首次交付完成')
  const firstFrames = f.evidence()[0]?.scenes[0]?.images.returned_frame_ids
  assert.ok(firstFrames, 'The successful source return must retain its attempted frame identities')
  await f.run('继续。')
  expect(JSON.stringify(f.adapter.requests.at(-1))).toContain('returned_blocks_offloaded_not_confirmed_admitted')
  const laterFrames = f.evidence()[1]?.scenes[0]?.images.returned_frame_ids ?? []
  expect(laterFrames.some(frame => firstFrames.includes(frame))).toBe(false)
})

it('keeps evidence identities stable across workspace relocation while distinguishing a different actual source review', async () => {
  const draft = { file_path: 'draft.md', content: '第4集\n4-1 家 日 内\n甲：你好。' }
  const first = await fixture([toolCallResponse('write-draft', 'write', draft), textResponse('完成。')])
  const second = await fixture([toolCallResponse('write-draft', 'write', draft), textResponse('完成。')])
  for (const f of [first, second]) {
    const source = await f.addReview('第4集'), review = reviewsOf(f.ctx, f.agent.session)[source.path]
    assert.ok(review?.transcript_reference, 'Relocation fixture requires an actual associated source and ASR')
    const stat = f.ctx.fs.stat.bind(f.ctx.fs)
    vi.spyOn(f.ctx.fs, 'stat').mockImplementation(async (target, signal) => {
      const info = await stat(target, signal)
      const version = target.displayPath === source.path ? FsVersion('same-video-version')
        : target.displayPath === source.transcript ? FsVersion('same-asr-version') : undefined
      return info && version ? { ...info, version } : info
    })
    f.agent.session.append('video/review', { kind: 'start', review: { ...review, source_version: 'same-video-version',
      transcript_reference: { ...review.transcript_reference, version: 'same-asr-version' } } })
    await f.run()
  }
  const original = first.evidence()[0]?.receipt, relocated = second.evidence()[0]?.receipt
  assert.ok(original && relocated, 'Both workspaces must actually return a source receipt')
  expect(original.path).not.toBe(relocated.path)
  expect(original.source_material_sha256).toBe(relocated.source_material_sha256)
  expect(original.evidence_key).toBe(relocated.evidence_key)
  const review = Object.values(reviewsOf(second.ctx, second.agent.session))[0]
  assert.ok(review, 'The relocated source review must still be recorded')
  saveReview(second.ctx, second.agent.session, { ...review, id: VideoReviewId('different-source-review') })
  await second.run('继续。')
  const changed = second.evidence()[1]?.receipt
  assert.ok(changed, 'A different actual review must return its own identity even when the draft bytes are unchanged')
  expect(changed.source_material_sha256).not.toBe(relocated.source_material_sha256)
  expect(changed.evidence_key).not.toBe(relocated.evidence_key)
})
