/** Story intent reranking through the actual tool, with measured library examples. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it } from 'vitest'
import { apply, inject } from '../src/index.ts'

const disposers: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const dispose of disposers.splice(0).reverse()) await dispose() })

interface IndexedFixture { path: string; valence: number; arousal: number; moods: string[]; sha256?: string }
const tracks: IndexedFixture[] = [
  { path: '大气震撼史诗宣传.mp3', valence: 5.27, arousal: 5.17, moods: ['epic', 'powerful', 'romantic'] },
  { path: '感动亲情.mp3', valence: 4.34, arousal: 2.56, moods: ['romantic', 'sad', 'soft'] },
  { path: '悲伤剧情氛围.mp3', valence: 3.99, arousal: 2.27, moods: ['sad', 'romantic'] },
  { path: '喜剧幽默搞笑古风.mp3', valence: 5.35, arousal: 4.49, moods: ['funny', 'happy'] },
  { path: '暗流涌动.mp3', valence: 4.54, arousal: 4.66, moods: ['dramatic', 'film'] },
  { path: 'unknown.mp3', valence: 5, arousal: 5, moods: [] },
  { path: '温情.mp3', valence: 4.88, arousal: 3.10, moods: ['romantic', 'sad', 'soft'] },
]

interface Candidate {
  path: string
  distance: number
  story_fit: { status: string; title_matches: string[]; mood_matches: string[]; title_conflicts: string[]; unknowns: string[] }
}
interface Output {
  candidates: Candidate[]
  review_candidates: Candidate[]
  withheld_candidates?: Candidate[]
  audition_checks: string[]
  recommendation?: string
}

it('uses the previous cue to avoid an unnecessary energy jump while retaining plot-intent priority', async () => {
  const previousId = `sha256:${'a'.repeat(64)}`
  const { run } = await mount([
    { path: 'family-soft.mp3', sha256: previousId, valence: 5, arousal: 3, moods: ['family', 'soft'] },
    { path: 'family-action.mp3', sha256: `sha256:${'b'.repeat(64)}`, valence: 5, arousal: 7, moods: ['action', 'epic'] },
    { path: 'family-warm.mp3', sha256: `sha256:${'c'.repeat(64)}`, valence: 5, arousal: 4, moods: ['family', 'soft'] },
  ])
  const family = await run({ valence: 5, arousal: 7, previous_track_id: previousId,
    story: { intent: '亲情争执继续，没有真实打斗，台词只是口头威胁', desired_tags: ['family'] } })
  expect(family.candidates[0]?.path).toBe('family-warm.mp3')
  expect(family.candidates.find(row => row.path === 'family-action.mp3')).toMatchObject({ continuity_fit: { status: 'review_required' } })
  const action = await run({ valence: 5, arousal: 7, previous_track_id: previousId,
    story: { intent: '实际情节发生打斗，不以平滑衔接歪曲剧情', desired_tags: ['action'] } })
  expect(action.candidates[0]?.path).toBe('family-action.mp3')
  const missing = await run({ previous_track_id: `sha256:${'f'.repeat(64)}` })
  expect(missing).toMatchObject({ continuity_reference: { status: 'missing_from_library' } })
})

async function mount(rows = tracks, repeatPenalty?: number, requireStoryEvidence = false) {
  const root = await mkdtemp(join(import.meta.dirname, 'story-'))
  disposers.push(() => rm(root, { recursive: true, force: true }))
  const indexPath = join(root, 'index.json')
  await writeFile(indexPath, JSON.stringify(rows))
  const ctx = new Context()
  disposers.push(() => ctx.fiber.dispose())
  let definition: { execute(args: Record<string, unknown>, exec: { signal: AbortSignal }): Promise<Output> } | undefined
  ctx.provide('tools', { register(value: typeof definition) { definition = value; return () => {} } })
  await ctx.plugin({ apply, inject, name: 'perception-bgm' }, { indexPath, pythonExecutable: join(root, 'missing-python'), requireStoryEvidence,
    ...(repeatPenalty === undefined ? {} : { adjacentEpisodeRepeatPenalty: repeatPenalty }) })
  if (!definition) throw new Error('Missing bgm_match')
  const tool = definition
  return { root, run: (args: Record<string, unknown>) => tool.execute({ method: 'match', valence: 5, arousal: 5, ...args },
    { signal: new AbortController().signal }) }
}

it('prefers family intent to an emotionally nearer epic cue without changing measured distances', async () => {
  const { run } = await mount()
  const output = await run({ story: { intent: '母女克制地和解，保持亲情温度', desired_tags: ['family', 'gentle'],
    avoid_tags: ['epic', 'comedy'], dialogue_density: 'dense' } })
  expect(output.candidates[0]).toMatchObject({ path: '感动亲情.mp3', distance: 3.1,
    story_fit: { status: 'supported', title_matches: ['family'], mood_matches: ['gentle'] } })
  expect(output.review_candidates.map(row => row.path)).toEqual(['大气震撼史诗宣传.mp3', '喜剧幽默搞笑古风.mp3'])
  expect(output.candidates.every(row => row.story_fit.unknowns.includes('vocals'))).toBe(true)
  expect(output.audition_checks.join(' ')).toContain('dialogue')
})

it('keeps catalogue mood evidence weaker than explicit titles and does not infer an absent property', async () => {
  const { run } = await mount()
  const output = await run({ story: { intent: '真正悲痛，没有反讽', desired_tags: ['sadness'], avoid_tags: ['comedy', 'romance'] } })
  expect(output.candidates[0]).toMatchObject({ path: '悲伤剧情氛围.mp3', story_fit: { title_matches: ['sadness'] } })
  expect(output.candidates.find(row => row.path === '感动亲情.mp3')?.story_fit.status).toBe('supported')
  expect(output.review_candidates.map(row => row.path)).toContain('喜剧幽默搞笑古风.mp3')
  expect(output.candidates.find(row => row.path === 'unknown.mp3')?.story_fit).toMatchObject({
    status: 'unconfirmed', title_matches: [], mood_matches: [], title_conflicts: [], unknowns: ['vocals', 'instruments', 'era', 'excerpt_suitability'],
  })
})

it('honors explicit musical priorities instead of imposing one genre hierarchy', async () => {
  const { run } = await mount()
  const output = await run({ story: { intent: '先要舒缓气质，亲情为次要线索', desired_tags: ['gentle', 'family'] } })
  expect(output.candidates[0]?.path).toBe('温情.mp3')
})

it('distinguishes unspoken menace from an action scene without treating dramatic as action', async () => {
  const { run } = await mount()
  const output = await run({ story: { intent: '言语威胁但未动手，不提前渲染打斗', desired_tags: ['suspense'], avoid_tags: ['action', 'epic'] } })
  expect(output.candidates[0]?.path).toBe('暗流涌动.mp3')
  expect(output.candidates[0]?.story_fit.title_matches).toEqual(['suspense'])
})

it('reports an unsupported library instead of inventing a perfect cue and keeps conflict evidence reviewable', async () => {
  const { run } = await mount(tracks.slice(0, 1))
  const output = await run({ story: { intent: '安静亲情', desired_tags: ['family'], avoid_tags: ['epic'] } })
  expect(output.candidates).toEqual([])
  expect(output.review_candidates).toHaveLength(1)
  expect(output.recommendation).toContain('without added BGM')
})

it('keeps a metadata gap visible, including when a directory name suggests a musical intention', async () => {
  const { run } = await mount([{ path: 'C:\\family\\bare.mp3', valence: 5, arousal: 5, moods: [] }])
  const output = await run({ story: { intent: '家庭戏', desired_tags: ['family'] } })
  expect(output.candidates[0]?.story_fit.status).toBe('unconfirmed')
  expect(output.recommendation).toContain('without added BGM')
})

it('reports an empty library as unavailable instead of fabricating a story recommendation', async () => {
  const { run } = await mount([])
  const output = await run({ story: { intent: '亲情', desired_tags: ['family'] } })
  expect(output.candidates).toEqual([])
  expect(output.review_candidates).toEqual([])
  expect(output.recommendation).toContain('missing library')
})

it('keeps user rejection effective even when the title supports the requested story', async () => {
  const hash = 'a'.repeat(64)
  const { root, run } = await mount([{ ...tracks[1]!, sha256: `sha256:${hash}` }])
  await writeFile(join(root, 'project_config.json'), JSON.stringify({ project_bible: { bgm_feedback: [{
    feedback_id: 'real-user-rejection', source_sha256: hash, decision: 'reject', context_tags: ['family'],
    reason: '用户认为该曲太煽情', recorded_at: '2026-10-27T10:00:00+08:00',
  }] } }))
  const output = await run({ project: root, context_tags: ['family'], story: { intent: '克制亲情', desired_tags: ['family'] } })
  expect(output.candidates).toEqual([])
  expect(output.review_candidates).toEqual([])
  expect(output.withheld_candidates?.[0]?.story_fit.title_matches).toEqual(['family'])
})

it.each([
  null, [], {}, { intent: '', desired_tags: ['family'] }, { intent: 'x'.repeat(601), desired_tags: ['family'] },
  { intent: 'x', desired_tags: ['family'], avoid_tags: 'comedy' },
  { intent: 'x', desired_tags: ['family'], avoid_tags: ['invented'] },
  { intent: 'x', desired_tags: [] }, { intent: 'x', desired_tags: Array(9).fill('family') },
  { intent: 'x', desired_tags: ['invented'] }, { intent: 'x', desired_tags: ['family'], avoid_tags: ['family'] },
  { intent: 'x', desired_tags: ['family'], dialogue_density: 'silent' },
])('rejects an ambiguous or contradictory story request: %j', async (story) => {
  const { run } = await mount()
  await expect(run({ story })).rejects.toThrow('story')
})

it('keeps equal reuse-adjusted candidates ordered by story evidence', async () => {
  const used = `sha256:${'d'.repeat(64)}`
  const { run } = await mount([
    { path: 'family-used.mp3', sha256: used, valence: 5, arousal: 5, moods: ['family'] },
    { path: 'family-fresh.mp3', sha256: `sha256:${'e'.repeat(64)}`, valence: 5, arousal: 7, moods: ['family'] },
    { path: 'family-busy.mp3', valence: 5, arousal: 5, moods: ['action', 'family'] },
  ])
  const result = await run({ adjacent_episode_track_ids: [used],
    story: { intent: 'Keep family dialogue restrained', desired_tags: ['family'], avoid_tags: ['action'] } })
  expect(result.candidates.map(row => row.path)).toEqual(['family-used.mp3', 'family-fresh.mp3', 'family-busy.mp3'])
})

it('discloses a repeat penalty when the reused track sorts after a fresh cue', async () => {
  const used = `sha256:${'d'.repeat(64)}`
  const { run } = await mount([
    { path: 'fresh.mp3', valence: 5, arousal: 5, moods: [] },
    { path: 'used.mp3', sha256: used, valence: 5, arousal: 5, moods: [] },
  ])
  const result = await run({ adjacent_episode_track_ids: [used] })
  expect(result.candidates.map(row => row.path)).toEqual(['fresh.mp3', 'used.mp3'])
  await expect(run({ adjacent_episode_track_ids: [' '] })).rejects.toThrow('nonempty track IDs')
})

it('prefers a comparable cue unused by adjacent episodes while retaining the measured distance', async () => {
  const previous = `sha256:${'a'.repeat(64)}`
  const { run } = await mount([
    { path: 'family-used.mp3', sha256: previous, valence: 5, arousal: 3, moods: ['family', 'gentle'] },
    { path: 'family-fresh.mp3', sha256: `sha256:${'b'.repeat(64)}`, valence: 5, arousal: 3.5, moods: ['family', 'gentle'] },
    { path: 'action-fresh.mp3', sha256: `sha256:${'c'.repeat(64)}`, valence: 5, arousal: 3, moods: ['action'] },
  ])
  const story = { intent: '克制的亲情和解，避免跨集机械重复', desired_tags: ['family', 'gentle'] }
  const output = await run({ valence: 5, arousal: 3, story, adjacent_episode_track_ids: [previous] })
  expect(output.candidates[0]?.path).toBe('family-fresh.mp3')
  expect(output.candidates[0]?.distance).toBe(0.5)
  expect(output.candidates.find(row => row.path === 'family-used.mp3')).toHaveProperty(
    'adjacent_episode_reuse.status', 'used_in_adjacent_episode')
  const legacy = await run({ valence: 5, arousal: 3, story })
  expect(legacy.candidates[0]?.path).toBe('family-used.mp3')
  expect(legacy.candidates[0]).not.toHaveProperty('adjacent_episode_reuse')
})

it('retains a reused cue when alternatives have an unsuitable mood or plot intent', async () => {
  const previous = `sha256:${'a'.repeat(64)}`
  const { run } = await mount([
    { path: 'family-used.mp3', sha256: previous, valence: 5, arousal: 3, moods: ['family', 'gentle'] },
    { path: 'family-far.mp3', sha256: `sha256:${'b'.repeat(64)}`, valence: 9, arousal: 9, moods: ['family', 'gentle'] },
    { path: 'action.mp3', sha256: `sha256:${'c'.repeat(64)}`, valence: 5, arousal: 3, moods: ['action'] },
  ])
  const output = await run({ valence: 5, arousal: 3, adjacent_episode_track_ids: [previous],
    story: { intent: '亲情沟通继续，不能为了换曲选错气质', desired_tags: ['family', 'gentle'] } })
  expect(output.candidates[0]?.path).toBe('family-used.mp3')
})

it('validates neighboring IDs and keeps unidentified legacy tracks unconfirmed', async () => {
  const { run } = await mount()
  await expect(run({ adjacent_episode_track_ids: [''] })).rejects.toThrow('nonempty track IDs')
  await expect(run({ adjacent_episode_track_ids: [42] })).rejects.toThrow('adjacent_episode_track_ids')
  await expect(run({ adjacent_episode_track_ids: 'wrong' })).rejects.toThrow('adjacent_episode_track_ids')
  const output = await run({ adjacent_episode_track_ids: [`sha256:${'a'.repeat(64)}`] })
  expect(output.candidates[0]).toHaveProperty('adjacent_episode_reuse.status', 'unknown_identity')
})

it('normalizes neighboring source hashes and permits a configured zero reuse penalty', async () => {
  const hash = 'a'.repeat(64)
  const rows = [
    { path: 'used.mp3', sha256: `sha256:${hash}`, valence: 5, arousal: 5, moods: [] },
    { path: 'fresh.mp3', sha256: `sha256:${'b'.repeat(64)}`, valence: 5, arousal: 5.5, moods: [] },
  ]
  const normal = await mount(rows)
  const preferred = await normal.run({ adjacent_episode_track_ids: [hash.toUpperCase()] })
  expect(preferred.candidates[0]?.path).toBe('fresh.mp3')
  const disabled = await mount(rows, 0)
  const original = await disabled.run({ adjacent_episode_track_ids: [hash] })
  expect(original.candidates[0]?.path).toBe('used.mp3')
})

it('rejects an invalid adjacent-episode preference at load', async () => {
  await expect(mount(tracks, -1)).rejects.toThrow('adjacentEpisodeRepeatPenalty')
})

it('allows a comparable unused family cue despite a stronger family title on the repeated cue', async () => {
  const hash = `sha256:${'a'.repeat(64)}`
  const { run } = await mount([
    { path: '感动亲情.mp3', sha256: hash, valence: 5, arousal: 3, moods: ['family', 'gentle'] },
    { path: '钢琴配乐.mp3', sha256: `sha256:${'b'.repeat(64)}`, valence: 5, arousal: 3.5, moods: ['family', 'gentle'] },
  ])
  const output = await run({ valence: 5, arousal: 3, adjacent_episode_track_ids: [hash],
    story: { intent: '亲情和解，选合适替代，避免曲名反复锁死同一首', desired_tags: ['family', 'gentle'] } })
  expect(output.candidates[0]?.path).toBe('钢琴配乐.mp3')
})

it('refuses to recommend music from invented dialogue under the production evidence policy', async () => {
  const { root, run } = await mount(tracks, undefined, true)
  await writeFile(join(root, 'script.txt'), '沈天赐：小爷听个响！小爷就爱听个响！\n摊主：我还指望卖钱养家呢！')
  await writeVisualEvidence(root, '男子持棍砸瓜，母亲握住其手腕，表情严肃。')
  const evidence = [
    { kind: 'script', file: 'script.txt', quotes: ['怎么卖', '你抢啊'] },
    { kind: 'visual_review', file: 'review.json', quotes: ['男子持棍砸瓜'] },
  ]
  const output = await run({ project: root, story: { intent: '集市抬杠，要让观众笑', desired_tags: ['comedy'], evidence } })
  expect(output.candidates).toEqual([])
  expect(output).toHaveProperty('selection_status', 'needs_source_correction')
  expect(output).toHaveProperty('story_grounding.status', 'quote_mismatch')
})

it('checks real script and observed-picture quotations again after a source changes', async () => {
  const { root, run } = await mount(tracks, undefined, true)
  const script = join(root, 'script.txt')
  await writeFile(script, '男子砸瓜。\n摊主：我还指望卖钱养家呢！')
  await writeVisualEvidence(root, '母亲握住男子手腕，表情严肃。')
  const args = { project: root, story: { intent: '受害者着急，母亲制止，克制冲突', desired_tags: ['restrained'], evidence: [
    { kind: 'script', file: 'script.txt', quotes: ['男子砸瓜。', '我还指望卖钱养家呢！'] },
    { kind: 'visual_review', file: 'review.json', quotes: ['母亲握住男子手腕'] },
  ] } }
  const valid = await run(args)
  expect(valid).toHaveProperty('selection_status', 'evidence_matched')
  expect(valid).toHaveProperty('story_grounding.status', 'quotes_matched')
  expect(valid.candidates.length).toBeGreaterThan(0)
  await writeFile(join(root, 'video.mp4'), 'a-different-adopted-video')
  const replaced = await run(args)
  expect(replaced.candidates).toEqual([])
  expect(replaced).toHaveProperty('story_grounding.status', 'video_changed')
  await writeFile(script, '已经换成另一场景。')
  const changed = await run(args)
  expect(changed.candidates).toEqual([])
  expect(changed).toHaveProperty('selection_status', 'needs_source_correction')
})

it('distinguishes library browsing from production recommendations without source evidence', async () => {
  const { run } = await mount(tracks, undefined, true)
  const browsing = await run({})
  expect(browsing.candidates.length).toBeGreaterThan(0)
  expect(browsing).toHaveProperty('selection_status', 'reference_only')
  const missing = await run({ story: { intent: '推测这是轻喜剧', desired_tags: ['comedy'] } })
  expect(missing.candidates).toEqual([])
  expect(missing).toHaveProperty('selection_status', 'needs_source_evidence')
})

async function writeVisualEvidence(root: string, observations: string): Promise<void> {
  const bytes = Buffer.from('video-version-one')
  await writeFile(join(root, 'video.mp4'), bytes)
  await writeFile(join(root, 'review.json'), JSON.stringify({ video: 'video.mp4',
    video_sha256: createHash('sha256').update(bytes).digest('hex'), observations }))
}

it('rejects references outside the project and explains missing picture evidence', async () => {
  const { root, run } = await mount(tracks, undefined, true)
  const other = await mount()
  await writeFile(join(root, 'script.txt'), 'A real action.')
  await writeFile(join(other.root, 'outside.txt'), 'A real action.')
  const partial = await run({ project: root, story: { intent: 'Use real actions', desired_tags: ['restrained'], evidence: [
    { kind: 'script', file: 'script.txt', quotes: ['A real action.'] },
  ] } })
  expect(partial).toHaveProperty('story_grounding.missing_kinds', ['visual_review'])
  await expect(run({ project: root, story: { intent: 'Wrong project evidence', desired_tags: ['restrained'], evidence: [
    { kind: 'script', file: join(other.root, 'outside.txt'), quotes: ['A real action.'] },
  ] } })).rejects.toThrow('must stay inside the project')
})
