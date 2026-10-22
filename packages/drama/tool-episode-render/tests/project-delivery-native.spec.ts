/** Real local FFmpeg regression for project subtitle placement and independent mix controls. */
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { resolveSettings, runDramaRender } from '../src/index.ts'
import type { MediaCommandOutcome, ProcessChannel } from '../src/types.ts'

/** Own every local process until close, including an outer test timeout. */
function processOwner(): { channel: ProcessChannel; dispose: () => Promise<void> } {
  const controller = new AbortController()
  const children = new Set<ChildProcess>()
  const pending = new Set<Promise<MediaCommandOutcome>>()
  const channel: ProcessChannel = {
    run(command, args) {
      const running = new Promise<MediaCommandOutcome>((resolve) => {
        const child = spawn(command, [...args], { windowsHide: true, signal: controller.signal, stdio: ['ignore', 'pipe', 'pipe'] })
        children.add(child)
        let stdout = '', stderr = ''
        child.stdout?.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk })
        child.stderr?.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
        child.on('error', (error) => { stderr += error.message })
        const deadline = setTimeout(() => { child.kill() }, 30_000)
        child.once('close', (code) => {
          clearTimeout(deadline)
          children.delete(child)
          resolve({ code: code ?? 127, stdout, stderr })
        })
      })
      pending.add(running)
      void running.finally(() => { pending.delete(running) })
      return running
    },
  }
  return { channel, async dispose() {
    controller.abort()
    for (const child of children) child.kill()
    await Promise.all(pending)
  } }
}

/** Locate bright subtitle pixels on the generated black test picture. */
function textBounds(pixels: Buffer, width: number, height: number) {
  let left = width, top = height, right = -1, bottom = -1
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if ((pixels[y * width + x] ?? 0) < 100) continue
    left = Math.min(left, x); right = Math.max(right, x)
    top = Math.min(top, y); bottom = Math.max(bottom, y)
  }
  return { left, right, top, bottom, height: bottom - top + 1 }
}

/** Measure a known sinusoid by both quadratures, independent of AAC/limiter phase delay. */
function amplitude(pcm: Buffer, frequency: number): number {
  let sine = 0, cosine = 0, count = 0
  for (let frame = 9_600; frame < 38_400; frame++) {
    const sample = pcm.readFloatLE(frame * 4)
    const angle = 2 * Math.PI * frequency * frame / 48_000
    sine += sample * Math.sin(angle)
    cosine += sample * Math.cos(angle)
    count++
  }
  return 2 * Math.hypot(sine, cosine) / count
}

const ffmpeg = process.env.DSH_FFMPEG_PATH
const ffprobe = process.env.DSH_FFPROBE_PATH

it.skipIf(!ffmpeg || !ffprobe)('renders changed project style and gains into real picture and AAC without changing the mix algorithm', async () => {
  const root = await mkdtemp(join(tmpdir(), 'drama-project-delivery-native-'))
  const owner = processOwner()
  onTestFinished(async () => { await owner.dispose(); await rm(root, { recursive: true, force: true }) })
  if (!ffmpeg || !ffprobe) throw new Error('native test requires explicit local media binaries')
  async function run(args: readonly string[]) {
    const result = await owner.channel.run(ffmpeg!, args)
    expect(result.code, result.stderr).toBe(0)
  }
  const video = join(root, 'source.mp4'), bgm = join(root, 'bed.wav')
  await run(['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=black:s=320x180:r=12:d=1',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=1',
    '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ar', '48000', video])
  await run(['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000:duration=1', bgm])
  await writeFile(join(root, 'shots.json'), JSON.stringify({ shots: [{ shot: 1, video }] }))
  await writeFile(join(root, 'source.srt'), '1\n00:00:00,000 --> 00:00:01,000\nTEST\n')
  const settings = { ...resolveSettings({ ffmpegPath: ffmpeg, ffprobePath: ffprobe, preferNvenc: false,
    fontsDir: process.env.DSH_FONTS_DIR ?? 'C:/Windows/Fonts', subtitleFontFamily: 'Arial' }), channel: owner.channel }
  const variants = [
    { name: 'first', fontSize: 16, margin: 22, master: 0.6, music: 0.2 },
    { name: 'second', fontSize: 30, margin: 8, master: 0, music: 0.5 },
  ]
  const pictures: ReturnType<typeof textBounds>[] = []
  for (const variant of variants) {
    const subtitle = { font_family: 'Arial', font_size_px: variant.fontSize, margin_bottom_px: variant.margin }
    const audio = { master_gain: variant.master, bgm_gain: variant.music }
    await writeFile(join(root, 'project_config.json'), JSON.stringify({ project_bible: { visual_medium: 'animation_3d',
      delivery: { width: 320, height: 180, fps: 12, subtitle, audio } } }))
    const prepared = await runDramaRender({ method: 'prepare', project: root, episode: 1,
      shots: 'shots.json', subtitleSrt: 'source.srt', bgm }, settings)
    expect(prepared.render_preview).toMatchObject({ subtitle: { font_family: 'Arial', font_size_output_px: variant.fontSize },
      audio: { master_gain: variant.master, bgm_gain: variant.music } })
    const output = join(root, `${variant.name}.mp4`)
    const rendered = await runDramaRender({ method: 'render', project: root, episode: 1,
      timeline: 'editing/01-timeline.json', subtitleSrt: 'editing/01.srt', lastShot: 1, bgm, output }, settings)
    expect(rendered.media).toMatchObject({ width: 320, height: 180, fps: 12, has_audio: true })
    expect(rendered.render_preview?.audio).toMatchObject({ master_gain: variant.master, bgm_gain: variant.music })
    const picture = join(root, `${variant.name}.gray`), pcm = join(root, `${variant.name}.f32`)
    await run(['-y', '-v', 'error', '-ss', '0.5', '-i', output, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', picture])
    await run(['-y', '-v', 'error', '-i', output, '-map', '0:a:0', '-ac', '1', '-ar', '48000', '-f', 'f32le', pcm])
    await run(['-v', 'error', '-xerror', '-i', output, '-f', 'null', '-'])
    const samples = await readFile(pcm)
    expect(amplitude(samples, 440)).toBeCloseTo(0.125 * variant.master, 2)
    expect(amplitude(samples, 880)).toBeCloseTo(0.125 * variant.music, 2)
    pictures.push(textBounds(await readFile(picture), 320, 180))
    const log = await readFile(join(root, 'exports', '.render_cache', '01', 'render.log'), 'utf8')
    expect(log).toContain(`"master_gain":${String(variant.master)},"bgm_gain":${String(variant.music)}`)
    if (variant.name === 'second') expect(rendered.reused_shots).toEqual([1])
  }
  const [first, second] = pictures
  expect(first?.height).toBeGreaterThan(3)
  expect(second?.height).toBeGreaterThan((first?.height ?? 0) * 1.5)
  expect(second?.bottom).toBeGreaterThan((first?.bottom ?? 0) + 8)
}, 90_000)
