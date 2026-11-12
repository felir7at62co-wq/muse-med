/** Formal episode deliveries cannot bypass the current render/draft artifact binding. */
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentRegistry, { AgentModel, modelSelectionProjectionDefinition, type Agent } from '@deepseek-ai/dsh-agent'
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'
import { executeModelToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { createScope, type Scope } from '@deepseek-ai/dsh-scope'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools, { defineTool } from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import WorkingDirectory from '@deepseek-ai/dsh-working-directory'
import * as Present from '@deepseek-ai/dsh-tool-present'
import * as EditingPolicy from '../src/editing-policy.ts'
import { validateShortDramaDelivery } from '../src/short-drama-delivery.ts'

const cleanups: Array<() => Promise<unknown>> = []
const signal = new AbortController().signal
const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex')
let serial = 0
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

interface FixtureSource {
  delivery_inputs: {
    timeline_sha256: string
    source_qa_sha256?: string
    subtitle_visual_verification?: {
      report_sha256: string
      delivery: { width: number; height: number; fps: number }
      visual: Record<string, number | string>
    }
  }
  input_files: Array<{ path: string; sha256: string | null }>
  inputs: string[]
}
interface FixtureLayout { entries: Array<{ selected_fonts: string[]; fontselect_trace: string[] }> }
interface FixtureTimeline { delivery: { width: number; height: number; fps: number } }
interface FixtureDraft { timeline_sha256: string; materials: Array<{ path: string; sha256: string }> }
const readFixture = async <T>(path: string): Promise<T> => JSON.parse(await readFile(path, 'utf8')) as T

async function fixture(episodeParent = '视频') {
  const root = await mkdtemp(join(tmpdir(), 'muse-short-drama-delivery-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const project = join(root, 'short-drama'), episode = join(project, episodeParent, '第41集')
  const video = join(episode, '01_可交付视频', '第41集.mp4'), working = join(project, 'exports', '41.mp4')
  const draft = join(episode, '02_剪映草稿', '第41集')
  const timeline = join(project, 'editing', '41-timeline.json'), subtitle = join(project, 'editing', '41.srt')
  const master = join(project, 'audio', '41.wav'), sourceVideo = join(project, 'video', '41', 'shot_001.mp4')
  for (const file of [video, working, join(draft, 'draft_content.json'), timeline, master, sourceVideo]) await mkdir(dirname(file), { recursive: true })
  const json = async (path: string, value: unknown) => { await writeFile(path, JSON.stringify(value)); return sha(await readFile(path)) }
  await json(join(project, 'project_config.json'), { jubian_script_id: 5933 })
  await writeFile(video, 'candidate-video'); await writeFile(working, 'candidate-video')
  await writeFile(sourceVideo, 'current-source'); await writeFile(master, 'current-voice')
  await writeFile(timeline, '{"delivery":{"width":480,"height":854,"fps":24},"clips":[{"shot":1,"start_us":0,"duration_us":2000000}]}')
  await writeFile(subtitle, '1\n00:00:00,000 --> 00:00:01,000\n现在回去\n')
  const paths = [timeline, subtitle, master, sourceVideo]
  const inputs = await Promise.all(paths.map(async path => ({ path, sha256: sha(await readFile(path)) })))
  const selected = [{ shot: 1, sha256: inputs[3]!.sha256 }]
  const layout = join(project, 'editing', '41-layout.json'), font = 'Zhuque Fangsong (technical preview)'
  const layoutSha = await json(layout, { schema_version: 1, status: 'measured', requested_font: font, delivery_size: { width: 480, height: 854 }, entries: [
    { status: 'measured', fits_available_width: true, selected_fonts: ['ZhuqueFangsong-Regular'],
      fontselect_trace: ['fontselect: (Zhuque Fangsong (technical preview), 400, 0) -> /fonts/ZhuqueFangsong-Regular.ttf, 0, ZhuqueFangsong-Regular'] }] })
  const sourceQa = sha('fixture-source-qa-summary')
  const sourcePath = `${working}.source-record.json`
  const renderSha = await json(sourcePath, { version: 1, episode: '41', output: { path: working, sha256: sha('candidate-video') },
    delivery_inputs: { timeline_sha256: inputs[0]!.sha256, subtitle_sha256: inputs[1]!.sha256,
      master_audio_sha256: inputs[2]!.sha256, videos: selected, source_qa_sha256: sourceQa,
      subtitle_visual_verification: { version: 1, subtitle_sha256: inputs[1]!.sha256, report_path: layout, report_sha256: layoutSha,
        delivery: { width: 480, height: 854, fps: 24 }, visual: { schema_version: 1, reference_width: 480, reference_height: 854,
          font_size_px: 46, outline_px: 1.25, center_y_ratio: 0.736747073, max_width_ratio: 0.9, font_family: font },
        requested_font: font, checks: ['subtitle_display_text', 'subtitle_display_width', 'subtitle_display_font'].map(id => ({ id, ok: true })) } },
    input_files: [...inputs, { path: layout, sha256: layoutSha }], inputs: [...inputs.map(row => row.sha256), layoutSha, sourceQa] })
  const native = ['draft_content.json', 'draft_meta_info.json']
  for (const name of native) await json(join(draft, name), { tracks: [], marker: name })
  const draftSource = join(draft, 'muse-episode-source.json')
  const draftSha = await json(draftSource, { version: 1, episode: '41', audio_mode: 'independent',
    timeline_sha256: inputs[0]!.sha256, subtitle_sha256: inputs[1]!.sha256, master_audio_sha256: inputs[2]!.sha256,
    videos: selected, files: await Promise.all(native.map(async path => ({ path, sha256: sha(await readFile(join(draft, path))) }))),
    materials: inputs })
  const receipt = join(episode, '成片与草稿回执.json')
  await json(receipt, { version: 1, status: 'candidate', episode: '41', video, draft, sha256: sha('candidate-video'),
    working_output: working, render_source_sha256: renderSha, draft_source_sha256: draftSha,
    wholeEpisodeContentAccepted: false })
  return { root, project, episode, video, working, draft, timeline, subtitle, master, sourceVideo,
    receipt, sourcePath, draftSource, layout, json }
}

it('keeps a matching same-episode artifact chain at candidate status', async () => {
  const f = await fixture()
  await expect(validateShortDramaDelivery([f.video], signal)).resolves.toBeUndefined()
  expect(JSON.parse(await readFile(f.receipt, 'utf8'))).toMatchObject({ status: 'candidate', wholeEpisodeContentAccepted: false })
})

it.each([
  { jubian_script_id: 5933, project_bible: { delivery: { width: 480, height: 854, fps: 24 } } },
  { project_bible: { schema_version: 1 } },
])('requires source evidence for a short-drama project with legacy metadata: %j', async (config) => {
  const f = await fixture()
  await f.json(join(f.project, 'project_config.json'), config)
  const source = await readFixture<FixtureSource>(f.sourcePath)
  delete source.delivery_inputs.source_qa_sha256
  const sourceSha = await f.json(f.sourcePath, source)
  const receipt = await readFixture<Record<string, unknown>>(f.receipt)
  await f.json(f.receipt, { ...receipt, render_source_sha256: sourceSha })
  await expect(validateShortDramaDelivery([f.video], signal)).rejects.toThrow('short_drama_delivery_evidence')
})

it.each(['subtitle', 'timeline', 'sourceVideo', 'master', 'video', 'working'] as const)('rejects changed %s after prior staging', async (field) => {
  const f = await fixture()
  await writeFile(f[field], `replaced-${field}`)
  await expect(validateShortDramaDelivery([f.video], signal)).rejects.toThrow('short_drama_delivery_changed')
})

it('allows subsequent editor changes without recertifying the current draft, while rejecting changed pairing evidence', async () => {
  const f = await fixture()
  await writeFile(join(f.draft, 'draft_content.json'), '{"changed":true}')
  await writeFile(join(f.draft, 'draft_meta_info.json'), '{"savedByEditor":true}')
  await expect(validateShortDramaDelivery([f.video], signal)).resolves.toBeUndefined()
  await writeFile(f.draftSource, '{"changedPairing":true}')
  await expect(validateShortDramaDelivery([f.video], signal)).rejects.toThrow('交付证据已变化')
  await writeFile(f.sourcePath, '{}')
  await expect(validateShortDramaDelivery([f.video], signal)).rejects.toThrow('交付证据已变化')
})

it('rejects handwritten FFmpeg outputs in formal export locations but leaves source media and ordinary file tasks alone', async () => {
  const f = await fixture()
  const manual = join(f.project, 'exports', 'manual.mp4')
  await writeFile(manual, 'agent-ffmpeg-output')
  await expect(validateShortDramaDelivery([manual], signal)).rejects.toThrow('short_drama_delivery_unstaged')
  const generic = join(f.root, 'exports', 'ordinary.mp4')
  await mkdir(dirname(generic), { recursive: true }); await writeFile(generic, 'ordinary-video')
  await expect(validateShortDramaDelivery([generic, f.sourceVideo, join(f.project, 'exports', 'notes.txt')], signal)).resolves.toBeUndefined()
  await writeFile(join(f.root, 'project_config.json'), 'Unrelated damaged metadata is not a short-drama marker')
  await expect(validateShortDramaDelivery([generic], signal)).resolves.toBeUndefined()
})

it('scopes registered native outputs without applying episode rules to arbitrary videos elsewhere', async () => {
  const f = await fixture(), output = join(f.root, 'current-native-output.mp4')
  await writeFile(output, 'native-output')
  await expect(validateShortDramaDelivery([output], signal)).resolves.toBeUndefined()
  await expect(validateShortDramaDelivery([output], signal, new Map([[output, f.project]]))).rejects.toThrow('short_drama_delivery_unstaged')
})

it.each(['source_qa_sha256', 'subtitle_visual_verification'] as const)('rejects a legacy candidate without %s', async (field) => {
  const f = await fixture(), source = await readFixture<FixtureSource>(f.sourcePath)
  if (field === 'source_qa_sha256') delete source.delivery_inputs.source_qa_sha256
  else delete source.delivery_inputs.subtitle_visual_verification
  const receipt = await readFixture<Record<string, unknown>>(f.receipt)
  await f.json(f.receipt, { ...receipt, render_source_sha256: await f.json(f.sourcePath, source) })
  await expect(validateShortDramaDelivery([f.video], signal)).rejects.toThrow('short_drama_delivery_evidence')
})

it('rejects claimed passing booleans when the bound libass evidence selected a fallback face', async () => {
  const f = await fixture(), layout = await readFixture<FixtureLayout>(f.layout)
  layout.entries[0]!.selected_fonts = ['NotoSansCJKsc-Regular']
  layout.entries[0]!.fontselect_trace = [
    'fontselect: (Zhuque Fangsong (technical preview), 400, 0) -> /fonts/NotoSans.otf, 0, NotoSansCJKsc-Regular',
  ]
  const layoutSha = await f.json(f.layout, layout), source = await readFixture<FixtureSource>(f.sourcePath)
  source.delivery_inputs.subtitle_visual_verification!.report_sha256 = layoutSha
  source.input_files.find(row => row.path === f.layout)!.sha256 = layoutSha
  const receipt = await readFixture<Record<string, unknown>>(f.receipt)
  await f.json(f.receipt, { ...receipt, render_source_sha256: await f.json(f.sourcePath, source) })
  await expect(validateShortDramaDelivery([f.video], signal)).rejects.toThrow('short_drama_delivery_font')
})

async function changeCanvas(f: Awaited<ReturnType<typeof fixture>>, width: number, height: number, retainVisual: boolean) {
  const timeline = await readFixture<FixtureTimeline>(f.timeline)
  timeline.delivery = { ...timeline.delivery, width, height }
  const timelineSha = await f.json(f.timeline, timeline), source = await readFixture<FixtureSource>(f.sourcePath)
  source.delivery_inputs.timeline_sha256 = timelineSha
  source.input_files.find(row => row.path === f.timeline)!.sha256 = timelineSha
  source.inputs.push(timelineSha)
  if (!retainVisual) delete source.delivery_inputs.subtitle_visual_verification
  else source.delivery_inputs.subtitle_visual_verification!.delivery = { width, height, fps: timeline.delivery.fps }
  const draft = await readFixture<FixtureDraft>(f.draftSource)
  draft.timeline_sha256 = timelineSha
  draft.materials.find(row => row.path === f.timeline)!.sha256 = timelineSha
  const receipt = await readFixture<Record<string, unknown>>(f.receipt)
  await f.json(f.receipt, { ...receipt, render_source_sha256: await f.json(f.sourcePath, source),
    draft_source_sha256: await f.json(f.draftSource, draft) })
}

it.each([[1280, 720], [720, 720]])('keeps nonportrait %ix%i candidates outside the portrait font extension', async (width, height) => {
  const f = await fixture()
  await changeCanvas(f, width, height, false)
  await expect(validateShortDramaDelivery([f.video], signal)).resolves.toBeUndefined()
})

it('rejects a claimed landscape timeline when its bound actual layout still describes portrait delivery', async () => {
  const f = await fixture()
  await changeCanvas(f, 1280, 720, true)
  await expect(validateShortDramaDelivery([f.video], signal)).rejects.toThrow('实测画布')
})

it.each([['font_size_px', 90], ['center_y_ratio', 0.5], ['center_y_ratio', 0.64]] as const)('rejects changed portrait product %s despite passing flags', async (field, value) => {
  const f = await fixture(), source = await readFixture<FixtureSource>(f.sourcePath)
  source.delivery_inputs.subtitle_visual_verification!.visual[field] = value
  const receipt = await readFixture<Record<string, unknown>>(f.receipt)
  await f.json(f.receipt, { ...receipt, render_source_sha256: await f.json(f.sourcePath, source) })
  await expect(validateShortDramaDelivery([f.video], signal)).rejects.toThrow('short_drama_delivery_evidence')
})

it('requires missing recorded inputs to remain absent even when replaced by a directory', async () => {
  const f = await fixture(), absentPath = join(f.project, 'unselected-overlay.json')
  const source = await readFixture<FixtureSource>(f.sourcePath)
  source.input_files.push({ path: absentPath, sha256: null })
  const sourceSha = await f.json(f.sourcePath, source)
  const receipt = await readFixture<Record<string, unknown>>(f.receipt)
  await f.json(f.receipt, { ...receipt, render_source_sha256: sourceSha })
  await expect(validateShortDramaDelivery([f.video], signal)).resolves.toBeUndefined()
  await mkdir(absentPath)
  await expect(validateShortDramaDelivery([f.video], signal)).rejects.toThrow('short_drama_delivery_changed')
})

async function formalHost(f: Awaited<ReturnType<typeof fixture>>) {
  const ctx = new Context(); cleanups.push(() => ctx.fiber.dispose())
  ctx.baseUrl = pathToFileURL(f.root).href + '/'
  await ctx.plugin(Loader); await ctx.plugin(SystemPrompt); await ctx.plugin(Tools); await ctx.plugin(AgentRegistry)
  await ctx.plugin(NativeToolExecutor)
  ctx.loader.builtins.include = Include
  await ctx.plugin(LocalFileSystem, { cwd: f.root }); await ctx.plugin(SessionProjections)
  await ctx.plugin(WorkingDirectory, { defaultDirectory: f.root })
  await ctx.plugin(Present, { maxFiles: 2 })
  ctx.loader.builtins['test-editing-policy'] = EditingPolicy
  const config = join(f.root, 'cordis.yml')
  await writeFile(config, '- name: cordis:test-editing-policy\n')
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(config).href } })
  await ctx.loader.await()
  const policy = [...ctx.loader.entries()].find(entry => entry.options.name === 'cordis:test-editing-policy')?.fiber
  if (policy === undefined) throw Error('Loader did not activate the shipped editing policy')
  const id = SessionId(`episode-delivery-${++serial}`)
  const session = Session.create(id, [], { version: SESSION_FORMAT_VERSION, id, createdAt: 0, cwd: f.root, isSeeded: false })
  const models = await ctx.sessionProjections.register(modelSelectionProjectionDefinition)
  let scope: Scope
  const owner: Agent = { id, options: {}, session, inbox: unsupportedInbox(), status: 'idle',
    model: new AgentModel(() => models.stateOf(session), session, {}),
    get ctx() { return scope.ctx }, send() {}, followup() {}, inject() {}, cancel() {}, whenIdle: () => Promise.resolve(),
    steer: () => ({ outcome: Promise.resolve({ status: 'rejected' as const }) }),
    runMaintenance: task => task(signal) }
  await ctx.plugin(Object.assign((inner: Context) => { scope = createScope(inner, owner) }, { inject: ['tools'] }))
  await ctx.agents.register(owner); session.append('turn/start', { turn: 1 })
  const sent: string[] = []
  for (const name of ['send_file', 'dsh_im_return_file']) ctx.tools.register(defineTool({ name, description: name,
    parameters: { path: { type: 'string', required: true } }, output: { schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }] }, execute: async (args) => { sent.push(args.path); return 'queued' } }))
  const execute = (name: string, path: string) => executeModelToolFixture(ctx, { name, callId: ToolCallId(`delivery-${++serial}`),
    arguments: name === 'present' ? { files: [{ path }] } : { path }, agent: owner, signal })
  return { ctx, owner, execute, sent, policy }
}

it('uses the Loader-owned policy before present events or either attachment executor, including relative paths', async () => {
  const f = await fixture(), h = await formalHost(f)
  expect((await h.execute('present', relative(f.root, f.video))).isError).toBe(false)
  expect(h.owner.session.snapshotEvents().filter(event => event.type === 'deliverables/presented')).toHaveLength(1)
  await writeFile(f.subtitle, 'changed text after stage')
  for (const name of ['present', 'send_file', 'dsh_im_return_file']) {
    const result = await h.execute(name, relative(f.root, f.video))
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result)).toContain('short_drama_delivery_changed')
  }
  expect(h.sent).toEqual([])
  expect(h.owner.session.snapshotEvents().filter(event => event.type === 'deliverables/presented')).toHaveLength(1)
})

it('requires staging for episode upload folders alongside a bound production root without blocking previews', async () => {
  const f = await fixture(), h = await formalHost(f)
  const upload = join(f.root, '视频', '第46集', '00-交付上传', '46.mp4')
  const nestedUpload = join(f.project, '视频', '第46集', '00-交付上传', '46.mp4')
  const preview = join(f.root, '视频', '第46集', '01-修复候选', '46.mp4')
  const source = join(f.project, 'video', '46', 'shot_001.mp4')
  for (const path of [upload, nestedUpload, preview, source]) {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, 'manual video')
  }
  for (const name of ['present', 'send_file', 'dsh_im_return_file']) {
    const result = await h.execute(name, relative(f.root, upload))
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result)).toContain('short_drama_delivery_unstaged')
  }
  expect((await h.execute('present', relative(f.root, nestedUpload))).isError).toBe(true)
  expect((await h.execute('present', relative(f.root, preview))).isError).toBe(false)
  expect((await h.execute('present', relative(f.root, source))).isError).toBe(false)
  expect(h.sent).toEqual([])
})

it('does not treat an unrelated upload folder as a bound short-drama delivery', async () => {
  const f = await fixture(), h = await formalHost(f)
  const unrelated = join(f.root, 'other', '视频', '第46集', '00-交付上传', '46.mp4')
  await mkdir(dirname(unrelated), { recursive: true })
  await writeFile(unrelated, 'unrelated video')
  expect((await h.execute('present', relative(f.root, unrelated))).isError).toBe(false)
})

it('accepts only a byte-identical upload copy of the same currently staged episode', async () => {
  const f = await fixture(), h = await formalHost(f)
  const sibling = join(f.root, '视频', '第41集', '00-交付上传', '41.mp4')
  const local = join(f.episode, '00-交付上传', '41.mp4')
  for (const path of [sibling, local]) {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, await readFile(f.video))
    expect((await h.execute('present', relative(f.root, path))).isError).toBe(false)
  }
  for (const name of ['send_file', 'dsh_im_return_file']) {
    expect((await h.execute(name, relative(f.root, sibling))).isError).toBe(false)
  }
  await writeFile(sibling, 'altered upload copy')
  expect(JSON.stringify(await h.execute('present', relative(f.root, sibling)))).toContain('short_drama_delivery_changed')
  await writeFile(sibling, await readFile(f.video))
  await writeFile(f.subtitle, 'modified after stage')
  expect(JSON.stringify(await h.execute('present', relative(f.root, sibling)))).toContain('short_drama_delivery_changed')
})

it('accepts a copy next to its own nonstandard staged episode but does not guess a sibling upload location', async () => {
  const f = await fixture('其他位置'), h = await formalHost(f)
  const local = join(f.episode, '00-交付上传', '41.mp4')
  const sibling = join(f.root, '视频', '第41集', '00-交付上传', '41.mp4')
  for (const path of [local, sibling]) {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, await readFile(f.video))
  }
  expect((await h.execute('present', relative(f.root, f.video))).isError).toBe(false)
  expect((await h.execute('present', relative(f.root, local))).isError).toBe(false)
  expect(JSON.stringify(await h.execute('present', relative(f.root, sibling)))).toContain('short_drama_delivery_unstaged')
})

it('registers relative native output paths from the actual episode report and Session cwd', async () => {
  const f = await fixture(), h = await formalHost(f), output = join(f.root, 'manual-native.mp4')
  await writeFile(output, 'current-native-output')
  h.ctx.tools.register(defineTool({ name: 'drama_render', description: 'offline native report fixture',
    parameters: { project: { type: 'string', required: true }, method: { type: 'string', required: true } },
    output: { schema: { type: 'object', additionalProperties: true }, render: () => [{ type: 'text', text: 'native result' }] },
    execute: async () => ({ ok: true, project: relative(f.root, f.project), output: relative(f.project, output) }) }))
  const rendered = await executeModelToolFixture(h.ctx, { name: 'drama_render', callId: ToolCallId(`register-${++serial}`),
    arguments: { method: 'render', project: relative(f.root, f.project) }, agent: h.owner, signal })
  expect(rendered.isError).toBe(false)
  const delivery = await h.execute('present', relative(f.root, output))
  expect(delivery.isError).toBe(true)
  expect(JSON.stringify(delivery)).toContain('short_drama_delivery_unstaged')
})

it.skipIf(process.platform !== 'win32')('accepts Windows path case variations of the same staged candidate', async () => {
  const f = await fixture()
  await expect(validateShortDramaDelivery([f.video.toUpperCase()], signal)).resolves.toBeUndefined()
})

it('reproduces direct export bypass without the policy and removes its listeners on dispose', async () => {
  const f = await fixture(), h = await formalHost(f)
  await h.policy.dispose()
  expect((await h.execute('present', f.working)).isError).toBe(false)
  expect((await h.execute('dsh_im_return_file', f.working)).isError).toBe(false)
  expect(h.sent).toEqual([f.working])
})
