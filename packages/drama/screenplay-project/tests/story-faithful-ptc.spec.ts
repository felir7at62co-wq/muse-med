/** Supported-source headless PTC round trips with real video tools, original logs, and fixed synthetic semantics. */
import { appendFile, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import sharp from 'sharp'
import { readImageFile } from '@deepseek-ai/dsh-attachment-local'
import { expect, it } from 'vitest'
import { PROJECT_FILE } from '../src/schema.ts'
import { acceptedScripts, candidateDigest } from '../src/episode.ts'
import { prepareStoryFixture, runStoryFixture, readStoryFixture } from './fixtures/story-faithful-fixture.ts'

const DEADLINE = 180_000
async function logs(cwd: string) {
  const names = await readdir(join(cwd, '.sessions'), { recursive: true })
  return (await Promise.all(names.filter(name => name.endsWith('.jsonl')).map(name => readFile(join(cwd, '.sessions', name), 'utf8')))).join('\n')
}
async function cleanup(cwd: string) {
  if (process.env.SCREENPLAY_STORY_FIXTURE_KEEP_DIR) {
    await writeFile(join(process.env.SCREENPLAY_STORY_FIXTURE_KEEP_DIR, 'latest-path.txt'), `${cwd}\n`)
  } else await rm(cwd, { recursive: true, force: true })
}

it('creates a fresh accepted V2 work with three actual sampled windows, exact next-model images, complete A/B/C reads, and separate delivery', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'story-faithful-ptc-'))
  try {
    await prepareStoryFixture(cwd)
    const original = await readFile(join(cwd, 'authored-transcript.json'))
    const { stdout, stderr } = await runStoryFixture(cwd)
    const fixture = await readStoryFixture(cwd, stdout), project = fixture.project, candidate = project.candidates[0]!
    expect(project.accepted).toEqual([candidate.id]); expect(project.refinement).toBeUndefined()
    expect(project.story_policy!.authorization).toMatchObject({ source: 'user', session_id: fixture.sessionId })
    expect(candidate.story_adaptation!.input_candidate_json).toBeUndefined()
    expect(candidate.story_adaptation!.notes.changes.every(change => change.before === undefined && change.source !== undefined)).toBe(true)
    expect(project.sources.filter(source => source.video !== undefined)).toHaveLength(3)
    for (const source of project.sources.filter(source => source.video !== undefined)) {
      expect(source.trusted_video_receipt!.duration_seconds).toBe(128)
      expect(source.trusted_video_receipt!.plan).toHaveLength(3)
      expect(source.trusted_video_receipt!.evidence.sample_ancestors).toHaveLength(1)
      expect(source.trusted_video_receipt!.model_input_step).toBeGreaterThan(source.trusted_video_receipt!.evidence.sample_root_result.seq)
    }
    const videoSources = project.sources.filter(source => source.video !== undefined)
    for (const [index, source] of videoSources.entries()) {
      const stored = await readImageFile(join(fixture.home, 'attachments', 'v1'), source.units[0]!.image!)
      const pixels = await sharp(stored.data).stats()
      expect(pixels.channels[index === 0 ? 2 : 0]!.mean).toBeGreaterThan(200)
      expect(pixels.channels[index === 0 ? 0 : 2]!.mean).toBeLessThan(20)
    }
    const observations = z.array(z.object({ phase: z.string(), step: z.number(), images: z.array(z.string()), canonical: z.literal(true) }))
      .parse(JSON.parse(await readFile(join(cwd, 'story-fixture-observations.json'), 'utf8')))
    expect(observations[0]!.images).toHaveLength(3)
    for (const subject of [...project.facts, project.story_inventories![0]!, candidate]) {
      expect(subject.review!.evidence!.reads.every(read =>
        subject.created_step! < read.step && read.step < subject.review!.evidence!.review_step)).toBe(true)
    }
    expect(candidate.review!.semantic_report!.checks).toHaveLength(5)
    expect(candidate.review!.story_acceptance!.sources).toHaveLength(3)
    expect(await readFile(join(cwd, 'authored-transcript.json'))).toEqual(original)
    const rendered = acceptedScripts(project)[0]!
    expect(await readFile(fixture.input!, 'utf8')).toBe(rendered.script)
    expect(await readFile(fixture.report!, 'utf8')).toBe(rendered.modification_notes)
    expect(rendered.script).toContain('别把我当外人！'); expect(rendered.script).not.toContain('修改说明')
    expect(rendered.modification_notes).toContain('没有逐字剧本基线')
    const log = await logs(cwd)
    expect(log).toContain('self_check_step'); expect(log).toContain('self_check_read_required')
    expect(log).toContain('story_semantic_deviation'); expect(log).toContain('story_approval_log_pending')
    expect(log).toContain('video_evidence_pending');expect(log).toContain('fake-samples.json');expect(log).toContain('forged-verified.json'); expect(log).toContain('fixture successful inner read but failed outer')
    expect(stderr).not.toContain('UNHANDLED')

    const cold = await runStoryFixture(cwd, { phase: 'accepted-cold', sessionId: fixture.sessionId, prompt: '在同一原会话冷恢复后只重新核实并导出这份已验收合成作品，不重新抽帧或审校。' })
    expect(cold.stderr).not.toContain('UNHANDLED')
    const tools = z.array(z.object({ name: z.string(), method: z.string().optional(), isError: z.boolean() }))
      .parse(JSON.parse(await readFile(join(cwd, 'story-fixture-tools.json'), 'utf8')))
    expect(tools.some(tool => tool.name === 'video_inspect' || tool.method === 'review')).toBe(false)
    expect(tools.find(tool => tool.method === 'export')?.isError).toBe(false)
    expect(await readFile(join(cwd, 'cold-delivery', fixture.input!.split('/').at(-1)!), 'utf8')).toBe(rendered.script)

    const originalProject = await readFile(fixture.projectPath, 'utf8')
    const edited = PROJECT_FILE.parse(JSON.parse(originalProject))
    edited.candidates[0]!.scenes[0]!.beats[1]!.text = '合成负例：关系立场改为驱逐。'
    edited.candidates[0]!.sha256 = candidateDigest(edited.candidates[0]!)
    await writeFile(fixture.projectPath, JSON.stringify(edited))
    const rejected = await runStoryFixture(cwd, { phase: 'export-negative', sessionId: fixture.sessionId, expectedError: 'story_candidate_digest' })
    expect(rejected.stdout).toContain('EXPECTED_DENIAL story_candidate_digest')
    await writeFile(fixture.projectPath, originalProject)
    await appendFile(join(cwd, 'original.mp4'), 'changed source version')
    const changedSource = await runStoryFixture(cwd, { phase: 'export-negative', sessionId: fixture.sessionId, expectedError: 'video_changed' })
    expect(changedSource.stdout).toContain('EXPECTED_DENIAL video_changed')
  } finally { await cleanup(cwd) }
}, DEADLINE)

it('cold-restores saved pending V2 observations and rereads B before a later C approval', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'story-faithful-pending-'))
  try {
    await prepareStoryFixture(cwd)
    const first = await runStoryFixture(cwd, { phase: 'checkpoint' }), fixture = await readStoryFixture(cwd, first.stdout)
    expect(fixture.project.accepted).toEqual([]); expect(fixture.project.candidates[0]!.review).toBeUndefined()
    const second = await runStoryFixture(cwd, { phase: 'resume-pending', sessionId: fixture.sessionId, prompt: '同一合成作品冷恢复后重新检查原视频和完整来源，再分轮审校。' })
    expect(second.stdout).toContain('EXPECTED_DENIAL self_check_read_required')
    const accepted = PROJECT_FILE.parse(JSON.parse(await readFile(fixture.projectPath, 'utf8'))), candidate = accepted.candidates.at(-1)!
    expect(accepted.accepted).toEqual([candidate.id])
    expect(accepted.candidates).toHaveLength(1)
    expect(accepted.story_inventories![0]!.superseded_at_revision).toBeUndefined()
    expect(candidate.id).toBe(fixture.project.candidates[0]!.id)
    expect(await readFile(join(cwd, 'story-fixture-tools.json'), 'utf8')).not.toContain('video_inspect')
    expect(candidate.review!.evidence!.reads.every(read => read.step > fixture.project.candidates[0]!.created_step!
      && read.step < candidate.review!.evidence!.review_step)).toBe(true)
    expect(await readFile(join(cwd, 'story-fixture-observations.json'), 'utf8')).toContain('resume-pending')
    expect(second.stderr).not.toContain('UNHANDLED')
  } finally { await cleanup(cwd) }
}, DEADLINE)

it.each(['offload-after-observation', 'offload-before-observation'] as const)(
  'uses actual model observation when source images leave the request: %s', async (phase) => {
    const cwd = await mkdtemp(join(tmpdir(), 'story-faithful-offload-'))
    try {
      await prepareStoryFixture(cwd)
      const output = await runStoryFixture(cwd, { phase }), fixture = await readStoryFixture(cwd, output.stdout)
      expect(await logs(cwd)).toContain('image/offload')
      if (phase === 'offload-after-observation') {
        expect(fixture.project.accepted).toEqual([fixture.project.candidates[0]!.id])
        expect(fixture.input).toBeDefined()
        expect(await readFile(fixture.input!, 'utf8')).toContain('红屏只是警报，不是赶你走。')
      } else {
        expect(output.stdout).toContain('EXPECTED_DENIAL self_check_read_required')
        expect(fixture.project.accepted).toEqual([])
        expect(fixture.project.candidates[0]!.review).toBeUndefined()
      }
      expect(output.stderr).not.toContain('UNHANDLED')
    } finally { await cleanup(cwd) }
  }, DEADLINE,
)
