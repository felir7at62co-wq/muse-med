/** Literal candidates need grounded semantic dispositions; rephrased events can be found without literal hits. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { Config } from '../src/manuscript-revisions.ts'
import { buildContinuityOutputSchema, validateContinuityAssessment, type ContinuityAssessment } from '../src/manuscript-continuity.ts'
import { readManuscriptMaterials, type ManuscriptMaterialsDocument } from '../src/manuscript-materials.ts'
import { scanManuscriptRepetitions } from '../src/manuscript-repeat-scan.ts'
import { validateRepetitionChecks } from '../src/manuscript-repeat-review.ts'
import { manuscriptQuotationMatches } from '../src/manuscript-review-evidence.ts'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'

const roots: string[] = [], signal = new AbortController().signal, config = Config({})
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const phrase = '他把完整的木匣交给掌柜，匣里的钥匙和收据一样不少，对方核对姓名后签字收下，交易到这里已经结束。'
const repeated = `第1集\n1-1 店内 日 内\n▲${phrase}\n第2集\n2-1 店内 日 内\n▲${phrase}\n`
async function fixture(text = repeated) {
  const root = await mkdtemp(join(tmpdir(), 'muse-repeat-review-')); roots.push(root)
  await writeFile(join(root, 'current.md'), text); await writeFile(join(root, 'candidate.md'), text)
  const materials = await readManuscriptMaterials([{ role: 'current', path: 'current.md' }, { role: 'candidate', path: 'candidate.md' }], root, config, signal)
  const target = materials.documents.find(document => document.role === 'candidate')!
  return { materials, target, scan: scanManuscriptRepetitions(target, config, signal) }
}
function cite(document: ManuscriptMaterialsDocument, number: number) {
  return { role: document.role, path: document.path, file_sha256: document.file_sha256, text_sha256: document.text_sha256,
    line: number, quote: document.lines.find(line => line.number === number)!.text }
}

it('requires every literal candidate to be assessed and rejects unrequested semantic fields', async () => {
  const { materials, target, scan } = await fixture()
  expect(scan.coverage.complete).toBe(true); expect(scan.candidates).toHaveLength(1)
  const report = { status: 'consistent', findings: [], unknowns: [], repeat_checks: [] }
  expect(validateContinuityAssessment(report, materials, target, 8, undefined, scan).status).toBe('unknown')
  expect(validateContinuityAssessment(report, materials, target, 8).reason).toBe('invalid_result')
  const accepted = { ...report, repeat_checks: scan.candidates.map(candidate => ({ candidate_sha256: candidate.candidate_sha256,
    status: 'legitimate', explanation: '明确的回忆或前情说明需要按实际上下文判断，本固定回复只验证保留路径。', evidence: [cite(target, 3), cite(target, 6)] })) }
  expect(validateJsonSchemaValue(buildContinuityOutputSchema(materials, undefined, scan), accepted)).toEqual([])
  expect(validateContinuityAssessment(accepted, materials, target, 8, undefined, scan)).toMatchObject({ status: 'consistent', reason: 'reviewed' })
})

it('accepts grounded event replay while source-versus-candidate identical text alone is insufficient', async () => {
  const { materials, target, scan } = await fixture(), evidence = [cite(target, 3), cite(target, 6)]
  const report: ContinuityAssessment = { status: 'issues', findings: [{ category: 'event_repetition',
    description: '同一已经完成的交付交易又当成新交易上演，后一次没有新信息。', evidence }], unknowns: [],
  repeat_checks: scan.candidates.map(candidate => ({ candidate_sha256: candidate.candidate_sha256,
    status: 'repeated_event', explanation: '引用候选稿两次已经完成的相同交易。', evidence })) }
  expect(validateContinuityAssessment(report, materials, target, 8, undefined, scan)).toMatchObject({ status: 'issues', reason: 'reviewed' })
  report.findings[0]!.evidence[0] = cite(materials.documents[0]!, 3)
  expect(validateContinuityAssessment(report, materials, target, 8, undefined, scan).reason).toBe('invalid_evidence')
})

it('allows a rephrased event finding when the complete literal scan has no hits', async () => {
  const { materials, target, scan } = await fixture('第1集\n1-1 店内 日 内\n▲周安付清两万元，拿回抵押物，掌柜宣布账已结清。\n第2集\n2-1 店内 日 内\n▲同一时刻，周安再次付款赎回原来那件物品，掌柜又宣布清账。\n')
  expect(scan.candidates).toEqual([])
  const report = { status: 'issues', findings: [{ category: 'event_repetition', description: '同一笔已经完成的赎当交易被换词重新上演。',
    evidence: [cite(target, 3), cite(target, 6)] }], unknowns: [], repeat_checks: [] }
  expect(validateContinuityAssessment(report, materials, target, 8, undefined, scan)).toMatchObject({ status: 'issues', reason: 'reviewed' })
})

it('requires exact Unicode columns for two literal occurrences on the same extracted line', async () => {
  const { materials, target, scan } = await fixture(`😀甲：${phrase}；乙：${phrase}`)
  const candidate = scan.candidates[0]!
  expect(candidate.occurrences[0]?.start.line).toBe(candidate.occurrences[1]?.start.line)
  const evidence = candidate.occurrences.slice(0, 2).map(occurrence => ({ ...cite(target, occurrence.start.line),
    quote: candidate.text, column: occurrence.start.column }))
  const report: ContinuityAssessment = { status: 'issues', unknowns: [], findings: [{ category: 'event_repetition',
    description: '同一行中两次相同的完整交易。', evidence }], repeat_checks: [{ candidate_sha256: candidate.candidate_sha256,
    status: 'repeated_event', explanation: '列号区分同一行的两次实际出现。', evidence }] }
  expect(validateContinuityAssessment(report, materials, target, 8, undefined, scan)).toMatchObject({ status: 'issues', reason: 'reviewed' })
  evidence[1]!.column++
  expect(validateContinuityAssessment(report, materials, target, 8, undefined, scan).status).toBe('unknown')
  expect(manuscriptQuotationMatches('😀甲：证据。', { quote: '甲：证据。', column: 2 })).toBe(true)
})

it('keeps partial scans and unresolved candidates unknown instead of treating them as zero repetition', async () => {
  const { target, scan } = await fixture()
  const incomplete = scanManuscriptRepetitions(target, Config({ repeatMaxOutputChars: 1 }), signal)
  expect(incomplete.coverage.complete).toBe(false)
  expect(validateRepetitionChecks([], incomplete, target, { status: 'consistent', findings: [], unknowns: [] })).toBeDefined()
  const candidate = scan.candidates[0]!, unknown = [{ candidate_sha256: candidate.candidate_sha256, status: 'unknown', explanation: '上下文不足。', evidence: [] }]
  expect(validateRepetitionChecks(unknown, scan, target, { status: 'unknown', findings: [], unknowns: ['上下文不足。'] })).toBeUndefined()
  expect(validateRepetitionChecks(unknown, scan, target, { status: 'consistent', findings: [], unknowns: [] })).toBeDefined()
})

it('does not count overlapping fragments of one target line as two repeated events', async () => {
  const { materials, target, scan } = await fixture('哈哈哈。')
  const first = { ...cite(target, 1), quote: '哈哈', column: 1 }, second = { ...first, column: 2 }
  expect(validateContinuityAssessment({ status: 'issues', unknowns: [], repeat_checks: [], findings: [{ category: 'event_repetition',
    description: '重叠引用反例。', evidence: [first, second] }] }, materials, target, 8, undefined, scan).reason).toBe('invalid_evidence')
})

it('requires quoted text to overlap the actual literal occurrence rather than an unrelated tail on its line', async () => {
  const shared = Array.from({ length: 40 }, (_, index) => String.fromCodePoint(0x4e00 + index)).join('')
  const { target, scan } = await fixture(`第1集\n1-1 家 日 内\n甲：${shared}尾注甲\n第2集\n2-1 家 日 内\n乙：${shared}尾注乙`)
  expect(scan.candidates).toHaveLength(1)
  const candidate = scan.candidates[0]!, root = { status: 'consistent' as const, findings: [], unknowns: [] }
  const irrelevant = [{ ...cite(target, 3), quote: '甲' }, { ...cite(target, 6), quote: '乙' }]
  const check = { candidate_sha256: candidate.candidate_sha256, status: 'legitimate', explanation: '候选所在线的无关尾注反例。', evidence: irrelevant }
  expect(validateRepetitionChecks([check], scan, target, root)).toBeDefined()
  const context = [3, 6].map(line => ({ ...cite(target, line), column: 1 }))
  expect(validateRepetitionChecks([{ ...check, evidence: context }], scan, target, root)).toBeUndefined()
})
