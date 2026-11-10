/** Formal episode deliveries cannot bypass the current render/draft artifact binding. */
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'
import { turnBoundaryProjectionDefinition } from '@deepseek-ai/dsh-agent-loop'
import { createScope, type Scope } from '@deepseek-ai/dsh-scope'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools, { defineTool } from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import * as Present from '@deepseek-ai/dsh-tool-present'
import * as EditingPolicy from '../src/editing-policy.ts'
import { validateShortDramaDelivery } from '../src/short-drama-delivery.ts'
import { verifyEpisodeContentReview, type ContentReviewVerifier } from '@deepseek-ai/dsh-tool-episode-render'
import { contentReviewFixture } from '../../../packages/drama/tool-episode-render/tests/content-review-fixture.ts'
import { draftFontFixture } from '../../../packages/drama/tool-episode-render/tests/draft-font-fixture.ts'
import { installReviewState } from '../../../packages/perception/tool-video-inspect/src/review-state.ts'
import { installSourceQaState } from '../../../packages/perception/tool-video-inspect/src/source-qa-state.ts'

const cleanups: Array<() => Promise<unknown>> = []
const signal = new AbortController().signal
const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex')
// Pure file-binding cases substitute the independent observation verifier; Loader cases use the real Host.
const verifiedContent: ContentReviewVerifier = async () => {}
const fileFailure = vi.hoisted(() => ({ path: undefined as string | undefined,
  rewriteBeforeRead: undefined as string | undefined, invalidStream: undefined as string | undefined,
  stringStream: undefined as string | undefined, readPaths: [] as string[] }))
vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  return { ...actual, lstat: async (...args: Parameters<typeof actual.lstat>) => {
    if (args[0] === fileFailure.path) throw Object.assign(new Error('permission denied for test input'), { code: 'EACCES' })
    return await actual.lstat(...args)
  }, readFile: async (...args: Parameters<typeof actual.readFile>) => {
    if (args[0] === fileFailure.rewriteBeforeRead) {
      fileFailure.rewriteBeforeRead = undefined
      await actual.appendFile(args[0], ' ')
    }
    return await actual.readFile(...args)
  } }
})
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
  const { Readable } = await import('node:stream')
  return { ...actual, createReadStream: (...args: Parameters<typeof actual.createReadStream>) => {
    fileFailure.readPaths.push(String(args[0]))
    if (args[0] === fileFailure.invalidStream) return Readable.from([{ invalidChunk: true }])
    if (args[0] === fileFailure.stringStream) return Readable.from([actual.readFileSync(args[0], 'utf8')])
    return actual.createReadStream(...args)
  } }
})
let serial = 0
afterEach(async () => {
  fileFailure.readPaths.length = 0
  vi.unstubAllEnvs()
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

interface FixtureSource {
  delivery_inputs: {
    timeline_sha256: string
    videos: Array<{ shot: number; sha256: string }>
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
interface FixtureLayout {
  delivery_size: { width: number; height: number }
  entries: Array<{ selected_fonts: string[]; fontselect_trace: string[] }>
}
interface FixtureTimeline { delivery: { width: number; height: number; fps: number } }
interface FixtureDraft { timeline_sha256: string; materials: Array<{ path: string; sha256: string }> }
const readFixture = async <T>(path: string): Promise<T> => JSON.parse(await readFile(path, 'utf8')) as T

async function fixture(videoCount = 1) {
  const root = await mkdtemp(join(tmpdir(), 'muse-short-drama-delivery-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const project = join(root, 'short-drama'), episode = join(project, '视频', '第41集')
  const video = join(episode, '01_可交付视频', '第41集.mp4'), working = join(project, 'exports', '41.mp4')
  const draft = join(episode, '02_剪映草稿', '第41集')
  const timeline = join(project, 'editing', '41-timeline.json'), subtitle = join(project, 'editing', '41.srt')
  const master = join(project, 'audio', '41.wav'), sourceVideo = join(project, 'video', '41', 'shot_001.mp4')
  for (const file of [video, working, join(draft, 'draft_content.json'), timeline, master, sourceVideo]) await mkdir(dirname(file), { recursive: true })
  const json = async (path: string, value: unknown) => { await writeFile(path, JSON.stringify(value)); return sha(await readFile(path)) }
  await json(join(project, 'project_config.json'), { jubian_script_id: 5933 })
  await writeFile(video, 'candidate-video'); await writeFile(working, 'candidate-video')
  const sourceVideos = Array.from({ length: videoCount }, (_, index) => join(project, 'video', '41', `shot_${String(index + 1).padStart(3, '0')}.mp4`))
  await Promise.all(sourceVideos.map((file, index) => writeFile(file, index === 0 ? 'current-source' : `current-source-${index + 1}`)))
  await writeFile(master, 'current-voice')
  await json(timeline, { delivery: { width: 480, height: 854, fps: 24 },
    clips: sourceVideos.map((_, index) => ({ shot: index + 1, start_us: index * 2000000 / videoCount,
      duration_us: 2000000 / videoCount })) })
  await writeFile(subtitle, '1\n00:00:00,000 --> 00:00:01,000\n现在回去\n')
  const paths = [timeline, subtitle, master, ...sourceVideos]
  const inputs = await Promise.all(paths.map(async path => ({ path, sha256: sha(await readFile(path)) })))
  const selected = sourceVideos.map((_, index) => ({ shot: index + 1, sha256: inputs[index + 3]!.sha256 }))
  const layout = join(project, 'editing', '41-layout.json'), font = 'Zhuque Fangsong (technical preview)'
  const layoutSha = await json(layout, { schema_version: 1, status: 'measured', requested_font: font, delivery_size: { width: 480, height: 854 }, entries: [
    { status: 'measured', fits_available_width: true, selected_fonts: ['ZhuqueFangsong-Regular'],
      fontselect_trace: ['fontselect: (Zhuque Fangsong (technical preview), 400, 0) -> /fonts/ZhuqueFangsong-Regular.ttf, 0, ZhuqueFangsong-Regular'] }] })
  const sourceQa = sha('fixture-source-qa-summary')
  const sourcePath = `${working}.source-record.json`
  const renderSha = await json(sourcePath, { version: 1, episode: '41', output: { path: working, sha256: sha('candidate-video'), duration_seconds: 2 },
    delivery_inputs: { timeline_sha256: inputs[0]!.sha256, subtitle_sha256: inputs[1]!.sha256,
      master_audio_sha256: inputs[2]!.sha256, videos: selected, source_qa_sha256: sourceQa,
      subtitle_visual_verification: { version: 1, subtitle_sha256: inputs[1]!.sha256, report_path: layout, report_sha256: layoutSha,
        delivery: { width: 480, height: 854, fps: 24 }, visual: { schema_version: 1, reference_width: 480, reference_height: 854,
          font_size_px: 46, outline_px: 1.25, center_y_ratio: 0.736747073, max_width_ratio: 0.9, font_family: font },
        requested_font: font, checks: ['subtitle_display_text', 'subtitle_display_width', 'subtitle_display_font'].map(id => ({ id, ok: true })) } },
    input_files: [...inputs, { path: layout, sha256: layoutSha }], inputs: [...inputs.map(row => row.sha256), layoutSha, sourceQa] })
  const native = ['draft_content.json', 'draft_meta_info.json']
  for (const name of native) await json(join(draft, name), { tracks: [], marker: name })
  const draftFont = await draftFontFixture(root, draft)
  vi.stubEnv('MUSE_FONTS_DIR', draftFont.input.fontsDir)
  const fontSnapshot = join(draft, 'muse-original-draft-content.json')
  await writeFile(fontSnapshot, await readFile(draftFont.contentPath))
  const draftSource = join(draft, 'muse-episode-source.json')
  const draftSha = await json(draftSource, { version: 1, episode: '41', audio_mode: 'independent',
    timeline_sha256: inputs[0]!.sha256, subtitle_sha256: inputs[1]!.sha256, master_audio_sha256: inputs[2]!.sha256,
    videos: selected, subtitle_font: draftFont.source.subtitle_font,
    files: [...await Promise.all(native.map(async path => ({ path, sha256: sha(await readFile(join(draft, path))) }))),
      draftFont.source.files[0]], materials: [...inputs, ...draftFont.source.materials] })
  const receipt = join(episode, '成片与草稿回执.json')
  const review = await contentReviewFixture({ project, episode: '41', output: working, duration: 2,
    sources: sourceVideos.map((path, index) => ({ shot: index + 1, path, duration: 2 / videoCount })) })
  if (videoCount > 1) {
    const observed = await readFixture<{ frames: Array<{ id: string; decoded_time: number }> }>(
      review.entry.content_review.output.inspection.path)
    observed.frames.push({ id: 'join-before', decoded_time: 0.9 }, { id: 'join-after', decoded_time: 1.1 })
    observed.frames.sort((left: { decoded_time: number }, right: { decoded_time: number }) => left.decoded_time - right.decoded_time)
    review.entry.content_review.output.inspection.sha256 = await json(review.entry.content_review.output.inspection.path, observed)
    for (const check of review.entry.content_review.output.checks) check.frame_ids.push('join-before', 'join-after')
    await json(review.path, review.document)
  }
  const content = await verifyEpisodeContentReview({ project, episode: '41', output: working,
    outputSha256: sha('candidate-video'), duration: 2,
    sources: selected.map(row => ({ ...row, duration: 2 / videoCount })), cuts: videoCount > 1 ? [1] : [], verifier: verifiedContent })
  await json(receipt, { version: 1, status: 'candidate', episode: '41', video, draft, sha256: sha('candidate-video'),
    working_output: working, render_source_sha256: renderSha, draft_source_sha256: draftSha,
    draft_font: { snapshot_path: fontSnapshot, snapshot_sha256: sha(await readFile(fontSnapshot)) },
    content_review: content, wholeEpisodeContentAccepted: false })
  return { root, project, episode, video, working, draft, timeline, subtitle, master, sourceVideo,
    receipt, sourcePath, draftSource, layout, json, review, font: draftFont, fontSnapshot }
}

it('keeps a matching same-episode artifact chain at candidate status', async () => {
  const f = await fixture()
  await expect(validateShortDramaDelivery([f.video], signal, undefined, verifiedContent)).resolves.toBeUndefined()
  expect(JSON.parse(await readFile(f.receipt, 'utf8'))).toMatchObject({ status: 'candidate', wholeEpisodeContentAccepted: false })
})

it('rechecks both sources and the internal join in a multi-clip episode', async () => {
  const f = await fixture(2)
  await expect(validateShortDramaDelivery([f.video], signal, undefined, verifiedContent)).resolves.toBeUndefined()
})

it.each(['count', 'order'] as const)('rejects %s disagreement between the selected sources and timeline', async (kind) => {
  const f = await fixture(2), source = await readFixture<FixtureSource>(f.sourcePath)
  if (kind === 'count') source.delivery_inputs.videos.pop()
  else source.delivery_inputs.videos.reverse()
  const receipt = await readFixture<Record<string, unknown>>(f.receipt)
  await f.json(f.receipt, { ...receipt, render_source_sha256: await f.json(f.sourcePath, source) })
  await expect(validateShortDramaDelivery([f.video], signal, undefined, verifiedContent)).rejects.toThrow('镜头数量或顺序')
})

it('requires the original timeline input in addition to its digest', async () => {
  const f = await fixture(), source = await readFixture<FixtureSource>(f.sourcePath)
  source.input_files = source.input_files.filter(file => file.path !== f.timeline)
  const receipt = await readFixture<Record<string, unknown>>(f.receipt)
  await f.json(f.receipt, { ...receipt, render_source_sha256: await f.json(f.sourcePath, source) })
  await expect(validateShortDramaDelivery([f.video], signal, undefined, verifiedContent)).rejects.toThrow('缺少已绑定的实际时间线')
})

it('rejects an unpaired episode and a missing stage receipt', async () => {
  const f = await fixture(), receipt = await readFixture<Record<string, unknown>>(f.receipt)
  await f.json(f.receipt, { ...receipt, episode: '42' })
  await expect(validateShortDramaDelivery([f.video], signal, undefined, verifiedContent)).rejects.toThrow('回执不属于本集')
  await rm(f.receipt)
  await expect(validateShortDramaDelivery([f.video], signal, undefined, verifiedContent)).rejects.toThrow('缺少成片与草稿回执')
})

it.each(['episode', 'output-path', 'output-hash'] as const)(
  'rejects a mismatched render record %s before content review', async (kind) => {
    const f = await fixture(), source = await readFixture<{ episode: string; output: { path: string; sha256: string } }>(f.sourcePath)
    if (kind === 'episode') source.episode = '42'
    else if (kind === 'output-path') source.output.path = join(f.project, 'other.mp4')
    else source.output.sha256 = sha('different-output')
    const receipt = await readFixture<Record<string, unknown>>(f.receipt)
    await f.json(f.receipt, { ...receipt, render_source_sha256: await f.json(f.sourcePath, source) })
    await expect(validateShortDramaDelivery([f.video], signal, undefined, verifiedContent))
      .rejects.toThrow('成片与本集渲染回执不符')
  })

it('rejects a directory substituted for a recorded media file', async () => {
  const f = await fixture()
  await rm(f.video); await mkdir(f.video)
  await expect(validateShortDramaDelivery([f.video], signal, undefined, verifiedContent)).rejects.toThrow('需要本地普通文件')
})

it('honors operation cancellation before reading delivery evidence', async () => {
  const f = await fixture(), cancelled = new AbortController()
  cancelled.abort(new Error('cancelled delivery'))
  await expect(validateShortDramaDelivery([f.video], cancelled.signal, undefined, verifiedContent)).rejects.toThrow('cancelled delivery')
})

it('compares unchanged exact-case paths under either supported path comparison policy', async () => {
  const f = await fixture(), alternate = Object.create(process) as NodeJS.Process
  Object.defineProperty(alternate, 'platform', { value: process.platform === 'win32' ? 'linux' : 'win32' })
  vi.stubGlobal('process', alternate)
  try { await expect(validateShortDramaDelivery([f.video], signal, undefined, verifiedContent)).resolves.toBeUndefined() }
  finally { vi.unstubAllGlobals() }
})

it('hashes string file chunks and rejects non-byte filesystem stream values', async () => {
  const f = await fixture()
  fileFailure.stringStream = f.video
  try { await expect(validateShortDramaDelivery([f.video], signal, undefined, verifiedContent)).resolves.toBeUndefined() }
  finally { fileFailure.stringStream = undefined }
  fileFailure.invalidStream = f.video
  try { await expect(validateShortDramaDelivery([f.video], signal, undefined, verifiedContent)).rejects.toThrow('未知字节类型') }
  finally { fileFailure.invalidStream = undefined }
})

it('rejects a receipt replaced between its digest and JSON read', async () => {
  const f = await fixture()
  fileFailure.rewriteBeforeRead = f.receipt
  try { await expect(validateShortDramaDelivery([f.video], signal, undefined, verifiedContent)).rejects.toThrow('读取期间交付证据已变化') }
  finally { fileFailure.rewriteBeforeRead = undefined }
})

it.each(['receipt', 'optional-input'] as const)('propagates a filesystem error reading the %s instead of treating it as absent', async (kind) => {
  const f = await fixture(), blocked = kind === 'receipt' ? f.receipt : join(f.project, 'unselected-overlay.json')
  if (kind === 'optional-input') {
    const source = await readFixture<FixtureSource>(f.sourcePath)
    source.input_files.push({ path: blocked, sha256: null })
    const receipt = await readFixture<Record<string, unknown>>(f.receipt)
    await f.json(f.receipt, { ...receipt, render_source_sha256: await f.json(f.sourcePath, source) })
  }
  fileFailure.path = blocked
  try {
    await expect(validateShortDramaDelivery([f.video], signal, new Map([[f.video, f.project]]), verifiedContent))
      .rejects.toThrow('permission denied for test input')
  } finally { fileFailure.path = undefined }
})

it('rejects a draft directory that resolves outside the project', async () => {
  const f = await fixture(), outside = join(f.root, 'external-draft')
  await rename(f.draft, outside)
  await symlink(outside, f.draft, process.platform === 'win32' ? 'junction' : 'dir')
  await expect(validateShortDramaDelivery([f.video], signal, undefined, verifiedContent)).rejects.toThrow('交付文件或草稿不在本集项目内')
})

it.each(['receipt', 'sourcePath'] as const)('detects %s changing while content evidence is independently verified', async (field) => {
  const f = await fixture()
  const concurrent: ContentReviewVerifier = async (binding) => {
    if (binding.kind === 'listening') await writeFile(f[field], `${await readFile(f[field], 'utf8')} `)
  }
  await expect(validateShortDramaDelivery([f.video], signal, undefined, concurrent)).rejects.toThrow('核对期间交付回执已变化')
})

it.each(['video', 'working', 'sourceVideo', 'master', 'subtitle'] as const)(
  'rejects %s replaced while waiting for content verification', async (field) => {
    const f = await fixture()
    const concurrent: ContentReviewVerifier = async (binding) => {
      if (binding.kind === 'listening') await writeFile(f[field], `replaced-during-review-${field}`)
    }
    await expect(validateShortDramaDelivery([f.video], signal, undefined, concurrent))
      .rejects.toThrow(/short_drama_delivery_changed|CONTENT_REVIEW_PENDING/u)
  })

it('checks shared render and draft media once, after content verification', async () => {
  const f = await fixture()
  fileFailure.readPaths.length = 0
  const concurrent: ContentReviewVerifier = async (binding) => {
    if (binding.kind === 'listening') {
      expect(fileFailure.readPaths.filter(path => path === f.master)).toHaveLength(0)
      expect(fileFailure.readPaths.filter(path => path === f.video)).toHaveLength(0)
    }
  }
  await expect(validateShortDramaDelivery([f.video], signal, undefined, concurrent)).resolves.toBeUndefined()
  expect(fileFailure.readPaths.filter(path => path === f.master)).toHaveLength(1)
  expect(fileFailure.readPaths.filter(path => path === f.video)).toHaveLength(1)
})

it('rejects conflicting hashes for the same retained input rather than choosing one', async () => {
  const f = await fixture(), source = await readFixture<FixtureSource>(f.sourcePath)
  source.input_files.push({ path: f.master, sha256: sha('conflicting-media') })
  const receipt = await readFixture<Record<string, unknown>>(f.receipt)
  await f.json(f.receipt, { ...receipt, render_source_sha256: await f.json(f.sourcePath, source) })
  await expect(validateShortDramaDelivery([f.video], signal, undefined, verifiedContent))
    .rejects.toThrow('同一文件的交付摘要不一致')
})

it('rejects an optional absent input created during content verification', async () => {
  const f = await fixture(), optional = join(f.project, 'new-overlay.json')
  const source = await readFixture<FixtureSource>(f.sourcePath)
  source.input_files.push({ path: optional, sha256: null })
  const receipt = await readFixture<Record<string, unknown>>(f.receipt)
  await f.json(f.receipt, { ...receipt, render_source_sha256: await f.json(f.sourcePath, source) })
  const concurrent: ContentReviewVerifier = async (binding) => {
    if (binding.kind === 'listening') await writeFile(optional, '{}')
  }
  await expect(validateShortDramaDelivery([f.video], signal, undefined, concurrent))
    .rejects.toThrow('short_drama_delivery_changed')
})

it('requires actual content verification even when the receipt and all review fields claim success', async () => {
  const f = await fixture()
  await expect(validateShortDramaDelivery([f.video], signal)).rejects.toThrow('真实观察和试听')
})

it('rejects stale content evidence and rebound unresolved content', async () => {
  const f = await fixture()
  f.review.entry.content_review.output.checks[0]!.status = 'unverified'
  await f.review.json(f.review.path, f.review.document)
  await expect(validateShortDramaDelivery([f.video], signal, undefined, verifiedContent))
    .rejects.toThrow('交付证据已变化')
  const receipt = await readFixture<{ content_review: { sha256: string } }>(f.receipt)
  receipt.content_review.sha256 = sha(await readFile(f.review.path))
  await f.json(f.receipt, receipt)
  await expect(validateShortDramaDelivery([f.video], signal, undefined, verifiedContent))
    .rejects.toThrow('仍有问题或未核实')
})

it('rejects content evidence outside this project or a changed bound observation list', async () => {
  const f = await fixture()
  const receipt = await readFixture<{ content_review: { path: string; files: unknown[] } }>(f.receipt)
  const original = receipt.content_review.path
  receipt.content_review.path = join(f.root, 'other-project-review.json')
  await f.json(f.receipt, receipt)
  await expect(validateShortDramaDelivery([f.video], signal, undefined, verifiedContent))
    .rejects.toThrow('内容审查越出当前项目')
  receipt.content_review.path = original
  receipt.content_review.files = []
  await f.json(f.receipt, receipt)
  await expect(validateShortDramaDelivery([f.video], signal, undefined, verifiedContent)).rejects.toThrow()
  receipt.content_review.files = [{ path: original, sha256: sha('another review') }]
  await f.json(f.receipt, receipt)
  await expect(validateShortDramaDelivery([f.video], signal, undefined, verifiedContent))
    .rejects.toThrow('与归档时不同')
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
  await expect(validateShortDramaDelivery([f.video], signal, undefined, verifiedContent)).rejects.toThrow('short_drama_delivery_evidence')
})

it.each(['subtitle', 'timeline', 'sourceVideo', 'master', 'video', 'working'] as const)('rejects changed %s after prior staging', async (field) => {
  const f = await fixture()
  await writeFile(f[field], `replaced-${field}`)
  await expect(validateShortDramaDelivery([f.video], signal, undefined, verifiedContent))
    .rejects.toThrow(/short_drama_delivery_changed|CONTENT_REVIEW_PENDING/u)
})

it('allows subsequent editor changes without recertifying the current draft, while rejecting changed pairing evidence', async () => {
  const f = await fixture()
  await writeFile(join(f.draft, 'draft_content.json'), '{"changed":true}')
  await writeFile(join(f.draft, 'draft_meta_info.json'), '{"savedByEditor":true}')
  await expect(validateShortDramaDelivery([f.video], signal, undefined, verifiedContent)).resolves.toEqual([
    { episode: '41', draft: f.draft, status: 'modified_unverified' },
  ])
  await writeFile(f.draftSource, '{"changedPairing":true}')
  await expect(validateShortDramaDelivery([f.video], signal, undefined, verifiedContent)).rejects.toThrow('交付证据已变化')
  await writeFile(f.sourcePath, '{}')
  await expect(validateShortDramaDelivery([f.video], signal, undefined, verifiedContent)).rejects.toThrow('交付证据已变化')
})

it.each(['missing snapshot', 'wrong snapshot path', 'snapshot hash', 'missing font proof', 'missing subtitle input'] as const)(
  'rejects handwritten receipt bypass: %s', async (kind) => {
    const f = await fixture()
    const receipt = await readFixture<Record<string, unknown>>(f.receipt)
    if (kind === 'missing snapshot') delete receipt['draft_font']
    if (kind === 'wrong snapshot path') receipt['draft_font'] = { snapshot_path: f.font.contentPath,
      snapshot_sha256: sha(await readFile(f.fontSnapshot)) }
    if (kind === 'snapshot hash') receipt['draft_font'] = { snapshot_path: f.fontSnapshot, snapshot_sha256: sha('different') }
    if (kind === 'missing font proof') {
      const source = await readFixture<Record<string, unknown>>(f.draftSource)
      delete source['subtitle_font']
      receipt['draft_source_sha256'] = await f.json(f.draftSource, source)
    }
    if (kind === 'missing subtitle input') {
      const source = await readFixture<FixtureSource>(f.sourcePath)
      const row = source.input_files.find(input => input.path === f.subtitle)
      if (row === undefined) throw Error('Fixture subtitle input missing')
      row.path = join(f.project, 'same-subtitle.bin')
      receipt['render_source_sha256'] = await f.json(f.sourcePath, source)
    }
    await f.json(f.receipt, receipt)
    await expect(validateShortDramaDelivery([f.video], signal, undefined, verifiedContent)).rejects.toThrow()
  })

it.each(['font', 'licence', 'manifest', 'snapshot'] as const)('rejects changed initial %s proof despite an unchanged final MP4', async (kind) => {
  const f = await fixture()
  const path = kind === 'font' ? f.font.fontPath : kind === 'licence' ? f.font.font.license_path
    : kind === 'manifest' ? f.font.manifestPath : f.fontSnapshot
  await writeFile(path, '{}')
  await expect(validateShortDramaDelivery([f.video], signal, undefined, verifiedContent)).rejects.toThrow()
})

it('does not accept a rebound initial snapshot containing only the system font', async () => {
  const f = await fixture(), snapshot = await readFixture<typeof f.font.content>(f.fontSnapshot)
  snapshot.materials.texts[0]!.content = JSON.stringify({ styles: [{ font: { id: 'system-font', path: '' } }] })
  const snapshotSha = await f.json(f.fontSnapshot, snapshot)
  const draft = await readFixture<{ files: { path: string; sha256: string }[] }>(f.draftSource)
  draft.files.find(row => row.path === 'draft_content.json')!.sha256 = snapshotSha
  const receipt = await readFixture<Record<string, unknown>>(f.receipt)
  receipt['draft_source_sha256'] = await f.json(f.draftSource, draft)
  receipt['draft_font'] = { snapshot_path: f.fontSnapshot, snapshot_sha256: snapshotSha }
  await f.json(f.receipt, receipt)
  await expect(validateShortDramaDelivery([f.video], signal, undefined, verifiedContent)).rejects.toThrow()
})

it('requires managed font resources for a portrait delivery and reports a missing current draft as unverified', async () => {
  const f = await fixture()
  vi.stubEnv('MUSE_FONTS_DIR', undefined)
  await expect(validateShortDramaDelivery([f.video], signal, undefined, verifiedContent)).rejects.toThrow('随包字体目录')
  vi.stubEnv('MUSE_FONTS_DIR', f.font.input.fontsDir)
  await rm(f.font.contentPath)
  await expect(validateShortDramaDelivery([f.video], signal, undefined, verifiedContent)).resolves.toEqual([
    { episode: '41', draft: f.draft, status: 'modified_unverified' },
  ])
})

it('requires regular bounded font proof files', async () => {
  const f = await fixture()
  await rm(f.font.fontPath)
  await mkdir(f.font.fontPath)
  await expect(validateShortDramaDelivery([f.video], signal, undefined, verifiedContent)).rejects.toThrow('本地普通文件')
})

it.each(['episode', 'native-record', 'material-scope'] as const)('rejects altered draft %s even when its updated digest is supplied', async (kind) => {
  const f = await fixture()
  const draft = await readFixture<{
    episode: string
    files: { path: string; sha256: string }[]
    materials: { path: string; sha256: string }[]
  }>(f.draftSource)
  if (kind === 'episode') draft.episode = '42'
  else if (kind === 'native-record') draft.files[0]!.path = 'other.json'
  else {
    const other = join(f.root, 'outside-material.mp4'); await writeFile(other, 'outside')
    draft.materials.push({ path: other, sha256: sha('outside') })
  }
  const receipt = await readFixture<Record<string, unknown>>(f.receipt)
  await f.json(f.receipt, { ...receipt, draft_source_sha256: await f.json(f.draftSource, draft) })
  await expect(validateShortDramaDelivery([f.video], signal, undefined, verifiedContent))
    .rejects.toThrow(kind === 'episode' ? '草稿与成片未使用同集' : kind === 'native-record' ? '草稿缺少原生文件' : '草稿引用素材')
})

it('rejects handwritten FFmpeg outputs in formal export locations but leaves source media and ordinary file tasks alone', async () => {
  const f = await fixture()
  const manual = join(f.project, 'exports', 'manual.mp4')
  await writeFile(manual, 'agent-ffmpeg-output')
  await expect(validateShortDramaDelivery([manual], signal, undefined, verifiedContent)).rejects.toThrow('short_drama_delivery_unstaged')
  const generic = join(f.root, 'exports', 'ordinary.mp4')
  await mkdir(dirname(generic), { recursive: true }); await writeFile(generic, 'ordinary-video')
  await expect(validateShortDramaDelivery([generic, f.sourceVideo, join(f.project, 'exports', 'notes.txt')], signal, undefined, verifiedContent)).resolves.toBeUndefined()
  await writeFile(join(f.root, 'project_config.json'), 'Unrelated damaged metadata is not a short-drama marker')
  await expect(validateShortDramaDelivery([generic], signal, undefined, verifiedContent)).resolves.toBeUndefined()
})

it('scopes registered native outputs without applying episode rules to arbitrary videos elsewhere', async () => {
  const f = await fixture(), output = join(f.root, 'current-native-output.mp4')
  await writeFile(output, 'native-output')
  await expect(validateShortDramaDelivery([output], signal, undefined, verifiedContent)).resolves.toBeUndefined()
  await expect(validateShortDramaDelivery([output], signal, new Map([[output, f.project]]), verifiedContent)).rejects.toThrow('short_drama_delivery_unstaged')
})

it.each(['source_qa_sha256', 'subtitle_visual_verification'] as const)('rejects a legacy candidate without %s', async (field) => {
  const f = await fixture(), source = await readFixture<FixtureSource>(f.sourcePath)
  if (field === 'source_qa_sha256') delete source.delivery_inputs.source_qa_sha256
  else delete source.delivery_inputs.subtitle_visual_verification
  const receipt = await readFixture<Record<string, unknown>>(f.receipt)
  await f.json(f.receipt, { ...receipt, render_source_sha256: await f.json(f.sourcePath, source) })
  await expect(validateShortDramaDelivery([f.video], signal, undefined, verifiedContent)).rejects.toThrow('short_drama_delivery_evidence')
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
  await expect(validateShortDramaDelivery([f.video], signal, undefined, verifiedContent)).rejects.toThrow('short_drama_delivery_font')
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
  await expect(validateShortDramaDelivery([f.video], signal, undefined, verifiedContent)).resolves.toBeUndefined()
})

it('rejects a claimed landscape timeline when its bound actual layout still describes portrait delivery', async () => {
  const f = await fixture()
  await changeCanvas(f, 1280, 720, true)
  await expect(validateShortDramaDelivery([f.video], signal, undefined, verifiedContent)).rejects.toThrow('实测画布')
})

it.each([['font_size_px', 90], ['center_y_ratio', 0.5], ['center_y_ratio', 0.64]] as const)('rejects changed portrait product %s despite passing flags', async (field, value) => {
  const f = await fixture(), source = await readFixture<FixtureSource>(f.sourcePath)
  source.delivery_inputs.subtitle_visual_verification!.visual[field] = value
  const receipt = await readFixture<Record<string, unknown>>(f.receipt)
  await f.json(f.receipt, { ...receipt, render_source_sha256: await f.json(f.sourcePath, source) })
  await expect(validateShortDramaDelivery([f.video], signal, undefined, verifiedContent)).rejects.toThrow('short_drama_delivery_evidence')
})

it('requires missing recorded inputs to remain absent even when replaced by a directory', async () => {
  const f = await fixture(), absentPath = join(f.project, 'unselected-overlay.json')
  const source = await readFixture<FixtureSource>(f.sourcePath)
  source.input_files.push({ path: absentPath, sha256: null })
  const sourceSha = await f.json(f.sourcePath, source)
  const receipt = await readFixture<Record<string, unknown>>(f.receipt)
  await f.json(f.receipt, { ...receipt, render_source_sha256: sourceSha })
  await expect(validateShortDramaDelivery([f.video], signal, undefined, verifiedContent)).resolves.toBeUndefined()
  await mkdir(absentPath)
  await expect(validateShortDramaDelivery([f.video], signal, undefined, verifiedContent)).rejects.toThrow('short_drama_delivery_changed')
})

it('requires every selected input digest to have a retained file record', async () => {
  const f = await fixture(), source = await readFixture<FixtureSource>(f.sourcePath)
  const audioSha = sha(await readFile(f.master))
  source.input_files = source.input_files.filter(value => value.sha256 !== audioSha)
  const receipt = await readFixture<Record<string, unknown>>(f.receipt)
  await f.json(f.receipt, { ...receipt, render_source_sha256: await f.json(f.sourcePath, source) })
  await expect(validateShortDramaDelivery([f.video], signal, undefined, verifiedContent)).rejects.toThrow('未完整绑定本集输入')
})

it('preserves measured landscape typography without enforcing the portrait face', async () => {
  const f = await fixture()
  await changeCanvas(f, 1280, 720, true)
  const layout = await readFixture<FixtureLayout>(f.layout)
  layout.delivery_size = { width: 1280, height: 720 }
  layout.entries[0]!.selected_fonts = ['A landscape font']
  layout.entries[0]!.fontselect_trace = ['fontselect: selected landscape face']
  const source = await readFixture<FixtureSource>(f.sourcePath), layoutSha = await f.json(f.layout, layout)
  source.delivery_inputs.subtitle_visual_verification!.report_sha256 = layoutSha
  source.input_files.find(row => row.path === f.layout)!.sha256 = layoutSha
  const receipt = await readFixture<Record<string, unknown>>(f.receipt)
  await f.json(f.receipt, { ...receipt, render_source_sha256: await f.json(f.sourcePath, source) })
  await expect(validateShortDramaDelivery([f.video], signal, undefined, verifiedContent)).resolves.toBeUndefined()
})

async function formalHost(f: Awaited<ReturnType<typeof fixture>>, evidenceServices = true) {
  const ctx = new Context(); cleanups.push(() => ctx.fiber.dispose())
  ctx.baseUrl = pathToFileURL(f.root).href + '/'
  await ctx.plugin(Loader); await ctx.plugin(SystemPrompt); await ctx.plugin(Tools); await ctx.plugin(AgentRegistry)
  ctx.loader.builtins.include = Include
  await ctx.plugin(LocalFileSystem, { cwd: f.root }); await ctx.plugin(SessionProjections)
  ctx.sessionProjections.register(turnBoundaryProjectionDefinition)
  if (evidenceServices) {
    await ctx.plugin(SandboxPolicy, { mode: 'danger-full-access', workspaceRoot: f.root })
    installReviewState(ctx)
    installSourceQaState(ctx)
  }
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
  let scope: Scope
  const owner: Agent = { id, options: {}, session, inbox: unsupportedInbox(), status: 'idle',
    get ctx() { return scope.ctx }, send() {}, followup() {}, inject() {}, cancel() {}, whenIdle: () => Promise.resolve(),
    steer: () => ({ outcome: Promise.resolve({ status: 'rejected' as const }) }),
    runMaintenance: task => task(signal) }
  await ctx.plugin(Object.assign((inner: Context) => { scope = createScope(inner, owner) }, { inject: ['tools'] }))
  await ctx.agents.register(owner); session.append('turn/start', { turn: 1 })
  const sent: string[] = []
  for (const name of ['send_file', 'dsh_im_return_file']) ctx.tools.register(defineTool({ name, description: name,
    parameters: { path: { type: 'string' } }, output: { schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }] }, execute: async (args) => {
      if (args.path === undefined) return 'no file selected'
      sent.push(args.path); return 'queued'
    } }))
  const execute = (name: string, path: string) => ctx.tools.execute({ name, callId: ToolCallId(`delivery-${++serial}`),
    arguments: name === 'present' ? { files: [{ path }] } : { path }, agent: owner, signal })
  return { ctx, owner, execute, sent, policy }
}

it('uses the real Loader policy to reject unobserved content before presentation and both attachment executors', async () => {
  const f = await fixture(), h = await formalHost(f)
  for (const name of ['present', 'send_file', 'dsh_im_return_file']) {
    const unobserved = await h.execute(name, relative(f.root, f.video))
    expect(unobserved.isError).toBe(true)
    expect(JSON.stringify(unobserved)).toContain('SOURCE_QA_SESSION')
  }
  expect(h.owner.session.snapshotEvents().filter(event => event.type === 'deliverables/presented')).toHaveLength(0)
  await writeFile(f.subtitle, 'changed text after stage')
  for (const name of ['present', 'send_file', 'dsh_im_return_file']) {
    const result = await h.execute(name, relative(f.root, f.video))
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result)).toContain('SOURCE_QA_SESSION')
  }
  expect(h.sent).toEqual([])
  expect(h.owner.session.snapshotEvents().filter(event => event.type === 'deliverables/presented')).toHaveLength(0)
})

it('refuses formal presentation when the Host lacks the observation verification service', async () => {
  const f = await fixture(), h = await formalHost(f, false)
  const result = await h.execute('present', relative(f.root, f.video))
  expect(result.isError).toBe(true)
  expect(JSON.stringify(result)).toContain('short_drama_delivery_content')
  expect(h.owner.session.snapshotEvents().filter(event => event.type === 'deliverables/presented')).toHaveLength(0)
})

it('preserves an attachment provider no-op with no selected file', async () => {
  const f = await fixture(), h = await formalHost(f)
  const result = await h.ctx.tools.execute({ name: 'send_file', callId: ToolCallId(`no-file-${++serial}`),
    arguments: {}, agent: h.owner, signal })
  expect(result.isError).toBe(false)
  expect(h.sent).toEqual([])
})

it('does not lend a user Session review to an agentless attachment operation', async () => {
  const f = await fixture(), h = await formalHost(f)
  const result = await h.ctx.tools.execute({ name: 'send_file', callId: ToolCallId(`agentless-send-${++serial}`),
    arguments: { path: f.video }, signal })
  expect(result.isError).toBe(true)
  expect(JSON.stringify(result)).toContain('SOURCE_QA_SESSION')
  expect(h.sent).toEqual([])
})

it('registers relative native output paths from the actual episode report and Session cwd', async () => {
  const f = await fixture(), h = await formalHost(f), output = join(f.root, 'manual-native.mp4')
  await writeFile(output, 'current-native-output')
  h.ctx.tools.register(defineTool({ name: 'drama_render', description: 'offline native report fixture',
    parameters: { project: { type: 'string', required: true }, method: { type: 'string', required: true } },
    output: { schema: { type: 'object', additionalProperties: true }, render: () => [{ type: 'text', text: 'native result' }] },
    execute: async () => ({ ok: true, project: relative(f.root, f.project), output: relative(f.project, output) }) }))
  const rendered = await h.ctx.tools.execute({ name: 'drama_render', callId: ToolCallId(`register-${++serial}`),
    arguments: { method: 'render', project: relative(f.root, f.project) }, agent: h.owner, signal })
  expect(rendered.isError).toBe(false)
  const delivery = await h.execute('present', relative(f.root, output))
  expect(delivery.isError).toBe(true)
  expect(JSON.stringify(delivery)).toContain('short_drama_delivery_unstaged')
})

it('registers an agentless native output using its explicit project when the report omits the project', async () => {
  const f = await fixture(), h = await formalHost(f), output = join(f.root, 'agentless-native.mp4')
  await writeFile(output, 'current-native-output')
  h.ctx.tools.register(defineTool({ name: 'drama_render', description: 'agentless native report fixture',
    parameters: { project: { type: 'string', required: true }, method: { type: 'string', required: true } },
    output: { schema: { type: 'object', additionalProperties: true }, render: () => [{ type: 'text', text: 'native result' }] },
    execute: async () => ({ ok: true, output }) }))
  const result = await h.ctx.tools.execute({ name: 'drama_render', callId: ToolCallId(`agentless-${++serial}`),
    arguments: { method: 'render', project: f.project }, signal })
  expect(result.isError).toBe(false)
  const delivery = await h.execute('present', output)
  expect(delivery.isError).toBe(true)
  expect(JSON.stringify(delivery)).toContain('short_drama_delivery_unstaged')
})

it.each(['prepare', 'incomplete-report', 'failed-render'] as const)('does not register %s as a completed native render', async (kind) => {
  const f = await fixture(), h = await formalHost(f), output = join(f.root, 'unregistered-work.mp4')
  await writeFile(output, 'work file')
  h.ctx.tools.register(defineTool({ name: 'drama_render', description: 'work report fixture',
    parameters: { project: { type: 'string', required: true }, method: { type: 'string', required: true } },
    output: { schema: { type: 'object', additionalProperties: true }, render: () => [{ type: 'text', text: 'work result' }] },
    execute: async () => {
      if (kind === 'failed-render') throw Error('render did not complete')
      return { ok: kind !== 'incomplete-report', output }
    } }))
  const result = await h.ctx.tools.execute({ name: 'drama_render', callId: ToolCallId(`work-${++serial}`),
    arguments: { method: kind === 'prepare' ? 'prepare' : 'render', project: f.project }, agent: h.owner, signal })
  expect(result.isError).toBe(kind === 'failed-render')
  expect((await h.execute('present', output)).isError).toBe(false)
})

it.skipIf(process.platform !== 'win32')('accepts Windows path case variations of the same staged candidate', async () => {
  const f = await fixture()
  await expect(validateShortDramaDelivery([f.video.toUpperCase()], signal, undefined, verifiedContent)).resolves.toBeUndefined()
})

it('reproduces direct export bypass without the policy and removes its listeners on dispose', async () => {
  const f = await fixture(), h = await formalHost(f)
  await h.policy.dispose()
  expect((await h.execute('present', f.working)).isError).toBe(false)
  expect((await h.execute('dsh_im_return_file', f.working)).isError).toBe(false)
  expect(h.sent).toEqual([f.working])
})
