/** Staged inputs retain the current renderer's audio clock and delivery policy. */
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { prepareStagedEpisodeAudio, stagedEpisodeEndingAssets } from '../src/prepare.ts'
import { ENDING_AUDIO_ASSET, ENDING_EFFECT_ASSET } from '../src/delivery.ts'
import { episodePaths } from '../src/paths.ts'
import { cleanup, stubChannel, tempProject } from './harness.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(async (root) => { await cleanup(root) })) })
async function fixture(medium: 'animation_3d' | 'photorealistic' = 'photorealistic') {
  const project = await tempProject(); roots.push(project)
  const timelinePath = join(project, 'timeline.json')
  await writeFile(timelinePath, JSON.stringify({ clips: [
    { shot: 1, start_us: 0, duration_us: 1_000_000 }, { shot: 2, start_us: 1_000_000, duration_us: 2_000_000 },
  ], body_end: 3, delivery: { width: 1440, height: 2560, fps: 60, visual_medium: medium } }))
  return { project, episode: '01', timelinePath }
}

it('assembles the original-audio master from staged shot videos on the authored clock', async () => {
  const input = await fixture()
  const channel = stubChannel([() => ({})])
  await prepareStagedEpisodeAudio(input, { ffmpeg: '/captured/ffmpeg', ffprobe: '/captured/ffprobe', channel: channel.channel })
  const paths = episodePaths(input.project, input.episode)
  expect(channel.calls).toHaveLength(1)
  expect(channel.calls[0]?.command).toBe('/captured/ffmpeg')
  expect(channel.calls[0]?.args).toEqual([
    '-y', '-v', 'error', '-i', join(paths.videoDir, 'shot_001.mp4'), '-i', join(paths.videoDir, 'shot_002.mp4'),
    '-filter_complex', '[0:a]atrim=0:1.000000,asetpts=N/SR/TB,adelay=delays=0:all=1[a0];'
      + '[1:a]atrim=0:2.000000,asetpts=N/SR/TB,adelay=delays=1000:all=1[a1];'
      + '[a0][a1]amix=inputs=2:duration=longest:normalize=0[a]',
    '-map', '[a]', '-c:a', 'pcm_s16le', '-ar', '48000', paths.masterAudio,
  ])
})

it('uses the captured per-shot audio and rejects an incomplete audio inventory', async () => {
  const input = await fixture(), channel = stubChannel([() => ({})])
  const audioPaths = [join(input.project, 'stage', 'one.wav'), join(input.project, 'stage', 'two.wav')]
  const settings = { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', channel: channel.channel }
  await prepareStagedEpisodeAudio({ ...input, audioPaths }, settings)
  expect(channel.calls[0]?.args.slice(3, 7)).toEqual(['-i', audioPaths[0], '-i', audioPaths[1]])
  await expect(prepareStagedEpisodeAudio({ ...input, audioPaths: [audioPaths[0]!] }, settings)).rejects.toThrow('音轨数量')
  expect(channel.calls).toHaveLength(1)
})

it('propagates native audio failures instead of claiming a complete master', async () => {
  const input = await fixture(), channel = stubChannel([() => ({ code: 1, stderr: 'controlled unavailable audio' })])
  await expect(prepareStagedEpisodeAudio(input, { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', channel: channel.channel })).rejects.toThrow()
})

it('selects exact bundled ending descriptors for the current photorealistic policy', async () => {
  expect(await stagedEpisodeEndingAssets(await fixture(), {})).toEqual({ audio: ENDING_AUDIO_ASSET, effect: ENDING_EFFECT_ASSET })
})

it('keeps animation body-only through the current delivery policy', async () => {
  expect(await stagedEpisodeEndingAssets(await fixture('animation_3d'), {})).toBeUndefined()
})

it('does not let an obsolete saved subtitle style override the enforced deployment visual', async () => {
  const input = await fixture()
  await writeFile(input.timelinePath, JSON.stringify({ clips: [{ shot: 1, start_us: 0, duration_us: 1_000_000 }], body_end: 1,
    delivery: { width: 1440, height: 2560, fps: 60, visual_medium: 'photorealistic', subtitle_visual: { invalid_old_style: true } } }))
  const settings = { enforceSubtitleVisual: true, defaultSubtitleVisual: {
    schema_version: 1 as const, reference_width: 480, reference_height: 854, font_size_px: 46,
    outline_px: 1.25, center_y_ratio: 0.736747073, max_width_ratio: 0.9,
  } }
  expect(await stagedEpisodeEndingAssets(input, settings)).toEqual({ audio: ENDING_AUDIO_ASSET, effect: ENDING_EFFECT_ASSET })
  await expect(stagedEpisodeEndingAssets(input, {})).rejects.toThrow()
})
