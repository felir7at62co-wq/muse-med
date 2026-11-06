/** Directed relationships retain model uncertainty while rejecting invented or stale source attribution. */
import { afterEach, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readManuscript } from '../src/manuscript-document.ts'
import { manuscriptCharacterSchema, manuscriptRelationshipSchema, validateCharacterRoster,
  manuscriptRelationshipScopeIssues, manuscriptRelationshipSourceContexts, manuscriptRelationshipSpeakerIssues, validateManuscriptEvidence,
  validateManuscriptRelationship } from '../src/manuscript-relationships.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

const original = '第1集\n1-1 客厅 日 内\n▲林遥（小遥）走向林宁。\n林遥：妈妈，我回来了。\n▲林宁是林遥的母亲。\n1-2 门口 日 外\n▲林澄望着程芳。\n林澄：妈妈，你等等。\n▲程芳是林澄的母亲。'

async function fixture(contents = original) {
  const cwd = await mkdtemp(join(tmpdir(), 'manuscript-relationships-'))
  roots.push(cwd)
  const path = join(cwd, 'source.txt')
  await writeFile(path, contents, { flag: 'wx', mode: 0o600 })
  const read = () => readManuscript(path, cwd, { maxFileBytes: 16_384, maxTextChars: 4096 }, new AbortController().signal)
  const source = await read()
  const evidence = (start: number, end = start) => ({ source_path: './source.txt', source_sha256: source.sha256,
    start_line: start, end_line: end, quote: source.text.replace(/\r\n/g, '\n').split('\n').slice(start - 1, end).join('\n') })
  const rows = [
    { character_id: 'lin-yao', name: '林遥', aliases: ['小遥'], evidence: [evidence(3)] },
    { character_id: 'lin-ning', name: '林宁', evidence: [evidence(5)] },
    { character_id: 'lin-cheng', name: '林澄', evidence: [evidence(7)] },
    { character_id: 'cheng-fang', name: '程芳', evidence: [evidence(9)] },
  ]
  const roster = await validateCharacterRoster(rows, [source], cwd)
  const note = { relationship_id: 'mother-lin-ning', subject_id: 'lin-ning', object_id: 'lin-yao', relation: '母亲',
    status: 'asserted', scope: { episode: '1', scene_id: '1-1', story_time: '日', context: '本场直接交谈，关系依据原文记录。' },
    contextual_name: { term: '妈妈', speaker_id: 'lin-yao', target_id: 'lin-ning' }, evidence: [evidence(4, 5)] }
  const validate = (raw: unknown) => validateManuscriptRelationship(raw, [source], roster, cwd)
  return { cwd, path, read, source, evidence, rows, roster, note, validate }
}

async function rejectedMessage(promise: Promise<unknown>): Promise<string> {
  try { await promise }
  catch (error) {
    if (error instanceof Error) return error.message
    throw error
  }
  throw Error('Expected source validation to reject')
}

it('keeps direction, source version and the speaker-relative designation without changing manuscripts or adding inverses', async () => {
  const f = await fixture(), relation = await f.validate(f.note)
  expect(relation).toMatchObject({ subject_id: 'lin-ning', object_id: 'lin-yao', relation: '母亲', status: 'asserted',
    scope: f.note.scope, contextual_name: f.note.contextual_name,
    evidence: [{ source_path: f.source.path, source_sha256: f.source.sha256, start_line: 4, end_line: 5,
      quote: '林遥：妈妈，我回来了。\n▲林宁是林遥的母亲。' }] })
  expect(f.roster[0]).toMatchObject({ character_id: 'lin-yao', name: '林遥', aliases: ['小遥'],
    evidence: [{ source_path: f.source.path }] })
  expect(await readFile(f.path, 'utf8')).toBe(original)
  expect(relation).not.toHaveProperty('inverse')
  expect(relation).not.toHaveProperty('verified')
})

it('accepts the CRLF source lines returned by source reading while retaining the exact file digest', async () => {
  const contents = original.replaceAll('\n', '\r\n'), f = await fixture(contents)
  expect(f.source.sha256).toBe(createHash('sha256').update(contents).digest('hex'))
  expect(f.source.sha256).not.toBe(createHash('sha256').update(original).digest('hex'))
  expect(await f.validate(f.note)).toMatchObject({ evidence: [{ source_sha256: f.source.sha256,
    quote: '林遥：妈妈，我回来了。\n▲林宁是林遥的母亲。' }] })
  expect(f.roster[0]?.evidence[0]?.quote).toBe('▲林遥（小遥）走向林宁。')
  expect(await readFile(f.path, 'utf8')).toBe(contents)
})

it('shares terminal-CR display with reading while retaining an internal carriage return in exact quotations', async () => {
  const f = await fixture(), contents = '甲\r乙是甲的父亲。\r'
  await writeFile(f.path, contents)
  const source = await f.read(), evidence = { source_path: 'source.txt', source_sha256: source.sha256,
    start_line: 1, end_line: 1, quote: '甲\r乙是甲的父亲。' }
  const roster = await validateCharacterRoster([
    { character_id: 'a', name: '甲', evidence: [evidence] },
    { character_id: 'b', name: '乙', evidence: [evidence] },
  ], [source], f.cwd)
  const note = { relationship_id: 'father', subject_id: 'b', object_id: 'a', relation: '父亲', status: 'asserted',
    scope: { context: '原文所述的父子关系。' }, evidence: [evidence] }
  expect((await validateManuscriptRelationship(note, [source], roster, f.cwd)).evidence).toEqual([
    { ...evidence, source_path: source.path },
  ])
  await expect(validateManuscriptRelationship({ ...note, evidence: [{ ...evidence, quote: '甲乙是甲的父亲。' }] },
    [source], roster, f.cwd)).rejects.toThrow('MANUSCRIPT_RELATION_QUOTE')
  expect(source.sha256).toBe(createHash('sha256').update(contents).digest('hex'))
  expect(await readFile(f.path, 'utf8')).toBe(contents)
})

it.each(['asserted', 'uncertain', 'contradicted'])('retains the model-authored %s status instead of deciding truth', async (status) => {
  const f = await fixture()
  const note = { ...f.note, status, scope: { context: '人物自称母亲，其他证据仍有冲突，适用范围尚待编辑判断。' } }
  expect(await f.validate(note)).toMatchObject({ status, scope: note.scope })
})

it('resolves the same contextual kinship term to different people without making it a global alias', async () => {
  const f = await fixture()
  const second = await f.validate({ ...f.note, relationship_id: 'mother-cheng-fang', subject_id: 'cheng-fang',
    object_id: 'lin-cheng', scope: { episode: '1', scene_id: '1-2', context: '另一对母女在门口。' },
    contextual_name: { term: '妈妈', speaker_id: 'lin-cheng', target_id: 'cheng-fang' }, evidence: [f.evidence(8, 9)] })
  expect(second.contextual_name).toEqual({ term: '妈妈', speaker_id: 'lin-cheng', target_id: 'cheng-fang' })
  expect((await f.validate(f.note)).contextual_name?.target_id).toBe('lin-ning')
  expect(f.roster.flatMap(row => row.aliases ?? [])).not.toContain('妈妈')
})

it('binds a contextual name to the actual speaker on a later line of the selected quotation', async () => {
  const f = await fixture()
  const valid = await f.validate({ ...f.note, evidence: [f.evidence(3, 5)] })
  expect(manuscriptRelationshipSpeakerIssues(valid, [f.source], f.roster)).toEqual([])
  const wrong = { ...valid, contextual_name: { ...valid.contextual_name!, speaker_id: f.roster[1]!.character_id } }
  await expect(f.validate(wrong)).rejects.toThrow('MANUSCRIPT_RELATION_SPEAKER')
  const before = JSON.stringify(wrong)
  const issues = manuscriptRelationshipSpeakerIssues(wrong, [f.source], f.roster)
  expect(issues).toMatchObject([{ field: 'contextual_name', code: 'speaker_mismatch' }])
  expect(issues[0]?.message).toContain(':4')
  expect(JSON.stringify(wrong)).toBe(before)
})

it.each(['林遥OS（在心里：😀）', '林遥（OS）', '小遥 vo（低声）'])('accepts literal %s attribution without requiring audible speech', async (label) => {
  const f = await fixture(original.replace('林遥：妈妈', `${label}：妈妈`))
  const note = await f.validate(f.note)
  expect(manuscriptRelationshipSpeakerIssues(note, [f.source], f.roster)).toEqual([])
  expect(note.contextual_name?.speaker_id).toBe('lin-yao')
  expect(await readFile(f.path, 'utf8')).toContain(`${label}：妈妈`)
})

it.each([
  ['▲林遥（小遥）看着写有妈妈的纸条。', 'term_not_in_body'],
  ['系统档案：妈妈叫林宁。', 'term_not_in_body'],
  ['【档案：妈妈叫林宁】', 'term_not_in_body'],
  ['林遥（想起妈妈）：我回来了。', 'term_not_in_body'],
  ['OS：妈妈，我回来了。', 'speaker_unresolved'],
  ['VO：妈妈，我回来了。', 'speaker_unresolved'],
  ['陌生人：妈妈，我回来了。', 'speaker_unresolved'],
  ['林遥遥：妈妈，我回来了。', 'speaker_unresolved'],
])('refuses an unbound contextual designation from %s', async (replacement, code) => {
  const f = await fixture(original.replace('林遥：妈妈，我回来了。', replacement))
  const saved = manuscriptRelationshipSchema.parse({ ...f.note,
    evidence: [{ ...f.evidence(4, 5), source_path: f.source.path }] })
  expect(manuscriptRelationshipSpeakerIssues(saved, [f.source], f.roster)).toEqual([
    expect.objectContaining({ field: 'contextual_name', code }),
  ])
  await expect(f.validate(f.note)).rejects.toThrow('MANUSCRIPT_RELATION_SPEAKER')
  const { contextual_name: _designation, ...ordinary } = f.note
  expect(await f.validate({ ...ordinary, status: 'uncertain' })).not.toHaveProperty('contextual_name')
})

it('reports an ambiguous stored alias without choosing a character or rewriting the saved note', async () => {
  const f = await fixture(original.replace('林遥：妈妈', '小遥：妈妈'))
  const saved = await f.validate(f.note)
  const decodedRoster = f.roster.map(row => manuscriptCharacterSchema.parse(row.character_id === 'lin-cheng'
    ? { ...row, aliases: ['小遥'] } : row))
  expect(manuscriptRelationshipSpeakerIssues(saved, [f.source], decodedRoster)).toEqual([
    expect.objectContaining({ code: 'speaker_ambiguous' }),
  ])
  await expect(validateCharacterRoster(decodedRoster, [f.source], f.cwd)).rejects.toThrow('MANUSCRIPT_CHARACTER_ALIAS')
})

it('keeps a designation with several source speakers unresolved instead of taking the first matching term', async () => {
  const f = await fixture()
  const note = { ...f.note, scope: { context: '分别保留所引人物的称呼语境。' }, evidence: [f.evidence(4, 5), f.evidence(8, 9)] }
  await expect(f.validate(note)).rejects.toThrow('MANUSCRIPT_RELATION_SPEAKER')
  const saved = manuscriptRelationshipSchema.parse({ ...note,
    evidence: note.evidence.map(row => ({ ...row, source_path: f.source.path })) })
  expect(manuscriptRelationshipSpeakerIssues(saved, [f.source], f.roster)).toEqual([
    expect.objectContaining({ code: 'speaker_ambiguous' }),
  ])
})

it('requires a current exact quotation before evaluating a saved speaker binding', async () => {
  const f = await fixture(), saved = await f.validate(f.note)
  for (const sources of [[], [{ ...f.source, sha256: 'f'.repeat(64) }]]) {
    expect(manuscriptRelationshipSpeakerIssues(saved, sources, f.roster)).toEqual([
      expect.objectContaining({ code: 'speaker_unresolved' }),
    ])
  }
  expect(manuscriptRelationshipSpeakerIssues({ ...saved, evidence: [{ ...saved.evidence[0]!, quote: '不同的原句。' }] },
    [f.source], f.roster)).toEqual([expect.objectContaining({ code: 'speaker_unresolved' })])
  const { contextual_name: _designation, ...ordinary } = saved
  expect(manuscriptRelationshipSpeakerIssues(ordinary, [], f.roster)).toEqual([])
})

it('requires explicit source-anchored character labels and rejects duplicate stable identities or globally ambiguous aliases', async () => {
  const f = await fixture()
  await expect(validateCharacterRoster([], [f.source], f.cwd)).rejects.toThrow()
  await expect(validateCharacterRoster([...f.rows, f.rows[0]], [f.source], f.cwd)).rejects.toThrow('MANUSCRIPT_CHARACTER_ID')
  await expect(validateCharacterRoster([
    { ...f.rows[1], aliases: ['妈妈'], evidence: [f.evidence(4, 5)] },
    { ...f.rows[3], aliases: ['妈妈'], evidence: [f.evidence(8, 9)] },
  ], [f.source], f.cwd)).rejects.toThrow('MANUSCRIPT_CHARACTER_ALIAS')
  await expect(validateCharacterRoster([{ ...f.rows[0], aliases: ['不存在的昵称'] }], [f.source], f.cwd))
    .rejects.toThrow('MANUSCRIPT_CHARACTER_QUOTE')
  await expect(validateCharacterRoster([{ ...f.rows[0], evidence: [f.evidence(9)] }], [f.source], f.cwd))
    .rejects.toThrow('MANUSCRIPT_CHARACTER_QUOTE')
  expect(manuscriptCharacterSchema.safeParse({ character_id: 'new', name: '新人物', evidence: [] }).success).toBe(false)
})

it.each(['subject_id', 'object_id', 'speaker_id', 'target_id'])('rejects a name or unknown ID supplied as %s', async (field) => {
  const f = await fixture()
  const note = field === 'subject_id' || field === 'object_id' ? { ...f.note, [field]: '林宁' }
    : { ...f.note, contextual_name: { ...f.note.contextual_name, [field]: '林宁' } }
  await expect(f.validate(note)).rejects.toThrow('MANUSCRIPT_RELATION_CHARACTER')
})

it('rejects self relations, unrelated designation targets and terms absent from the selected evidence', async () => {
  const f = await fixture()
  await expect(f.validate({ ...f.note, object_id: f.note.subject_id })).rejects.toThrow('MANUSCRIPT_RELATION_SELF')
  await expect(f.validate({ ...f.note, contextual_name: { ...f.note.contextual_name, target_id: 'lin-cheng' } }))
    .rejects.toThrow('MANUSCRIPT_RELATION_TARGET')
  await expect(f.validate({ ...f.note, contextual_name: { ...f.note.contextual_name, term: '姑姑' } }))
    .rejects.toThrow('MANUSCRIPT_RELATION_TERM')
  const { contextual_name: _designation, ...withoutDesignation } = f.note
  expect(await f.validate(withoutDesignation)).not.toHaveProperty('contextual_name')
})

it('rejects missing narrative context, invalid statuses and blank optional scope values', async () => {
  const f = await fixture()
  for (const scope of [{}, { context: '  ' }, { context: '明确语境', episode: '' },
    { context: '明确语境', scene_id: ' ' }, { context: '明确语境', story_time: '' }]) {
    await expect(f.validate({ ...f.note, scope })).rejects.toThrow()
  }
  expect(manuscriptRelationshipSchema.safeParse({ ...f.note, status: 'proven' }).success).toBe(false)
  expect(manuscriptRelationshipSchema.safeParse({ ...f.note, evidence: [] }).success).toBe(false)
  expect(manuscriptRelationshipSchema.safeParse({ ...f.note, relation: ' ' }).success).toBe(false)
})

it('rejects a source outside the bound task even when its content and hash match', async () => {
  const f = await fixture()
  await writeFile(join(f.cwd, 'unbound.txt'), original, { flag: 'wx' })
  const evidence = [{ ...f.evidence(4, 5), source_path: 'unbound.txt' }]
  await expect(f.validate({ ...f.note, evidence })).rejects.toThrow('MANUSCRIPT_RELATION_SOURCE')
  await expect(validateCharacterRoster([{ ...f.rows[0], evidence: [{ ...f.evidence(3), source_path: 'unbound.txt' }] }],
    [f.source], f.cwd)).rejects.toThrow('MANUSCRIPT_RELATION_SOURCE')
})

it('expires character and relationship evidence when actual source bytes change', async () => {
  const f = await fixture()
  await writeFile(f.path, original.replace('林遥（小遥）', '林遥（遥遥）'))
  const current = await f.read()
  await expect(validateCharacterRoster(f.rows, [current], f.cwd)).rejects.toThrow('MANUSCRIPT_RELATION_STALE')
  await expect(validateManuscriptRelationship(f.note, [current], f.roster, f.cwd)).rejects.toThrow('MANUSCRIPT_RELATION_STALE')
})

it('requires the exact original text at the requested lines, including multiline punctuation and spacing', async () => {
  const f = await fixture()
  for (const evidence of [
    [{ ...f.evidence(4), quote: f.evidence(5).quote }],
    [{ ...f.evidence(4, 5), quote: f.evidence(4, 5).quote + ' ' }],
    [{ ...f.evidence(4, 5), quote: f.evidence(4, 5).quote.replace('。', '！') }],
  ]) await expect(f.validate({ ...f.note, evidence })).rejects.toThrow('MANUSCRIPT_RELATION_QUOTE')
  for (const [start_line, end_line] of [[4, 3], [4, 100]]) {
    await expect(f.validate({ ...f.note, evidence: [{ ...f.evidence(4), start_line, end_line }] }))
      .rejects.toThrow('MANUSCRIPT_RELATION_LINES')
  }
  for (const evidence of [[{ ...f.evidence(4), start_line: 0 }], [{ ...f.evidence(4), quote: ' ' }]]) {
    await expect(f.validate({ ...f.note, evidence })).rejects.toThrow()
  }
})

it('locates a rejected quote and gives versioned reread arguments without revealing the expected source passage', async () => {
  const f = await fixture()
  const message = await rejectedMessage(f.validate({ ...f.note, evidence: [{ ...f.evidence(4, 5), quote: '人物关系的错误摘录。' }] }))
  expect(message).toContain('MANUSCRIPT_RELATION_QUOTE')
  expect(message).toContain('source_path="./source.txt"')
  expect(message).toContain('start_line=4')
  expect(message).toContain('end_line=5')
  expect(message).toContain('read_source')
  expect(message).toContain(`source_sha256=${f.source.sha256}`)
  expect(message).toContain('offset=4')
  expect(message).toContain('continuation')
  expect(message).not.toContain('林遥：妈妈，我回来了。')
  expect(message).not.toContain('▲林宁是林遥的母亲。')
})

it.each([
  { name: '没有依据的姓名', aliases: [], label: '没有依据的姓名' },
  { name: '林遥', aliases: ['没有依据的别名'], label: '没有依据的别名' },
])('identifies the exact character and unsupported label $label in a rejected roster', async ({ name, aliases, label }) => {
  const f = await fixture()
  const message = await rejectedMessage(validateCharacterRoster([{ ...f.rows[0], name, aliases }], [f.source], f.cwd))
  expect(message).toContain('MANUSCRIPT_CHARACTER_QUOTE')
  expect(message).toContain('character_id="lin-yao"')
  expect(message).toContain(`label=${JSON.stringify(label)}`)
  expect(message).not.toContain('▲林遥（小遥）走向林宁。')
})

it('derives actual citation headings and identifies the exact literal time basis without asserting validity periods', async () => {
  const f = await fixture(), note = await f.validate(f.note)
  const [context] = manuscriptRelationshipSourceContexts(note, [f.source])
  expect(context).toMatchObject({ source_path: f.source.path, source_sha256: f.source.sha256,
    start_line: 4, end_line: 5, crosses_episodes: false, crosses_scenes: false,
    sections: [{ episode: '1', scene_id: '1-1', heading_line: 2, heading: '1-1 客厅 日 内' }],
    time_basis: [{ kind: 'scene_heading', start_line: 2, end_line: 2, quote: '1-1 客厅 日 内', value: '日' }] })
  expect(context?.notice).toContain('仅说明引文出处')
  expect(context?.notice).toContain('不自动说明关系有效期或事件已发生')
  expect(manuscriptRelationshipScopeIssues(note, [f.source])).toEqual([])
  expect(context?.sections[0]?.source_scene_id).toEqual(expect.any(String))
  expect(await f.validate({ ...f.note, scope: { ...f.note.scope, episode: '第1集',
    scene_id: context?.sections[0]?.source_scene_id } })).toMatchObject({ status: 'asserted' })
})

it('rejects explicit episode, source-scene, and unquoted time mistakes with the actual heading and citation lines', async () => {
  const f = await fixture()
  for (const scope of [
    { ...f.note.scope, episode: '第9集' }, { ...f.note.scope, scene_id: '1-2' },
    { ...f.note.scope, scene_id: 'file-1/1:1' }, { ...f.note.scope, story_time: '拦截后' },
  ]) {
    const message = await rejectedMessage(f.validate({ ...f.note, scope }))
    expect(message).toContain('MANUSCRIPT_RELATION_SCOPE')
    expect(message).toContain('引用行=4-5')
    expect(message).toContain('标题行=2')
    expect(message).toContain('1-1 客厅 日 内')
  }
})

it('uses an actual quoted time as evidence without automatically applying it to other citations', async () => {
  const f = await fixture(original + '\n第2集\n2-1 门口 夜 外\n林遥：三年前，林宁一直照顾我。')
  const note = { ...f.note, scope: { story_time: '三年前', context: '人物回忆，其余引文补充称谓。' },
    evidence: [f.evidence(4, 5), f.evidence(12)] }
  const validated = await f.validate(note), contexts = manuscriptRelationshipSourceContexts(validated, [f.source])
  expect(contexts[0]?.time_basis).toEqual([])
  expect(contexts[1]?.time_basis).toEqual([{ kind: 'quote', start_line: 12, end_line: 12,
    quote: '林遥：三年前，林宁一直照顾我。', value: '三年前' }])
  expect(contexts.map(context => context.sections[0]?.episode)).toEqual(['1', '2'])
  expect(validated.scope).toEqual(note.scope)
})

it('retains cross-scene and cross-episode evidence when a note omits a single shared location', async () => {
  const f = await fixture(original + '\n第2集\n2-1 门口 夜 外\n林遥：妈妈，等我。')
  const scope = { context: '不同引文共同支持人物称谓，不指定关系起止时间。' }
  const note = await f.validate({ ...f.note, scope, evidence: [f.evidence(4, 5), f.evidence(12)] })
  expect(note.scope).toEqual(scope)
  expect(manuscriptRelationshipSourceContexts(note, [f.source]).map(context => context.sections[0]?.scene_id))
    .toEqual(['1-1', '2-1'])
  await expect(f.validate({ ...note, scope: { ...scope, episode: '1' } })).rejects.toThrow('scope.episode')
  await expect(f.validate({ ...note, scope: { ...scope, scene_id: '1-1' } })).rejects.toThrow('scope.scene_id')
})

it('leaves a source without headings unassigned and requires rereading when an old note supplies an unsupported location', async () => {
  const contents = original.replace('第1集', '人物往来').replace('1-1 客厅 日 内', '对白开始。').replace('1-2 门口 日 外', '另一段对白。')
  const f = await fixture(contents), scope = { context: '引文明确了称谓，地点与集数未标明。' }
  const note = await f.validate({ ...f.note, scope })
  expect(manuscriptRelationshipScopeIssues(note, [f.source])).toEqual([])
  expect(manuscriptRelationshipSourceContexts(note, [f.source])[0]?.sections[0])
    .toMatchObject({ episode: 'unassigned', scene_id: null })
  const old = manuscriptRelationshipSchema.parse({ ...note, scope: { ...scope, episode: '1' } })
  const issues = manuscriptRelationshipScopeIssues(old, [f.source])
  expect(issues).toMatchObject([{ field: 'episode', code: 'unassigned' }])
  expect(issues[0]?.message).toContain('没有实际集标题依据')
  expect(manuscriptRelationshipScopeIssues(manuscriptRelationshipSchema.parse({ ...note,
    scope: { ...scope, scene_id: '1-1' } }), [f.source])).toMatchObject([{ field: 'scene_id', code: 'unassigned' }])
  await expect(f.validate({ ...note, scope: { ...scope, episode: 'unassigned' } })).rejects.toThrow('MANUSCRIPT_RELATION_SCOPE')
})

it('keeps source archives and dialogue place references from supplying a false current episode or scene', async () => {
  const f = await fixture(original + '\n第2集\n2-1 三楼备勤间 日 内\n林遥：原书第47章，我会去一楼大厅找妈妈。')
  const note = await f.validate({ ...f.note, scope: { episode: '2', scene_id: '2-1', context: '台词提及旧剧情和别处。' },
    evidence: [f.evidence(12)] })
  expect(manuscriptRelationshipSourceContexts(note, [f.source])[0]?.sections[0])
    .toMatchObject({ episode: '2', scene_id: '2-1', heading: '2-1 三楼备勤间 日 内' })
  await expect(f.validate({ ...note, scope: { ...note.scope, episode: '第47集' } })).rejects.toThrow('scope.episode')
})

it.each(['第9集首次见面', '场景1-2见面', '12:30相遇'])('requires structured fields and source support for context %s', async (context) => {
  const f = await fixture()
  const message = await rejectedMessage(f.validate({ ...f.note, scope: { context } }))
  expect(message).toContain('scope.context')
  expect(message).toContain('scope.episode、scene_id、story_time')
})

it('reports outdated or unavailable old citation rows without mutating saved notes', async () => {
  const f = await fixture(), note = await f.validate(f.note), before = JSON.stringify(note)
  expect(manuscriptRelationshipScopeIssues(note, [])).toEqual(expect.arrayContaining([
    expect.objectContaining({ field: 'evidence', code: 'source_unavailable' }),
  ]))
  expect(() => manuscriptRelationshipSourceContexts(note, [])).toThrow('MANUSCRIPT_RELATION_SCOPE_SOURCE')
  const anchor = { ...f.evidence(4, 5), source_path: f.source.path }
  const outOfRange = { ...note, evidence: [{ ...anchor, end_line: 100 }] }
  expect(manuscriptRelationshipScopeIssues(outOfRange, [f.source])).toEqual(expect.arrayContaining([
    expect.objectContaining({ field: 'evidence', code: 'range_unavailable' }),
  ]))
  expect(() => manuscriptRelationshipSourceContexts(outOfRange, [f.source])).toThrow('MANUSCRIPT_RELATION_SCOPE_LINES')
  const wrongQuote = { ...note, evidence: [{ ...anchor, quote: '未经核对的原句。' }] }
  expect(manuscriptRelationshipScopeIssues(wrongQuote, [f.source])).toEqual(expect.arrayContaining([
    expect.objectContaining({ field: 'evidence', code: 'quote_mismatch' }),
  ]))
  expect(() => manuscriptRelationshipSourceContexts(wrongQuote, [f.source])).toThrow('MANUSCRIPT_RELATION_SCOPE_QUOTE')
  expect(JSON.stringify(note)).toBe(before)
})

it('rejects model-supplied derived contexts and time bases rather than accepting a second source of location data', async () => {
  const f = await fixture()
  await expect(f.validate({ ...f.note, source_contexts: [] })).rejects.toThrow()
  await expect(f.validate({ ...f.note, time_basis: [] })).rejects.toThrow()
  expect(await validateManuscriptEvidence([f.evidence(4)], [f.source], f.cwd))
    .toEqual([{ ...f.evidence(4), source_path: f.source.path }])
})
