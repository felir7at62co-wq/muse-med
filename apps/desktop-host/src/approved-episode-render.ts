/** Host-owned renderer for project episodes made from reviewed video artifacts. */
import { createHash } from 'node:crypto'
import { constants, createReadStream, createWriteStream } from 'node:fs'
import { link, lstat, mkdir, mkdtemp, open, realpath, rm } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, relative, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import type { Context } from '@deepseek-ai/cordis'
import { createFileCaptureChannel, prepareStagedEpisodeAudio, runDramaRender, shotFileName,
  stagedEpisodeEndingAssets } from '@deepseek-ai/dsh-tool-episode-render'
import type { ApprovedEpisodeRenderer } from '@deepseek-ai/dsh-tool-jubian'
import z from '@deepseek-ai/schemastery'

type ApprovedEpisodeRenderInput = Parameters<ApprovedEpisodeRenderer['render']>[0]
type ApprovedEpisodeRenderResult = Awaited<ReturnType<ApprovedEpisodeRenderer['render']>>

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

/** Require a regular staged MP4 before linking the verified candidate. */
async function assertFile(path: string): Promise<string> {
  const actual = await realpath(path)
  const entry = await lstat(path)
  if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('Episode render output must be a regular file')
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

/** Verify the bytes that the media tools will read from this run's private directory. */
async function stageInput(path: string, target: string, sha256: string, label: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  const expected = await lstat(path)
  if (!expected.isFile() || expected.isSymbolicLink()) throw new Error(`${label} must be a regular file`)
  const source = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const actual = await source.stat()
    if (!actual.isFile() || actual.dev !== expected.dev || actual.ino !== expected.ino) {
      throw new Error(`${label} changed before rendering`)
    }
    await pipeline(source.createReadStream({ autoClose: false }),
      createWriteStream(target, { flags: 'wx', mode: 0o600 }), { signal })
  } finally {
    await source.close()
  }
  if (await fileHash(target, signal) !== sha256) throw new Error(`${label} changed before rendering`)
}

/** Require a contained physical directory while accepting Windows short-name and case aliases. */
async function assertOutputDirectory(parent: string, root: string): Promise<void> {
  const actual = await realpath(parent)
  const invalid = () => new Error('Episode output directory must be a local project directory')
  const suffix = relative(root, actual)
  if (suffix === '..' || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) throw invalid()
  if (process.platform !== 'win32') {
    if (relative(parent, actual) !== '') throw invalid()
    return
  }
  const expected = await lstat(parent, { bigint: true })
  const canonical = await lstat(actual, { bigint: true })
  if (!expected.isDirectory() || expected.isSymbolicLink() || !canonical.isDirectory()
    || canonical.isSymbolicLink() || expected.dev !== canonical.dev || expected.ino !== canonical.ino) throw invalid()
  // Directory identity also follows ancestor redirects, so each requested ancestor must be physical.
  let ancestor = dirname(parent)
  while (true) {
    const info = await lstat(ancestor)
    if (!info.isDirectory() || info.isSymbolicLink()) throw invalid()
    const next = dirname(ancestor)
    if (next === ancestor) break
    ancestor = next
  }
}

/** Check the private candidate directory and refuse to replace an existing file. */
async function assertOutput(path: string, root: string): Promise<void> {
  await assertOutputDirectory(dirname(path), root)
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
  signal.throwIfAborted()
  const root = await realpath(input.projectDir)
  await assertOutput(input.outputPath, root)
  const tasks = join(root, 'video_tasks')
  const tasksInfo = await lstat(tasks)
  if (!tasksInfo.isDirectory() || tasksInfo.isSymbolicLink() || relative(tasks, await realpath(tasks)) !== '') {
    throw new Error('Episode task directory must be a real project directory')
  }
  const stagingParent = join(tasks, 'episode-render-staging')
  await mkdir(stagingParent, { recursive: true })
  const parentInfo = await lstat(stagingParent)
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink() || relative(stagingParent, await realpath(stagingParent)) !== '') {
    throw new Error('Episode staging directory must be a real project directory')
  }
  const stage = await mkdtemp(join(stagingParent, 'render-'))
  const episode = String(input.episode).padStart(2, '0')
  const stagingOutput = join(stage, 'exports', `episode-${episode}.mp4`)
  try {
    await mkdir(join(stage, 'editing'), { recursive: true })
    await mkdir(join(stage, 'video', episode), { recursive: true })
    await mkdir(join(stage, 'audio'), { recursive: true })
    const subtitlePath = join(stage, 'editing', `${episode}.srt`)
    const profilePath = join(stage, 'editing', `${episode}-mix-profile.json`)
    const timelinePath = join(stage, 'editing', `${episode}-timeline.json`)
    const { inputHashes } = input
    await stageInput(join(root, 'project_config.json'), join(stage, 'project_config.json'), inputHashes.projectConfig, 'Project configuration', signal)
    await stageInput(input.timelinePath, timelinePath, inputHashes.timeline, 'Timeline', signal)
    await stageInput(input.subtitlePath, subtitlePath, inputHashes.subtitle, 'Subtitle', signal)
    await stageInput(input.mixProfilePath, profilePath, inputHashes.mixProfile, 'Mix profile', signal)
    let bgmPath: string | undefined
    if (input.bgmPath !== undefined) {
      if (inputHashes.bgm === undefined) throw new Error('Episode render is missing the planned background music hash')
      bgmPath = join(stage, 'audio', `${episode}-bgm${extname(input.bgmPath)}`)
      await stageInput(input.bgmPath, bgmPath, inputHashes.bgm, 'Background music', signal)
    } else if (inputHashes.bgm !== undefined) {
      throw new Error('Episode render is missing the planned background music file')
    }
    for (const clip of input.clips) {
      await stageInput(clip.path, join(stage, 'video', episode, shotFileName(clip.shot)),
        clip.sha256, `Approved source for shot ${String(clip.shot)}`, signal)
    }

    const stagedEpisode = { project: stage, episode, timelinePath }
    const endingAssets = await stagedEpisodeEndingAssets(stagedEpisode)
    let ending: { endingAudio: string; endingEffect: string } | undefined
    if (endingAssets !== undefined) {
      if (config.endingAssetsDir === undefined) throw new Error('Packaged ending assets are unavailable for this episode')
      const directory = join(stage, 'assets')
      await mkdir(directory)
      const audioName = basename(endingAssets.audio.file)
      const effectName = basename(endingAssets.effect.file)
      ending = { endingAudio: join(directory, audioName), endingEffect: join(directory, effectName) }
      await stageInput(join(config.endingAssetsDir, audioName), ending.endingAudio,
        endingAssets.audio.sha256, endingAssets.audio.label, signal)
      await stageInput(join(config.endingAssetsDir, effectName), ending.endingEffect,
        endingAssets.effect.sha256, endingAssets.effect.label, signal)
    }
    const settings = {
      ffmpeg: config.ffmpegPath, ffprobe: config.ffprobePath, masterVolume: 1.45, bgmVolume: 0.24,
      maxBgmVolume: 1, preferNvenc: true, fontsDir: config.fontsDir,
      subtitleFontFamily: 'SimHei', watermarkFontFamily: 'Microsoft YaHei', channel: createFileCaptureChannel(signal),
    }
    await prepareStagedEpisodeAudio(stagedEpisode, settings)
    signal.throwIfAborted()
    const rendered = await runDramaRender({ method: 'render', project: stage, episode: input.episode,
      timeline: timelinePath, subtitleSrt: subtitlePath, mixProfile: profilePath,
      ...ending,
      ...(bgmPath === undefined ? {} : { bgm: bgmPath }), lastShot: input.clips.length, output: stagingOutput, force: true }, settings)
    if (!rendered.ok || rendered.output !== stagingOutput) throw new Error(rendered.failures.join('\n') || 'Episode render checks failed')
    signal.throwIfAborted()
    const verified = await runDramaRender({ method: 'verify', project: stage, episode: input.episode,
      timeline: timelinePath, subtitleSrt: subtitlePath, output: stagingOutput }, settings)
    if (!verified.ok) throw new Error(verified.failures.join('\n') || 'Episode output verification failed')
    const checks = [...rendered.checks, ...verified.checks].map(({ id, ok, detail }) => ({ id, ok, detail }))
    if (checks.some(check => !check.ok)) throw new Error('Episode render contains a failed delivery check')
    await assertOutput(input.outputPath, root)
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
