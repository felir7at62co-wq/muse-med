/** Real filesystem, cached attachments and author-loop dispatch verify saved-draft evidence admission. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Llm, { createUserMessage, IMAGE_OFFLOAD_REQUIRED_CODE, type StreamChunk } from '@deepseek-ai/dsh-llm'
import Sessions, { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools, { defineTool } from '@deepseek-ai/dsh-tools'
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
import { bindReviewEvents } from '../../../packages/perception/tool-video-inspect/src/review-events.ts'
import { ManuscriptVideoEvidence, manuscriptDeclaredOutputs, manuscriptEpisodeNumber, manuscriptEvidenceFrames,
  manuscriptSourceWindows } from '../src/manuscript-video-evidence.ts'
import { manuscriptReadText, manuscriptTextReadSnapshots, manuscriptVideoReadCandidates } from '../src/manuscript-video-reads.ts'
import { manuscriptScenes } from '../src/manuscript-scenes.ts'
import { readVideoSourceTimeline, type VideoSourceTimeline } from '@deepseek-ai/dsh-tool-video-inspect'
import * as ImageOffload from '@deepseek-ai/dsh-compaction-image-offload'
import { FsVersion } from '@deepseek-ai/dsh-fs'
import { MANUSCRIPT_VIDEO_PRESENTATION, manuscriptVideoPacketContent, planManuscriptVideoPackets } from '../src/manuscript-video-packets.ts'

function literalSourceTimeline(rows: { start: number; end: number; text: string }[]): VideoSourceTimeline {
  return { advisory: true, semantic_assessment: 'not_performed', source: { review_id: VideoReviewId('literal-test'),
    episode: '4', path: '/source.mp4', source_version: 'v1', duration_seconds: 64, scanned_until: 64, scan_complete: true },
  scope: { start_seconds: 0, end_seconds: 64, full_episode: true, window_seconds: 8 }, material_sha256: 'literal-material',
  windows: [{ window_id: 'all', start_seconds: 0, end_seconds: 64, event_notes: [], speech_segment_ids: [],
    continuous_speech_candidate_indexes: [], frames: [0, 15, 40].map((time, index) => ({ frame_id: `F${index}`, time,
      reasons: ['cut'], exposed: true, image_available: true, observation_source: 'model_authored_observation',
      observation: { visible: '测试缓存中的人物和道具画面。', change: '画面发生变化。', uncertainty: '' } })) }],
  speech: { source: { path: '/asr.json', version: 'v1', sha256: 'asr-hash', time_unit: 'seconds' },
    association: 'caller_supplied_not_verified', segments: rows.map((row, index) => ({ segment_id: `S${index + 1}`,
      start_seconds: row.start, end_seconds: row.end, text: row.text, speaker_identity_unverified: true, raw: row })),
    continuous_speech_candidates: [], notice: '未验证的原始 ASR。' }, notice: '定位候选。' }
}

const speechRowSchema = z.object({ segment_id: z.string(), text: z.string(), start_seconds: z.number(), end_seconds: z.number(),
  draft_line_refs: z.array(z.object({ scene_id: z.string(), line: z.number() })) })
const readRevisionSchema = z.object({ status: z.string(), relationship: z.string(), adopted_authorization: z.string(),
  normalization: z.string(), omitted_read_snapshots: z.number(),
  candidates: z.array(z.object({ path: z.string(), read_text_sha256: z.string().optional(), current_status: z.string(),
    read_scope: z.object({ status: z.string() }) })),
  comparison_source: z.object({ path: z.string(), read_text_sha256: z.string(), read_call_id: z.string() }).optional(),
  hunks: z.array(z.object({ kind: z.string(), before: z.array(z.object({ number: z.number(), text: z.string() })),
    after: z.array(z.object({ number: z.number(), text: z.string() })) })) })

const materialSchema = z.object({ manuscript_video_evidence: z.object({ advisory: z.boolean(), semantic_assessment: z.string(),
  changed_scenes: z.number(), returned_scenes: z.number(), not_returned_scenes: z.number(), remaining_image_scenes: z.number(),
  output_association: z.object({ basis: z.string() }),
  format_reference: z.object({ action_line: z.string(), parenthetical: z.string(), source_scope: z.string() }).optional(),
  presentation_evidence: z.object({ advisory: z.boolean(), semantic_assessment: z.string(), episodes: z.array(z.object({
    ending: z.object({ marker_status: z.string(), suspense_assessment: z.string() }),
    action_locations: z.object({ findings: z.array(z.object({ line: z.number(), quote: z.string() })) }),
  })) }).optional(),
  changed_line_selection: z.object({ basis: z.string(), current_file_sha256: z.string(), after_changed_lines: z.array(z.number()),
    native_mutation_status: z.string(), semantic_assessment: z.string() }).optional(),
  receipt: z.object({ path: z.string(), sha256: z.string(), complete_lf_text_sha256: z.string().optional(),
    evidence_key: z.string(), source_material_sha256: z.string(),
    read_source_identity_sha256: z.string().optional(),
    returned_frames: z.array(z.object({ frame_id: z.string() })) }),
  scenes: z.array(z.object({ source_alignment: z.string(), semantic_assessment: z.string().optional(),
    read_source_revision: readRevisionSchema.optional(),
    manuscript: z.object({ current: z.object({ text: z.string() }),
      previous: z.object({ text: z.string() }).nullable(), next: z.object({ text: z.string() }).nullable() }),
    anchors: z.array(z.object({ source_text: z.string() })).default([]),
    source: z.object({ episode: z.string() }).default({ episode: '' }),
    source_candidates: z.array(z.unknown()).default([]),
    speech_unavailable: z.object({ reference: z.object({ path: z.string() }) }).optional(),
    image_selection_scope: z.string().optional(), source_ending_ref: z.string().optional(),
    source_ending: z.object({ original_asr: z.array(speechRowSchema.omit({ draft_line_refs: true })),
      last_recorded_asr: speechRowSchema.omit({ draft_line_refs: true }).nullable(), selection: z.string(),
      source_end_seconds: z.number(), scan_complete: z.boolean(), scanned_until: z.number(),
      relationship: z.string(), suspense_assessment: z.string(),
      window: z.object({ start_seconds: z.number(), end_seconds: z.number(),
        frame_refs: z.array(z.object({ frame_id: z.string(), time: z.number() })) }) }).optional(),
    observation_locations: z.object({ relationship: z.string(), unmatched: z.string(), semantic_assessment: z.string(),
      candidates: z.array(z.object({ line: z.number(), kind: z.string(), observation_refs: z.array(z.object({
        window_id: z.string(), frame_id: z.string(), time: z.number(),
      })) })) }).optional(),
    images: z.object({ returned: z.number(), returned_frame_ids: z.array(z.string()), not_returned_from_selected_windows: z.number() })
      .default({ returned: 0, returned_frame_ids: [], not_returned_from_selected_windows: 0 }),
  })) }) })

const fixtures: { ctx: Context; root: string }[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const { ctx, root } of fixtures.splice(0)) { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) }
})

async function fixture(script = [textResponse('已完成。')], config: Partial<RevisionPlugin.Config> = {}, imageCapable = true,
  filesystem: { diffBasisMaxBytes?: number } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'muse-local-evidence-'))), ctx = new Context()
  fixtures.push({ ctx, root })
  await ctx.plugin(Llm); await ctx.plugin(Sessions); await ctx.plugin(SessionProjections)
  await ctx.plugin(SystemPrompt); await ctx.plugin(Tools); await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(LocalFileSystem, { cwd: root, ...filesystem })
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
  const addReview = async (episode: string, name = `episode-${episode}.mp4`, linkTranscript = true) => {
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
      ...linkTranscript ? { transcript_reference: { path: transcript, version: asrInfo.version,
        sha256: createHash('sha256').update(text).digest('hex') } } : {},
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
  const evidenceContent = () => agent.session.deriveMessages().flatMap(message => message.role === 'user'
    && message.source.kind === 'muse-manuscript' && message.content.some(block => block.type === 'text'
      && block.text.startsWith('{"manuscript_video_evidence":')) ? [message.content] : [])
  const endingCues = () => evidenceContent().map(blocks => blocks[0]?.type === 'text' ? blocks[0].text : '')
  const sourceRows = () => agent.session.deriveMessages().flatMap(message => message.role === 'user' && message.source.kind === 'muse-manuscript'
    ? message.content.flatMap((block) => {
      if (block.type !== 'text' || !block.text.startsWith('{')) return []
      const packet = z.object({ manuscript_source_packet: z.object({ original_asr_first_occurrences: z.array(speechRowSchema) }) })
        .safeParse(JSON.parse(block.text))
      if (packet.success) return packet.data.manuscript_source_packet.original_asr_first_occurrences
      const remaining = z.object({ manuscript_source_speech: z.object({ original_asr_remaining: z.array(speechRowSchema) }) })
        .safeParse(JSON.parse(block.text))
      return remaining.success ? remaining.data.manuscript_source_speech.original_asr_remaining : []
    }) : [])
  return { root, ctx, agent, adapter, addReview, run, evidence, evidenceContent, endingCues, sourceRows, image }
}

/** Emit a legacy tool call in the test log without installing the removed product tool. */
function installLegacyBinding(f: Awaited<ReturnType<typeof fixture>>) {
  f.agent.ctx.tools.register(defineTool({ name: 'manuscript_work', description: 'Legacy session fixture', parameters: {
    action: { type: 'string' }, task_key: { type: 'string' }, mode: { type: 'string' },
    source_paths: { type: 'array', items: { type: 'string' } },
    candidate_paths: { type: 'array', items: { type: 'string' } },
  }, output: { schema: { type: 'boolean' }, render: () => [{ type: 'text', text: 'Legacy receipt.' }] },
  execute: async () => true }))
}

async function replaceTranscript(f: Awaited<ReturnType<typeof fixture>>, source: { path: string; transcript: string },
  segments: { start: number; end: number; text: string; speaker_id?: string }[]) {
  const text = JSON.stringify(segments)
  await writeFile(source.transcript, text)
  const signal = new AbortController().signal, target = await f.ctx.fs.resolve(source.transcript, { signal })
  const info = await f.ctx.fs.stat(target, signal), review = reviewsOf(f.ctx, f.agent.session)[source.path]
  assert.ok(info && review, 'The replacement fixture must retain its actual file revision and source review')
  saveReview(f.ctx, f.agent.session, { ...review, transcript_reference: { path: source.transcript,
    version: info.version, sha256: createHash('sha256').update(text).digest('hex') } })
}

const visualBefore = '第4集\n4-1 厨房 日 内\n甲（点头）：你好。\n4-2 餐厅 日 内\n乙：等一下。\n▲乙把碗放在桌中央。\n甲：这一大段没有改过的台词仍然按原稿写在这里。\n甲（站在门边）：我在这里。'
const visualAfter = visualBefore.replace('▲乙把碗放在桌中央。', '▲乙把碗推向桌边。').replace('甲（站在门边）', '甲（走到乙身边）')

async function addChangedVisualSource(f: Awaited<ReturnType<typeof fixture>>) {
  const source = await f.addReview('第4集', 'changed-visual.mp4')
  await replaceTranscript(f, source, [{ start: 0.5, end: 1.5, text: '你好。' }, { start: 40, end: 41, text: '等一下。' },
    { start: 50, end: 51, text: '这一大段没有改过的台词仍然按原稿写在这里。' },
    { start: 53, end: 54, text: '我在这里。' }, { start: 55, end: 55.5, text: '未入正文的片尾原声。' }])
  const review = reviewsOf(f.ctx, f.agent.session)[source.path]
  assert.ok(review, 'Changed-line sampling must retain a real current source review')
  f.agent.session.append('video/review', { kind: 'start', review: { ...review, duration: 56, scanned_until: 56,
    frames: [{ id: 'E1', time: 0.8 }, { id: 'E2', time: 1 }, { id: 'E3', time: 1.2 },
      { id: 'M1', time: 43.8 }, { id: 'M2', time: 44 }, { id: 'M3', time: 44.2 },
      { id: 'U1', time: 50.3 }, { id: 'U2', time: 50.5 }, { id: 'U3', time: 50.7 },
      { id: 'T1', time: 53.2 }, { id: 'T2', time: 53.5 }, { id: 'T3', time: 53.8 },
      { id: 'Z1', time: 55.6 }, { id: 'Z3', time: 55.9 }]
      .map((frame, index) => ({ id: `F${String(index + 1).padStart(5, '0')}`, time: frame.time,
        reasons: frame.id.endsWith('2') ? ['cut'] : ['coverage'], image: f.image, exposed: true,
        observation: { visible: `合成缓存 ${frame.id}。`, change: '仅验证时间与记录引用，不核实人物动作。', uncertainty: '' } })) } })
  return source
}

function savedSourcePackets(f: Awaited<ReturnType<typeof fixture>>, sha256: string) {
  const schema = z.object({ manuscript_source_packet: z.object({ document_sha256: z.string(),
    origin: z.string(), actual_current_lines: z.array(z.object({ line: z.number() })),
    time_candidate: z.object({ relation: z.string() }),
    sampling_interval: z.object({ start_seconds: z.number(), end_seconds: z.number() }),
    changed_visual_line_candidates: z.array(z.object({ line: z.number(), quote: z.string(), kind: z.string() })).optional(),
    requested_frame_ids: z.array(z.string()) }) })
  return f.agent.session.deriveMessages().flatMap(message => message.role === 'user' && message.source.kind === 'muse-manuscript'
    ? message.content.flatMap(block => block.type === 'text' && block.text.startsWith('{"manuscript_source_packet":')
      ? [schema.parse(JSON.parse(block.text)).manuscript_source_packet] : []) : [])
    .filter(packet => packet.document_sha256 === sha256)
}

const localPreviousSchema = z.object({ manuscript_source_packet: z.object({
  document_sha256: z.string(), actual_current_lines: z.array(z.object({ line: z.number(), quote: z.string() })),
  previous_text: z.object({ status: z.string(), context_document_sha256: z.string().optional(), mapping: z.string(), adoption: z.string(),
    hunks: z.array(z.object({ basis: z.string(), before: z.array(z.object({ line: z.number(), quote: z.string() })),
      after_lines: z.array(z.number()), source_path: z.string().optional(), source_text_sha256: z.string().optional() })) }),
}) })

function localPrevious(content: ReturnType<Awaited<ReturnType<typeof fixture>>['evidenceContent']>[number]) {
  return content.flatMap(block => block.type === 'text' && block.text.startsWith('{"manuscript_source_packet":')
    ? [localPreviousSchema.parse(JSON.parse(block.text)).manuscript_source_packet] : [])
}

it('returns event-referenced cached images with current lines and complete-read old quotes before unverified interpretations', async () => {
  const intermediate = visualBefore.replace('▲乙把碗放在桌中央。', '▲乙把碗收进抽屉。')
  const f = await fixture([toolCallResponse('read-original', 'read', { file_path: 'source.md' }),
    toolCallResponse('edit-current', 'edit', { file_path: 'draft.md', old_string: intermediate, new_string: visualAfter }),
    textResponse('首次自主交付。')], { videoEvidenceMaxFrames: 6 })
  const source = await addChangedVisualSource(f), review = reviewsOf(f.ctx, f.agent.session)[source.path]
  assert.ok(review)
  saveReview(f.ctx, f.agent.session, { ...review, event_groups: bindReviewEvents([{ event_id: 'bowl-movement',
    frame_ids: ['F00004', 'F00006'], actor: '乙', action: '移动碗', object: '碗', before: '碗在桌中央。',
    after: '碗在桌边。', uncertainty: '仅为测试模型原有记录，未认证动作事实。' }], review.frames) })
  await writeFile(join(f.root, 'source.md'), visualBefore); await writeFile(join(f.root, 'draft.md'), intermediate)
  await f.run()
  const content = f.evidenceContent().at(-1)
  assert.ok(content)
  const sha = createHash('sha256').update(visualAfter).digest('hex')
  const local = localPrevious(content).find(packet => packet.actual_current_lines.some(line => line.line === 6))
  expect(local).toMatchObject({ document_sha256: sha, previous_text: { context_document_sha256: sha,
    status: 'same_text_diff_hunk_candidates', mapping: 'text_diff_hunk_not_semantic_line_pair', adoption: 'not_asserted' } })
  expect(local?.previous_text.hunks).toContainEqual(expect.objectContaining({ basis: 'complete_read_source_difference',
    source_path: join(f.root, 'source.md'), before: [{ line: 6, quote: '▲乙把碗放在桌中央。' }], after_lines: [6] }))
  expect(JSON.stringify(local)).not.toContain('收进抽屉')
  const label = content.findIndex(block => block.type === 'text' && block.text.startsWith('VIDEO_FRAME changed-visual.mp4/F00004 '))
  expect(label).toBeGreaterThan(-1); expect(content[label + 1]?.type).toBe('image')
  const interpretationIndex = content.findIndex(block => block.type === 'text' && block.text.startsWith('{"manuscript_prior_event_interpretations":'))
  expect(interpretationIndex).toBeGreaterThan(label + 1)
  const interpretation = content[interpretationIndex]
  assert.ok(interpretation?.type === 'text')
  expect(interpretation.text).toContain('碗在桌边。')
  expect(JSON.stringify(content.slice(0, label))).not.toContain('仅为测试模型原有记录')
  expect(f.agent.session.deriveMessages().at(-1)?.content).toEqual([{ type: 'text', text: '首次自主交付。' }])
})

it('uses the last native saved text when no complete-read source exists and keeps raw frame notes after cached images', async () => {
  const f = await fixture([toolCallResponse('edit-current', 'edit', { file_path: 'draft.md', old_string: visualBefore, new_string: visualAfter }),
    textResponse('正常交付。')], { videoEvidenceMaxFrames: 6 })
  await addChangedVisualSource(f); await writeFile(join(f.root, 'draft.md'), visualBefore)
  await f.run()
  const content = f.evidenceContent().at(-1)
  assert.ok(content)
  const local = localPrevious(content).find(packet => packet.actual_current_lines.some(line => line.line === 6))
  expect(local?.previous_text.hunks).toContainEqual(expect.objectContaining({ basis: 'successful_native_mutation',
    source_path: join(f.root, 'draft.md'), before: [{ line: 6, quote: '▲乙把碗放在桌中央。' }], after_lines: [6] }))
  const lastImage = content.findLastIndex(block => block.type === 'image')
  const notes = content.findIndex(block => block.type === 'text' && block.text.startsWith('{"manuscript_prior_frame_observations":'))
  expect(notes).toBeGreaterThan(lastImage)
  const observations = content[notes]
  assert.ok(observations?.type === 'text')
  expect(observations.text).toContain('合成缓存')
  expect(JSON.stringify(content.slice(0, lastImage))).not.toContain('合成缓存 T1。')
})

it('does not invent previous local quotes for a new manuscript without a complete source read', async () => {
  const f = await fixture([toolCallResponse('write-current', 'write', { file_path: 'draft.md', content: visualAfter }),
    textResponse('无旧稿仍可交付。')])
  await addChangedVisualSource(f); await f.run()
  const content = f.evidenceContent()[0]
  assert.ok(content)
  expect(localPrevious(content).every(packet => packet.previous_text.status === 'previous_context_unavailable'
    && packet.previous_text.hunks.length === 0)).toBe(true)
  expect(f.agent.session.deriveMessages().at(-1)?.content).toEqual([{ type: 'text', text: '无旧稿仍可交付。' }])
})

it.each(['partial', 'changed', 'ambiguous'] as const)('keeps %s source reads out of cached-image previous-quote candidates', async (kind) => {
  const f = await fixture([toolCallResponse('read-source', 'read', { file_path: 'source.md', ...kind === 'partial' ? { limit: 2 } : {} }),
    ...kind === 'ambiguous' ? [toolCallResponse('read-other', 'read', { file_path: 'other.md' })] : [],
    toolCallResponse('write-current', 'write', { file_path: 'draft.md', content: visualAfter }), textResponse('材料不全仍可交付。')])
  await addChangedVisualSource(f); await writeFile(join(f.root, 'source.md'), visualBefore)
  if (kind === 'ambiguous') await writeFile(join(f.root, 'other.md'), visualBefore.replace('桌中央', '门口'))
  if (kind === 'changed') f.ctx.on('tools/post-execute', async (exec, _result, next) => {
    const result = await next()
    if (exec.callId === 'read-source') await writeFile(join(f.root, 'source.md'), visualBefore.replace('桌中央', '门口'))
    return result
  })
  await f.run()
  const content = f.evidenceContent().at(-1)
  assert.ok(content)
  expect(f.evidence().at(-1)?.scenes[0]?.read_source_revision?.status)
    .toBe(kind === 'changed' ? 'current_source_changed' : kind === 'ambiguous' ? 'ambiguous' : 'partial')
  expect(localPrevious(content).every(packet => packet.previous_text.status === 'previous_context_unavailable'
    && packet.previous_text.hunks.length === 0)).toBe(true)
  expect(f.agent.session.deriveMessages().at(-1)?.content).toEqual([{ type: 'text', text: '材料不全仍可交付。' }])
})

it('returns native edit changed visual lines and their source samples without replaying unchanged scenes or long dialogue', async () => {
  const f = await fixture([toolCallResponse('write-prior', 'write', { file_path: 'draft.md', content: visualBefore }),
    toolCallResponse('read-draft', 'read', { file_path: 'draft.md' }),
    toolCallResponse('edit-visual', 'edit', { file_path: 'draft.md', old_string: visualBefore, new_string: visualAfter }),
    textResponse('自主首次交付。')], { videoEvidenceMaxFrames: 6 })
  await addChangedVisualSource(f)
  await writeFile(join(f.root, 'source.md'), visualBefore); await writeFile(join(f.root, 'draft.md'), visualBefore)
  await f.run()
  const report = f.evidence().at(-1), sha256 = createHash('sha256').update(visualAfter).digest('hex')
  expect(report?.changed_line_selection).toMatchObject({ basis: 'successful_native_mutation', current_file_sha256: sha256,
    after_changed_lines: [6, 8], native_mutation_status: 'current', semantic_assessment: 'not_performed' })
  expect(report?.format_reference).toBeUndefined()
  expect(f.endingCues().at(-1)).toContain('忠实转写')
  expect(report?.returned_scenes).toBe(1)
  expect(report?.scenes[0]?.manuscript.current.text).toContain('4-2 餐厅')
  expect(report?.scenes[0]?.images.returned_frame_ids.sort()).toEqual(['F00004', 'F00006', 'F00010', 'F00012', 'F00013', 'F00014'])
  const packets = savedSourcePackets(f, sha256)
  const changedCandidateLines = packets.flatMap(packet => packet.changed_visual_line_candidates?.map(line => line.line) ?? [])
  expect([...new Set(changedCandidateLines)].sort()).toEqual([6, 8])
  expect(packets.flatMap(packet => packet.requested_frame_ids)).toHaveLength(6)
  expect(packets.find(packet => packet.time_candidate.relation === 'source_tail_not_aligned_to_draft_ending'))
    .toMatchObject({ origin: 'source_timeline', actual_current_lines: [],
      requested_frame_ids: ['changed-visual.mp4/F00013', 'changed-visual.mp4/F00014'] })
  expect(report?.presentation_evidence).toMatchObject({ advisory: true, semantic_assessment: 'not_performed' })
  expect(report?.presentation_evidence?.episodes[0]?.action_locations.findings.map(line => line.line)).toEqual([6, 8])
  expect(report?.presentation_evidence?.episodes[0]?.ending).toMatchObject({ marker_status: 'not_found', suspense_assessment: 'not_performed' })
  const local = report?.scenes[0]
  expect(local?.source_ending?.original_asr.map(row => row.text)).toContain('未入正文的片尾原声。')
  expect(local?.source_ending).toMatchObject({ relationship: 'source_tail_not_aligned_to_draft_ending', suspense_assessment: 'not_performed' })
  expect(local?.observation_locations).toMatchObject({ relationship: 'time_overlap_candidates_not_event_equivalence',
    unmatched: 'unjudged_not_an_omission', semantic_assessment: 'not_performed' })
  expect(local?.observation_locations?.candidates.find(row => row.line === 6)?.observation_refs.map(row => row.frame_id)).toContain('F00005')
  expect(local?.observation_locations?.candidates.find(row => row.line === 8)?.observation_refs.map(row => row.frame_id)).toContain('F00011')
  const count = f.evidence().length
  await f.run('继续。')
  expect(f.evidence()).toHaveLength(count)
})

it('allocates the shared image budget to source-difference visual lines before an unchanged earlier scene in a new saved copy', async () => {
  const f = await fixture([toolCallResponse('read-source', 'read', { file_path: 'source.md' }),
    toolCallResponse('save-copy', 'write', { file_path: 'draft.md', content: visualAfter }), textResponse('直接交付。')])
  await addChangedVisualSource(f); await writeFile(join(f.root, 'source.md'), visualBefore)
  await f.run()
  const report = f.evidence()[0]
  expect(report?.changed_line_selection).toMatchObject({ basis: 'complete_read_source_difference', after_changed_lines: [6, 8] })
  expect(report?.scenes[0]?.manuscript.current.text).toContain('4-2 餐厅')
  const unchanged = report?.scenes.find(scene => scene.manuscript.current.text.includes('4-1 厨房'))
  expect(unchanged?.images.returned).toBe(0)
  expect(report?.scenes[0]?.images.returned_frame_ids.sort()).toEqual(['F00010', 'F00012', 'F00013', 'F00014'])
  expect(report?.scenes.reduce((total, scene) => total + scene.images.returned, 0)).toBe(4)
  expect(report?.scenes[0]?.image_selection_scope).toBe('source_timeline_samples_not_draft_alignment')
  expect(unchanged?.source_ending).toBeUndefined()
  expect(unchanged?.source_ending_ref).toBe('changed-visual.mp4')
  const sha256 = createHash('sha256').update(visualAfter).digest('hex'), packets = savedSourcePackets(f, sha256)
  const changedPackets = packets.filter(packet => packet.origin === 'draft_candidates')
  expect(changedPackets.flatMap(packet => packet.changed_visual_line_candidates?.map(line => line.line) ?? [])).toEqual([8])
  expect(packets.find(packet => packet.origin === 'source_timeline')?.actual_current_lines).toEqual([])
})

it('keeps the last recorded ASR separate when a partial episode has no cached images or speech in its fixed closing window', async () => {
  const f = await fixture([toolCallResponse('save-partial-eight', 'write', { file_path: 'EP08.md',
    content: '第8集\n8-1 家 日 内\n甲：最后一句已转出的原声。' }), textResponse('交付已有材料。')])
  const source = await f.addReview('第8集', 'partial-eight.mp4')
  await replaceTranscript(f, source, [{ start: 40, end: 41, text: '最后一句已转出的原声。' }])
  const review = reviewsOf(f.ctx, f.agent.session)[source.path]
  assert.ok(review, 'Partial episode fixture must retain its current source revision')
  f.agent.session.append('video/review', { kind: 'start', review: { ...review, duration: 60, scanned_until: 48, scan_complete: false } })
  await f.run()
  expect(f.evidence()[0]?.scenes[0]?.source_ending).toMatchObject({ source_end_seconds: 60, scanned_until: 48,
    scan_complete: false, window: { start_seconds: 52, end_seconds: 60, frame_refs: [] }, original_asr: [],
    last_recorded_asr: { start_seconds: 40, end_seconds: 41, text: '最后一句已转出的原声。' },
    relationship: 'source_tail_not_aligned_to_draft_ending',
    selection: 'rolling_source_tail_last_recorded_speech_separate_from_silent_tail' })
  expect(f.endingCues()[0]).toContain('最后一句已转出的原声。')
  expect(f.endingCues()[0]).toContain('末图引用未提供')
  const count = f.evidence().length
  await f.run('继续。')
  expect(f.evidence()).toHaveLength(count)
})

it('logs the ending cue before the large source report and actually returns independent tail images within the default shared budget', async () => {
  const f = await fixture([toolCallResponse('read-original', 'read', { file_path: 'source.md' }),
    toolCallResponse('save-current', 'write', { file_path: 'draft.md', content: visualAfter }), textResponse('首次交付。')])
  await addChangedVisualSource(f); await writeFile(join(f.root, 'source.md'), visualBefore)
  await f.run()
  const content = f.evidenceContent()[0]
  assert.ok(content, 'Successful saved draft must log source materials')
  expect(content[0]?.type === 'text' ? content[0].text : '').toMatch(/^第4集当前结尾：/u)
  expect(content[0]?.type === 'text' ? content[0].text : '').toContain('未入正文的片尾原声。')
  expect(content[1]?.type === 'text' ? content[1].text : '').toMatch(/^\{"manuscript_video_evidence":/u)
  const sha256 = createHash('sha256').update(visualAfter).digest('hex'), packets = savedSourcePackets(f, sha256)
  const tail = packets.find(packet => packet.time_candidate.relation === 'source_tail_not_aligned_to_draft_ending')
  expect(tail).toMatchObject({ origin: 'source_timeline', actual_current_lines: [],
    sampling_interval: { start_seconds: 55.5, end_seconds: 56 },
    requested_frame_ids: ['changed-visual.mp4/F00013', 'changed-visual.mp4/F00014'] })
  for (const id of tail?.requested_frame_ids ?? []) {
    const label = content.findIndex(block => block.type === 'text' && block.text.startsWith(`VIDEO_FRAME ${id} `))
    expect(label).toBeGreaterThan(1)
    expect(content[label + 1]?.type).toBe('image')
  }
  expect(content.filter(block => block.type === 'image')).toHaveLength(4)
  expect(packets.filter(packet => packet.origin === 'draft_candidates')
    .flatMap(packet => packet.changed_visual_line_candidates?.map(line => line.line) ?? [])).toEqual([8])
  expect(f.evidence()[0]?.scenes[0]?.image_selection_scope).toBe('source_timeline_samples_not_draft_alignment')
  const count = f.evidence().length
  await f.run('继续。')
  expect(f.evidence()).toHaveLength(count)
})

it('rejects a native mutation after hash mismatch and falls back to the actual complete read source difference', async () => {
  const external = visualAfter.replace('▲乙把碗推向桌边。', '▲乙把碗移到椅子上。')
  const f = await fixture([toolCallResponse('read-source', 'read', { file_path: 'source.md' }),
    toolCallResponse('edit-visual', 'edit', { file_path: 'draft.md', old_string: visualBefore, new_string: visualAfter }),
    textResponse('仍然交付。')])
  await addChangedVisualSource(f)
  await writeFile(join(f.root, 'source.md'), visualBefore); await writeFile(join(f.root, 'draft.md'), visualBefore)
  f.ctx.on('tools/post-execute', async (exec, _result, next) => {
    const decision = await next()
    if (exec.name === 'edit') await writeFile(join(f.root, 'draft.md'), external)
    return decision
  })
  await f.run()
  expect(f.evidence().at(-1)?.changed_line_selection).toMatchObject({ basis: 'complete_read_source_difference',
    current_file_sha256: createHash('sha256').update(external).digest('hex'), after_changed_lines: [6, 8],
    native_mutation_status: 'after_hash_mismatch' })
  expect(f.evidence().at(-1)?.scenes[0]?.manuscript.current.text).toContain('把碗移到椅子上')
  expect(JSON.stringify(f.agent.session.deriveMessages().at(-1))).toContain('仍然交付')
})

it('ignores legacy bind mode changes without refreshing an unchanged saved draft', async () => {
  const bind = (mode: 'transcribe' | 'adapt') => ({ action: 'bind', task_key: 'mode-only', mode,
    source_paths: ['source.md'], candidate_paths: ['draft.md'] })
  const f = await fixture([
    toolCallResponse('write-draft', 'write', { file_path: 'draft.md', content: '第4集\n4-1 家 日 内\n甲：你好。' }),
    textResponse('第一次交付。'), toolCallResponse('bind-transcribe', 'manuscript_work', bind('transcribe')), textResponse('忠实转写。'),
    toolCallResponse('bind-adapt', 'manuscript_work', bind('adapt')), textResponse('获准改编。'),
  ])
  installLegacyBinding(f)
  await f.addReview('第4集'); await writeFile(join(f.root, 'source.md'), '第4集\n4-1 家 日 内\n甲：你好。')
  await f.run()
  expect(f.evidence()).toHaveLength(1)
  expect(f.evidence()[0]?.format_reference).toBeUndefined()
  expect(f.endingCues()[0]).toContain('格式整理不授权新增或改写原片事实')
  await f.run('继续。')
  expect(f.evidence()).toHaveLength(1)
  await f.run('继续。')
  expect(f.evidence()).toHaveLength(1)
  await f.run('继续。')
  expect(f.evidence()).toHaveLength(1)
})

it('matches a native CRLF edit by normalized after text while retaining the exact file-byte receipt', async () => {
  const f = await fixture([toolCallResponse('edit-crlf', 'edit', { file_path: 'draft.md', old_string: visualBefore, new_string: visualAfter }),
    textResponse('正常交付。')])
  await addChangedVisualSource(f); await writeFile(join(f.root, 'draft.md'), visualBefore.replaceAll('\n', '\r\n'))
  await f.run()
  const bytes = await readFile(join(f.root, 'draft.md')), rawSha = createHash('sha256').update(bytes).digest('hex')
  expect(bytes.toString()).toBe(visualAfter.replaceAll('\n', '\r\n'))
  expect(rawSha).not.toBe(createHash('sha256').update(visualAfter).digest('hex'))
  expect(f.evidence()[0]?.changed_line_selection).toMatchObject({ basis: 'successful_native_mutation', current_file_sha256: rawSha,
    after_changed_lines: [6, 8], native_mutation_status: 'current' })
  expect(f.evidence()[0]?.receipt.sha256).toBe(rawSha)
})

it.each(['create', 'update'] as const)('uses the actual %s operation to interpret a null native diff basis', async (operation) => {
  const body = '第4集\n4-1 家 日 内\n甲：你好。\n▲甲抬眼。'
  const f = await fixture([toolCallResponse('write-without-basis', 'write', { file_path: 'draft.md', content: body }),
    textResponse('继续交付。')], {}, true, { diffBasisMaxBytes: 1 })
  await f.addReview('第4集')
  if (operation === 'update') await writeFile(join(f.root, 'draft.md'), '第4集\n4-1 家 日 内\n甲：旧稿。')
  const write = vi.spyOn(f.ctx.fs, 'writeText')
  await f.run()
  expect(await write.mock.results[0]?.value).toMatchObject({ operation, before: null })
  expect(f.evidence()[0]?.changed_line_selection).toMatchObject({ basis: operation === 'create' ? 'new_saved_document' : 'unavailable',
    after_changed_lines: operation === 'create' ? [1, 2, 3, 4] : [] })
  expect(JSON.stringify(f.agent.session.deriveMessages().at(-1))).toContain('继续交付')
})

it('associates a successful native edit through a symlinked parent with the canonical saved manuscript', async () => {
  const f = await fixture([toolCallResponse('edit-parent-alias', 'edit', { file_path: 'alias/draft.md',
    old_string: visualBefore, new_string: visualAfter }), textResponse('正常交付。')])
  await addChangedVisualSource(f); await mkdir(join(f.root, 'physical'))
  await symlink(join(f.root, 'physical'), join(f.root, 'alias'), process.platform === 'win32' ? 'junction' : 'dir')
  await writeFile(join(f.root, 'physical/draft.md'), visualBefore)
  await f.run()
  expect(f.evidence()[0]?.receipt.path).toBe(join(f.root, 'physical/draft.md'))
  expect(f.evidence()[0]?.changed_line_selection).toMatchObject({ basis: 'successful_native_mutation', after_changed_lines: [6, 8],
    native_mutation_status: 'current' })
  const count = f.evidence().length
  await f.run('继续。')
  expect(f.evidence()).toHaveLength(count)
})

it('does not turn a successful native write into an error if the file disappears before advisory canonicalization', async () => {
  const f = await fixture([toolCallResponse('write-disappearing', 'write', { file_path: 'draft.md',
    content: '第4集\n4-1 家 日 内\n甲：你好。' }), textResponse('可以继续。')])
  await f.addReview('第4集')
  f.ctx.on('tools/post-execute', async (exec, _result, next) => {
    const decision = await next()
    if (exec.name === 'write') await rm(join(f.root, 'draft.md'))
    return decision
  })
  await f.run()
  const result = f.agent.session.snapshotEvents().find(event => event.type === 'tool/result'
    && event.data.message.toolCallId === 'write-disappearing')
  expect(result?.type === 'tool/result' && result.data.message.isError).toBe(false)
  expect(f.evidence()).toEqual([])
  expect(JSON.stringify(f.agent.session.deriveMessages().at(-1))).toContain('可以继续')
})

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
  expect(f.sourceRows().map(row => row.text)).toEqual(expect.arrayContaining(['你好。', '回来。']))
  const home = material?.scenes.find(scene => scene.manuscript.current.text.includes('4-1 家'))
  const doorway = material?.scenes.find(scene => scene.manuscript.current.text.includes('4-2 门口'))
  expect(home?.manuscript.next?.text).toContain('她走向门口')
  expect(doorway?.manuscript.previous?.text).toContain('甲：你好')
  const request = f.adapter.requests[1]
  expect(JSON.stringify(request)).toContain('unverified_prior_model_observations')
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

it('retains explicit ASR failure and a whole-source index without pretending unaligned images are local evidence', async () => {
  const f = await fixture([toolCallResponse('write-draft', 'write', { file_path: 'draft.md', content: '第4集\n4-1 家 日 内\n▲她走向门口。' }), textResponse('已完成。')])
  const source = await f.addReview('第4集')
  await writeFile(source.transcript, 'changed ASR')
  await f.run()
  expect(f.evidence()[0]?.scenes[0]).toMatchObject({ source_alignment: 'source_order_not_aligned',
    speech_unavailable: { reference: { path: source.transcript } }, image_selection_scope: 'source_timeline_samples_not_draft_alignment' })
  expect(f.evidence()[0]?.scenes[0]?.images.returned).toBe(2)
  expect(f.adapter.requests[1]?.messages.flatMap(message => message.content.filter(block => block.type === 'image'))).toHaveLength(2)
  expect(f.sourceRows()).toEqual([])
  const report = f.evidence()[0]
  assert.ok(report, 'Unavailable ASR must not discard independent source-tail materials')
  expect(savedSourcePackets(f, report.receipt.sha256).every(packet => packet.origin === 'source_timeline'
    && packet.actual_current_lines.length === 0)).toBe(true)
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

it('ignores a legacy future path until a normal write registers the draft', async () => {
  const f = await fixture([toolCallResponse('bind-future', 'manuscript_work', { action: 'bind', task_key: 'video', mode: 'transcribe',
    source_paths: ['source.txt'], candidate_paths: ['future.md'] }), textResponse('登记完成。'), textResponse('继续。'),
  toolCallResponse('write-future', 'write', { file_path: 'future.md', content: '第4集\n4-1 家 日 内\n甲：你好。' }),
  textResponse('已保存。')])
  installLegacyBinding(f)
  await writeFile(join(f.root, 'source.txt'), '原始来源材料。')
  await f.addReview('第4集')
  await f.run()
  expect(f.evidence()).toHaveLength(0)
  await writeFile(join(f.root, 'future.md'), '第4集\n4-1 家 日 内\n甲：你好。')
  await f.run('继续。')
  expect(f.evidence()).toHaveLength(0)
  await f.run('继续。')
  expect(f.evidence()[0]?.receipt.path).toBe(join(f.root, 'future.md'))
  expect(f.evidence()[0]?.scenes[0]?.manuscript.current.text).toContain('甲：你好。')
})

it('selects the independent source ending despite an uncertain old caption without replaying the entire cache', async () => {
  const f = await fixture([toolCallResponse('write-draft', 'write', { file_path: 'draft.md',
    content: '第4集\n4-1 家 日 内\n甲：你好。\n▲她走向门口。\n甲：回来。' }), textResponse('已完成。')], { videoEvidenceMaxFrames: 1 })
  const source = await f.addReview('第4集'), old = reviewsOf(f.ctx, f.agent.session)[source.path]
  assert.ok(old, 'The fixture must publish its source review before modifying the observation')
  saveReview(f.ctx, f.agent.session, { ...old, frames: old.frames.map(frame => frame.id === 'F00005'
    ? { ...frame, observation: { visible: '合成测试画面中的物体仍然可见。', change: '物体离开原位置。', uncertainty: '物体是否已离开画面不清楚。' } }
    : frame) })
  await f.run()
  expect(f.evidence()[0]?.scenes[0]?.images.returned_frame_ids).toEqual(['F00005'])
  expect(f.evidence()[0]?.scenes[0]?.image_selection_scope).toBe('source_timeline_samples_not_draft_alignment')
  const report = f.evidence()[0]
  assert.ok(report, 'The one-image budget must retain its independent source-tail packet')
  expect(savedSourcePackets(f, report.receipt.sha256)).toMatchObject([{ origin: 'source_timeline', actual_current_lines: [],
    time_candidate: { relation: 'source_tail_not_aligned_to_draft_ending' } }])
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

it('reuses a real successful JSON read when the video scan did not explicitly link its transcript', async () => {
  const f = await fixture([
    toolCallResponse('read-asr', 'read', { file_path: 'source.mp4.json' }),
    toolCallResponse('write-draft', 'write', { file_path: 'draft.md', content: '第4集\n4-1 家 日 内\n甲：你好。' }),
    textResponse('自主完成。'),
  ])
  await f.addReview('第4集', 'source.mp4', false)
  await f.run('处理这一集，保存为draft.md。')
  expect(f.sourceRows()[0]?.text).toBe('你好。')
  expect(f.evidence()[0]?.scenes[0]?.images.returned).toBeGreaterThan(0)
  expect(JSON.stringify(f.adapter.requests[2])).toContain('successful_read_candidate')
  expect(JSON.stringify(f.adapter.requests[2])).toContain('same_source_verified')
  const receipts = manuscriptVideoReadCandidates(f.ctx, f.agent.session)
  expect(receipts?.reads).toHaveLength(1)
  expect(receipts?.reads[0]?.path).toBe(join(f.root, 'source.mp4.json'))
  expect(receipts?.reads[0]?.readCallId).toBe('read-asr')
  expect(receipts?.reads[0]?.readResultSeq).toBeGreaterThan(receipts?.taskStartSeq ?? Infinity)
  const resumedId = SessionId('resumed-read-receipts')
  const resumed = Session.create(resumedId, f.agent.session.snapshotEvents(), { ...f.agent.session.header, id: resumedId })
  expect(manuscriptVideoReadCandidates(f.ctx, resumed)).toEqual(receipts)
  await f.run('继续。')
  expect(manuscriptVideoReadCandidates(f.ctx, f.agent.session)?.reads).toHaveLength(1)
  await f.run('另一部剧保存为another.md。')
  expect(manuscriptVideoReadCandidates(f.ctx, f.agent.session)?.reads).toEqual([])
})

it('excludes failed reads from transcript candidates and still lets the author deliver normally', async () => {
  const f = await fixture([
    toolCallResponse('read-missing', 'read', { file_path: 'missing.json' }),
    toolCallResponse('write-draft', 'write', { file_path: 'draft.md', content: '第4集\n4-1 家 日 内\n甲：你好。' }),
    textResponse('照常交付。'),
  ])
  await f.addReview('第4集', 'source.mp4', false)
  await f.run()
  expect(manuscriptVideoReadCandidates(f.ctx, f.agent.session)?.reads).toEqual([])
  expect(f.evidence()[0]?.scenes[0]?.images.returned).toBe(2)
  expect(f.evidence()[0]?.scenes[0]?.image_selection_scope).toBe('source_timeline_samples_not_draft_alignment')
  expect(f.sourceRows()).toEqual([])
  expect(JSON.stringify(f.agent.session.deriveMessages().at(-1))).toContain('照常交付')
})

it.each(['原视频', '第5集'])('keeps explicit episode conflicts while allowing a nonstandard single-video label: %s', async (label) => {
  const f = await fixture([
    toolCallResponse('open-video', 'video_inspect', { file_path: 'source.mp4' }),
    toolCallResponse('write-draft', 'write', { file_path: 'draft.md', content: '第4集\n4-1 家 日 内\n甲：你好。' }),
    textResponse('完成。'),
  ])
  f.ctx.tools.register(defineTool({ name: 'video_inspect', description: 'Fixture source access', parameters: {
    file_path: { type: 'string', required: true },
  }, output: { schema: { type: 'object', additionalProperties: false,
    properties: { opened: { type: 'boolean', required: true } } },
  render: () => [{ type: 'text', text: 'Source opened.' }] }, execute: async () => ({ opened: true }) }))
  await f.addReview(label, 'source.mp4')
  await f.run('处理第4集，保存为draft.md。')
  if (label === '原视频') {
    expect(f.sourceRows()[0]?.text).toBe('你好。')
    expect(JSON.stringify(f.adapter.requests[2])).toContain('single_current_task_video_candidate')
  } else {
    expect(f.evidence()[0]?.scenes[0]?.source_alignment).toBe('no_matching_episode_source')
    expect(f.evidence()[0]?.scenes[0]?.images.returned).toBe(0)
    expect(JSON.stringify(f.adapter.requests[2])).not.toContain('single_current_task_video_candidate')
  }
  expect(JSON.stringify(f.adapter.requests[2])).toContain('not_performed')
})

it('does not repeat unchanged drafts for intermediate observation batches but returns completion and a real new source revision', async () => {
  const f = await fixture([toolCallResponse('write-draft', 'write', { file_path: 'draft.md',
    content: '第4集\n4-1 家 日 内\n甲：你好。\n甲：回来。' }), textResponse('完成。')])
  const source = await f.addReview('第4集'), original = reviewsOf(f.ctx, f.agent.session)[source.path]
  assert.ok(original, 'The fixture needs a recorded source revision')
  saveReview(f.ctx, f.agent.session, { ...original, frames: original.frames.map((frame) => {
    if (!['F00004', 'F00005'].includes(frame.id)) return frame
    const { observation: _observation, ...unobserved } = frame
    return unobserved
  }) })
  await f.run()
  expect(f.evidence()).toHaveLength(1)
  const pending = reviewsOf(f.ctx, f.agent.session)[source.path]
  assert.ok(pending, 'Partial observation must still be a valid source review')
  saveReview(f.ctx, f.agent.session, { ...pending, frames: pending.frames.map(frame =>
    frame.id === 'F00004' ? original.frames.find(old => old.id === frame.id) ?? frame : frame) })
  await f.run('继续。')
  expect(f.evidence()).toHaveLength(1)
  const completing = reviewsOf(f.ctx, f.agent.session)[source.path]
  assert.ok(completing, 'The remaining pending observation must remain available')
  saveReview(f.ctx, f.agent.session, { ...completing, frames: original.frames })
  await f.run('继续。')
  expect(f.evidence()).toHaveLength(2)
  saveReview(f.ctx, f.agent.session, { ...original, frames: original.frames.map(frame => frame.id === 'F00001'
    ? { ...frame, observation: { visible: '同一画面的新笔记，原视频版本没有变化。', change: '未新增事件。', uncertainty: '无新增疑点' } } : frame) })
  await f.run('继续。')
  expect(f.evidence()).toHaveLength(2)
  await writeFile(source.path, 'actual new video bytes')
  const target = await f.ctx.fs.resolve(source.path, { signal: new AbortController().signal })
  const info = await f.ctx.fs.stat(target, new AbortController().signal)
  assert.ok(info, 'The replaced source must have a new actual filesystem version')
  f.agent.session.append('video/review', { kind: 'start', review: { ...original,
    id: VideoReviewId('real-new-source'), source_version: info.version } })
  await f.run('继续。')
  expect(f.evidence()).toHaveLength(3)
  const asr = JSON.stringify([{ start: 1, end: 2, text: '你好。', speaker_id: '1' }])
  await writeFile(source.transcript, asr)
  const transcriptTarget = await f.ctx.fs.resolve(source.transcript, { signal: new AbortController().signal })
  const transcriptInfo = await f.ctx.fs.stat(transcriptTarget, new AbortController().signal)
  const latest = reviewsOf(f.ctx, f.agent.session)[source.path]
  assert.ok(transcriptInfo && latest, 'The changed transcript must retain actual source and filesystem revisions')
  saveReview(f.ctx, f.agent.session, { ...latest, transcript_reference: { path: source.transcript,
    version: transcriptInfo.version, sha256: createHash('sha256').update(asr).digest('hex') } })
  await f.run('继续。')
  expect(f.evidence()).toHaveLength(4)
})

it('keeps actual line locations and marks split manuscript lines inside one ASR utterance without inventing an action gap', async () => {
  const f = await fixture(), source = await f.addReview('第4集')
  const material = await readVideoSourceTimeline(f.ctx, f.agent.session, source.id, {
    windowSeconds: 4, maxBytes: 100_000, maxFrames: 4, maxTranscriptBytes: 4096,
  }, new AbortController().signal)
  const speech = material.timeline.speech
  assert.ok(speech?.segments[0], 'The fixture must retain a complete saved ASR row')
  const timeline = { ...material.timeline, speech: { ...speech, segments: [{ ...speech.segments[0],
    text: '你好，今天回来。', start_seconds: 1, end_seconds: 3 }] } }
  const scene = manuscriptScenes('第4集\n4-1 家 日 内\n甲（抱紧书包）：你好。\n▲她将书包放在门边。\n甲：今天回来。')[0]
  assert.ok(scene, 'The manuscript must retain actual absolute line numbers')
  const location = manuscriptSourceWindows(scene, timeline)
  expect(location.anchors.map(anchor => anchor.draft_line)).toEqual([3, 5])
  expect(location.between_dialogue_lines[0]).toMatchObject({ previous_line: 3, current_line: 5,
    relation: 'within_same_speech', shared_segment_ids: ['S00001'] })
  expect(location.visual_queries).toMatchObject([
    { line: 3, kind: 'dialogue_parenthetical', quote: '甲（抱紧书包）：你好。', text: '抱紧书包' },
    { line: 4, kind: 'action_line', quote: '▲她将书包放在门边。', text: '她将书包放在门边。' },
  ])
  expect(location.visual_queries[1]?.time_candidates).toEqual([{ start_seconds: 1, end_seconds: 3,
    relation: 'within_same_speech', segment_ids: ['S00001'] }])
})

it('keeps before and after cache frames beside one temporal anchor instead of filling the image allowance globally', async () => {
  const f = await fixture(), source = await f.addReview('第4集')
  const material = await readVideoSourceTimeline(f.ctx, f.agent.session, source.id, {
    windowSeconds: 4, maxBytes: 100_000, maxFrames: 4, maxTranscriptBytes: 4096,
  }, new AbortController().signal)
  const template = material.timeline.windows[0]?.frames[0]
  assert.ok(template, 'The source cache must supply frame metadata')
  const windows = [0, 4, 8, 12].map((start, index) => ({ window_id: `W${index}`, start_seconds: start,
    end_seconds: start + 4, event_notes: [], speech_segment_ids: [], continuous_speech_candidate_indexes: [],
    frames: (index === 0 ? [0, 0.1, 0.2, 0.3] : [start]).map((time, frameIndex) => ({ ...template,
      frame_id: `${index}-${frameIndex}`, time, observation: { visible: index === 2 ? '她把书包放到门口。' : '人物站在原位。',
        change: '原画面记录。', uncertainty: index === 0 ? '切镜模糊不清楚。' : '无新增疑点' } })) }))
  const scene = manuscriptScenes('第4集\n4-1 家 日 内\n甲：你好。\n▲她把书包放到门口。\n甲：回来。')[0]
  assert.ok(scene, 'The fixture needs a scene with actual dialogue anchors')
  const location = manuscriptSourceWindows(scene, { ...material.timeline, windows })
  const selected = manuscriptEvidenceFrames(scene, location, 4, new Set())
  expect(selected).toEqual(['0-3', '1-0', '2-0'])
})

it('retains every short or repeated source match without presenting a unique scene location', async () => {
  const f = await fixture(), source = await f.addReview('第4集')
  const material = await readVideoSourceTimeline(f.ctx, f.agent.session, source.id, {
    windowSeconds: 4, maxBytes: 100_000, maxFrames: 4, maxTranscriptBytes: 4096,
  }, new AbortController().signal)
  const speech = material.timeline.speech, row = speech?.segments[0]
  assert.ok(speech && row, 'Repeated speech candidates need a real raw ASR row')
  const scene = manuscriptScenes('第4集\n4-1 家 日 内\n甲：妈。\n甲：回来。')[0]
  assert.ok(scene, 'The fixture must have the literal short manuscript line')
  const location = manuscriptSourceWindows(scene, { ...material.timeline, speech: { ...speech, segments: [
    { ...row, segment_id: 'S00001', start_seconds: 1, end_seconds: 2, text: '妈，回来。' },
    { ...row, segment_id: 'S00002', start_seconds: 10, end_seconds: 11, text: '妈，回来。' },
  ] } })
  expect(location.line_candidates[0]?.candidates.map(anchor => anchor.segment_id)).toEqual(['S00001', 'S00002'])
  expect(location.repeated_source_text_segment_ids).toEqual(['S00001', 'S00002'])
  expect(location.between_dialogue_lines[0]?.ambiguous_source_matches).toBe(true)
})

it('keeps two current-task videos ambiguous when their source labels cannot identify the draft episode', async () => {
  const f = await fixture([
    toolCallResponse('open-first', 'video_inspect', { file_path: 'a.mp4' }),
    toolCallResponse('open-second', 'video_inspect', { file_path: 'b.mp4' }),
    toolCallResponse('write-draft', 'write', { file_path: 'draft.md', content: '第4集\n4-1 家 日 内\n甲：你好。' }),
    textResponse('照常交付。'),
  ])
  f.ctx.tools.register(defineTool({ name: 'video_inspect', description: 'Fixture source access', parameters: {
    file_path: { type: 'string', required: true },
  }, output: { schema: { type: 'object', additionalProperties: false,
    properties: { opened: { type: 'boolean', required: true } } },
  render: () => [{ type: 'text', text: 'Source opened.' }] }, execute: async () => ({ opened: true }) }))
  await f.addReview('原视频甲', 'a.mp4'); await f.addReview('原视频乙', 'b.mp4')
  await f.run('处理第4集，保存为draft.md。')
  expect(f.evidence()[0]?.scenes[0]?.source_candidates).toHaveLength(2)
  expect(f.evidence()[0]?.scenes[0]?.images.returned).toBe(0)
  expect(JSON.stringify(f.adapter.requests[3])).not.toContain('single_current_task_video_candidate')
})

it('returns the current dialogue-time frame even when an earlier frame contains words supporting the wrong parenthetical', async () => {
  const f = await fixture(), source = await f.addReview('第4集')
  const material = await readVideoSourceTimeline(f.ctx, f.agent.session, source.id, {
    windowSeconds: 8, maxBytes: 100_000, maxFrames: 4, maxTranscriptBytes: 4096,
  }, new AbortController().signal)
  const speech = material.timeline.speech, row = speech?.segments[0], frame = material.timeline.windows[0]?.frames[0]
  assert.ok(speech && row && frame, 'The selector fixture needs original speech and cached frame metadata')
  const makeFrame = (id: string, time: number, visible: string) => ({ ...frame, frame_id: id, time,
    observation: { visible, change: '原视频画面记录。', uncertainty: '' } })
  const timeline = { ...material.timeline, source: { ...material.timeline.source, duration_seconds: 56 },
    scope: { ...material.timeline.scope, end_seconds: 56, window_seconds: 8 },
    speech: { ...speech, segments: [
      { ...row, segment_id: 'S00001', start_seconds: 20, end_seconds: 21, text: '先喝茶。' },
      { ...row, segment_id: 'S00002', start_seconds: 50, end_seconds: 51, text: '我不去了。' },
    ] }, windows: [
      { window_id: 'W00003', start_seconds: 16, end_seconds: 24, event_notes: [], speech_segment_ids: ['S00001'],
        continuous_speech_candidate_indexes: [], frames: [makeFrame('early', 18, '乙抱紧书包。'), makeFrame('cue1', 20, '甲端着茶杯。')] },
      { window_id: 'W00007', start_seconds: 48, end_seconds: 56, event_notes: [], speech_segment_ids: ['S00002'],
        continuous_speech_candidate_indexes: [], frames: [makeFrame('cue2', 50, '乙空手站在门口。')] },
    ] }
  const scene = manuscriptScenes('第4集\n4-1 家 日 内\n甲：先喝茶。\n乙（抱紧书包）：我不去了。')[0]
  assert.ok(scene, 'The fixture keeps the problematic parenthetical on its actual dialogue line')
  const location = manuscriptSourceWindows(scene, timeline)
  expect(location.visual_queries[0]?.time_candidates).toEqual([{ start_seconds: 50, end_seconds: 51,
    relation: 'within_speech_candidate', segment_ids: ['S00002'] }])
  expect(manuscriptEvidenceFrames(scene, location, 1, new Set())).toEqual(['cue2'])
  expect(manuscriptEvidenceFrames(scene, location, 4, new Set())).toEqual(['cue2'])
})

it('returns both plain dialogue lines and the whole original utterance once on a text-only model route', async () => {
  const f = await fixture([toolCallResponse('write-dialogue', 'write', { file_path: 'draft.md',
    content: '第4集\n4-1 家 日 内\n甲：你好。\n甲：今天回来。' }), textResponse('首次交付。')], {}, false)
  const source = await f.addReview('第4集')
  await replaceTranscript(f, source, [{ start: 1, end: 3, text: '你好，今天回来。', speaker_id: '1' }])
  await f.run()
  expect(f.sourceRows()).toEqual([{ segment_id: 'S00001', start_seconds: 1, end_seconds: 3, text: '你好，今天回来。',
    draft_line_refs: [{ scene_id: '4:1', line: 3 }, { scene_id: '4:1', line: 4 }] }])
  const request = f.adapter.requests[1]
  assert.ok(request, 'The successful write must be followed by an actual model request')
  expect(request.messages.flatMap(message => message.content.filter(block => block.type === 'image'))).toEqual([])
  const text = request.messages.flatMap(message => message.content.flatMap(block => block.type === 'text' ? [block.text] : [])).join('\n')
  expect(text).toContain('within_same_speech')
  expect(text).toContain('"actual_quote":"甲：你好。"')
  expect(text).toContain('"actual_quote":"甲：今天回来。"')
  expect(f.evidence()[0]?.returned_scenes).toBe(1)
  expect(JSON.stringify(f.agent.session.deriveMessages().at(-1))).toContain('首次交付')
})

it('keeps equal original utterance texts separate by their actual source segment ids', async () => {
  const f = await fixture([toolCallResponse('write-repeat', 'write', { file_path: 'draft.md',
    content: '第4集\n4-1 家 日 内\n甲：妈。' }), textResponse('完成。')])
  const source = await f.addReview('第4集')
  await replaceTranscript(f, source, [{ start: 1, end: 2, text: '妈。' }, { start: 10, end: 11, text: '妈。' }])
  await f.run()
  expect(f.sourceRows().map(row => [row.segment_id, row.text])).toEqual([['S00001', '妈。'], ['S00002', '妈。']])
  const text = f.adapter.requests[1]?.messages.flatMap(message => message.content.flatMap(block => block.type === 'text' ? [block.text] : [])).join('\n')
  expect(text).toContain('"candidate_segment_ids":["S00001","S00002"]')
  expect(text).toContain('"ambiguous_source_matches":true')
})

it('puts the actual line and ASR beside qualified before-anchor-after images with distinct document and scene hashes', async () => {
  const f = await fixture(), source = await f.addReview('第4集')
  const material = await readVideoSourceTimeline(f.ctx, f.agent.session, source.id, {
    windowSeconds: 4, maxBytes: 100_000, maxFrames: 4, maxTranscriptBytes: 4096,
  }, new AbortController().signal)
  const template = material.timeline.windows[0]?.frames[0], review = reviewsOf(f.ctx, f.agent.session)[source.path]
  assert.ok(template && review?.frames[0]?.image, 'Actual cached attachment references are required')
  const make = (id: string, time: number, reasons: string[]) => ({ ...template, frame_id: id, time, reasons })
  const frames = [make('F00071', 1.5, ['cut']), make('F00110', 1.75, ['context_for:F00071']),
    make('F00109', 1.25, ['context_for:F00071'])]
  const timeline = { ...material.timeline, windows: [{ ...material.timeline.windows[0],
    window_id: 'W1', start_seconds: 0, end_seconds: 4, speech_segment_ids: ['S00001'],
    continuous_speech_candidate_indexes: [], event_notes: [], frames }] }
  const scene = manuscriptScenes('第4集\n4-1 家 日 内\n甲（抬手）：你好。')[0]
  assert.ok(scene, 'The saved scene must retain its real hash and line number')
  const plan = planManuscriptVideoPackets(scene, manuscriptSourceWindows(scene, timeline), 4, new Set())
  const image = { type: 'image' as const, attachment: f.image }
  const content = manuscriptVideoPacketContent({ timeline, documentSha256: 'whole-document-sha', plans: [plan], indexRows: 3,
    images: new Map(frames.map(frame => [frame.frame_id, image])) })
  const packet = content.find(block => block.type === 'text' && block.text.startsWith('{"manuscript_source_packet":')
    && block.text.includes('"origin":"draft_candidates"'))
  assert.ok(packet?.type === 'text', 'The line packet must immediately precede its raw images')
  expect(packet.text).toContain('甲（抬手）：你好。')
  expect(packet.text).toContain('"asr_segment_refs":["S00001"]')
  expect(packet.text).toContain('"document_sha256":"whole-document-sha"')
  expect(packet.text).toContain(`"scene_sha256":"${scene.sha256}"`)
  expect(packet.text).not.toContain('"draft_sha256"')
  const labels = content.flatMap(block => block.type === 'text' && block.text.startsWith('VIDEO_FRAME ') ? [block.text] : [])
  expect(labels.map(label => /^VIDEO_FRAME (\S+)/u.exec(label)?.[1])).toEqual(['F00109', 'F00110', 'F00071'].map(id => `${source.id}/${id}`))
  for (const [index, block] of content.entries()) if (block.type === 'text' && block.text.startsWith('VIDEO_FRAME ')) {
    expect(content[index + 1]?.type).toBe('image')
  }
  expect(content.filter(block => block.type === 'image')).toHaveLength(3)
  expect(JSON.stringify(content)).toContain('unverified_prior_model_observations')
  const withoutIndex = manuscriptVideoPacketContent({ timeline, documentSha256: 'whole-document-sha', plans: [plan],
    indexRows: 0, images: new Map() })
  const withoutIndexHeader = withoutIndex[0]
  assert.ok(withoutIndexHeader?.type === 'text', 'The explicit omitted-index summary must remain visible')
  expect(withoutIndexHeader.text).toContain('"omitted_for_budget":3')
  const missingPacket = withoutIndex[1]
  assert.ok(missingPacket?.type === 'text', 'Missing cache blocks must retain their packet metadata')
  expect(missingPacket.text).toContain('"selection_anchor_returned":false')
  expect(withoutIndex.filter(block => block.type === 'image')).toHaveLength(0)
})

it('ranks original change anchors inside a real candidate interval ahead of a shorter static or padding-only range', async () => {
  const f = await fixture(), source = await f.addReview('第4集')
  const material = await readVideoSourceTimeline(f.ctx, f.agent.session, source.id, {
    windowSeconds: 8, maxBytes: 100_000, maxFrames: 4, maxTranscriptBytes: 4096,
  }, new AbortController().signal)
  const template = material.timeline.windows[0]?.frames[0], speech = material.timeline.speech, row = speech?.segments[0]
  assert.ok(template && speech && row, 'The ranking fixture needs real metadata and a saved ASR row')
  const frames = [{ ...template, frame_id: 'static', time: 1.05, reasons: ['uncertainty_context'] },
    { ...template, frame_id: 'padding-only', time: 8, reasons: ['cut'] },
    { ...template, frame_id: 'before', time: 10.5, reasons: ['context_for:anchor'] },
    { ...template, frame_id: 'anchor', time: 11, reasons: ['appearance_or_continuity'] },
    { ...template, frame_id: 'after', time: 11.5, reasons: ['context_for:anchor'] }]
  const timeline = { ...material.timeline, speech: { ...speech, segments: [
    { ...row, segment_id: 'S1', start_seconds: 1, end_seconds: 1.1, text: '静止。' },
    { ...row, segment_id: 'S2', start_seconds: 10, end_seconds: 12, text: '有变化。' },
  ] }, windows: [{ window_id: 'W1', start_seconds: 0, end_seconds: 16, frames, event_notes: [],
    speech_segment_ids: ['S1', 'S2'], continuous_speech_candidate_indexes: [] }] }
  const scene = manuscriptScenes('第4集\n4-1 家 日 内\n甲（站着）：静止。\n乙（抬手）：有变化。')[0]
  assert.ok(scene, 'Both actual line ranges must exist')
  const plan = planManuscriptVideoPackets(scene, manuscriptSourceWindows(scene, timeline), 4, new Set())
  const current = plan.selected.find(packet => packet.origin === 'draft_candidates')
  expect(current?.lines.map(line => line.line)).toEqual([4])
  expect(current?.selection_anchor).toEqual({ frame_id: 'anchor', time: 11 })
  expect(plan.selected.some(packet => packet.origin === 'source_timeline')).toBe(true)
  const copied = { ...plan, selected: plan.selected.map(packet => ({ ...packet, lines: packet.lines.map(line => ({ ...line })) })) }
  const content = manuscriptVideoPacketContent({ timeline, documentSha256: 'actual-document', plans: [copied], images: new Map(), indexRows: 5 })
  const header = content[0], packet = content[1]
  assert.ok(header?.type === 'text' && packet?.type === 'text', 'Copied plans must retain source and packet metadata')
  expect(header.text).toContain('"selected_for_images":true')
  expect(packet.text).toContain('"selection_anchor_returned":false')
})

it('reads an older presentation receipt without allowing it to suppress the new representation or repeat it indefinitely', async () => {
  const f = await fixture([toolCallResponse('write-draft', 'write', { file_path: 'draft.md',
    content: '第4集\n4-1 家 日 内\n甲：你好。' }), textResponse('完成。')])
  await f.addReview('第4集'); await f.run()
  const original = f.agent.session.deriveMessages().find(message => message.role === 'user'
    && message.source.kind === 'muse-manuscript' && message.content.some(block => block.type === 'text'
      && block.text.startsWith('{"manuscript_video_evidence":')))
  const text = original?.content.find(block => block.type === 'text' && block.text.startsWith('{"manuscript_video_evidence":'))
  assert.ok(text?.type === 'text', 'The compatibility fixture needs a real successful receipt')
  const oldText = text.text.replaceAll(`"presentation_version":"${MANUSCRIPT_VIDEO_PRESENTATION}",`, '')
  f.agent.session.append('user/message', createUserMessage({ source: { kind: 'muse-manuscript' },
    content: [{ type: 'text', text: oldText }] }), { surfaceOp: 'append' })
  const before = f.evidence().length
  await f.run('继续。')
  expect(f.evidence()).toHaveLength(before + 1)
  const current = f.agent.session.deriveMessages().filter(message => message.source.kind === 'muse-manuscript').at(-1)
  expect(JSON.stringify(current)).toContain(MANUSCRIPT_VIDEO_PRESENTATION)
  await f.run('继续。')
  expect(f.evidence()).toHaveLength(before + 1)
})

it('automatically returns actual complete-read before and after lines for a new saved manuscript without video or compare calls', async () => {
  const before = '第4集\r\n4-1 家 日 内\r\n▲甲把杯子放回桌上。\r\n甲：我不走。\r\n'
  const after = '第4集\n4-1 家 日 内\n甲（端杯）：我不走。\n'
  const f = await fixture([toolCallResponse('read-original', 'read', { file_path: 'source.md' }),
    toolCallResponse('write-new', 'write', { file_path: 'draft.md', content: after }), textResponse('首次交付。')])
  await writeFile(join(f.root, 'source.md'), before)
  await f.run('精修来源，保存为draft.md。')
  const report = f.evidence()[0]?.scenes[0]?.read_source_revision
  expect(report).toMatchObject({ status: 'compared', relationship: 'current_task_read_source_candidate', adopted_authorization: 'not_inferred',
    comparison_source: { path: join(f.root, 'source.md'), read_text_sha256: createHash('sha256').update(manuscriptReadText(before)).digest('hex') } })
  expect(report?.comparison_source?.read_text_sha256).not.toBe(createHash('sha256').update(before).digest('hex'))
  expect(report?.hunks.flatMap(hunk => hunk.before)).toContainEqual({ number: 3, text: '▲甲把杯子放回桌上。' })
  expect(report?.hunks.flatMap(hunk => hunk.after)).toContainEqual({ number: 3, text: '甲（端杯）：我不走。' })
  expect(report?.normalization).toContain('not_file_bytes')
  expect(JSON.stringify(f.agent.session.deriveMessages().at(-1))).toContain('首次交付')
  const snapshots = manuscriptTextReadSnapshots(f.ctx, f.agent.session)
  expect(snapshots?.reads[0]?.readCallId).toBe('read-original')
  expect(snapshots?.reads[0]?.text).toBe(manuscriptReadText(before))
  const resumedId = SessionId('resume-complete-source-reads')
  const resumed = Session.create(resumedId, f.agent.session.snapshotEvents(), { ...f.agent.session.header, id: resumedId })
  expect(manuscriptTextReadSnapshots(f.ctx, resumed)).toEqual(snapshots)
})

it('does not refresh an unchanged saved body after a legacy bind', async () => {
  const f = await fixture([toolCallResponse('read-original', 'read', { file_path: 'source.md' }),
    toolCallResponse('write-new', 'write', { file_path: 'draft.md', content: '第4集\n4-1 家 日 内\n甲：改过。' }),
    toolCallResponse('bind-later', 'manuscript_work', { action: 'bind', task_key: 'same-episode-edit', mode: 'edit',
      source_paths: ['source.md'], candidate_paths: ['draft.md'] }), textResponse('完成。')])
  installLegacyBinding(f)
  await writeFile(join(f.root, 'source.md'), '第4集\n4-1 家 日 内\n甲：原句。')
  await f.run('精修后保存为draft.md。')
  expect(f.evidence()).toHaveLength(1)
  expect(f.evidence()[0]?.scenes[0]?.read_source_revision?.relationship).toBe('current_task_read_source_candidate')
  await f.run('继续。')
  expect(f.evidence()).toHaveLength(1)
})

it('keeps multiple same-episode read sources ambiguous without selecting the earliest read or a filename', async () => {
  const f = await fixture([toolCallResponse('read-one', 'read', { file_path: 'first.md' }),
    toolCallResponse('read-two', 'read', { file_path: 'second.md' }),
    toolCallResponse('bind-two', 'manuscript_work', { action: 'bind', task_key: 'ambiguous-sources', mode: 'edit',
      source_paths: ['first.md'], candidate_paths: ['draft.md'] }),
    toolCallResponse('write-new', 'write', { file_path: 'draft.md', content: '第4集\n4-1 家 日 内\n甲：当前稿。' }), textResponse('照常交付。')])
  installLegacyBinding(f)
  await writeFile(join(f.root, 'first.md'), '第4集\n4-1 家 日 内\n甲：第一份。')
  await writeFile(join(f.root, 'second.md'), '第4集\n4-1 家 日 内\n甲：第二份。')
  await f.run('精修后保存为draft.md。')
  const report = f.evidence()[0]?.scenes[0]?.read_source_revision
  expect(report?.status).toBe('ambiguous')
  expect(report?.candidates.map(candidate => candidate.path)).toEqual(['first.md', 'second.md'].map(path => join(f.root, path)))
  expect(report?.hunks).toEqual([])
  expect(report?.comparison_source).toBeUndefined()
  expect(JSON.stringify(f.agent.session.deriveMessages().at(-1))).toContain('照常交付')
})

it.each(['partial', 'truncated'])('does not treat a %s native read as a complete baseline', async (kind) => {
  const f = await fixture([toolCallResponse('read-window', 'read', { file_path: 'source.md', ...kind === 'partial' ? { limit: 2 } : {} }),
    toolCallResponse('write-new', 'write', { file_path: 'draft.md', content: '第4集\n4-1 家 日 内\n甲：当前稿。' }), textResponse('正常交付。')])
  await writeFile(join(f.root, 'source.md'), `第4集\n4-1 家 日 内\n甲：${kind === 'truncated' ? '长'.repeat(12_000) : '原句'}。\n`)
  await f.run('精修后保存为draft.md。')
  const report = f.evidence()[0]?.scenes[0]?.read_source_revision
  expect(report?.status).toBe(kind)
  expect(report?.hunks).toEqual([])
  expect(manuscriptTextReadSnapshots(f.ctx, f.agent.session)?.reads[0]?.text).toBeUndefined()
  expect(JSON.stringify(f.agent.session.deriveMessages().at(-1))).toContain('正常交付')
})

it('ignores an unread legacy bound source and retains the actual complete same-episode read', async () => {
  const f = await fixture([toolCallResponse('read-other', 'read', { file_path: 'other.md' }),
    toolCallResponse('bind-unread', 'manuscript_work', { action: 'bind', task_key: 'unread-source', mode: 'edit',
      source_paths: ['source.md'], candidate_paths: ['unrelated.md'] }),
    toolCallResponse('write-new', 'write', { file_path: 'draft.md', content: '第4集\n4-1 家 日 内\n甲：当前稿。' }), textResponse('完成。')])
  installLegacyBinding(f)
  await writeFile(join(f.root, 'source.md'), '第4集\n4-1 家 日 内\n甲：指定来源。')
  await writeFile(join(f.root, 'other.md'), '第4集\n4-1 家 日 内\n甲：其他读稿。')
  await f.run('精修后保存为draft.md。')
  const report = f.evidence()[0]?.scenes[0]?.read_source_revision
  expect(report?.status).toBe('compared')
  expect(report?.relationship).toBe('current_task_read_source_candidate')
  expect(report?.comparison_source?.path).toBe(join(f.root, 'other.md'))
  expect(report?.candidates.map(candidate => candidate.path)).toEqual([join(f.root, 'other.md')])
  const context = JSON.stringify(f.agent.session.deriveMessages())
  expect(context).not.toContain('bound_text_paths_without_matching_snapshot')
})

it('retains an explicit diagnostic when complete read text exceeds the configured snapshot allowance', async () => {
  const f = await fixture([toolCallResponse('read-large', 'read', { file_path: 'source.md' }),
    toolCallResponse('write-short', 'write', { file_path: 'draft.md', content: '第4集\n4-1 家 日 内\n甲：短稿。' }),
    textResponse('仍可交付。')], { maxTextChars: 64 })
  await writeFile(join(f.root, 'source.md'), `第4集\n4-1 家 日 内\n甲：${'原句'.repeat(50)}。`)
  await f.run('精修后保存为draft.md。')
  const report = f.evidence()[0]?.scenes[0]?.read_source_revision
  expect(report?.status).toBe('snapshot_over_budget')
  expect(report?.hunks).toEqual([])
  expect(manuscriptTextReadSnapshots(f.ctx, f.agent.session)?.reads[0]?.text).toBeUndefined()
  expect(JSON.stringify(f.agent.session.deriveMessages().at(-1))).toContain('仍可交付')
})

it('reports a changed source instead of rereading it as the old complete snapshot', async () => {
  const f = await fixture([toolCallResponse('read-original', 'read', { file_path: 'source.md' }),
    toolCallResponse('change-original', 'source_changes', {}),
    toolCallResponse('write-new', 'write', { file_path: 'draft.md', content: '第4集\n4-1 家 日 内\n甲：当前稿。' }), textResponse('仍可交付。')])
  await writeFile(join(f.root, 'source.md'), '第4集\n4-1 家 日 内\n甲：旧来源。')
  f.ctx.tools.register(defineTool({ name: 'source_changes', description: 'Fixture source replacement', parameters: {},
    output: { schema: { type: 'boolean' }, render: () => [{ type: 'text', text: 'Source changed.' }] },
    execute: async () => { await writeFile(join(f.root, 'source.md'), '第4集\n4-1 家 日 内\n甲：另一个来源版本。'); return true } }))
  await f.run('精修后保存为draft.md。')
  const report = f.evidence()[0]?.scenes[0]?.read_source_revision
  expect(report?.status).toBe('current_source_changed')
  expect(report?.comparison_source).toBeUndefined()
  expect(report?.hunks).toEqual([])
  expect(JSON.stringify(f.agent.session.deriveMessages().at(-1))).toContain('仍可交付')
})

it('bounds retained text snapshots and does not refresh for a repeated identical read receipt', async () => {
  const f = await fixture([toolCallResponse('read-original', 'read', { file_path: 'source.md' }),
    toolCallResponse('read-other', 'read', { file_path: 'other.md' }),
    toolCallResponse('write-new', 'write', { file_path: 'draft.md', content: '第4集\n4-1 家 日 内\n甲：当前稿。' }), textResponse('完成。'),
    toolCallResponse('read-original-again', 'read', { file_path: 'source.md' }), textResponse('没有重复回灌。')], { maxDocuments: 1 })
  await writeFile(join(f.root, 'source.md'), '第4集\n4-1 家 日 内\n甲：旧原句。')
  await writeFile(join(f.root, 'other.md'), '第5集\n5-1 门口 日 外\n乙：另一集。')
  await f.run('精修后保存为draft.md。')
  expect(manuscriptTextReadSnapshots(f.ctx, f.agent.session)?.reads).toHaveLength(1)
  expect(manuscriptTextReadSnapshots(f.ctx, f.agent.session)?.omitted).toBe(1)
  expect(f.evidence()[0]?.scenes[0]?.read_source_revision?.omitted_read_snapshots).toBe(1)
  await f.run('继续。')
  expect(f.evidence()).toHaveLength(1)
  expect(manuscriptTextReadSnapshots(f.ctx, f.agent.session)?.reads[0]?.readCallId).toBe('read-original')
  await f.run('另一任务保存为another.md。')
  expect(manuscriptTextReadSnapshots(f.ctx, f.agent.session)?.reads).toEqual([])
})

it.each(['partial_then_complete', 'complete_then_partial'])('uses the current complete same-path snapshot for %s', async (order) => {
  const full = toolCallResponse('read-complete', 'read', { file_path: 'source.md' })
  const partial = toolCallResponse('read-partial', 'read', { file_path: 'source.md', limit: 2 })
  const f = await fixture([...(order === 'partial_then_complete' ? [partial, full] : [full, partial]),
    toolCallResponse('write-new', 'write', { file_path: 'draft.md', content: '第4集\n4-1 家 日 内\n甲：改稿。' }),
    textResponse('完成。')], { maxDocuments: 1 })
  await writeFile(join(f.root, 'source.md'), '第4集\n4-1 家 日 内\n甲：完整原句。')
  await f.run('精修后保存为draft.md。')
  const report = f.evidence()[0]?.scenes[0]?.read_source_revision
  expect(report?.status).toBe('compared')
  expect(report?.candidates).toHaveLength(1)
  expect(report?.comparison_source?.read_call_id).toBe('read-complete')
  expect(report?.hunks.flatMap(hunk => hunk.before)).toContainEqual({ number: 3, text: '甲：完整原句。' })
  expect(manuscriptTextReadSnapshots(f.ctx, f.agent.session)?.reads.map(read => read.status).sort()).toEqual(['complete', 'partial'])
})

it('replaces a same-path old complete read with the newly read current text without treating versions as adopted alternatives', async () => {
  const f = await fixture([toolCallResponse('read-old', 'read', { file_path: 'source.md' }),
    toolCallResponse('source-new', 'source_changes', {}), toolCallResponse('read-new', 'read', { file_path: 'source.md' }),
    toolCallResponse('write-new', 'write', { file_path: 'draft.md', content: '第4集\n4-1 家 日 内\n甲：改稿。' }), textResponse('完成。')])
  await writeFile(join(f.root, 'source.md'), '第4集\n4-1 家 日 内\n甲：旧来源。')
  f.ctx.tools.register(defineTool({ name: 'source_changes', description: 'Fixture source replacement', parameters: {},
    output: { schema: { type: 'boolean' }, render: () => [{ type: 'text', text: 'Source changed.' }] },
    execute: async () => { await writeFile(join(f.root, 'source.md'), '第4集\n4-1 家 日 内\n甲：最新来源。'); return true } }))
  await f.run('精修后保存为draft.md。')
  const report = f.evidence()[0]?.scenes[0]?.read_source_revision
  expect(report?.status).toBe('compared')
  expect(report?.candidates).toHaveLength(1)
  expect(report?.comparison_source?.read_call_id).toBe('read-new')
  expect(report?.hunks.flatMap(hunk => hunk.before)).toContainEqual({ number: 3, text: '甲：最新来源。' })
  expect(manuscriptTextReadSnapshots(f.ctx, f.agent.session)?.reads).toHaveLength(1)
})

it('counts distinct snapshot paths rather than same-path partial and complete versions against the document allowance', async () => {
  const f = await fixture([toolCallResponse('read-partial', 'read', { file_path: 'source.md', limit: 2 }),
    toolCallResponse('read-complete', 'read', { file_path: 'source.md' }),
    toolCallResponse('read-second', 'read', { file_path: 'second.md' }),
    toolCallResponse('write-new', 'write', { file_path: 'draft.md', content: '第4集\n4-1 家 日 内\n甲：改稿。' }), textResponse('完成。')],
  { maxDocuments: 2 })
  await writeFile(join(f.root, 'source.md'), '第4集\n4-1 家 日 内\n甲：完整原句。')
  await writeFile(join(f.root, 'second.md'), '第5集\n5-1 家 日 内\n乙：第二份。')
  await f.run('精修后保存为draft.md。')
  const snapshots = manuscriptTextReadSnapshots(f.ctx, f.agent.session)
  expect(snapshots?.reads).toHaveLength(3)
  expect(new Set(snapshots?.reads.map(read => read.path)).size).toBe(2)
  expect(snapshots?.omitted).toBe(0)
  expect(f.evidence()[0]?.scenes[0]?.read_source_revision?.status).toBe('compared')
})

it('compares only the actual matching episode from a multi-episode complete read', async () => {
  const f = await fixture([toolCallResponse('read-series', 'read', { file_path: 'source.md' }),
    toolCallResponse('write-episode', 'write', { file_path: 'draft.md', content: '第4集\n4-1 家 日 内\n甲：改好的第四集。' }), textResponse('完成。')])
  await writeFile(join(f.root, 'source.md'), '第4集\n4-1 家 日 内\n甲：原第四集。\n第5集\n5-1 家 日 内\n乙：第五集不在本轮范围。')
  await f.run('处理第四集，保存为draft.md。')
  const report = f.evidence()[0]?.scenes[0]?.read_source_revision
  expect(report?.status).toBe('compared')
  expect(JSON.stringify(report?.hunks)).toContain('原第四集')
  expect(JSON.stringify(report?.hunks)).not.toContain('第五集不在本轮范围')
})

function nativeEditBatch(calls: readonly { id: string; name: 'edit' | 'write'; args: object }[]): StreamChunk[] {
  const chunks: StreamChunk[] = []
  for (const [index, call] of calls.entries()) {
    for (const chunk of toolCallResponse(call.id, call.name, call.args)) {
      if (chunk.type === 'usage' || chunk.type === 'finish') continue
      chunks.push('index' in chunk ? { ...chunk, index } : chunk)
    }
  }
  return [...chunks, { type: 'finish', reason: { kind: 'tool-calls' } }]
}

it('returns both native edits from one tool batch relative to the last version whose source materials were admitted', async () => {
  const f = await fixture([nativeEditBatch([
    { id: 'chain-a', name: 'edit', args: { file_path: 'draft.md', old_string: '▲乙把碗放在桌中央。', new_string: '▲乙把碗推向桌边。' } },
    { id: 'chain-b', name: 'edit', args: { file_path: 'draft.md', old_string: '甲（站在门边）', new_string: '甲（走到乙身边）' } },
  ]), textResponse('首次交付。')])
  await addChangedVisualSource(f); await writeFile(join(f.root, 'draft.md'), visualBefore)
  await f.run()
  const report = f.evidence().at(-1)
  expect(report?.changed_line_selection).toMatchObject({ basis: 'successful_native_mutation', after_changed_lines: [6, 8] })
  expect(report?.receipt.complete_lf_text_sha256).toBe(createHash('sha256').update(visualAfter).digest('hex'))
  const count = f.evidence().length
  await f.run('继续。')
  expect(f.evidence()).toHaveLength(count)
})

it.each([
  { name: 'insert', old: '甲（点头）：你好。', replacement: '▲甲推开门。\n甲（点头）：你好。', expected: [3, 9] },
  { name: 'delete', old: '甲（点头）：你好。\n', replacement: '', expected: [7] },
])('recomputes the pending diff after a later $name shifts an earlier changed action line', async ({ old, replacement, expected }) => {
  const f = await fixture([nativeEditBatch([
    { id: 'shift-last', name: 'edit', args: { file_path: 'draft.md', old_string: '甲（站在门边）', new_string: '甲（走到乙身边）' } },
    { id: 'shift-before', name: 'edit', args: { file_path: 'draft.md', old_string: old, new_string: replacement } },
  ]), textResponse('直接交付。')])
  await addChangedVisualSource(f); await writeFile(join(f.root, 'draft.md'), visualBefore)
  await f.run()
  expect(f.evidence().at(-1)?.changed_line_selection).toMatchObject({ basis: 'successful_native_mutation', after_changed_lines: expected })
})

it('starts a fresh known baseline when an intervening external change breaks the native before-to-after chain', async () => {
  const first = visualBefore.replace('▲乙把碗放在桌中央。', '▲乙把碗推向桌边。')
  const external = first.replace('乙：等一下。', '乙：我先去外面。')
  const f = await fixture([nativeEditBatch([
    { id: 'broken-a', name: 'edit', args: { file_path: 'draft.md', old_string: '▲乙把碗放在桌中央。', new_string: '▲乙把碗推向桌边。' } },
    { id: 'broken-b', name: 'edit', args: { file_path: 'draft.md', old_string: '甲（站在门边）', new_string: '甲（走到乙身边）' } },
  ]), textResponse('按当前文件交付。')])
  await addChangedVisualSource(f); await writeFile(join(f.root, 'draft.md'), visualBefore)
  f.ctx.on('tools/post-execute', async (exec, _result, next) => {
    const decision = await next()
    if (exec.callId === 'broken-a') await writeFile(join(f.root, 'draft.md'), external)
    return decision
  })
  await f.run()
  expect(f.evidence().at(-1)?.changed_line_selection).toMatchObject({ basis: 'successful_native_mutation', after_changed_lines: [8] })
})

it('discards a pending native chain when a later update has no complete before text even if it writes identical bytes', async () => {
  const first = visualBefore.replace('▲乙把碗放在桌中央。', '▲乙把碗推向桌边。')
  const f = await fixture([nativeEditBatch([
    { id: 'known-a', name: 'edit', args: { file_path: 'draft.md', old_string: '▲乙把碗放在桌中央。', new_string: '▲乙把碗推向桌边。' } },
    { id: 'unknown-write', name: 'write', args: { file_path: 'draft.md', content: first } },
  ]), textResponse('不推定未知修改。')], {}, true, { diffBasisMaxBytes: 1 })
  await addChangedVisualSource(f); await writeFile(join(f.root, 'draft.md'), visualBefore)
  await f.run()
  expect(f.evidence().at(-1)?.changed_line_selection).toMatchObject({ basis: 'unavailable', after_changed_lines: [] })
})

it('resets the native baseline after a logged source receipt without replaying an already returned change', async () => {
  const f = await fixture([
    toolCallResponse('delivered-a', 'edit', { file_path: 'draft.md', old_string: '▲乙把碗放在桌中央。', new_string: '▲乙把碗推向桌边。' }),
    nativeEditBatch([
      { id: 'fresh-b', name: 'edit', args: { file_path: 'draft.md', old_string: '甲（站在门边）', new_string: '甲（走到乙身边）' } },
      { id: 'fresh-c', name: 'edit', args: { file_path: 'draft.md', old_string: '甲（点头）：你好。', new_string: '▲甲推开门。\n甲（点头）：你好。' } },
    ]), textResponse('交付新版本。'),
  ])
  await addChangedVisualSource(f); await writeFile(join(f.root, 'draft.md'), visualBefore.replaceAll('\n', '\r\n'))
  await f.run()
  expect(f.evidence()[0]?.changed_line_selection?.after_changed_lines).toEqual([6])
  expect(f.evidence().at(-1)?.changed_line_selection?.after_changed_lines).toEqual([3, 9])
  expect(f.evidence().at(-1)?.changed_line_selection?.after_changed_lines).not.toContain(7)
  const current = await readFile(join(f.root, 'draft.md'), 'utf8')
  expect(f.evidence().at(-1)?.receipt.sha256).toBe(createHash('sha256').update(current).digest('hex'))
  expect(f.evidence().at(-1)?.receipt.complete_lf_text_sha256)
    .toBe(createHash('sha256').update(current.replaceAll('\r\n', '\n')).digest('hex'))
})

it('keeps native changes pending when source materials were prepared but never admitted into the Session', async () => {
  const f = await fixture(), evidence = new ManuscriptVideoEvidence(RevisionPlugin.Config({}))
  await addChangedVisualSource(f)
  const path = join(f.root, 'draft.md'), signal = new AbortController().signal
  const first = visualBefore.replace('▲乙把碗放在桌中央。', '▲乙把碗推向桌边。')
  await writeFile(path, first)
  await evidence.remember(f.agent, path, { before: visualBefore, after: first, operation: 'update' })
  const prepared = await evidence.refresh(f.ctx, f.agent, signal)
  const parse = (content: typeof prepared) => content.flatMap(block => block.type === 'text'
    && block.text.startsWith('{"manuscript_video_evidence":')
    ? [materialSchema.parse(JSON.parse(block.text)).manuscript_video_evidence] : [])
  expect(parse(prepared)[0]?.changed_line_selection?.after_changed_lines).toEqual([6])
  expect(f.evidence()).toHaveLength(0)
  await writeFile(path, visualAfter)
  await evidence.remember(f.agent, path, { before: first, after: visualAfter, operation: 'update' })
  expect(parse(await evidence.refresh(f.ctx, f.agent, signal))[0]?.changed_line_selection?.after_changed_lines).toEqual([6, 8])
})

it.each(['other_message_source', 'different_path', 'different_lf_hash', 'legacy_receipt_without_lf_hash'])(
  'does not reset a pending chain from %s receipt contents', async (kind) => {
    const f = await fixture(), evidence = new ManuscriptVideoEvidence(RevisionPlugin.Config({}))
    f.ctx.on('session/event', (session, event) => { evidence.observeReceipt(session, event) })
    await addChangedVisualSource(f)
    const path = join(f.root, 'draft.md'), signal = new AbortController().signal
    const first = visualBefore.replace('▲乙把碗放在桌中央。', '▲乙把碗推向桌边。')
    await writeFile(path, first)
    await evidence.remember(f.agent, path, { before: visualBefore, after: first, operation: 'update' })
    const prepared = await evidence.refresh(f.ctx, f.agent, signal)
    const schema = z.object({ manuscript_video_evidence: z.object({ receipt: z.object({ path: z.string(),
      complete_lf_text_sha256: z.string().optional() }).loose() }).loose() }).loose()
    const content = prepared.map((block) => {
      if (block.type !== 'text' || !block.text.startsWith('{"manuscript_video_evidence":')) return block
      const value = schema.parse(JSON.parse(block.text))
      if (kind === 'different_path') value.manuscript_video_evidence.receipt.path = join(f.root, 'different.md')
      if (kind === 'different_lf_hash') value.manuscript_video_evidence.receipt.complete_lf_text_sha256 = 'different-text-version'
      if (kind === 'legacy_receipt_without_lf_hash') delete value.manuscript_video_evidence.receipt.complete_lf_text_sha256
      return { ...block, text: JSON.stringify(value) }
    })
    f.agent.session.append('user/message', createUserMessage({ source: kind === 'other_message_source'
      ? { kind: 'user' } : { kind: 'muse-manuscript' }, content }), { surfaceOp: 'append' })
    await writeFile(path, visualAfter)
    await evidence.remember(f.agent, path, { before: first, after: visualAfter, operation: 'update' })
    const combined = await evidence.refresh(f.ctx, f.agent, signal)
    const reports = combined.flatMap(block => block.type === 'text' && block.text.startsWith('{"manuscript_video_evidence":')
      ? [materialSchema.parse(JSON.parse(block.text)).manuscript_video_evidence] : [])
    expect(reports[0]?.changed_line_selection?.after_changed_lines).toEqual([6, 8])
  },
)

it('locates an action between the nearest actual anchors while retaining corrected-name dialogue as unaligned', () => {
  const timeline = literalSourceTimeline([{ start: 1, end: 2, text: '先说清楚。' },
    { start: 10, end: 11, text: '明威，坐这里。' }, { start: 30, end: 31, text: '别走。' }])
  const scene = manuscriptScenes('第4集\n4-1 家 日 内\n甲：先说清楚。\n乙（抬头）：明薇，坐这里。\n▲乙把杯子放下。\n丙：谁知道呢。\n丁：别走。')[0]!
  const location = manuscriptSourceWindows(scene, timeline), action = location.visual_queries.find(query => query.line === 5)
  expect(location.line_candidates.find(line => line.line === 4)?.candidates).toEqual([])
  expect(location.line_candidates.find(line => line.line === 6)?.candidates).toEqual([])
  expect(location.visual_queries.find(query => query.line === 4)?.time_candidates).toEqual([])
  expect(location.between_dialogue_lines.map(pair => pair.relation)).toEqual(['not_aligned', 'not_aligned', 'not_aligned'])
  expect(action).toMatchObject({ nearest_aligned_dialogue_lines: { previous_line: 3, next_line: 7 },
    skipped_unaligned_dialogue_lines: [4, 6], temporal_alignment: 'literal_speech_time_candidates' })
  expect(action?.time_candidates).toEqual([{ start_seconds: 2, end_seconds: 30,
    relation: 'between_speech_candidates_not_an_event', segment_ids: ['S1', 'S3'] }])
  const plan = planManuscriptVideoPackets(scene, location, 1, new Set(), new Set([5]))
  expect(plan.selected[0]).toMatchObject({ changed_literal_selection: { preferred: true, tier: 0 },
    interval: { start_seconds: 2, end_seconds: 30 }, images: [{ frame_id: 'F1' }] })
  const blocks = manuscriptVideoPacketContent({ timeline, documentSha256: 'draft', plans: [plan], images: new Map(), indexRows: 20 })
  const raw: unknown = JSON.parse(blocks[0]?.type === 'text' ? blocks[0].text : '{}')
  expect(raw).toMatchObject({ manuscript_video_source: { visual_query_anchor_skips: [{ line: 5,
    nearest_aligned_dialogue_lines: { previous_line: 3, next_line: 7 }, skipped_unaligned_dialogue_lines: [4, 6],
    scope: 'nearest_literal_dialogue_candidates_not_semantic_alignment' }] } })
})

it('retains every ordered repeated-anchor combination when an action skips unaligned dialogue', () => {
  const timeline = literalSourceTimeline([{ start: 1, end: 2, text: '停下。' }, { start: 10, end: 11, text: '停下。' },
    { start: 5, end: 6, text: '回来。' }, { start: 15, end: 16, text: '回来。' }])
  const scene = manuscriptScenes('第4集\n4-1 家 日 内\n甲：停下。\n乙：明薇坐。\n▲乙放下杯子。\n丙：明薇来。\n丁：回来。')[0]!
  const location = manuscriptSourceWindows(scene, timeline), action = location.visual_queries[0]!
  expect(location.line_candidates[0]?.candidates.map(row => row.segment_id)).toEqual(['S1', 'S2'])
  expect(location.line_candidates.at(-1)?.candidates.map(row => row.segment_id)).toEqual(['S3', 'S4'])
  expect(action.skipped_unaligned_dialogue_lines).toEqual([4, 6])
  expect(action.source_ambiguity_retained).toBe(true)
  expect(action.time_candidates.map(range => [range.start_seconds, range.end_seconds, range.segment_ids])).toEqual([
    [2, 5, ['S1', 'S3']], [2, 15, ['S1', 'S4']], [11, 15, ['S2', 'S4']],
  ])
})

it.each([
  { name: 'only a later anchor', body: '▲乙放杯。\n乙：明薇坐。\n甲：回来。', rows: [{ start: 20, end: 21, text: '回来。' }],
    expected: [{ start_seconds: 0, end_seconds: 20, relation: 'before_speech_candidate', segment_ids: ['S1'] }],
    support: { next_line: 5 }, skipped: [4] },
  { name: 'only an earlier anchor', body: '甲：停下。\n乙：明薇坐。\n▲乙放杯。', rows: [{ start: 1, end: 2, text: '停下。' }],
    expected: [{ start_seconds: 2, end_seconds: 64, relation: 'after_speech_candidate', segment_ids: ['S1'] }],
    support: { previous_line: 3 }, skipped: [4] },
  { name: 'no literal anchor', body: '甲：明薇坐。\n▲乙放杯。\n乙：明薇来。', rows: [{ start: 1, end: 2, text: '明威坐。' }],
    expected: [], support: {}, skipped: [3, 5] },
])('keeps $name explicit without matching corrected names or inventing a second endpoint', ({ body, rows, expected, support, skipped }) => {
  const scene = manuscriptScenes(`第4集\n4-1 家 日 内\n${body}`)[0]!
  const location = manuscriptSourceWindows(scene, literalSourceTimeline(rows)), action = location.visual_queries[0]!
  expect(action.time_candidates).toEqual(expected)
  expect(action.nearest_aligned_dialogue_lines).toEqual(support)
  expect(action.skipped_unaligned_dialogue_lines).toEqual(skipped)
  expect(location.line_candidates.filter(line => line.quote.includes('明薇')).every(line => line.candidates.length === 0)).toBe(true)
})

it('does not borrow a literal dialogue anchor from another manuscript scene', () => {
  const timeline = literalSourceTimeline([{ start: 1, end: 2, text: '停下。' }])
  const scenes = manuscriptScenes('第4集\n4-1 家 日 内\n甲：停下。\n4-2 门外 日 外\n乙：明薇坐。\n▲乙放杯。')
  expect(scenes).toHaveLength(2)
  const first = manuscriptSourceWindows(scenes[0]!, timeline), second = manuscriptSourceWindows(scenes[1]!, timeline)
  expect(first.anchors).toHaveLength(1)
  expect(second.anchors).toEqual([])
  expect(second.visual_queries[0]).toMatchObject({ time_candidates: [], nearest_aligned_dialogue_lines: {},
    skipped_unaligned_dialogue_lines: [5] })
  expect(second.between_dialogue_lines).toEqual([])
})
