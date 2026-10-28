import { Context } from '@deepseek-ai/cordis'
import Tools from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import { execFile } from 'node:child_process'
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { expect, it, onTestFinished, vi } from 'vitest'
import * as Draft from '../src/jianying-draft.ts'

const fakePython = `
const fs = require('node:fs'), path = require('node:path');
const [request, root, failure] = process.argv.slice(1);
const input = JSON.parse(fs.readFileSync(request, 'utf8'));
if (failure) { console.log(JSON.stringify({ success:false,drafts_created:0,drafts:[],error:'save rejected' })); process.exit(0); }
const target = path.join(root, input.name_prefix + String(input.episode).padStart(2, '0'));
fs.mkdirSync(target); fs.writeFileSync(path.join(target,'draft_content.json'),JSON.stringify({})+String.fromCharCode(10));
console.log(JSON.stringify({success:true,drafts_created:1,drafts:[{episode:'95',name:'candidate-95',path:target,id:'draft-id',success:true,error:'',quality:'needs_review',warnings:['subtitle requires review'],review_path:path.join(target,'muse-review.json')}],quality:'needs_review',warnings:['subtitle requires review'],library:{name:'pyJianYingDraft',version:'0.3.1'},editor_open_verified:false}));
`

// Opt in with the packaged media runtime; never replace Python or the generator in this test.
const mediaPython = process.env.DSH_TEST_MEDIA_PYTHON
const mediaFfmpeg = process.env.DSH_FFMPEG_PATH
const runFile = promisify(execFile)

it.runIf(Boolean(mediaPython && mediaFfmpeg)).each([
  ['animation_3d', 'utf8'], ['animation_3d', 'utf8-bom'],
  ['photorealistic', 'utf8'], ['photorealistic', 'utf8-bom'],
] as const)(
  'generates separate editable tracks through the native Host tool and packaged Python: %s with %s inputs', async (medium, encoding) => {
    if (mediaPython === undefined || mediaFfmpeg === undefined) throw new Error('Configure the packaged media runtime for this test')
    const f = await fixture()
    try {
      const video = join(f.root, 'video.mp4')
      const audio = join(f.root, 'dialogue.wav')
      const bgm = join(f.root, 'music-only.wav')
      const subtitles = join(f.root, 'subtitles.srt')
      const timeline = join(f.root, 'timeline.json')
      const prefix = encoding === 'utf8-bom' ? '\ufeff' : ''
      await f.startExternal(mediaFfmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i',
        'color=blue:s=160x120:r=24:d=2', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
        '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', video]).result
      for (const [file, frequency] of [[audio, 440], [bgm, 220]] as const) {
        await f.startExternal(mediaFfmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i',
          `sine=frequency=${frequency}:duration=2`, '-ar', '48000', '-ac', '2', file]).result
      }
      await writeFile(subtitles, `${prefix}1\n00:00:00,000 --> 00:00:02,000\n原生草稿回归\n`)
      await writeFile(timeline, `${prefix}${JSON.stringify({ clips: [{ shot: 1, start_us: 0, duration_us: 2000000 }],
        body_end: 2.032, delivery: { visual_medium: medium, width: 480, height: 854, fps: 24 } })}`)
      const photorealistic = medium === 'photorealistic'
      if (photorealistic) {
        await writeFile(join(f.root, 'project_config.json'), JSON.stringify({ project_bible: {
          visual_medium: medium, delivery: { draft_style: { watermark: { font_size_ui: 7 },
            subtitle: { font_family: '山海经', font_size_ui: 11, border_width_ui: 20, transform_y: -0.465625 } } },
        } }))
      }
      const request = { project: f.root, episode: 95,
        name_prefix: 'native-host-', audio, videos: [video], subtitle_srt: subtitles, timeline,
        bgm, bgm_role: 'music_only', ...(photorealistic ? { ending_effect: video,
          ending_audio: resolve('packages/drama/skills/skills/tweet-drama-background-render/assets/ending_audio.mp3') } : {}) }
      await writeFile(f.input.request_file, `${prefix}${JSON.stringify(request)}`)
      const inputs = [video, audio, bgm, subtitles, timeline, ...(photorealistic ? [
        join(f.root, 'project_config.json'),
        resolve('packages/drama/skills/skills/tweet-drama-background-render/assets/ending_audio.mp3'),
      ] : [])]
      const inputBytes = await Promise.all(inputs.map(file => readFile(file)))
      const requestBytes = await readFile(f.input.request_file)
      await f.ctx.plugin(Draft, { source: f.root, pythonPath: mediaPython, timeoutMs: 60000,
        ffmpegPath: mediaFfmpeg, ffprobePath: process.env.DSH_FFPROBE_PATH ?? 'ffprobe',
        graceMs: 100, maxInputBytes: 65536, maxOutputBytes: 65536 })
      const response = await f.ctx.tools.execute({ name: 'jianying_draft', arguments: f.input,
        callId: ToolCallId('native-draft-runtime'), signal: f.signal })
      expect(response.isError, JSON.stringify(response.content)).not.toBe(true)
      expect(response.value).toMatchObject({ success: true, drafts_created: 1, editor_open_verified: false,
        library: { name: 'pyJianYingDraft' } })
      const content = JSON.parse(await readFile(join(f.input.drafts_dir, 'native-host-95', 'draft_content.json'), 'utf8')) as {
        duration: number
        tracks: { type: string; name: string; segments: { volume: number; material_id: string }[] }[]
        materials: { texts: { id: string; content: string }[] }
      }
      expect(content.duration).toBe(photorealistic ? 4000000 : 2000000)
      expect(content.tracks.filter((track: { type: string }) => track.type === 'video')).toHaveLength(photorealistic ? 2 : 1)
      expect(content.tracks.filter((track: { type: string }) => track.type === 'text')).toHaveLength(photorealistic ? 2 : 1)
      expect(content.tracks.filter((track: { type: string }) => track.type === 'audio')).toHaveLength(photorealistic ? 3 : 2)
      expect(content.tracks.find(track => track.name === '视频轨道')?.segments[0]?.volume).toBe(0)
      expect(content.tracks.find(track => track.name === '主音频轨道')?.segments.map(segment => segment.volume)).toEqual([1])
      expect(content.materials.texts.some((text: { content: string }) => text.content.includes('原生草稿回归'))).toBe(true)
      if (photorealistic) {
        expect(content.tracks.find(track => track.name === '片尾特效')?.segments.map(segment => segment.volume)).toEqual([0])
        expect(content.tracks.find(track => track.name === '片尾音')?.segments.map(segment => segment.volume)).toEqual([1])
        const mark = content.tracks.find(track => track.name === 'AI内容标识')?.segments[0]?.material_id
        const text = content.materials.texts.find(material => material.id === mark)
        expect(text).toBeDefined()
        const serialized = JSON.parse(text!.content) as { styles: { size: number }[] }
        expect(serialized.styles[0]?.size).toBe(7)
        const review = JSON.parse(await readFile(join(f.input.drafts_dir, 'native-host-95', 'muse-review.json'), 'utf8')) as {
          subtitle_font: { requested: string; status: string; resolved: string }
        }
        expect(review.subtitle_font).toEqual(expect.objectContaining({ requested: '山海经', status: 'fallback', resolved: '剪映系统默认字体' }))
        expect(JSON.stringify(response.value)).toContain('回退剪映系统默认字体')
      }
      const saved = await readFile(join(f.input.drafts_dir, 'native-host-95', 'draft_content.json'), 'utf8')
      const repeated = await f.ctx.tools.execute({ name: 'jianying_draft', arguments: f.input,
        callId: ToolCallId('native-draft-no-overwrite'), signal: f.signal })
      expect(repeated.isError).toBe(true)
      expect(await readFile(join(f.input.drafts_dir, 'native-host-95', 'draft_content.json'), 'utf8')).toBe(saved)
      expect(await Promise.all(inputs.map(file => readFile(file)))).toEqual(inputBytes)
      expect(await readFile(f.input.request_file)).toEqual(requestBytes)
      await writeFile(f.input.request_file, `${prefix}${JSON.stringify({ ...request, name_prefix: 'native-mix-', bgm_role: 'dialogue_music_mix' })}`)
      const mixedRequestBytes = await readFile(f.input.request_file)
      const mixed = await f.ctx.tools.execute({ name: 'jianying_draft', arguments: f.input,
        callId: ToolCallId('native-draft-review-mix'), signal: f.signal })
      expect(mixed.isError, JSON.stringify(mixed.content)).not.toBe(true)
      expect(mixed.value).toMatchObject({ success: true })
      expect(JSON.stringify(mixed.value)).toContain('dialogue_music_mix')
      const mixContent = JSON.parse(await readFile(join(f.input.drafts_dir, 'native-mix-95', 'draft_content.json'), 'utf8')) as {
        tracks: { type: string }[]
      }
      expect(mixContent.tracks.filter((track: { type: string }) => track.type === 'audio')).toHaveLength(photorealistic ? 2 : 1)
      expect(await Promise.all(inputs.map(file => readFile(file)))).toEqual(inputBytes)
      expect(await readFile(f.input.request_file)).toEqual(mixedRequestBytes)
    } finally {
      await f.dispose()
    }
  }, 120000)

it.runIf(Boolean(mediaPython && mediaFfmpeg))('native-ep10-aac keeps five source clips silent with their concatenated dialogue track', async () => {
  if (mediaPython === undefined || mediaFfmpeg === undefined) throw new Error('Configure the packaged media runtime for this test')
  const f = await fixture()
  try {
    const videos: string[] = []
    for (let index = 0; index < 5; index++) {
      const video = join(f.root, `part-${index + 1}.mp4`)
      await f.startExternal(mediaFfmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i',
        'color=blue:s=160x120:r=24:d=0.5', '-f', 'lavfi', '-i',
        `sine=frequency=${440 + index * 110}:duration=0.5`, '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-shortest', video]).result
      videos.push(video)
    }
    const audio = join(f.root, 'concatenated-dialogue.wav')
    await f.startExternal(mediaFfmpeg, ['-v', 'error', '-y',
      ...videos.flatMap(video => ['-i', video]), '-filter_complex',
      `${videos.map((_video, index) => `[${index}:a]`).join('')}concat=n=5:v=0:a=1[dialogue]`,
      '-map', '[dialogue]', '-ar', '48000', '-ac', '2', audio]).result
    const subtitles = join(f.root, 'subtitles.srt')
    const timeline = join(f.root, 'timeline.json')
    await writeFile(subtitles, '1\n00:00:00,000 --> 00:00:02,500\n合成五段原声回归\n')
    await writeFile(timeline, JSON.stringify({
      clips: videos.map((_video, index) => ({ shot: index + 1, start_us: index * 500000, duration_us: 500000 })),
      body_end: 2.5, delivery: { visual_medium: 'animation_3d', width: 480, height: 854, fps: 24 },
    }))
    await writeFile(f.input.request_file, JSON.stringify({ project: f.root, episode: 95,
      name_prefix: 'native-five-source-', audio, videos, subtitle_srt: subtitles, timeline }))
    const inputs = [...videos, audio, subtitles, timeline, f.input.request_file]
    const sourceBytes = await Promise.all(inputs.map(file => readFile(file)))
    await f.ctx.plugin(Draft, { source: f.root, pythonPath: mediaPython, timeoutMs: 60000,
      ffmpegPath: mediaFfmpeg, ffprobePath: process.env.DSH_FFPROBE_PATH ?? 'ffprobe',
      graceMs: 100, maxInputBytes: 65536, maxOutputBytes: 65536 })
    expect(f.ctx.tools.get('jianying_draft')).toBeDefined()
    const response = await f.ctx.tools.execute({ name: 'jianying_draft', arguments: f.input,
      callId: ToolCallId('native-five-source-draft'), signal: f.signal })
    expect(response.isError, JSON.stringify(response.content)).not.toBe(true)
    expect(response.value).toMatchObject({ success: true, drafts_created: 1, editor_open_verified: false,
      library: { name: 'pyJianYingDraft' } })
    const savedPath = join(f.input.drafts_dir, 'native-five-source-95', 'draft_content.json')
    const saved = await readFile(savedPath)
    const content = JSON.parse(saved.toString('utf8')) as {
      tracks: { type: string; name: string; segments: { volume: number }[] }[]
    }
    const videoTracks = content.tracks.filter(track => track.type === 'video')
    const audioTracks = content.tracks.filter(track => track.type === 'audio')
    expect(videoTracks).toHaveLength(1)
    expect(videoTracks[0]?.segments.map(segment => segment.volume)).toEqual([0, 0, 0, 0, 0])
    expect(audioTracks).toHaveLength(1)
    expect(audioTracks[0]).toMatchObject({ name: '主音频轨道', segments: [{ volume: 1 }] })
    expect(await Promise.all(inputs.map(file => readFile(file)))).toEqual(sourceBytes)
    const repeated = await f.ctx.tools.execute({ name: 'jianying_draft', arguments: f.input,
      callId: ToolCallId('native-five-source-no-overwrite'), signal: f.signal })
    expect(repeated.isError).toBe(true)
    expect(await readFile(savedPath)).toEqual(saved)
    expect(await Promise.all(inputs.map(file => readFile(file)))).toEqual(sourceBytes)
  } finally {
    await f.dispose()
  }
}, 120000)

async function fixture(maxInputBytes = 65536, maxBgmGain = 8) {
  const root = await mkdtemp(join(tmpdir(), 'muse-jianying-draft-'))
  const ctx = new Context()
  const controller = new AbortController()
  const children = new Set<Promise<void>>()
  let disposal: Promise<void> | undefined
  const dispose = () => disposal ??= (async () => {
    controller.abort(new Error('Draft fixture cleanup cancelled its work'))
    await Promise.all(children)
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  })()
  onTestFinished(dispose)
  const startExternal = (command: string, args: string[]) => {
    controller.signal.throwIfAborted()
    const result = runFile(command, args, { cwd: root, timeout: 30000, windowsHide: true, signal: controller.signal })
    const closed = new Promise<void>(resolve => result.child.once('close', () => { resolve() }))
    children.add(closed)
    void closed.then(() => { children.delete(closed) })
    const collected = (async () => {
      try { return await result }
      finally { await closed }
    })()
    return { child: result.child, result: collected }
  }
  try {
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(Tools)
    await ctx.plugin(LocalSubprocessRuntime)
    const input = { request_file: join(root, 'request.json'), drafts_dir: join(root, 'drafts') }
    await mkdir(input.drafts_dir)
    await writeFile(input.request_file, JSON.stringify({ episode: 95, name_prefix: 'candidate-' }))
    const config: Draft.Config = { source: root, pythonPath: process.execPath, timeoutMs: 30000,
      graceMs: 100, maxInputBytes, maxOutputBytes: 65536, maxBgmGain,
      ffmpegPath: join(root, 'ffmpeg'), ffprobePath: join(root, 'ffprobe') }
    return { root, ctx, input, config, signal: controller.signal, startExternal, dispose }
  } catch (error) {
    await dispose()
    throw error
  }
}

it('cancels raw fixture children and awaits their exit before disposing the Host and removing files', async () => {
  const f = await fixture()
  try {
    await expect(f.startExternal(process.execPath, ['-e',
      'process.stdout.write("kept-output"); process.stderr.write("kept-error"); process.exit(9)']).result)
      .rejects.toMatchObject({ code: 9, stdout: 'kept-output', stderr: 'kept-error' })
    const running = f.startExternal(process.execPath, ['-e', 'process.stdout.write("ready"); setInterval(() => {}, 1000)'])
    const outcome = running.result.then(value => ({ value }), (error: unknown) => ({ error }))
    const events: string[] = []
    const stdout = running.child.stdout
    if (stdout === null) throw new Error('Fixture child must expose stdout')
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => { stdout.off('data', ready); running.child.off('close', stopped) }
      const ready = () => { cleanup(); resolve() }
      const stopped = () => { cleanup(); reject(new Error('Fixture child stopped before readiness')) }
      stdout.once('data', ready)
      running.child.once('close', stopped)
    })
    const pid = running.child.pid
    if (pid === undefined) throw new Error('Fixture child must have an operating-system pid')
    expect(process.kill(pid, 0)).toBe(true)
    running.child.once('close', () => { events.push('raw child closed') })
    f.ctx.effect(() => () => { events.push('Host disposed') })
    await f.dispose()
    events.push('files removed')
    expect(events).toEqual(['raw child closed', 'Host disposed', 'files removed'])
    expect(await outcome).toMatchObject({ error: { name: 'AbortError', code: 'ABORT_ERR' } })
    expect(() => process.kill(pid, 0)).toThrow()
    await expect(access(f.root)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(f.signal.aborted).toBe(true)
    expect(() => f.startExternal(process.execPath, ['-e', 'process.exit(0)'])).toThrow('Draft fixture cleanup cancelled')
    await f.dispose()
  } finally {
    await f.dispose()
  }
})

it('runs the draft bridge directly with managed argv and removes its tool on disposal', async () => {
  const f = await fixture(65536, 1)
  const spawn = f.ctx.subprocess.spawn.bind(f.ctx.subprocess)
  // Only the external Python/library is substituted; process collection and teardown are real.
  const spy = vi.spyOn(f.ctx.subprocess, 'spawn').mockImplementation(spec => spawn({ ...spec,
    argv: [process.execPath, '-e', fakePython, f.input.request_file, f.input.drafts_dir] }))
  try {
    const fiber = await f.ctx.plugin(Draft, f.config)
    expect(f.ctx.tools.get('jianying_draft')).toBeDefined()
    const result = await Draft.generateJianyingDraft(f.ctx.subprocess, f.input, f.config)
    expect(result).toMatchObject({ success: true, drafts_created: 1, editor_open_verified: false,
      library: { name: 'pyJianYingDraft', version: '0.3.1' },
      quality: 'needs_review', warnings: ['subtitle requires review'],
      drafts: [expect.objectContaining({ warnings: ['subtitle requires review'], review_path: join(f.input.drafts_dir, 'candidate-95/muse-review.json') })] })
    expect(await readFile(join(result.drafts[0]!.path, 'draft_content.json'), 'utf8')).toBe('{}\n')
    const request = spy.mock.calls[0]![0]
    expect(request.env).toMatchObject({ DSH_BGM_MAX_GAIN: '1',
      DSH_FFMPEG_PATH: join(f.root, 'ffmpeg'), DSH_FFPROBE_PATH: join(f.root, 'ffprobe') })
    expect(request.argv.slice(0, 2)).toEqual([process.execPath, '-B'])
    expect(request.argv[2]).toMatch(/generate_draft_request\.py$/u)
    expect(request.argv).not.toContain('pwsh')
    await fiber.dispose()
    expect(f.ctx.tools.get('jianying_draft')).toBeUndefined()
  } finally {
    spy.mockRestore()
    await f.dispose()
  }
})

it('rejects a library save failure even when the child exits zero', async () => {
  const f = await fixture()
  const spawn = f.ctx.subprocess.spawn.bind(f.ctx.subprocess)
  const spy = vi.spyOn(f.ctx.subprocess, 'spawn').mockImplementation(spec => spawn({ ...spec,
    argv: [process.execPath, '-e', fakePython, f.input.request_file, f.input.drafts_dir, 'fail'] }))
  try {
    await expect(Draft.generateJianyingDraft(f.ctx.subprocess, f.input, f.config)).rejects.toThrow('save rejected')
  } finally {
    spy.mockRestore()
    await f.dispose()
  }
})

it('reports startup stderr when a generator exits before returning JSON', async () => {
  const f = await fixture()
  const spawn = f.ctx.subprocess.spawn.bind(f.ctx.subprocess)
  const spy = vi.spyOn(f.ctx.subprocess, 'spawn').mockImplementation(spec => spawn({ ...spec,
    argv: [process.execPath, '-e', 'process.stderr.write("ModuleNotFoundError: draft_inputs"); process.exit(1)'] }))
  try {
    await expect(Draft.generateJianyingDraft(f.ctx.subprocess, f.input, f.config))
      .rejects.toThrow('Draft generator returned no JSON (exit 1): ModuleNotFoundError: draft_inputs')
  } finally {
    spy.mockRestore()
    await f.dispose()
  }
})

it('preserves embedded-text warnings and limited subtitle editability from the generator', async () => {
  const f = await fixture()
  const spawn = f.ctx.subprocess.spawn.bind(f.ctx.subprocess)
  const script = fakePython.replace('editor_open_verified:false',
    "editor_open_verified:false,subtitle_overlay:{evidence_kind:'caller_declared',overlay_cue_count:1,retained_embedded_count:1,all_subtitles_editable:false}")
  const spy = vi.spyOn(f.ctx.subprocess, 'spawn').mockImplementation(spec => spawn({ ...spec,
    argv: [process.execPath, '-e', script, f.input.request_file, f.input.drafts_dir] }))
  try {
    const result = await Draft.generateJianyingDraft(f.ctx.subprocess, f.input, f.config)
    expect(result).toMatchObject({ editor_open_verified: false, warnings: ['subtitle requires review'],
      subtitle_overlay: { evidence_kind: 'caller_declared', overlay_cue_count: 1,
        retained_embedded_count: 1, all_subtitles_editable: false } })
  } finally {
    spy.mockRestore()
    await f.ctx.fiber.dispose()
    await rm(f.root, { recursive: true, force: true })
  }
})

it('rejects oversized requests before starting a generator', async () => {
  const f = await fixture(1)
  const spy = vi.spyOn(f.ctx.subprocess, 'spawn')
  try {
    await expect(Draft.generateJianyingDraft(f.ctx.subprocess, f.input, f.config))
      .rejects.toThrow('input limit')
    expect(spy).not.toHaveBeenCalled()
  } finally {
    spy.mockRestore()
    await f.dispose()
  }
})

it('selects the source-audio backend only for Windows and preserves the independent-audio route', () => {
  expect(Draft.resolveJianyingDraftBackend('embedded', 'win32')).toEqual({
    script: 'windows_aa_draft.py', library: 'aa-jianying',
  })
  for (const platform of ['win32', 'darwin', 'linux'] as const) {
    expect(Draft.resolveJianyingDraftBackend('independent', platform)).toEqual({
      script: 'generate_draft_request.py', library: 'pyJianYingDraft',
    })
  }
  expect(() => Draft.resolveJianyingDraftBackend('embedded', 'darwin')).toThrow('Windows only')
})

it.each(['{"audio_mode":"guess"}', 'null', '[]', '{'])('rejects an invalid episode request before a subprocess: %s', async (request) => {
  const f = await fixture()
  const spy = vi.spyOn(f.ctx.subprocess, 'spawn')
  try {
    await writeFile(f.input.request_file, request)
    await expect(Draft.generateJianyingDraft(f.ctx.subprocess, f.input, f.config)).rejects.toThrow()
    expect(spy).not.toHaveBeenCalled()
  } finally {
    spy.mockRestore()
    await f.dispose()
  }
})

it.runIf(process.platform === 'win32')('runs embedded source audio through the same Host tool and AA implementation', async () => {
  const f = await fixture()
  const spawn = f.ctx.subprocess.spawn.bind(f.ctx.subprocess)
  const script = fakePython.replace("name:'pyJianYingDraft'", "name:'aa-jianying'")
    .replace('success:true,drafts_created:1', "success:true,backend:'aa-jianying',drafts_created:1")
  const spy = vi.spyOn(f.ctx.subprocess, 'spawn').mockImplementation(spec => spawn({ ...spec,
    argv: [process.execPath, '-e', script, f.input.request_file, f.input.drafts_dir] }))
  try {
    await writeFile(f.input.request_file, '\ufeff' + JSON.stringify({ episode: 95, name_prefix: 'candidate-', audio_mode: 'embedded' }))
    await f.ctx.plugin(Draft, { ...f.config, ffmpegPath: 'C:\\media\\ffmpeg.exe', ffprobePath: 'C:\\media\\ffprobe.exe',
      windowsPowerShellPath: 'C:\\Windows\\powershell.exe' })
    const response = await f.ctx.tools.execute({ name: 'jianying_draft', arguments: f.input,
      callId: ToolCallId('aa-source-audio'), signal: f.signal })
    expect(response.isError, JSON.stringify(response.content)).not.toBe(true)
    expect(response.value).toMatchObject({ backend: 'aa-jianying', library: { name: 'aa-jianying' }, editor_open_verified: false })
    expect(spy.mock.calls[0]![0].argv[2]).toMatch(/windows_aa_draft\.py$/u)
    expect(spy.mock.calls[0]![0].env).toMatchObject({ FFMPEG_BINARY: 'C:\\media\\ffmpeg.exe',
      FFPROBE_BINARY: 'C:\\media\\ffprobe.exe', MUSE_JIANYING_POWERSHELL: 'C:\\Windows\\powershell.exe' })
    expect(f.ctx.tools.schemas().filter(tool => tool.name === 'jianying_draft')).toHaveLength(1)
  } finally {
    spy.mockRestore()
    await f.dispose()
  }
})

it('awaits the managed generator exit when the caller cancels', async () => {
  const f = await fixture()
  const spawn = f.ctx.subprocess.spawn.bind(f.ctx.subprocess)
  const started = Promise.withResolvers<SubprocessHandle>()
  const exiting = Promise.withResolvers<undefined>()
  const releaseExit = Promise.withResolvers<undefined>()
  const controller = new AbortController()
  const spy = vi.spyOn(f.ctx.subprocess, 'spawn').mockImplementation((spec) => {
    const handle = spawn({ ...spec, argv: [process.execPath, '-e', 'setInterval(() => {}, 1000)'] })
    started.resolve(handle)
    return { stdin: handle.stdin, stdout: handle.stdout, stderr: handle.stderr, control: handle.control,
      collected: handle.collected, done: handle.done, terminate: () => { handle.terminate() },
      async waitForExit(signal) {
        exiting.resolve(undefined)
        await releaseExit.promise
        return handle.waitForExit(signal)
      } }
  })
  let settled = false
  try {
    const operation = Draft.generateJianyingDraft(f.ctx.subprocess, f.input, f.config, controller.signal)
    const observed = operation.then(() => { settled = true }, () => { settled = true })
    const handle = await started.promise
    const cancelled = expect(operation).rejects.toThrow('draft cancelled')
    controller.abort(new Error('draft cancelled'))
    await exiting.promise
    expect(settled).toBe(false)
    releaseExit.resolve(undefined)
    await cancelled
    await observed
    expect(await handle.waitForExit()).toBe(true)
  } finally {
    releaseExit.resolve(undefined)
    spy.mockRestore()
    await f.dispose()
  }
})
