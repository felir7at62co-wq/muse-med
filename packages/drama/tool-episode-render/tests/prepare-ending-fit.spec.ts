/** Saved ending choices and malformed prior timelines use the existing preparation policy. */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createMediaToolkit } from '../src/ffmpeg.ts'
import { episodePaths } from '../src/paths.ts'
import { prepareEpisode } from '../src/prepare.ts'
import { cleanup, probeHandler, stubChannel, tempProject, writePlaceholder } from './harness.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(cleanup)) })
async function fixture() {
  const project = await tempProject(); roots.push(project)
  const source = join(project, 'original.mp4'), shotsPath = join(project, 'shots.json'), subtitleSrt = join(project, 'source.srt')
  await writePlaceholder(source, 'source')
  await writeFile(shotsPath, JSON.stringify({ shots: [{ shot: 1, video: 'original.mp4' }] }))
  await writeFile(subtitleSrt, '')
  const paths = episodePaths(project, '01'); await mkdir(dirname(paths.timeline), { recursive: true })
  const channel = stubChannel([probeHandler({ [source]: { durationSeconds: 1, video: {}, audio: {} } }), () => ({})])
  return { paths, channel, input: { project, episode: '01', shotsPath, subtitleSrt,
    toolkit: createMediaToolkit({ ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', channel: channel.channel }),
    defaultEndingEffectFit: 'stretch_to_window' as const } }
}

it.each(['source_once', 'stretch_to_window'] as const)('preserves the prior explicit ending choice %s', async (fit) => {
  const f = await fixture()
  await writeFile(f.paths.timeline, JSON.stringify({ ending_effect_fit: fit }))
  expect((await prepareEpisode(f.input)).timeline.endingEffectFit).toBe(fit)
})

it.each([null, {}, 'not a timeline'])('uses the deployment choice when a prior JSON document has no ending choice: %j', async (value) => {
  const f = await fixture()
  await writeFile(f.paths.timeline, JSON.stringify(value))
  expect((await prepareEpisode(f.input)).timeline.endingEffectFit).toBe('stretch_to_window')
})

it('uses the deployment choice when no prior timeline exists', async () => {
  const f = await fixture()
  expect((await prepareEpisode(f.input)).timeline.endingEffectFit).toBe('stretch_to_window')
})

it.each([
  ['{"ending_effect_fit":"invalid"}', '旧时间线的片尾适配值无效'],
  ['{"ending_effect_fit":', '旧时间线无法解析'],
])('warns before replacing an unusable prior ending choice: %s', async (text, warning) => {
  const f = await fixture()
  await writeFile(f.paths.timeline, text)
  const result = await prepareEpisode(f.input)
  expect(result.timeline.endingEffectFit).toBe('stretch_to_window')
  expect(result.warnings.some(item => item.includes(warning))).toBe(true)
})

it('preserves a prior timeline directory and rejects its read error before media runs', async () => {
  const f = await fixture()
  await mkdir(f.paths.timeline)
  await expect(prepareEpisode(f.input)).rejects.toMatchObject({ code: 'EISDIR' })
  expect(f.channel.calls).toHaveLength(0)
  await expect(readFile(f.paths.timeline)).rejects.toMatchObject({ code: 'EISDIR' })
})
