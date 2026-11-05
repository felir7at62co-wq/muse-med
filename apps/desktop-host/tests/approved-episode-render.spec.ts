/** Desktop hands off a private MP4 only after verifying the staged render. */
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { runDramaRender } from '@deepseek-ai/dsh-tool-episode-render'
import { beforeEach, expect, it, vi } from 'vitest'
import { configurationFixture } from '../../../packages/settings/settings/tests/configuration-fixture.ts'
import { shippedEndingAsset } from '../../../packages/drama/tool-episode-render/tests/harness.ts'
import * as Renderer from '../src/approved-episode-render.ts'

const media = vi.hoisted(() => ({ prepare: vi.fn(), render: vi.fn() }))
vi.mock('@deepseek-ai/dsh-tool-episode-render', async importOriginal => ({
  ...await importOriginal<typeof import('@deepseek-ai/dsh-tool-episode-render')>(),
  prepareStagedEpisodeAudio: media.prepare,
  runDramaRender: media.render,
}))

beforeEach(() => { media.prepare.mockReset(); media.render.mockReset() })

const fileHash = (value: string) => createHash('sha256').update(value).digest('hex')

async function fixture(medium: 'animation_3d' | 'photorealistic' = 'animation_3d') {
  const endingDir = dirname(shippedEndingAsset('ending_audio.mp3'))
  const { ctx, home } = await configurationFixture({ hmr: false, rows: [
    { id: 'config-editor', name: 'cordis:editor' },
    { id: 'settings', name: 'cordis:settings' },
    { id: 'renderer', name: 'cordis:renderer', config: {
      ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe', fontsDir: endingDir, endingAssetsDir: endingDir,
    } },
  ], builtins: { renderer: Renderer } })
  const project = join(home, 'project')
  const review = join(project, 'video_tasks', 'review')
  // Equivalent Windows drive casing must retain the same directory identity.
  const outputPath = join(review, 'private-candidate.mp4').replace(/^[A-Za-z]:/u,
    drive => drive === drive.toUpperCase() ? drive.toLowerCase() : drive.toUpperCase())
  const paths = {
    projectConfig: join(project, 'project_config.json'),
    timeline: join(project, 'timeline.json'),
    subtitle: join(project, 'subtitle.srt'),
    mixProfile: join(project, 'mix.json'),
    bgm: join(project, 'music.wav'),
    clip: join(project, 'reviewed.mp4'),
  }
  const bytes = {
    projectConfig: JSON.stringify({ project_bible: { visual_medium: medium } }),
    timeline: JSON.stringify({ clips: [{ shot: 1, start_us: 0, duration_us: 1_000_000 }],
      delivery: { visual_medium: medium, width: 64, height: 64, fps: 25 } }),
    subtitle: '1\n00:00:00,000 --> 00:00:01,000\nTest\n',
    mixProfile: '{"mode":"music_bed"}',
    bgm: 'planned BGM bytes',
    clip: 'approved clip bytes',
  }
  await mkdir(review, { recursive: true })
  for (const key of Object.keys(paths) as Array<keyof typeof paths>) await writeFile(paths[key], bytes[key])
  const input = {
    projectDir: project, episode: 1, clips: [{ shot: 1, path: paths.clip, sha256: fileHash(bytes.clip) }],
    timelinePath: paths.timeline, subtitlePath: paths.subtitle, mixProfilePath: paths.mixProfile, bgmPath: paths.bgm, outputPath,
    inputHashes: { projectConfig: fileHash(bytes.projectConfig), timeline: fileHash(bytes.timeline), subtitle: fileHash(bytes.subtitle),
      mixProfile: fileHash(bytes.mixProfile), bgm: fileHash(bytes.bgm) },
  }
  return { paths, bytes, input, staging: join(project, 'video_tasks', 'episode-render-staging'),
    render: () => ctx.approvedEpisodeRenderer.render(input, new AbortController().signal) }
}

it.each([
  ['projectConfig', 'Project configuration'], ['timeline', 'Timeline'], ['subtitle', 'Subtitle'],
  ['mixProfile', 'Mix profile'], ['bgm', 'Background music'], ['clip', 'Approved source for shot 1'],
] as const)('rejects changed %s bytes before invoking media tools', async (key, label) => {
  const f = await fixture()
  await writeFile(f.paths[key], 'changed after planning')
  await expect(f.render()).rejects.toThrow(`${label} changed before rendering`)
  expect(media.prepare).not.toHaveBeenCalled()
  expect(media.render).not.toHaveBeenCalled()
  await expect(stat(f.input.outputPath)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readdir(f.staging)).toEqual([])
})

it.each(['animation_3d', 'photorealistic'] as const)('verifies %s output before linking the private candidate', async (medium) => {
  const f = await fixture(medium)
  const check = { id: 'fixture', ok: true, detail: 'verified' }
  media.prepare.mockImplementation(async ({ project }: { project: string }) => {
    expect(await readFile(join(project, 'video', '01', 'shot_001.mp4'), 'utf8')).toBe(f.bytes.clip)
  })
  media.render.mockImplementation(async (call: Parameters<typeof runDramaRender>[0]) => {
    await expect(stat(f.input.outputPath)).rejects.toMatchObject({ code: 'ENOENT' })
    if (call.output === undefined) throw new Error('Missing staging output')
    if (call.method === 'render') {
      expect(call.project).not.toBe(f.input.projectDir)
      expect(await readFile(join(call.project, 'project_config.json'), 'utf8')).toBe(f.bytes.projectConfig)
      expect(await readFile(call.timeline!, 'utf8')).toBe(f.bytes.timeline)
      expect(await readFile(call.subtitleSrt!, 'utf8')).toBe(f.bytes.subtitle)
      expect(await readFile(call.mixProfile!, 'utf8')).toBe(f.bytes.mixProfile)
      expect(await readFile(call.bgm!, 'utf8')).toBe(f.bytes.bgm)
      if (medium === 'photorealistic') {
        expect(call.endingAudio).toBe(join(call.project, 'assets', 'ending_audio.mp3'))
        expect(call.endingEffect).toBe(join(call.project, 'assets', 'ending_effect.mp4'))
        expect((await readFile(call.endingAudio!)).equals(await readFile(shippedEndingAsset('ending_audio.mp3')))).toBe(true)
        expect((await readFile(call.endingEffect!)).equals(await readFile(shippedEndingAsset('ending_effect.mp4')))).toBe(true)
      } else {
        expect(call.endingAudio).toBeUndefined()
        expect(call.endingEffect).toBeUndefined()
      }
      await mkdir(dirname(call.output))
      await writeFile(call.output, 'verified MP4 bytes')
    } else {
      expect(call.method).toBe('verify')
      expect(await readFile(call.output, 'utf8')).toBe('verified MP4 bytes')
    }
    return { ok: true, output: call.output, checks: [check], media: { duration_seconds: 1 }, failures: [] }
  })
  await expect(f.render()).resolves.toEqual({ durationSeconds: 1, checks: [check, check] })
  expect(media.prepare).toHaveBeenCalledOnce()
  expect(await readFile(f.input.outputPath, 'utf8')).toBe('verified MP4 bytes')
  expect(await readdir(f.staging)).toEqual([])
  await expect(f.render()).rejects.toThrow('Episode output already exists')
  expect(await readFile(f.input.outputPath, 'utf8')).toBe('verified MP4 bytes')
})

it('removes the staged MP4 and keeps the candidate absent when output verification fails', async () => {
  const f = await fixture()
  media.render.mockImplementation(async (call: Parameters<typeof runDramaRender>[0]) => {
    if (call.method === 'verify') return { ok: false, failures: ['Invalid output audio'] }
    if (call.output === undefined) throw new Error('Missing staging output')
    await mkdir(dirname(call.output))
    await writeFile(call.output, 'encoded MP4 bytes')
    return { ok: true, output: call.output }
  })
  await expect(f.render()).rejects.toThrow('Invalid output audio')
  await expect(stat(f.input.outputPath)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readdir(f.staging)).toEqual([])
})
