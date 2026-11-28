/** Network-free evidence that local picture repairs retain their original audio window. */
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { executeModelToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { TOOL_BODY_META_KEY } from '@deepseek-ai/dsh-tools/pipeline'
import { expect, it, onTestFinished, vi } from 'vitest'
import { fileSha256 } from '../src/cache.ts'
import { resolveSettings } from '../src/index.ts'
import { localClipRepairBindingSchema } from '../src/local-clip-evidence.ts'
import { registerLocalClipTool } from '../src/local-clip-tool.ts'
import { repairLocalClip } from '../src/local-clip.ts'
import type { ProcessChannel } from '../src/types.ts'
import { createMediaRunner, ffmpeg, ffprobe, hasFfmpeg } from './audio-ffmpeg-harness.ts'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))

async function repairFixture() {
  const project = await mkdtemp(join(await realpath(tmpdir()), 'dsh-local-clip-fault-'))
  const runner = createMediaRunner()
  onTestFinished(async () => { await runner.dispose(); await rm(project, { recursive: true, force: true }) })
  const input = join(project, 'original.mp4')
  const args = { project, episode: 7, input, startMs: 500, endMs: 1500 }
  const toolkit = { ffmpeg, ffprobe, channel: runner.channel }
  return { runner, args, toolkit }
}

it('refuses invalid source paths or boundaries, stale authorization and an aliased work directory', async () => {
  const { args, toolkit } = await repairFixture()
  const noProcess = { ...toolkit, channel: { run: () => { throw new Error('unexpected media command') } } }
  await writeFile(args.input, 'input identity')
  await expect(repairLocalClip(noProcess, { ...args, episode: 0 })).rejects.toThrow(/正整数集号/u)
  await expect(repairLocalClip(noProcess, { ...args, input: '.' })).rejects.toThrow(/项目内 MP4/u)
  await expect(repairLocalClip(noProcess, { ...args, expectedInputSha256: 'a'.repeat(64) })).rejects.toThrow(/已审看的版本/u)
  await writeFile(args.input, '')
  await expect(repairLocalClip(noProcess, args)).rejects.toThrow(/完整的本地文件/u)
  await writeFile(args.input, 'input identity')
  const editing = join(args.project, 'editing'), other = join(args.project, 'retained')
  await mkdir(other)
  await symlink(other, editing, 'junction')
  await expect(repairLocalClip(noProcess, args)).rejects.toThrow(/规范目录/u)
  expect(await readdir(other)).toEqual([])
  await rm(editing)
  const files = await import('node:fs/promises')
  const copy = files.copyFile
  const spy = vi.spyOn(files, 'copyFile').mockImplementation(async (from, to, mode) => {
    await copy(from, to, mode)
    if (from === args.input) await writeFile(to, 'bytes changed while copying')
  })
  onTestFinished(() => { spy.mockRestore() })
  await expect(repairLocalClip(noProcess, args)).rejects.toThrow(/复制时变化/u)
  expect(await readdir(editing)).toEqual([])
})

interface FixtureFrame { media_type: string; best_effort_timestamp_time?: string; nb_samples?: number }
interface FixtureStream { codec_type: string; duration?: string }

it.skipIf(!hasFfmpeg).each([
  ['missing source stream metadata', /可核恒定帧率/u],
  ['unknown source video duration', /可核恒定帧率/u],
  ['invalid crop rectangle', /偶数像素边界/u],
  ['decode process failed', /controlled decode failure/u],
  ['missing frame list', /解码时钟/u],
  ['unknown frame timestamp', /未能核实的解码时间戳/u],
  ['misaligned video frame', /首帧没有对齐/u],
  ['invalid audio sample count', /音频时钟有空缺/u],
  ['incomplete video frames', /解码帧数或原声不足/u],
  ['unknown source audio duration', /未覆盖所选视频区间/u],
  ['unknown output video duration', /输出的画面或声音/u],
  ['unknown output audio duration', /输出的画面或声音/u],
  ['incomplete output sample decode', /输出解码不完整/u],
] as const)('refuses to keep a repair with %s', async (fault, expectedError) => {
  const { args, runner, toolkit } = await repairFixture()
  const generated = await runner.runCommand(ffmpeg, ['-n', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=128x96:rate=24:duration=2',
    '-f', 'lavfi', '-i', 'sine=frequency=337:sample_rate=48000:duration=2', '-c:v', 'libx264', '-threads', '1', '-c:a', 'aac', args.input])
  expect(generated.code, generated.stderr).toBe(0)
  const original = await fileSha256(args.input)
  const run: ProcessChannel['run'] = async (command, argv) => {
    const result = await toolkit.channel.run(command, argv)
    if (command !== ffprobe) return result
    const output = argv.at(-1)?.endsWith('clip.mp4') === true
    if (argv.includes('-show_format')) {
      const doc = JSON.parse(result.stdout) as { streams: FixtureStream[] }
      if (!output && fault === 'missing source stream metadata') doc.streams = []
      for (const stream of doc.streams) {
        if ((output && fault === 'unknown output video duration' && stream.codec_type === 'video')
          || (output && fault === 'unknown output audio duration' && stream.codec_type === 'audio')
          || (!output && fault === 'unknown source video duration' && stream.codec_type === 'video')
          || (!output && fault === 'unknown source audio duration' && stream.codec_type === 'audio')) delete stream.duration
      }
      return { ...result, stdout: JSON.stringify(doc) }
    }
    if (!argv.includes('frame=media_type,best_effort_timestamp_time,nb_samples')) return result
    if (fault === 'decode process failed') return { code: 1, stdout: '', stderr: 'controlled decode failure' }
    if (fault === 'missing frame list') return { ...result, stdout: 'null' }
    const doc = JSON.parse(result.stdout) as { frames: FixtureFrame[] }
    const firstPicture = doc.frames.find(frame => frame.media_type === 'video')!
    const firstSample = doc.frames.find(frame => frame.media_type === 'audio')!
    if (fault === 'unknown frame timestamp') delete firstPicture.best_effort_timestamp_time
    if (fault === 'misaligned video frame') firstPicture.best_effort_timestamp_time = '0.010000'
    if (fault === 'invalid audio sample count') firstSample.nb_samples = 0
    if (fault === 'incomplete video frames') {
      const lastPicture = doc.frames.findLastIndex(frame => frame.media_type === 'video')
      doc.frames.splice(lastPicture, 1)
    }
    if (output && fault === 'incomplete output sample decode') {
      doc.frames = [...doc.frames.filter(frame => frame.media_type === 'video'), firstSample,
        { media_type: 'subtitle', best_effort_timestamp_time: '0.000000' }]
    }
    return { ...result, stdout: JSON.stringify(doc) }
  }
  const crop = fault === 'invalid crop rectangle' ? { x: 1, y: 0, width: 20, height: 20 } : undefined
  await expect(repairLocalClip({ ...toolkit, channel: { run } },
    { ...args, expectedInputSha256: original, ...(crop === undefined ? {} : { crop }) })).rejects.toThrow(expectedError)
  expect(await fileSha256(args.input)).toBe(original)
  expect(await readdir(join(args.project, 'editing'))).toEqual([])
})

it.skipIf(!hasFfmpeg)('crops exact frames and preserves the corresponding original audio under a new path', async () => {
  const project = await mkdtemp(join(await realpath(tmpdir()), 'dsh-local-clip-'))
  const ctx = new Context()
  const runner = createMediaRunner()
  const toolkit = { ffmpeg, ffprobe, channel: runner.channel }
  const command = async (args: readonly string[]) => {
    const result = await runner.runCommand(ffmpeg, args)
    expect(result.code, result.stderr).toBe(0)
  }
  try {
    const input = join(project, 'original.mp4')
    await command(['-n', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=60:duration=2',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=1',
      '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000:duration=1',
      '-filter_complex', '[1:a][2:a]concat=n=2:v=0:a=1[audio]', '-map', '0:v:0', '-map', '[audio]',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', input])
    const originalHash = await fileSha256(input)
    const args = { project, episode: 7, input, startMs: 1017, endMs: 1500,
      crop: { x: 20, y: 10, width: 280, height: 220 } }
    await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
    await ctx.plugin(SandboxPolicy, { mode: 'workspace-write', workspaceRoot: project })
    const driver = await mountAgentLoopTestHarness(ctx)
    const agent = await driver.create(SessionId('local-clip-media'), {}, { cwd: project })
    registerLocalClipTool(ctx, resolveSettings({ ffmpegPath: ffmpeg, ffprobePath: ffprobe }))
    const invoke = () => executeModelToolFixture(ctx, { name: 'drama_repair_clip', callId: ToolCallId('local-clip-media'),
      arguments: { project, episode: args.episode, input, start_ms: args.startMs, end_ms: args.endMs, crop: args.crop },
      signal: new AbortController().signal, agent })
    agent.session.append('sandbox/mode', { mode: 'read-only' })
    expect(await invoke()).toMatchObject({ isError: true })
    agent.session.append('sandbox/mode', { mode: 'workspace-write' })
    const repaired = await invoke()
    expect(repaired.isError, JSON.stringify(repaired.content)).toBe(false)
    if (repaired.isError) throw new Error('Actual repair tool did not complete')
    const binding = localClipRepairBindingSchema.parse(repaired.value)
    expect(repaired.meta).toMatchObject({ [TOOL_BODY_META_KEY]: binding })
    expect(binding).toMatchObject({ project, episode: '07', original: { path: input, sha256: originalHash },
      startMs: 1017, endMs: 1500 })
    expect(binding.pictureClock).toBeDefined()
    expect(binding.durationSeconds).toBeCloseTo(29 / 60, 5)
    expect(dirname(dirname(binding.output.path))).toBe(join(project, 'editing'))
    expect(await readdir(dirname(binding.output.path))).toEqual(['clip.mp4'])
    expect(await fileSha256(binding.output.path)).toBe(binding.output.sha256)
    expect(await fileSha256(input)).toBe(originalHash)

    const referencePath = join(project, 'reference.pcm')
    const decodedPath = join(project, 'decoded.pcm')
    await command(['-n', '-v', 'error', '-i', input, '-map', '0:a:0', '-af', 'atrim=start_sample=48800:end_sample=72000',
      '-c:a', 'pcm_s16le', '-f', 's16le', referencePath])
    await command(['-n', '-v', 'error', '-i', binding.output.path, '-map', '0:a:0', '-c:a', 'pcm_s16le', '-f', 's16le', decodedPath])
    const reference = await readFile(referencePath)
    const decoded = await readFile(decodedPath)
    expect(reference.length).toBe(23200 * 2)
    expect(decoded.length).toBeGreaterThanOrEqual(reference.length)
    let products = 0
    let referenceEnergy = 0
    let outputEnergy = 0
    for (let offset = 0; offset < reference.length; offset += 2) {
      const a = reference.readInt16LE(offset)
      const b = decoded.readInt16LE(offset)
      products += a * b
      referenceEnergy += a * a
      outputEnergy += b * b
    }
    expect(products / Math.sqrt(referenceEnergy * outputEnergy)).toBeGreaterThan(0.98)

    await expect(repairLocalClip(toolkit, { ...args, startMs: 1014 })).rejects.toThrow('源帧边界')
    expect(await readdir(join(project, 'editing'))).toEqual([dirname(binding.output.path).split(/[\\/]/u).at(-1)])
  } finally {
    await ctx.fiber.dispose()
    await runner.dispose()
    await rm(project, { recursive: true, force: true })
  }
}, 45_000)

it.skipIf(!hasFfmpeg)('rejects the wrong picture window with the same duration and original sound', async () => {
  const project = await mkdtemp(join(await realpath(tmpdir()), 'dsh-local-clip-wrong-picture-'))
  const runner = createMediaRunner()
  try {
    const input = join(project, 'original.mp4')
    const moving = [
      'color=black:size=128x96:rate=24:duration=7',
      "drawbox=x=0:y=24:w=iw:h=40:color=yellow:t=fill:enable='lt(t,3.5)'",
      "drawbox=x=0:y=0:w=iw:h=24:color=white:t=fill:enable='lt(t,3.5)*lt(mod(t,0.5),0.25)'",
    ].join(',')
    const source = await runner.runCommand(ffmpeg, ['-n', '-v', 'error', '-f', 'lavfi', '-i', moving,
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=7',
      '-c:v', 'libx264', '-threads', '1', '-c:a', 'aac', input])
    expect(source.code, source.stderr).toBe(0)
    const originalSha256 = await fileSha256(input)
    let rewrites = 0
    const channel = {
      run: async (command: string, args: readonly string[]) => {
        const offset = args.indexOf('-vf') + 1
        const filter = args[offset]
        if (command !== ffmpeg || offset === 0 || !filter?.startsWith('trim=start_frame=24:end_frame=72,')) {
          return runner.runCommand(command, args)
        }
        rewrites += 1
        const altered = [...args]
        altered[offset] = filter.replace('trim=start_frame=24:end_frame=72,', 'trim=start_frame=96:end_frame=144,')
        altered.splice(altered.length - 1, 0, '-threads', '1')
        return runner.runCommand(command, altered)
      },
    }
    await expect(repairLocalClip({ ffmpeg, ffprobe, channel }, {
      project, episode: 43, input, startMs: 1000, endMs: 3000,
    })).rejects.toThrow('LOCAL_CLIP_PICTURE_CLOCK')
    expect(rewrites).toBe(1)
    expect(await fileSha256(input)).toBe(originalSha256)
    expect(await readdir(join(project, 'editing'))).toEqual([])
  } finally {
    await runner.dispose()
    await rm(project, { recursive: true, force: true })
  }
}, 30_000)

it.skipIf(!hasFfmpeg)('retains an exact sample clock beyond the 64-second AAC timestamp boundary', async () => {
  const project = await mkdtemp(join(await realpath(tmpdir()), 'dsh-local-clip-clock-'))
  const runner = createMediaRunner()
  try {
    const input = join(project, 'original.mp4')
    const source = await runner.runCommand(ffmpeg, ['-n', '-v', 'error', '-f', 'lavfi', '-i', 'color=size=32x32:rate=24',
      '-f', 'lavfi', '-i', 'sine=frequency=340:sample_rate=48000', '-t', '79',
      '-c:v', 'libx264', '-c:a', 'aac', '-ac', '2', input])
    expect(source.code, source.stderr).toBe(0)
    const binding = await repairLocalClip({ ffmpeg, ffprobe, channel: runner.channel },
      { project, episode: 43, input, startMs: 0, endMs: 76583 })
    expect(binding.pictureClock).toEqual({ status: 'unverified', matchingSamples: 0 })
    expect(binding.durationSeconds).toBeCloseTo(1838 / 24, 5)
    expect(await fileSha256(input)).toBe(binding.original.sha256)
    expect(await fileSha256(binding.output.path)).toBe(binding.output.sha256)
  } finally {
    await runner.dispose()
    await rm(project, { recursive: true, force: true })
  }
}, 45_000)
