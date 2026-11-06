/** Roster replacements immediately rederive relationship eligibility from real task files. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { z } from 'zod'
import { SessionId } from '@deepseek-ai/dsh-session'
import { Config } from '../src/manuscript-revisions.ts'
import { ManuscriptWork } from '../src/manuscript-work.ts'
import { manuscriptTextHash } from '../src/manuscript-scenes.ts'
import { manuscriptCharacterSchema, manuscriptRelationshipSchema } from '../src/manuscript-relationships.ts'
import { reportedRelationshipSchema, recheckRelationshipSchema } from './manuscript-test-schemas.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

const reportSchema = z.object({ sources: z.array(z.object({ path: z.string(), sha256: z.string() })),
  characters: z.array(manuscriptCharacterSchema), relationships: z.array(reportedRelationshipSchema),
  relationships_needing_recheck: z.array(recheckRelationshipSchema) })
const savedSchema = z.object({ characters: z.array(manuscriptCharacterSchema), relationships: z.array(manuscriptRelationshipSchema) })

async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), 'manuscript-roster-refresh-')); roots.push(cwd)
  await writeFile(join(cwd, 'source.txt'), '第1集\n1-1 日 内 门口\n▲甲（小甲）与乙站在门口。\n小甲：爸爸。')
  const work = new ManuscriptWork(Config({ manuscriptReportMaxResultCharacters: 100000 }))
  const session = SessionId('roster-refresh'), signal = new AbortController().signal
  const request = async (args: object) => reportSchema.parse(JSON.parse(await work.request(args, cwd, session, signal)))
  const bound = await request({ action: 'bind', task_key: '字面发话人随名册更新', mode: 'edit',
    source_paths: ['source.txt'], candidate_paths: ['future.md'] })
  const source = bound.sources[0]
  if (!source) throw Error('Expected bound source')
  const anchor = (line: number, quote: string) => ({ source_path: 'source.txt', source_sha256: source.sha256,
    start_line: line, end_line: line, quote })
  const roster = (aliases: string[]) => [
    { character_id: 'a', name: '甲', aliases, evidence: [anchor(3, '▲甲（小甲）与乙站在门口。')] },
    { character_id: 'b', name: '乙', evidence: [anchor(3, '▲甲（小甲）与乙站在门口。')] },
  ]
  await request({ action: 'characters', characters: roster(['小甲']) })
  const initial = await request({ action: 'relationship', relationship: {
    relationship_id: 'relative', subject_id: 'b', object_id: 'a', relation: '父亲', status: 'uncertain',
    scope: { context: '由称谓推测，实际关系未核实。' },
    contextual_name: { term: '爸爸', speaker_id: 'a', target_id: 'b' }, evidence: [anchor(4, '小甲：爸爸。')],
  } })
  const path = join(cwd, '.muse', 'manuscript-work', manuscriptTextHash(session), 'state.json')
  const saved = async () => savedSchema.parse(JSON.parse(await readFile(path, 'utf8')))
  return { cwd, path, request, roster, initial, saved }
}

it('removes and restores alias-dependent relationships in the same complete roster response without deleting their records', async () => {
  const f = await fixture(), original = (await f.saved()).relationships
  expect(f.initial.relationships).toHaveLength(1)
  const removed = await f.request({ action: 'characters', characters: f.roster([]) })
  expect(removed.relationships).toEqual([])
  expect(removed.relationships_needing_recheck).toHaveLength(1)
  expect(removed.relationships_needing_recheck[0]?.scope_issues.map(issue => issue.code)).toContain('speaker_unresolved')
  expect((await f.saved()).relationships).toEqual(original)
  expect((await f.saved()).characters.find(row => row.character_id === 'a')?.aliases).toEqual([])
  const afterRemoval = await f.request({ action: 'audit' })
  expect(afterRemoval.relationships).toEqual(removed.relationships)
  expect(afterRemoval.relationships_needing_recheck).toEqual(removed.relationships_needing_recheck)

  const restored = await f.request({ action: 'characters', characters: f.roster(['小甲']) })
  expect(restored.relationships).toEqual(f.initial.relationships)
  expect(restored.relationships_needing_recheck).toEqual([])
  expect((await f.saved()).relationships).toEqual(original)
  const afterRestoration = await f.request({ action: 'audit' })
  expect(afterRestoration.relationships).toEqual(restored.relationships)
  expect(afterRestoration.relationships_needing_recheck).toEqual([])
})

it('rechecks an ambiguous persisted alias and reactivates its retained note immediately when a valid roster resolves it', async () => {
  const f = await fixture(), original = (await f.saved()).relationships
  const raw = z.record(z.string(), z.unknown()).parse(JSON.parse(await readFile(f.path, 'utf8')))
  const characters = z.array(manuscriptCharacterSchema).parse(raw.characters)
  await writeFile(f.path, JSON.stringify({ ...raw, characters: characters.map(row => row.character_id === 'b'
    ? { ...row, aliases: ['小甲'] } : row) }) + '\n')
  const ambiguous = await f.request({ action: 'audit' })
  expect(ambiguous.relationships).toEqual([])
  expect(ambiguous.relationships_needing_recheck[0]?.scope_issues.map(issue => issue.code)).toContain('speaker_ambiguous')
  expect((await f.saved()).relationships).toEqual(original)

  const resolved = await f.request({ action: 'characters', characters: f.roster(['小甲']) })
  expect(resolved.relationships).toEqual(f.initial.relationships)
  expect(resolved.relationships_needing_recheck).toEqual([])
  expect((await f.saved()).relationships).toEqual(original)
  expect((await f.request({ action: 'audit' })).relationships).toEqual(resolved.relationships)
})

it('rejects new cross-character alias ambiguity without changing the saved roster or relationship eligibility', async () => {
  const f = await fixture(), before = await readFile(f.path, 'utf8')
  const ambiguous = f.roster(['小甲']).map(row => row.character_id === 'b' ? { ...row, aliases: ['小甲'] } : row)
  await expect(f.request({ action: 'characters', characters: ambiguous })).rejects.toThrow('MANUSCRIPT_CHARACTER_ALIAS')
  expect(await readFile(f.path, 'utf8')).toBe(before)
  const audit = await f.request({ action: 'audit' })
  expect(audit.relationships).toEqual(f.initial.relationships)
  expect(audit.relationships_needing_recheck).toEqual([])
})
