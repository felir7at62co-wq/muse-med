/** Authored plan parsing, exact local facts and current-file checks use real private project files. */
import { createHash } from 'node:crypto'
import { readFile, rename, symlink, unlink, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { assertApprovedEpisodePlan, episodePlanDigest, readApprovedEpisodePlan } from '../src/approved-episode-plan.ts'
import { createEpisodeDeliveryFixture } from './fixtures/episode-delivery.ts'

interface PlanJson {
  schema_version: number
  episode: number
  total_shots: number
  shots: { shot: number; idempotency_key: string; review_digest: string }[]
  timeline: string
  subtitle_srt: string
  mix_profile: string
  bgm?: string
}

const hash = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')

async function fixture() {
  const f = await createEpisodeDeliveryFixture()
  onTestFinished(() => {
    expect(f.fetch).not.toHaveBeenCalled()
    expect(f.renderer.captures).toBe(0)
    expect(f.renderer.calls).toBe(0)
  })
  const path = join(f.project, 'editing', '01-episode-delivery.json')
  const authored: PlanJson = { schema_version: 1, episode: 1, total_shots: 1,
    shots: [{ shot: 1, idempotency_key: f.key, review_digest: f.input.digest }],
    timeline: 'editing/timeline.json', subtitle_srt: 'editing/subtitles.srt', mix_profile: 'editing/mix.json' }
  const read = (episode = 1, budget = f.episodeOptions.metadataMaxBytes, signal = new AbortController().signal) =>
    readApprovedEpisodePlan(f.project, episode, budget, signal)
  return { ...f, path, authored, read, writePlan: (value: object) => writeFile(path, JSON.stringify(value)) }
}

it('measures every authored file and preserves the exact original approved-shot references', async () => {
  const f = await fixture(), plan = await f.read()
  expect(plan.shots).toEqual([{ shot: 1, input: f.input }])
  expect(plan.inputHashes.map(file => file.role)).toEqual(['project', 'plan', 'timeline', 'subtitle', 'mix-profile'])
  expect(plan.versions.map(file => file.path)).toEqual(plan.inputHashes.map(file => file.path))
  for (const file of plan.inputHashes) {
    const bytes = await readFile(file.path)
    expect(file.sha256).toBe(hash(bytes))
    expect(file.bytes).toBe(bytes.length)
  }
  expect(plan.bansPresent).toBe(false)
  expect(plan.bgmPath).toBeUndefined()
  expect(episodePlanDigest(f.project, plan.inputHashes)).toBe(plan.digest)
  await expect(assertApprovedEpisodePlan(plan, new AbortController().signal)).resolves.toBeUndefined()
})

it('keeps the digest portable across project roots and changes it with exact authored content', async () => {
  const f = await fixture(), before = await f.read(), elsewhere = join(f.root, 'relocated')
  const relocated = before.inputHashes.map(file => ({ ...file, path: join(elsewhere, relative(f.project, file.path)) }))
  expect(episodePlanDigest(elsewhere, relocated)).toBe(before.digest)
  await writeFile(before.subtitlePath, '1\n00:00:00,000 --> 00:00:01,000\nChanged line\n')
  const after = await f.read()
  expect(after.digest).not.toBe(before.digest)
  expect(after.shots).toEqual(before.shots)
  expect(after.inputHashes.filter(file => file.role !== 'subtitle'))
    .toEqual(before.inputHashes.filter(file => file.role !== 'subtitle'))
})

const invalidPlans: { name: string; change: (plan: PlanJson) => object }[] = [
  { name: 'unknown top-level field', change: plan => ({ ...plan, fallback: true }) },
  { name: 'unsupported version', change: plan => ({ ...plan, schema_version: 2 }) },
  { name: 'different episode', change: plan => ({ ...plan, episode: 2 }) },
  { name: 'declared count mismatch', change: plan => ({ ...plan, total_shots: 2 }) },
  { name: 'noncontiguous shot order', change: plan => ({ ...plan, shots: plan.shots.map(shot => ({ ...shot, shot: 2 })) }) },
  { name: 'duplicate original reference', change: plan => ({ ...plan, total_shots: 2,
    shots: [plan.shots[0], { ...plan.shots[0], shot: 2 }] }) },
  { name: 'invalid review digest', change: plan => ({ ...plan, shots: plan.shots.map(shot => ({ ...shot, review_digest: 'not-a-digest' })) }) },
  { name: 'unknown shot field', change: plan => ({ ...plan, shots: plan.shots.map(shot => ({ ...shot, preview_url: 'local' })) }) },
]
it.each(invalidPlans)('rejects $name in the authored JSON plan', async ({ change }) => {
  const f = await fixture()
  await f.writePlan(change(f.authored))
  await expect(f.read()).rejects.toThrow()
})

it('rejects malformed JSON before treating the plan as measured input', async () => {
  const f = await fixture()
  await writeFile(f.path, '{"schema_version":1,')
  await expect(f.read()).rejects.toThrow()
})

it.each([0, 100, 1.5])('rejects unsupported episode number %s', async (episode) => {
  const f = await fixture()
  await expect(f.read(episode)).rejects.toThrow('integer 1..99')
})

const invalidTimelines = [
  { name: 'gap', clips: [{ shot: 1, start_us: 1, duration_us: 1000000 }], body_end: 1.000001 },
  { name: 'different shot', clips: [{ shot: 2, start_us: 0, duration_us: 1000000 }], body_end: 1 },
  { name: 'missing clip', clips: [], body_end: 1 },
  { name: 'zero duration', clips: [{ shot: 1, start_us: 0, duration_us: 0 }], body_end: 1 },
  { name: 'inconsistent body end', clips: [{ shot: 1, start_us: 0, duration_us: 1000000 }], body_end: 2 },
]
it.each(invalidTimelines)('rejects a timeline with $name', async ({ clips, body_end }) => {
  const f = await fixture()
  await writeFile(join(f.project, f.authored.timeline), JSON.stringify({ clips, body_end }))
  await expect(f.read()).rejects.toThrow()
})

it('accepts matching consecutive shots with comma timestamps and a ducking BGM input', async () => {
  const f = await fixture(), bgm = 'editing/music.wav'
  await f.writePlan({ ...f.authored, total_shots: 2, bgm,
    shots: [f.authored.shots[0], { shot: 2, idempotency_key: 'second-original-reference', review_digest: 'b'.repeat(64) }] })
  await writeFile(join(f.project, f.authored.timeline), JSON.stringify({ clips: [
    { shot: 1, start_us: 0, duration_us: 1000000 }, { shot: 2, start_us: 1000000, duration_us: 500000 }], body_end: 1.5 }))
  await writeFile(join(f.project, f.authored.mix_profile), '{"schema_version":1,"mode":"ducking"}')
  await writeFile(join(f.project, f.authored.subtitle_srt), '1\r\n00:00:00,000 --> 00:00:01,000\r\nTimed cue\r\n')
  await writeFile(join(f.project, bgm), 'opaque local BGM bytes; this owner does not decode media')
  const plan = await f.read()
  expect(plan.shots.map(shot => shot.shot)).toEqual([1, 2])
  expect(plan.bgmPath).toBe(join(f.project, bgm))
  expect(plan.inputHashes.find(file => file.role === 'bgm')?.sha256).toBe(hash(await readFile(join(f.project, bgm))))
})

it.each(['', 'Unscheduled text\n', '1\n00:00:00,000 --> 00:00:01,000\n\n'])('rejects subtitles without a timed nonempty cue (%j)', async (subtitle) => {
  const f = await fixture()
  await writeFile(join(f.project, f.authored.subtitle_srt), subtitle)
  await expect(f.read()).rejects.toThrow('timed nonempty cue')
})

it.each(['missing BGM', 'unexpected BGM'])('rejects a mix with %s', async (mode) => {
  const f = await fixture()
  if (mode === 'missing BGM') await writeFile(join(f.project, f.authored.mix_profile), '{"schema_version":1,"mode":"ducking"}')
  else await f.writePlan({ ...f.authored, bgm: 'editing/music.wav' })
  await expect(f.read()).rejects.toThrow('mix profile and BGM disagree')
})

it('accepts exact metadata budgets and rejects an over-budget authored file', async () => {
  const f = await fixture(), plan = await f.read()
  const budget = Math.max(...plan.inputHashes.map(file => file.bytes))
  expect((await f.read(1, budget)).digest).toBe(plan.digest)
  await expect(f.read(1, budget - 1)).rejects.toThrow('bounded regular file')
})

it('rejects paths outside the project and absolute inputs', async () => {
  const f = await fixture(), outside = join(f.root, 'outside.json')
  await writeFile(outside, '{"clips":[],"body_end":1}')
  for (const timeline of [outside, '../outside.json']) {
    await f.writePlan({ ...f.authored, timeline })
    await expect(f.read()).rejects.toThrow(/project-relative|escapes the project/u)
  }
})

it('rejects final symlinks, symlinked ancestors, directories and absent inputs', async () => {
  const f = await fixture()
  await symlink(join(f.project, f.authored.timeline), join(f.project, 'editing', 'linked-timeline.json'))
  await symlink(join(f.project, 'editing'), join(f.project, 'linked-editing'), 'dir')
  for (const timeline of ['editing/linked-timeline.json', 'linked-editing/timeline.json', 'editing', 'editing/absent.json']) {
    await f.writePlan({ ...f.authored, timeline })
    await expect(f.read()).rejects.toThrow()
  }
})

it('requires a canonical absolute project directory', async () => {
  const f = await fixture(), linked = join(f.root, 'linked-project'), signal = new AbortController().signal
  await symlink(f.project, linked, 'dir')
  await expect(readApprovedEpisodePlan('project', 1, 1000000, signal)).rejects.toThrow('canonical and absolute')
  await expect(readApprovedEpisodePlan(linked, 1, 1000000, signal)).rejects.toThrow('canonical and absolute')
})

it('invalidates captured versions after a same-byte file replacement', async () => {
  const f = await fixture(), plan = await f.read(), replacement = join(f.project, 'editing', 'replacement.srt')
  await writeFile(replacement, await readFile(plan.subtitlePath))
  await rename(replacement, plan.subtitlePath)
  await expect(assertApprovedEpisodePlan(plan, new AbortController().signal)).rejects.toThrow('changed since verification')
  expect((await f.read()).digest).toBe(plan.digest)
})

it('captures bans presence and exact bytes and rejects later policy changes', async () => {
  const f = await fixture(), before = await f.read()
  await writeFile(before.bansPath, '{}\n')
  await expect(assertApprovedEpisodePlan(before, new AbortController().signal)).rejects.toThrow('bans changed')
  const present = await f.read()
  expect(present.bansPresent).toBe(true)
  expect(present.digest).not.toBe(before.digest)
  expect(present.inputHashes.find(file => file.path === present.bansPath)?.sha256).toBe(hash(Buffer.from('{}\n')))
  const replacement = join(f.project, 'bans-replacement.json')
  await writeFile(replacement, '{"changed":true}\n')
  await rename(replacement, present.bansPath)
  await expect(assertApprovedEpisodePlan(present, new AbortController().signal)).rejects.toThrow('changed since verification')
  const changed = await f.read()
  expect(changed.digest).not.toBe(present.digest)
  await unlink(changed.bansPath)
  await expect(assertApprovedEpisodePlan(changed, new AbortController().signal)).rejects.toThrow()
})

it('rejects a bans symlink instead of treating it as an absent policy', async () => {
  const f = await fixture(), outside = join(f.root, 'outside-bans.json')
  await writeFile(outside, '{}\n')
  await symlink(outside, join(f.project, 'video-bans.json'))
  await expect(f.read()).rejects.toThrow('bounded regular file')
})

it('honors an already aborted preparation and file-version check', async () => {
  const f = await fixture(), plan = await f.read(), controller = new AbortController()
  controller.abort(new Error('owned preparation cancelled'))
  await expect(f.read(1, f.episodeOptions.metadataMaxBytes, controller.signal)).rejects.toThrow('owned preparation cancelled')
  await expect(assertApprovedEpisodePlan(plan, controller.signal)).rejects.toThrow('owned preparation cancelled')
})
