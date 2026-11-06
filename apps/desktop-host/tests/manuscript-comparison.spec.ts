/** Literal differences and source contexts remain separate from model-authored conflict judgments. */
import { afterEach, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readManuscript } from '../src/manuscript-document.ts'
import { manuscriptReadingText } from '../src/manuscript-reading.ts'
import { validateCharacterRoster } from '../src/manuscript-relationships.ts'
import { annotateComparison, comparisonEvidence, comparisonReviewIssues, comparisonTimeIssues, manuscriptComparisonSchema,
  validateManuscriptComparison } from '../src/manuscript-comparison.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

const original = ['第2集', '2-1 钟楼 日 内', '人物：叶青。', '叶青：昨天账上有三十元。', '叶青：刚才取出十元。',
  '叶青：现在账上还剩二十元。', '2-2 饭馆 夜 内', '叶青：明天去钟楼取信。', '第3集', '3-1 医院 日 内',
  '叶青：昨天签的贷款总额是三十元，未追加。', '叶青：今天说还是同一笔原额，却写成五十元。'].join('\n')

async function fixture(contents = original) {
  const cwd = await mkdtemp(join(tmpdir(), 'manuscript-comparison-'))
  roots.push(cwd)
  const path = join(cwd, 'source.txt')
  await writeFile(path, contents, { flag: 'wx', mode: 0o600 })
  const source = await readManuscript(path, cwd, { maxFileBytes: 16_384, maxTextChars: 4096 }, new AbortController().signal)
  const evidence = (start: number, end = start) => ({ source_path: './source.txt', source_sha256: source.sha256,
    start_line: start, end_line: end, quote: manuscriptReadingText(contents).split('\n').slice(start - 1, end).join('\n') })
  const roster = await validateCharacterRoster([{ character_id: 'qing', name: '叶青', evidence: [evidence(3)] }], [source], cwd)
  const note = manuscriptComparisonSchema.parse({ comparison_id: 'balance-change', subject_id: 'qing', quantity: '账上余额',
    before: { value_text: '三十', unit: '元', condition: '账上余额', story_time: '昨天', evidence: [evidence(4)] },
    after: { value_text: '二十', unit: '元', condition: '账上余额', story_time: '现在', evidence: [evidence(6)] },
    explanation_evidence: [evidence(5)], explanation_kind: 'explicit_change',
    interpretation: 'explained_change', rationale: '原文存在两次数值之间的取款过程。' })
  return { cwd, path, source, evidence, roster, note,
    validate: (raw: unknown) => validateManuscriptComparison(raw, [source], roster, cwd) }
}

it('keeps a normal value change and its intervening explanation separately without certifying semantics', async () => {
  const f = await fixture(), before = await readFile(f.path)
  const result = await f.validate(f.note)
  expect(result.record.before.evidence[0]?.source_path).toBe(f.source.path)
  expect(result.record.after.evidence[0]?.quote).toBe('叶青：现在账上还剩二十元。')
  expect(result.record.explanation_evidence[0]?.quote).toBe('叶青：刚才取出十元。')
  expect(result.literal_difference).toBe(true)
  expect(result.effective_interpretation).toBe('explained_change')
  expect(result).toMatchObject({ semantic_assessment: 'model_authored', contradiction_proven: false,
    labels_verified: false, intervening_context_assessed: false, missing_basis: [] })
  expect(result.bridge_ranges).toMatchObject([{ source_path: f.source.path, source_sha256: f.source.sha256, start_line: 4, end_line: 6 }])
  expect(result.source_contexts.before[0]?.context.sections[0]).toMatchObject({ episode: '2', heading: '2-1 钟楼 日 内' })
  expect(result.source_contexts.explanation[0]?.start_line).toBe(5)
  expect(result.source_contexts.before[0]?.context.citation_labels).toEqual([
    { start_line: 4, end_line: 4, episode: '第2集', scene_id: '2-1', source_scene_id: 'source-scene-1' },
  ])
  for (const contexts of Object.values(result.source_contexts)) {
    for (const context of contexts) {
      expect(context.context.sections.every(section => !('previous_section' in section) && !('next_section' in section))).toBe(true)
    }
  }
  expect(result.citation_labels).toEqual({
    before: [{ source_path: f.source.path, source_sha256: f.source.sha256, start_line: 4, end_line: 4,
      episode: '第2集', scene_id: '2-1', source_scene_id: 'source-scene-1' }],
    after: [{ source_path: f.source.path, source_sha256: f.source.sha256, start_line: 6, end_line: 6,
      episode: '第2集', scene_id: '2-1', source_scene_id: 'source-scene-1' }],
    explanation: [{ source_path: f.source.path, source_sha256: f.source.sha256, start_line: 5, end_line: 5,
      episode: '第2集', scene_id: '2-1', source_scene_id: 'source-scene-1' }],
  })
  expect(Object.keys(result.bridge_ranges[0] ?? {})).toEqual(['source_path', 'source_sha256', 'start_line', 'end_line'])
  expect(comparisonEvidence(result.record)).toEqual([
    ...result.record.before.evidence, ...result.record.after.evidence, ...result.record.explanation_evidence,
  ])
  expect(await readFile(f.path)).toEqual(before)
})

it('retains a fully specified potential conflict across episodes without promoting it to a proved contradiction', async () => {
  const lines = original.split('\n')
  lines.splice(11, 0, '第4集', '4-1 律所 日 内')
  const f = await fixture(lines.join('\n'))
  const result = await f.validate({ ...f.note, interpretation: 'potential_conflict', explanation_evidence: [],
    quantity: '同一笔贷款原额', rationale: '同一笔原额出现不同字面值，仍需核对其他变更或转述误差。',
    before: { value_text: '三十', unit: '元', condition: '原额未追加', story_time: '昨天', evidence: [f.evidence(11)] },
    after: { value_text: '五十', unit: '元', condition: '同一笔原额', story_time: '今天', evidence: [f.evidence(14)] } })
  expect(result.effective_interpretation).toBe('potential_conflict')
  expect(result.contradiction_proven).toBe(false)
  expect(result.citation_labels.before[0]?.episode).toBe('第3集')
  expect(result.citation_labels.after[0]?.episode).toBe('第4集')
  expect(result.bridge_ranges).toEqual([{ source_path: f.source.path, source_sha256: f.source.sha256, start_line: 11, end_line: 14 }])
  expect(result.source_contexts.after[0]?.context.sections[0]).toMatchObject({ episode: '4', heading: '4-1 律所 日 内' })
})

it.each(['unit', 'condition', 'story_time'] as const)('downgrades potential conflict missing an endpoint %s', async (field) => {
  const f = await fixture()
  const note = structuredClone(f.note)
  note.interpretation = 'potential_conflict'
  switch (field) {
    case 'unit': delete note.before.unit; delete note.after.unit; break
    case 'condition': delete note.before.condition; delete note.after.condition; break
    case 'story_time': delete note.before.story_time; delete note.after.story_time; break
  }
  const result = await f.validate(note)
  expect(result.effective_interpretation).toBe('unresolved')
  expect(result.missing_basis).toEqual([`before.${field}`, `after.${field}`])
  expect(result.record.interpretation).toBe('potential_conflict')
  expect(result.contradiction_proven).toBe(false)
})

it('rejects an explained change with no actual explanation evidence', async () => {
  const f = await fixture()
  await expect(f.validate({ ...f.note, explanation_evidence: [] })).rejects.toThrow('MANUSCRIPT_COMPARISON_EXPLANATION')
})

it('requires each literal value in its own endpoint evidence instead of borrowing the other endpoint', async () => {
  const f = await fixture()
  await expect(f.validate({ ...f.note, before: { ...f.note.before, value_text: '二十' } })).rejects.toThrow('MANUSCRIPT_COMPARISON_VALUE')
  await expect(f.validate({ ...f.note, after: { ...f.note.after, value_text: '一百' } })).rejects.toThrow('MANUSCRIPT_COMPARISON_VALUE')
})

it('rejects unknown subjects, invented quotations and stale explanation anchors', async () => {
  const f = await fixture()
  await expect(f.validate({ ...f.note, subject_id: '叶青' })).rejects.toThrow('MANUSCRIPT_COMPARISON_SUBJECT')
  await expect(f.validate({ ...f.note, before: { ...f.note.before,
    evidence: [{ ...f.evidence(4), quote: '叶青：昨天账上有三十万元。' }] } })).rejects.toThrow('MANUSCRIPT_RELATION_QUOTE')
  await expect(f.validate({ ...f.note,
    explanation_evidence: [{ ...f.evidence(5), source_sha256: 'a'.repeat(64) }] })).rejects.toThrow('MANUSCRIPT_RELATION_STALE')
})

it('keeps mentioned places separate from actual source scene headings', async () => {
  const f = await fixture()
  const result = await f.validate({ ...f.note, quantity: '地点提及', interpretation: 'unresolved',
    before: { value_text: '钟楼', evidence: [f.evidence(8)] },
    after: { value_text: '医院', evidence: [f.evidence(10)] } })
  expect(result.source_contexts.before[0]?.context.sections[0]?.heading).toBe('2-2 饭馆 夜 内')
  expect(result.source_contexts.after[0]?.context.sections[0]?.heading).toBe('3-1 医院 日 内')
  expect(result.contradiction_proven).toBe(false)
})

it('keeps equal literal values across episodes without inferring incomparability', async () => {
  const f = await fixture()
  const result = await f.validate({ ...f.note, interpretation: 'unresolved',
    before: { value_text: '三十', evidence: [f.evidence(4)] },
    after: { value_text: '三十', evidence: [f.evidence(11)] } })
  expect(result.literal_difference).toBe(false)
  expect(result.effective_interpretation).toBe('unresolved')
  expect(result.citation_labels.before[0]?.episode).toBe('第2集')
  expect(result.citation_labels.after[0]?.episode).toBe('第3集')
})

it('compares literal text without converting number spellings or units', async () => {
  const f = await fixture(original.replace('账上有三十元', '账上有30元').replace('贷款总额是三十元', '贷款总额是３０元'))
  const result = await f.validate({ ...f.note, interpretation: 'unresolved',
    before: { value_text: '30', evidence: [f.evidence(4)] }, after: { value_text: '３０', evidence: [f.evidence(11)] } })
  expect(result.literal_difference).toBe(true)
  expect(result.effective_interpretation).toBe('unresolved')
  expect(result.contradiction_proven).toBe(false)
})

it('rejects source changes during annotation and keeps output metadata outside persisted model rows', async () => {
  const f = await fixture()
  const result = await f.validate(f.note)
  const next = { ...f.source, sha256: 'b'.repeat(64), text: original + '\n新段落。' }
  expect(() => annotateComparison(result.record, [next])).toThrow('MANUSCRIPT_COMPARISON_STALE')
  expect(() => annotateComparison(result.record, [])).toThrow('MANUSCRIPT_COMPARISON_STALE')
  const otherPath = join(f.cwd, 'different-source.txt')
  await writeFile(otherPath, original, { flag: 'wx', mode: 0o600 })
  const other = await readManuscript(otherPath, f.cwd, { maxFileBytes: 16_384, maxTextChars: 4096 }, new AbortController().signal)
  expect(other.sha256).toBe(f.source.sha256)
  expect(() => annotateComparison(result.record, [other])).toThrow('MANUSCRIPT_COMPARISON_STALE')
  expect(() => manuscriptComparisonSchema.parse({ ...f.note, contradiction_proven: true })).toThrow()
  expect(result.record).not.toHaveProperty('source_contexts')
})

it('normalizes source display once when a title contains a carriage return before CRLF', async () => {
  const contents = original.replace('2-1 钟楼 日 内', '2-1 钟楼 日 内\r').replace(/\n/g, '\r\n')
  const f = await fixture(contents)
  const result = await f.validate(f.note)
  expect(result.source_contexts.before[0]?.context.sections[0]?.heading).toBe('2-1 钟楼 日 内\r')
  expect(await readFile(f.path, 'utf8')).toBe(contents)
})

it('retains an explicitly annotated salary change supported by the quoted promotion process', async () => {
  const lines = original.split('\n')
  lines[3] = '叶青：入职时月薪是三千元。'
  lines[4] = '▲叶青晋升后，月薪调为五千元。'
  lines[5] = '叶青：晋升后月薪是五千元。'
  const f = await fixture(lines.join('\n'))
  const result = await f.validate({ ...f.note, quantity: '月薪', rationale: '原文明确记载晋升后调薪。',
    before: { value_text: '三千', unit: '元', condition: '基本月薪', story_time: '入职时', evidence: [f.evidence(4)] },
    after: { value_text: '五千', unit: '元', condition: '基本月薪', story_time: '晋升后', evidence: [f.evidence(6)] } })
  expect(result.effective_interpretation).toBe('explained_change')
  expect(result.source_contexts.before[0]?.time_basis).toMatchObject([{ kind: 'quote', value: '入职时' }])
  expect(result.source_contexts.after[0]?.time_basis).toMatchObject([{ kind: 'quote', value: '晋升后' }])
  expect(result.contradiction_proven).toBe(false)
  expect(result.labels_verified).toBe(false)
})

it.each([undefined, 'general_rule', 'suggested'] as const)('rejects new explained claims with explanation kind %s and marks old records for review', async (kind) => {
  const f = await fixture(), current = await f.validate(f.note), note = structuredClone(current.record)
  if (kind === undefined) delete note.explanation_kind
  else note.explanation_kind = kind
  await expect(f.validate(note)).rejects.toThrow('MANUSCRIPT_COMPARISON_EXPLANATION_KIND')
  const legacy = manuscriptComparisonSchema.parse(note)
  const result = annotateComparison(legacy, [f.source])
  expect(result.record.interpretation).toBe('explained_change')
  expect(result.effective_interpretation).toBe('possible_change')
  expect(result.interpretation_reasons.length).toBeGreaterThan(0)
  expect(result.notice).toContain('一般规则不等于本次已发生或已到账')
  expect(comparisonReviewIssues(legacy, [f.source])).toMatchObject([{ code: 'explanation_kind_requires_review' }])
  expect(comparisonReviewIssues(current.record, [f.source])).toEqual([])
  expect((await f.validate({ ...note, interpretation: 'possible_change' })).record.interpretation).toBe('possible_change')
})

it('keeps a general points rule as a possible mechanism within the actual prelude frame', async () => {
  const lines = original.split('\n')
  lines[1] = '2-1 旧楼 日/夜·先导快切'
  lines[3] = '▲积分显示十。'
  lines[4] = '规则牌：每日可加二积分。'
  lines[5] = '▲积分显示十二。'
  const f = await fixture(lines.join('\n'))
  const note = { ...f.note, quantity: '积分', explanation_kind: 'general_rule', interpretation: 'possible_change',
    rationale: '只有一般规则，没有本次加分到账的明确事件。',
    before: { value_text: '十', unit: '分', condition: '积分面板', story_time: '日/夜·先导快切', evidence: [f.evidence(4)] },
    after: { value_text: '十二', unit: '分', condition: '积分面板', story_time: '日/夜·先导快切', evidence: [f.evidence(6)] } }
  const result = await f.validate(note)
  expect(result.effective_interpretation).toBe('possible_change')
  expect(result.interpretation_reasons).toContain('general_rule_does_not_establish_occurrence')
  expect(result.source_contexts.before[0]?.time_basis).toMatchObject([
    { kind: 'scene_heading', quote: '2-1 旧楼 日/夜·先导快切', value: '日/夜·先导快切' },
  ])
  expect(result.source_contexts.after[0]?.context.sections[0]?.heading).toBe('2-1 旧楼 日/夜·先导快切')
  await expect(f.validate({ ...note, before: { ...note.before, story_time: '清晨' } })).rejects.toThrow('MANUSCRIPT_COMPARISON_TIME')
  await expect(f.validate({ ...note, after: { ...note.after, story_time: '搬箱之前' } })).rejects.toThrow('MANUSCRIPT_COMPARISON_TIME')
})

it('marks stored unsupported time labels for rereading while omitted times remain unknown', async () => {
  const f = await fixture(), result = await f.validate(f.note)
  const old = { ...result.record, before: { ...result.record.before, story_time: '清晨' } }
  expect(comparisonTimeIssues(old, [f.source])).toMatchObject([{ endpoint: 'before', story_time: '清晨', code: 'unsupported_time' }])
  expect(comparisonReviewIssues(old, [f.source])).toMatchObject([{ endpoint: 'before', story_time: '清晨', code: 'unsupported_time' }])
  expect(() => annotateComparison(old, [f.source])).toThrow('MANUSCRIPT_COMPARISON_TIME')
  const note = structuredClone(result.record)
  delete note.before.story_time
  delete note.after.story_time
  expect(comparisonTimeIssues(note, [f.source])).toEqual([])
  expect(annotateComparison(note, [f.source]).source_contexts.before[0]?.time_basis).toEqual([])
})
