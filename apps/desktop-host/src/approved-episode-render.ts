/** Host-owned renderer for project episodes made from reviewed video artifacts. */
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { copyFile, link, lstat, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { dirname, extname, join, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import type { Context } from '@deepseek-ai/cordis'
import { prepareStagedEpisodeAudio, runDramaRender, shotFileName } from '@deepseek-ai/dsh-tool-episode-render'
import z from '@deepseek-ai/schemastery'

interface ApprovedEpisodeRenderInput {
  readonly projectDir: string
  readonly episode: number
  readonly clips: readonly { readonly shot: number; readonly path: string; readonly sha256: string }[]
  readonly timelinePath: string
  readonly subtitlePath: string
  readonly mixProfilePath: string
  readonly bgmPath?: string
  readonly outputPath: string
}
interface ApprovedEpisodeRenderResult {
  readonly durationSeconds: number
  readonly checks: readonly { readonly id: string; readonly ok: boolean; readonly detail: string }[]
}
/** Media binaries and subtitle font used by the packaged renderer. */
export interface Config {
  /** FFmpeg executable resolved by the Desktop Host. */
  readonly ffmpegPath: string
  /** FFprobe executable resolved by the Desktop Host. */
  readonly ffprobePath: string
  /** Font directory packaged with Desktop. */
  readonly fontsDir: string
  /** Directory containing Desktop's shipped ending assets for marked deliveries. */
  readonly endingAssetsDir?: string
}

/** Reject missing or non-regular project inputs before staging. */
async function assertFile(path: string): Promise<string> {
  const actual = await realpath(path)
  const entry = await lstat(path)
  if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('Episode render inputs must be regular files')
  return actual
}

/** Hash staged bytes without buffering a full episode clip in Host memory. */
async function fileHash(path: string, signal: AbortSignal): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path, { signal })) {
    if (!(chunk instanceof Uint8Array)) throw new Error('Episode render input stream returned non-binary data')
    hash.update(chunk)
  }
  return hash.digest('hex')
}

/** Ensure the project output folder exists and does not follow a link. */
async function assertOutput(path: string): Promise<void> {
  const parent = dirname(path)
  await mkdir(parent, { recursive: true })
  const actual = await realpath(parent)
  if (resolve(parent) !== actual) throw new Error('Episode output directory must be a local project directory')
  try {
    const entry = await lstat(path)
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('Episode output already exists with an invalid file type')
    throw new Error('Episode output already exists')
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error
  }
}

/** Render reviewed clips and their embedded audio against the authored timeline. */
async function renderApprovedEpisode(input: ApprovedEpisodeRenderInput, signal: AbortSignal,
  config: Config): Promise<ApprovedEpisodeRenderResult> {
  const root = await realpath(input.projectDir)
  const stagingParent = join(root, 'video_tasks', 'episode-render-staging')
  await mkdir(stagingParent, { recursive: true })
  const parentInfo = await lstat(stagingParent)
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink() || await realpath(stagingParent) !== stagingParent) {
    throw new Error('Episode staging directory must be a real project directory')
  }
  const stage = await mkdtemp(join(stagingParent, 'render-'))
  const episode = String(input.episode).padStart(2, '0')
  const stagingOutput = join(stage, 'exports', `episode-${episode}.mp4`)
  try {
    signal.throwIfAborted()
    await mkdir(join(stage, 'editing'), { recursive: true })
    await mkdir(join(stage, 'video', episode), { recursive: true })
    await mkdir(join(stage, 'audio'), { recursive: true })
    await copyFile(await assertFile(join(root, 'project_config.json')), join(stage, 'project_config.json'))
    for (const clip of input.clips) {
      signal.throwIfAborted()
      const source = await assertFile(clip.path)
      const staged = join(stage, 'video', episode, shotFileName(clip.shot))
      await pipeline(createReadStream(source), createWriteStream(staged, { flags: 'wx', mode: 0o600 }), { signal })
      if (await fileHash(staged, signal) !== clip.sha256) {
        throw new Error(`Approved source for shot ${String(clip.shot)} changed before rendering`)
      }
    }
    const subtitlePath = join(stage, 'editing', `${episode}.srt`)
    const profilePath = join(stage, 'editing', `${episode}-mix-profile.json`)
    const timelinePath = join(stage, 'editing', `${episode}-timeline.json`)
    await copyFile(await assertFile(input.timelinePath), timelinePath)
    await copyFile(await assertFile(input.subtitlePath), subtitlePath)
    await copyFile(await assertFile(input.mixProfilePath), profilePath)
    const bgmPath = input.bgmPath === undefined ? undefined : join(stage, 'audio', `${episode}-bgm${extname(input.bgmPath)}`)
    if (input.bgmPath !== undefined && bgmPath !== undefined) await copyFile(await assertFile(input.bgmPath), bgmPath)

    const settings = {
      ffmpeg: config.ffmpegPath, ffprobe: config.ffprobePath, masterVolume: 1.45, bgmVolume: 0.24,
      maxBgmVolume: 1, preferNvenc: true, fontsDir: config.fontsDir,
      subtitleFontFamily: 'SimHei', watermarkFontFamily: 'Microsoft YaHei',
    }
    await prepareStagedEpisodeAudio({ project: stage, episode, timelinePath }, settings)
    signal.throwIfAborted()
    const rendered = await runDramaRender({ method: 'render', project: stage, episode: input.episode,
      timeline: timelinePath, subtitleSrt: subtitlePath, mixProfile: profilePath,
      ...(config.endingAssetsDir === undefined ? {} : {
        endingAudio: join(config.endingAssetsDir, 'ending_audio.mp3'),
        endingEffect: join(config.endingAssetsDir, 'ending_effect.mp4'),
      }),
      ...(bgmPath === undefined ? {} : { bgm: bgmPath }), lastShot: input.clips.length, output: stagingOutput, force: true }, settings)
    if (!rendered.ok || rendered.output !== stagingOutput) throw new Error(rendered.failures.join('\n') || 'Episode render checks failed')
    signal.throwIfAborted()
    const verified = await runDramaRender({ method: 'verify', project: stage, episode: input.episode,
      timeline: timelinePath, subtitleSrt: subtitlePath, output: stagingOutput }, settings)
    if (!verified.ok) throw new Error(verified.failures.join('\n') || 'Episode output verification failed')
    const checks = [...rendered.checks, ...verified.checks].map(({ id, ok, detail }) => ({ id, ok, detail }))
    if (checks.some(check => !check.ok)) throw new Error('Episode render contains a failed delivery check')
    await assertOutput(input.outputPath)
    const output = await assertFile(stagingOutput)
    signal.throwIfAborted()
    await link(output, input.outputPath)
    return { durationSeconds: verified.media.duration_seconds, checks }
  } finally {
    await rm(stage, { recursive: true, force: true })
  }
}

/** Register the provider used by the browser's approved-episode delivery Remote. */
export function apply(ctx: Context, config: Config): void {
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.effect(() => settingsCtx.provide('approvedEpisodeRenderer', {
      render: (input, signal) => renderApprovedEpisode(input, signal, config),
    }))
  })
}

/** Validated Host plugin configuration. */
export const Config = z.object({
  ffmpegPath: z.string().min(1).required(),
  ffprobePath: z.string().min(1).required(),
  fontsDir: z.string().min(1).required(),
  endingAssetsDir: z.string().min(1),
})

/** Loader identity for the approved episode renderer. */
export const name = 'desktop-approved-episode-render'
