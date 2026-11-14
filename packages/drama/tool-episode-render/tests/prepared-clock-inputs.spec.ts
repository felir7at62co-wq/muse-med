/** Private subtitle inputs retain the original picture, audio and timeline identities. */
import { createHash } from 'node:crypto'
import { mkdir, realpath, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { fileSha256 } from '../src/cache.ts'
import { episodePaths } from '../src/paths.ts'
import { preparedSubtitleClockInputs, prepareStagedEpisodeAudio } from '../src/prepare.ts'
import { subtitleClockPath, writeSubtitleClock } from '../src/subtitle-clock.ts'
import { cleanup, srtDocument, stubChannel, tempProject, writePlaceholder } from './harness.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(cleanup)) })

async function fixture() {
  const project = await realpath(await tempProject())
  roots.push(project)
  const paths = episodePaths(project, '02')
  const video = join(paths.videoDir, 'shot_001.mp4'), audio = join(project, 'separate.wav')
  const subtitle = srtDocument([{ start: '00:00:00,100', end: '00:00:00,500', text: '台词' }])
  await Promise.all([writePlaceholder(video, 'original picture'), writePlaceholder(audio, 'original audio'),
    writePlaceholder(paths.masterAudio, 'original master'), writePlaceholder(paths.subtitle, subtitle),
    writePlaceholder(paths.timeline, JSON.stringify({ clips: [{ shot: 1, start_us: 0, duration_us: 1_000_000 }], body_end: 1 }))])
  const source = { shot: 1, video: 'original.mp4', audio: 'original.mp4' }
  const manifest: Record<string, unknown> = { shots: [source] }
  const save = async (prefix = '') => { await writePlaceholder(paths.sources, prefix + JSON.stringify(manifest)) }
  const read = async (signal?: AbortSignal) => await preparedSubtitleClockInputs(project, '02', paths.timeline, paths.subtitle, undefined, signal)
  return { project, paths, video, audio, subtitle, source, manifest, save, read }
}

it.each(['picture audio', 'external audio', 'prepared clock', 'generated subtitle'] as const)
('captures exact private subtitle inputs: %s', async (kind) => {
  const f = await fixture()
  if (kind === 'external audio') f.source.audio = f.audio
  const metadata = kind === 'prepared clock' || kind === 'generated subtitle'
  if (metadata) {
    f.manifest.master_audio_sha256 = await fileSha256(f.paths.masterAudio)
    f.manifest.timeline_clips = [{ shot: 1, start_us: 0, duration_us: 1_000_000 }]
  }
  if (kind === 'generated subtitle') {
    await writeSubtitleClock(f.paths.subtitle, f.subtitle, '02', [{ source: f.source, video: f.video, audio: f.video, durationUs: 1_000_000 }])
  }
  await f.save(kind === 'prepared clock' ? '\ufeff' : '')
  const result = await f.read()
  expect(result).toEqual({ clockPath: subtitleClockPath(f.paths.subtitle), manifestPath: f.paths.sources,
    manifestSha256: await fileSha256(f.paths.sources),
    manifestBytes: Buffer.byteLength((kind === 'prepared clock' ? '\ufeff' : '') + JSON.stringify(f.manifest)),
    clockPresent: kind === 'generated subtitle', ...(metadata ? { masterPath: f.paths.masterAudio } : {}),
    shots: [{ shot: 1, video: f.video, audio: kind === 'external audio' ? f.audio : f.video }] })
})

it.each(['invalid JSON', 'non-object', 'extra shot', 'wrong shot', 'missing master hash', 'invalid master hash',
  'changed master', 'missing clock', 'clock not array', 'clock length', 'clock missing row', 'clock shot', 'clock start',
  'clock duration', 'generated without metadata', 'required speech without metadata'] as const)
('rejects incomplete or changed private subtitle evidence: %s', async (fault) => {
  const f = await fixture()
  f.manifest.master_audio_sha256 = await fileSha256(f.paths.masterAudio)
  f.manifest.timeline_clips = [{ shot: 1, start_us: 0, duration_us: 1_000_000 }]
  switch (fault) {
    case 'extra shot': f.manifest.shots = [f.source, { shot: 2, video: 'extra.mp4' }]; break
    case 'wrong shot': f.manifest.shots = [{ ...f.source, shot: 2 }]; break
    case 'missing master hash': delete f.manifest.master_audio_sha256; break
    case 'invalid master hash': f.manifest.master_audio_sha256 = 'invalid'; break
    case 'changed master': await writeFile(f.paths.masterAudio, 'changed'); break
    case 'missing clock': delete f.manifest.timeline_clips; break
    case 'clock not array': f.manifest.timeline_clips = {}; break
    case 'clock length': f.manifest.timeline_clips = []; break
    case 'clock missing row': f.manifest.timeline_clips = [null]; break
    case 'clock shot': f.manifest.timeline_clips = [{ shot: 2, start_us: 0, duration_us: 1_000_000 }]; break
    case 'clock start': f.manifest.timeline_clips = [{ shot: 1, start_us: 1, duration_us: 1_000_000 }]; break
    case 'clock duration': f.manifest.timeline_clips = [{ shot: 1, start_us: 0, duration_us: 1 }]; break
    case 'generated without metadata':
      delete f.manifest.master_audio_sha256; delete f.manifest.timeline_clips
      await writePlaceholder(subtitleClockPath(f.paths.subtitle), '{}')
      break
    case 'required speech without metadata':
      delete f.manifest.master_audio_sha256; delete f.manifest.timeline_clips
      await writeFile(f.paths.timeline, JSON.stringify({ clips: [{ shot: 1, start_us: 0, duration_us: 1_000_000 }], body_end: 1,
        delivery: { subtitle: { require_speech_coverage: true } } }))
      break
    case 'invalid JSON': case 'non-object': break
  }
  await f.save()
  if (fault === 'invalid JSON' || fault === 'non-object') await writeFile(f.paths.sources, fault === 'invalid JSON' ? '{' : 'null')
  await expect(f.read()).rejects.toThrow()
})

it('does not read private evidence after its owner aborts', async () => {
  const f = await fixture(), owner = new AbortController()
  owner.abort(new Error('owner released'))
  await expect(f.read(owner.signal)).rejects.toThrow('owner released')
})

it.each(['new proof', 'project root', 'outside project', 'existing proof', 'linked directory'] as const)
('keeps regenerated audio within a new canonical private file: %s', async (kind) => {
  const f = await fixture()
  let proof = join(f.project, 'proof', 'master.wav')
  if (kind === 'project root') proof = f.project
  if (kind === 'outside project') proof = join(dirname(f.project), 'outside.wav')
  if (kind === 'existing proof') await writePlaceholder(proof, 'retained proof')
  if (kind === 'linked directory') {
    const target = join(f.project, 'proof-original')
    await mkdir(target)
    await symlink(target, dirname(proof), process.platform === 'win32' ? 'junction' : 'dir')
  }
  const channel = stubChannel([call => ({ after: async () => { await writeFile(call.args.at(-1)!, 'new master') } })])
  const operation = prepareStagedEpisodeAudio({ project: f.project, episode: '02', timelinePath: f.paths.timeline,
    proofOutputPath: proof }, { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', channel: channel.channel })
  if (kind === 'new proof') {
    await expect(operation).resolves.toBeUndefined()
    expect(await fileSha256(proof)).toBe(createHash('sha256').update('new master').digest('hex'))
    expect(channel.calls).toHaveLength(1)
  } else {
    await expect(operation).rejects.toThrow()
    expect(channel.calls).toHaveLength(0)
    if (kind === 'existing proof') expect(await fileSha256(proof)).toBe(createHash('sha256').update('retained proof').digest('hex'))
  }
})
