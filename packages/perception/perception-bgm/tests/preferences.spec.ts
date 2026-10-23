import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { musicPreferenceFor, parseContextTags, readProjectMusicFeedback } from '../src/preferences.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

const sourceHash = 'a'.repeat(64)
const rejection = { feedback_id: 'ep23-hall-reject', source_sha256: sourceHash,
  decision: 'reject', context_tags: ['hall', 'family conflict'], reason: 'too playful for this confrontation',
  recorded_at: '2026-10-21T10:00:00+08:00', episode: 23, user_quote: 'Remove this music from the hall scene.' }

async function fixture(records?: unknown): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'muse-music-feedback-'))
  roots.push(root)
  if (records !== undefined) await writeFile(join(root, 'project_config.json'), JSON.stringify({
    untouched: 'legacy setting', project_bible: { bgm_feedback: records },
  }))
  return root
}

describe('project-scoped music feedback reader', () => {
  it('does not create a configuration for a legacy unconfigured project', async () => {
    const project = await fixture()
    expect(await readProjectMusicFeedback(project, new AbortController().signal)).toEqual({
      config_path: join(await realpath(project), 'project_config.json'), status: 'missing_config', records: [],
    })
    await writeFile(join(project, 'project_config.json'), JSON.stringify({ unrelated: true }))
    expect((await readProjectMusicFeedback(project, new AbortController().signal)).status).toBe('no_feedback')
  })

  it('matches the content hash across renamed files and retains the reason, time and user quote', async () => {
    const project = await fixture([rejection])
    const read = await readProjectMusicFeedback(project, new AbortController().signal)
    const result = musicPreferenceFor({ source_sha256: `sha256:${sourceHash}` }, read, ['hall', 'family conflict', 'night'])
    expect(result).toMatchObject({ decision: 'reject', feedback_id: rejection.feedback_id,
      reason: rejection.reason, recorded_at: rejection.recorded_at, history: [{ applicable: true, user_quote: rejection.user_quote }] })
  })

  it('does not convert a hall rejection into a kitchen or global blacklist', async () => {
    const project = await fixture([rejection])
    const read = await readProjectMusicFeedback(project, new AbortController().signal)
    for (const tags of [[], ['kitchen'], ['family conflict']]) {
      expect(musicPreferenceFor({ source_sha256: sourceHash }, read, tags)).toMatchObject({
        decision: 'unreviewed', history: [{ applicable: false, reason: rejection.reason }],
      })
    }
    expect(musicPreferenceFor({ track_id: 'different-track' }, read, ['hall', 'family conflict']).history).toEqual([])
  })

  it('rereads an explicit later user reversal without erasing the earlier rejection', async () => {
    const project = await fixture([rejection])
    const first = await readProjectMusicFeedback(project, new AbortController().signal)
    const acceptance = { ...rejection, feedback_id: 'ep24-user-changed-mind', decision: 'accept',
      reason: 'User explicitly approved this revised scene.', recorded_at: '2026-10-22T10:00:00+08:00' }
    await writeFile(join(project, 'project_config.json'), JSON.stringify({ project_bible: { bgm_feedback: [rejection, acceptance] } }))
    const fresh = await readProjectMusicFeedback(project, new AbortController().signal)
    expect(musicPreferenceFor({ source_sha256: sourceHash }, first, ['hall', 'family conflict']).decision).toBe('reject')
    expect(musicPreferenceFor({ source_sha256: sourceHash }, fresh, ['hall', 'family conflict'])).toMatchObject({
      decision: 'accept', feedback_id: acceptance.feedback_id, history: [{ decision: 'reject' }, { decision: 'accept' }],
    })
    const separate = await fixture([])
    expect((await readProjectMusicFeedback(separate, new AbortController().signal)).records).toEqual([])
  })

  it('matches a catalogue ID independently from a file hash', async () => {
    const project = await fixture([{ ...rejection, track_id: 'catalogue:carefree' }])
    const read = await readProjectMusicFeedback(project, new AbortController().signal)
    expect(musicPreferenceFor({ track_id: 'catalogue:carefree' }, read, ['hall', 'family conflict']).decision).toBe('reject')
  })

  it('reads legacy Windows BOM and the same tag counts accepted by the project writer', async () => {
    const project = await fixture()
    const tags = Array.from({ length: 33 }, (_, index) => `scene-${index}`)
    await writeFile(join(project, 'project_config.json'), '\ufeff' + JSON.stringify({
      project_bible: { bgm_feedback: [{ ...rejection, context_tags: tags }] },
    }))
    const read = await readProjectMusicFeedback(project, new AbortController().signal)
    expect(musicPreferenceFor({ source_sha256: sourceHash }, read, parseContextTags(tags)).decision).toBe('reject')
  })

  it('bounds displayed feedback without changing matching, stored quotes or history counts', async () => {
    const rows = Array.from({ length: 12 }, (_, index) => ({ ...rejection, feedback_id: `feedback-${index}`,
      reason: '用户原话'.repeat(2000), user_quote: '完整原话'.repeat(2000) }))
    const project = await fixture(rows)
    const read = await readProjectMusicFeedback(project, new AbortController().signal)
    const result = musicPreferenceFor({ source_sha256: sourceHash }, read, ['hall', 'family conflict'])
    expect(result).toMatchObject({ decision: 'reject', feedback_id: 'feedback-11', history_count: 12,
      history_truncated: true, history_display_truncated: true, decision_display_truncated: true })
    expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThan(12_000)
    expect(read.records[0]?.reason).toBe(rows[0]?.reason)
    expect(read.records[0]?.user_quote).toBe(rows[0]?.user_quote)
  })

  it.each([
    { ...rejection, source_sha256: 'not-a-hash' },
    { ...rejection, source_sha256: undefined },
    { ...rejection, context_tags: [] },
    { ...rejection, decision: 'agent-preferred' },
    { ...rejection, recorded_at: 'yesterday' },
    { ...rejection, recorded_at: '2026-10-22T12:00:00' },
    { ...rejection, recorded_at: '2026-02-30T12:00:00Z' },
    { ...rejection, episode: 0 },
    { ...rejection, reason: '' },
  ])('reports malformed feedback instead of silently losing it (%j)', async (record) => {
    await expect(readProjectMusicFeedback(await fixture([record]), new AbortController().signal)).rejects.toThrow()
  })

  it('rejects duplicate record identities and malformed configuration', async () => {
    const project = await fixture([rejection, rejection])
    await expect(readProjectMusicFeedback(project, new AbortController().signal)).rejects.toThrow('unique')
    await writeFile(join(project, 'project_config.json'), '[]')
    await expect(readProjectMusicFeedback(project, new AbortController().signal)).rejects.toThrow('must be an object')
    await expect(readProjectMusicFeedback('', new AbortController().signal)).rejects.toThrow('nonempty')
  })

  it('honors an already cancelled match and normalizes only comparison tags', async () => {
    const controller = new AbortController()
    controller.abort(new Error('fixture cancelled'))
    await expect(readProjectMusicFeedback(await fixture(), controller.signal)).rejects.toThrow('fixture cancelled')
    expect(parseContextTags([' Hall ', 'hall', 'Family Conflict'])).toEqual(['hall', 'family conflict'])
    expect(() => parseContextTags([])).toThrow()
  })
})
