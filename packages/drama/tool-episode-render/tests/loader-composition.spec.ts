/** Public render arguments through a Loader-owned tool registration. */
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools, { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import * as Render from '../src/index.ts'
import * as Media from '../src/ffmpeg.ts'
import { cleanup, decodeHandler, framemd5Line, placeholderHandler, probeHandler, runContext,
  seekHandler, shippedEndingAsset, stubChannel, tempProject, writePlaceholder } from './harness.ts'

/** Load the real renderer contribution through a private test-only Cordis config. */
async function loadRenderer(ctx: Context, root: string): Promise<void> {
  const config = join(root, 'cordis.yml')
  await writeFile(config, [
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-tool-episode-render'",
    '  config:',
    '    preferNvenc: false',
    '',
  ].join('\n'))
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', Tools],
    ['@deepseek-ai/dsh-tool-episode-render', Render],
  ])
  ctx.loader.internal = {
    version: 'v2', loadCache: new Map(),
    register() { throw new Error('Unexpected loader hooks') },
    getOrCreateModuleJob() { throw new Error('Unexpected loader job') },
    resolveSync() { throw new Error('Unexpected loader resolution') },
    load() { throw new Error('Unexpected loader load') },
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected module: ${specifier}`)
      return modules.get(specifier)
    },
  }
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(config).href } })
  await ctx.loader.await()
  for (const entry of ctx.loader.entries()) await entry.fiber?.await()
}

/** Invoke the Loader-owned tool with public arguments and validate both schemas. */
async function invoke(tool: ToolDefinition, args: Record<string, unknown>) {
  expect(validateJsonSchemaValue(tool.parameters, args, '')).toEqual([])
  const result = await tool.execute(args, runContext())
  expect(validateJsonSchemaValue(tool.output.schema, result, '')).toEqual([])
  return result
}

/** Write one small 480p project whose media commands stay on the injected channel. */
async function writePreviewInputs(root: string): Promise<void> {
  await writePlaceholder(join(root, 'source.mp4'), 'selected source')
  await writePlaceholder(join(root, 'approved-bgm.wav'), 'selected pure music bed')
  await writePlaceholder(join(root, 'project_config.json'), JSON.stringify({ project_bible: {
    visual_medium: 'animation_3d', delivery: { width: 480, height: 854, fps: 24 } } }))
  await writePlaceholder(join(root, 'shots.json'), JSON.stringify({ shots: [{ shot: 1, video: 'source.mp4' }] }))
  await writePlaceholder(join(root, 'source.srt'), '1\n00:00:01,000 --> 00:00:02,000\n原文\n')
}

it('loads the renderer, accepts public arguments, and removes its tool on disposal', async () => {
  const root = await tempProject()
  const ctx = new Context()
  try {
    await loadRenderer(ctx, root)
    const tool = ctx.tools.get('drama_render')
    expect(tool).toBeDefined()
    if (tool === undefined) throw new Error('missing drama_render')
    const videoTool = ctx.tools.get('drama_video')
    expect(videoTool).toBeDefined()
    if (videoTool === undefined) throw new Error('missing drama_video')
    const video = join(root, 'source.mp4')
    await writeFile(video, 'exact video version')
    const banArgs = { method: 'ban', project: root, video, labels: ['人物对调'], reason: '用户指定' }
    expect(validateJsonSchemaValue(videoTool.parameters, banArgs, '')).toEqual([])
    const ban = await videoTool.execute(banArgs, runContext())
    expect(validateJsonSchemaValue(videoTool.output.schema, ban, '')).toEqual([])
    // The schema check above already validated this value; narrow it for `render`
    // without adding a type-only workspace dependency to this package.
    const rendered = videoTool.output.render(
      banArgs,
      ban as Parameters<typeof videoTool.output.render>[1],
    ) as { type: string; text: string }[]
    const text = rendered[0]?.text ?? ''
    const owned = JSON.parse(text) as Record<string, unknown>
    expect({ ...owned, project: '<project>', manifest_path: '<project>/video-bans.json' }).toMatchInlineSnapshot(`
      {
        "banned": true,
        "labels": [
          "人物对调",
        ],
        "manifest_path": "<project>/video-bans.json",
        "method": "ban",
        "project": "<project>",
        "reason": "用户指定",
        "review_status": "not_assessed",
        "sha256": "cca729571d4b27fc3a64090bf227a3bcbb24b117be88e7ca7e8efaefc2d2a719",
        "videos": [],
      }
    `)
    const listArgs = { method: 'list', project: root }
    expect(validateJsonSchemaValue(videoTool.parameters, listArgs, '')).toEqual([])
    const list = await videoTool.execute(listArgs, runContext())
    expect(validateJsonSchemaValue(videoTool.output.schema, list, '')).toEqual([])
    expect(list).toMatchObject({ banned: true, videos: [{ labels: ['人物对调'], reason: '用户指定', banned: true }] })
    const unban = await videoTool.execute({ method: 'unban', project: root, video }, runContext())
    expect(validateJsonSchemaValue(videoTool.output.schema, unban, '')).toEqual([])
    expect(unban).toMatchObject({ banned: false, review_status: 'not_assessed', labels: ['人物对调'] })
    const missing = join(root, 'missing.json')
    for (const method of ['prepare', 'render', 'verify']) {
      const args = {
        method, project: root, episode: 1, shots: missing, timeline: missing,
        subtitle_srt: join(root, 'subtitles.srt'), last_shot: 1,
        bgm: join(root, 'bgm.wav'), ending_audio: join(root, 'ending.wav'),
        ending_effect: join(root, 'effect.mp4'), output: join(root, 'output.mp4'),
      }
      expect(validateJsonSchemaValue(tool.parameters, args, '')).toEqual([])
      await expect(tool.execute(args, runContext())).rejects.toMatchObject({ code: 'ENOENT', path: missing })
    }
    const entry = [...ctx.loader.entries()].find(row => row.options.name === '@deepseek-ai/dsh-tool-episode-render')
    expect(entry?.fiber).toBeDefined()
    await entry?.fiber?.dispose()
    expect(ctx.tools.get('drama_render')).toBeUndefined()
    expect(ctx.tools.get('drama_video')).toBeUndefined()
  } finally {
    await ctx.fiber.dispose()
    await cleanup(root)
  }
})

it('reads and writes mixed project-relative and absolute paths through all four Loader methods', async () => {
  const root = await tempProject()
  const ctx = new Context()
  const project = join(root, '中文 项目')
  const cwd = process.cwd()
  const shots = join('输入 文件', '镜头.json')
  const lines = join(project, '输入 文件', '台词.json')
  const alignment = join('输入 文件', '对齐.json')
  const subtitle = join('输入 文件', '对白.srt')
  const video = join(project, '媒体 文件', '原视频.mp4')
  const bgm = join('audio', '配乐 文件.wav')
  const plan = join('editing', '配乐计划.json')
  const endingAudio = join('片尾 素材', '音效.mp3')
  const endingEffect = join(root, '共享 素材', '特效.mp4')
  const output = join('exports', '成片 空格.mp4')
  const outputPath = join(project, output)
  const stub = stubChannel([
    probeHandler({
      [video]: { durationSeconds: 5, video: {}, audio: {} },
      [endingEffect]: { durationSeconds: 1.02 },
      [outputPath]: { durationSeconds: 7, sizeBytes: 5_000_000, bitRateBps: 8_000_000, video: {}, audio: {} },
    }),
    seekHandler('tail image'),
    call => call.args.includes('framemd5') ? { stdout: `${framemd5Line(0, 'tail')}\n` } : undefined,
    decodeHandler(),
    placeholderHandler(),
  ])
  const toolkit = Media.createMediaToolkit({ ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', channel: stub.channel })
  const mediaFactory = vi.spyOn(Media, 'createMediaToolkit').mockReturnValue(toolkit)
  try {
    expect(project).not.toBe(cwd)
    await writePlaceholder(video, 'selected provider video')
    await writePlaceholder(join(project, shots), JSON.stringify({ shots: [{ shot: 1,
      video: join('媒体 文件', '原视频.mp4') }] }))
    await writePlaceholder(lines, JSON.stringify({ shots: [{ shot: 1, lines: ['原文台词'] }] }))
    await writePlaceholder(join(project, alignment), JSON.stringify({ shots: [{ shot: 1, strategy: 'asr_aligned',
      cues: [{ text: '原文台词', start: 1, end: 2 }] }] }))
    await writePlaceholder(join(project, bgm), 'approved BGM')
    await writePlaceholder(join(project, plan), JSON.stringify({ episodes: [{ episode: '01', body_duration_seconds: 5,
      segments: [{ track: '已选曲目', source: bgm, start_seconds: 0, end_seconds: 5, reason: '剧情' }] }] }))
    await mkdir(join(project, '片尾 素材'), { recursive: true })
    await mkdir(join(root, '共享 素材'), { recursive: true })
    await copyFile(shippedEndingAsset('ending_audio.mp3'), join(project, endingAudio))
    await copyFile(shippedEndingAsset('ending_effect.mp4'), endingEffect)
    await loadRenderer(ctx, root)
    const tool = ctx.tools.get('drama_render')
    if (tool === undefined) throw new Error('missing drama_render')
    await invoke(tool, { method: 'subtitles', project, episode: 1, shots, lines, alignment, subtitle_srt: subtitle })
    const subtitleText = await readFile(join(project, subtitle), 'utf8')
    expect(subtitleText).toContain('00:00:01,000 --> 00:00:02,000\n原文台词')
    const sourceBlock = `${join(project, subtitle)}.blocked`
    await writeFile(sourceBlock, 'subtitle alignment pending\n', 'utf8')
    const preparedWithWarning = await invoke(tool, { method: 'prepare', project, episode: 1, shots,
      subtitle_srt: join(project, subtitle) })
    expect(JSON.stringify(preparedWithWarning)).toContain('字幕对齐待核')
    await rm(sourceBlock)
    const preparedPlan = await invoke(tool, { method: 'prepare', project, episode: 1, shots,
      subtitle_srt: join(project, subtitle), bgm, bgm_plan: plan })
    expect(preparedPlan).toMatchObject({ ok: true, bgm_plan: { path: join(project, plan), segments: [{ track: '已选曲目' }] },
      render_preview: { audio: { bgm_path: join(project, bgm), bgm_plan_path: join(project, plan) } } })
    expect(await readFile(join(project, 'video', '01', 'shot_001.mp4'), 'utf8')).toBe('selected provider video')
    expect(await readFile(join(project, 'editing', '01.srt'), 'utf8')).toBe(subtitleText)
    const timeline = join('editing', '01-timeline.json')
    expect(JSON.parse(await readFile(join(project, timeline), 'utf8'))).toMatchObject({ body_end: 5 })
    const deliveryBlock = `${join(project, 'editing', '01.srt')}.blocked`
    await writeFile(deliveryBlock, 'subtitle alignment pending\n', 'utf8')
    const rendered = await invoke(tool, { method: 'render', project, episode: 1, timeline,
      subtitle_srt: join('editing', '01.srt'), last_shot: 1, bgm, bgm_plan: plan,
      ending_audio: endingAudio, ending_effect: endingEffect, output })
    expect(JSON.stringify(rendered)).toContain('字幕对齐待核')
    await rm(deliveryBlock)
    expect(rendered).toMatchObject({ ok: true, output: outputPath, bgm_plan: { path: join(project, plan) } })
    expect(await readFile(outputPath, 'utf8')).toBe('media')
    expect(JSON.parse(await readFile(`${outputPath}.source-record.json`, 'utf8')))
      .toMatchObject({ output: { path: outputPath } })
    const verified = await invoke(tool, { method: 'verify', project, episode: 1, output,
      timeline: join(project, timeline), subtitle_srt: join('editing', '01.srt') })
    expect(verified).toMatchObject({ ok: true, output: outputPath, written: [] })
    expect(stub.calls.filter(call => call.command === 'ffprobe').map(call => call.args.at(-1)))
      .toEqual(expect.arrayContaining([video, endingEffect, outputPath]))
    expect(process.cwd()).toBe(cwd)
  } finally {
    mediaFactory.mockRestore()
    await ctx.fiber.dispose()
    await cleanup(root)
  }
})

it('exposes the selected 480p render inputs through Loader prepare, render and the written log', async () => {
  const root = await tempProject()
  const ctx = new Context()
  const video = join(root, 'source.mp4')
  const output = join(root, 'exports', 'candidate.mp4')
  const bgm = join(root, 'approved-bgm.wav')
  const stub = stubChannel([
    probeHandler({ [video]: { durationSeconds: 5, video: { width: 480, height: 854, fps: 24 }, audio: {} },
      [output]: { durationSeconds: 5, video: { width: 480, height: 854, fps: 24 }, audio: {} } }),
    placeholderHandler(),
  ])
  const mediaFactory = vi.spyOn(Media, 'createMediaToolkit').mockReturnValue(
    Media.createMediaToolkit({ ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', channel: stub.channel }))
  try {
    await writePreviewInputs(root)
    await loadRenderer(ctx, root)
    const tool = ctx.tools.get('drama_render')
    if (tool === undefined) throw new Error('missing drama_render')
    const prepared = await invoke(tool, { method: 'prepare', project: root, episode: 23, shots: 'shots.json',
      subtitle_srt: 'source.srt', bgm: 'approved-bgm.wav' })
    expect(prepared).toMatchObject({ ok: true, render_preview: {
      delivery: { width: 480, height: 854, fps: 24 },
      subtitle: { path: join(root, 'editing', '23.srt'), font_size_design: 40, font_size_output_px: 17.773 },
      audio: { bgm_path: bgm, bgm_plan_path: '', master_gain: 1.45, bgm_gain: 0.24 } } })
    const rendered = await invoke(tool, { method: 'render', project: root, episode: 23, timeline: 'editing/23-timeline.json',
      subtitle_srt: 'editing/23.srt', last_shot: 1, bgm: 'approved-bgm.wav', output })
    expect(rendered).toMatchObject({ ok: true, bgm_plan: { path: '', segments: [] }, render_preview: {
      delivery: { width: 480, height: 854, fps: 24 }, audio: { bgm_path: bgm, bgm_plan_path: '' } } })
    const log = await readFile(join(root, 'exports', '.render_cache', '23', 'render.log'), 'utf8')
    expect(log).toContain('render_preview=')
    expect(log).toContain('"font_size_output_px":17.773')
    expect(log).toContain(JSON.stringify(bgm))
    const mux = stub.calls.find(call => call.args.includes('-stream_loop'))
    expect(mux?.args).toContain(bgm)
    expect(mux?.args.join(' ')).toContain('[2:a]atrim=0:5.000000,volume=0.24[a1]')
    expect(await readFile(output, 'utf8')).toBe('media')
  } finally {
    mediaFactory.mockRestore()
    await ctx.fiber.dispose()
    await cleanup(root)
  }
})

it('carries project subtitle and gain snapshots through Loader prepare, ASS, mux and log', async () => {
  const root = await tempProject()
  const ctx = new Context()
  const video = join(root, 'source.mp4')
  const output = join(root, 'exports', 'configured.mp4')
  const stub = stubChannel([
    probeHandler({ [video]: { durationSeconds: 5, video: { width: 480, height: 854, fps: 24 }, audio: {} },
      [output]: { durationSeconds: 5, video: { width: 480, height: 854, fps: 24 }, audio: {} } }),
    placeholderHandler(),
  ])
  const mediaFactory = vi.spyOn(Media, 'createMediaToolkit').mockReturnValue(
    Media.createMediaToolkit({ ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', channel: stub.channel }))
  const subtitle = { font_family: 'Project font', font_size_px: 30, margin_bottom_px: 18 }
  const audio = { master_gain: 1, bgm_gain: 0 }
  try {
    await writePreviewInputs(root)
    const config = { project_bible: { visual_medium: 'animation_3d',
      delivery: { width: 480, height: 854, fps: 24, subtitle, audio } } }
    await writeFile(join(root, 'project_config.json'), JSON.stringify(config))
    await loadRenderer(ctx, root)
    const tool = ctx.tools.get('drama_render')
    if (tool === undefined) throw new Error('missing drama_render')
    const prepared = await invoke(tool, { method: 'prepare', project: root, episode: 23, shots: 'shots.json',
      subtitle_srt: 'source.srt', bgm: 'approved-bgm.wav' })
    expect(prepared).toMatchObject({ render_preview: { subtitle: { font_family: 'Project font', font_size_output_px: 30 },
      audio: { master_gain: 1, bgm_gain: 0 } } })
    expect(JSON.parse(await readFile(join(root, 'editing', '23-timeline.json'), 'utf8')))
      .toMatchObject({ delivery: { subtitle, audio } })
    // Later project changes cannot silently restyle or remix the prepared episode.
    config.project_bible.delivery.subtitle = { font_family: 'Later font', font_size_px: 50, margin_bottom_px: 50 }
    config.project_bible.delivery.audio = { master_gain: 2, bgm_gain: 1 }
    await writeFile(join(root, 'project_config.json'), JSON.stringify(config))
    const rendered = await invoke(tool, { method: 'render', project: root, episode: 23, timeline: 'editing/23-timeline.json',
      subtitle_srt: 'editing/23.srt', last_shot: 1, bgm: 'approved-bgm.wav', output })
    expect(rendered).toMatchObject({ render_preview: { subtitle: { font_family: 'Project font', font_size_output_px: 30 },
      audio: { master_gain: 1, bgm_gain: 0 } } })
    const cache = join(root, 'exports', '.render_cache', '23')
    const ass = await readFile(join(cache, 'display.ass'), 'utf8')
    expect(ass).toContain('Style: Default,Project font,67.518,')
    expect(ass).toContain('0,2,40,40,41,1')
    const mux = stub.calls.find(call => call.args.includes('-stream_loop'))
    expect(mux?.args.join(' ')).toContain('[1:a]apad,atrim=0:5.000000,volume=1[a0]')
    expect(mux?.args.join(' ')).toContain('[2:a]atrim=0:5.000000,volume=0[a1]')
    const log = await readFile(join(cache, 'render.log'), 'utf8')
    expect(log).toContain('"font_family":"Project font"')
    expect(log).toContain('"master_gain":1,"bgm_gain":0')
  } finally {
    mediaFactory.mockRestore()
    await ctx.fiber.dispose()
    await cleanup(root)
  }
})

it.each([null, { font_size_px: 0.0001 }])('rejects explicit invalid project style %j before Loader prepare starts media or writes products', async (subtitle) => {
  const root = await tempProject()
  const ctx = new Context()
  const stub = stubChannel([])
  const mediaFactory = vi.spyOn(Media, 'createMediaToolkit').mockReturnValue(
    Media.createMediaToolkit({ ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', channel: stub.channel }))
  try {
    await writePreviewInputs(root)
    await writeFile(join(root, 'project_config.json'), JSON.stringify({ project_bible: {
      delivery: { width: 480, height: 854, fps: 24, subtitle } } }))
    await loadRenderer(ctx, root)
    const tool = ctx.tools.get('drama_render')
    if (tool === undefined) throw new Error('missing drama_render')
    await expect(invoke(tool, { method: 'prepare', project: root, episode: 1, shots: 'shots.json',
      subtitle_srt: 'source.srt' })).rejects.toThrow('.subtitle')
    expect(stub.calls).toEqual([])
    await expect(readFile(join(root, 'editing', '01-timeline.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  } finally {
    mediaFactory.mockRestore()
    await ctx.fiber.dispose()
    await cleanup(root)
  }
})

it.each([
  { label: 'missing', contents: undefined, error: 'BGM 计划不可读' },
  { label: 'malformed', contents: '{', error: 'BGM 计划不可读' },
  { label: 'stale duration', contents: JSON.stringify({ episodes: [{ episode: '23', body_duration_seconds: 6,
    segments: [{ track: 'chosen', source: 'approved-bgm.wav', start_seconds: 0, end_seconds: 5 }] }] }),
  error: 'BGM 计划正文时长与当前时间线不一致' },
])('keeps Loader prepare files when the optional plan is $label while render still rejects it', async ({ contents, error }) => {
  const root = await tempProject()
  const ctx = new Context()
  const video = join(root, 'source.mp4')
  const plan = join(root, 'optional-plan.json')
  const stub = stubChannel([probeHandler({ [video]: { durationSeconds: 5, video: { width: 480, height: 854, fps: 24 } } }),
    placeholderHandler()])
  const mediaFactory = vi.spyOn(Media, 'createMediaToolkit').mockReturnValue(
    Media.createMediaToolkit({ ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', channel: stub.channel }))
  try {
    await writePreviewInputs(root)
    if (contents !== undefined) await writeFile(plan, contents)
    await loadRenderer(ctx, root)
    const tool = ctx.tools.get('drama_render')
    if (tool === undefined) throw new Error('missing drama_render')
    const prepared = await invoke(tool, { method: 'prepare', project: root, episode: 23, shots: 'shots.json',
      subtitle_srt: 'source.srt', bgm: 'approved-bgm.wav', bgm_plan: 'optional-plan.json' })
    expect(prepared).toMatchObject({ ok: true, bgm_plan: { path: '', segments: [] },
      render_preview: { audio: { bgm_path: join(root, 'approved-bgm.wav'), bgm_plan_path: plan } } })
    expect(prepared).toHaveProperty('not_checked', expect.arrayContaining(['bgm_plan', 'bgm_license_info']))
    expect(prepared).toHaveProperty('warnings', expect.arrayContaining([
      expect.stringContaining('prepare 已完成'), expect.stringContaining(error),
    ]))
    const files = ['video/23/shot_001.mp4', 'audio/23.wav', 'editing/23.srt',
      'editing/23-timeline.json', 'editing/23-sources.json'].map(path => join(root, path))
    const before = await Promise.all(files.map(path => readFile(path)))
    expect(before[0]?.toString()).toBe('selected source')
    expect(before[1]?.toString()).toBe('media')
    expect(before[2]?.toString()).toBe(await readFile(join(root, 'source.srt'), 'utf8'))
    expect(JSON.parse(before[3]?.toString() ?? '')).toMatchObject({ body_end: 5, delivery: { width: 480, height: 854, fps: 24 } })
    expect(JSON.parse(before[4]?.toString() ?? '')).toMatchObject({ shots: [{ shot: 1, video }] })
    const commands = stub.calls.length
    await expect(invoke(tool, { method: 'render', project: root, episode: 23, timeline: 'editing/23-timeline.json',
      subtitle_srt: 'editing/23.srt', last_shot: 1, bgm: 'approved-bgm.wav', bgm_plan: 'optional-plan.json' })).rejects.toThrow(error)
    expect(stub.calls).toHaveLength(commands)
    expect(await Promise.all(files.map(path => readFile(path)))).toEqual(before)
  } finally {
    mediaFactory.mockRestore()
    await ctx.fiber.dispose()
    await cleanup(root)
  }
})
