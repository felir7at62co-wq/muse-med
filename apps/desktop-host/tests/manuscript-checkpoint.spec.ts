/** Current manuscript evidence survives bounded checkpoint recovery without stale facts. */
import { expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import ToolResultPruner from '@deepseek-ai/dsh-compaction-tool-result-pruner'
import { formatManuscriptCheckpoint, type ManuscriptCheckpointInput } from '../src/manuscript-checkpoint.ts'
import { manuscriptCharacterSchema, manuscriptRelationshipSchema } from '../src/manuscript-relationships.ts'
import { annotateComparison, manuscriptComparisonSchema } from '../src/manuscript-comparison.ts'

const sourceHash = 'a'.repeat(64), sceneHash = 'b'.repeat(64), version = 'c'.repeat(64)

function input(): ManuscriptCheckpointInput {
  return {
    task_key: '旧信跨集改稿', mode: 'edit', version,
    sources: [{ path: '/project/source.txt', sha256: sourceHash }],
    files: [{ path: '/project/current.md', sha256: 'd'.repeat(64) }],
    scenes: [{ id: 'file-1/scene-1', sha256: sceneHash }],
    coverage: [{ path: '/project/source.txt', sha256: sourceHash,
      missing: [{ start_line: 4, end_line: 7, start_column: 2001, end_column: 12 }] }],
    characters: [manuscriptCharacterSchema.parse({ character_id: 'sister', name: '姐姐', aliases: ['阿青'],
      evidence: [{ source_path: '/project/source.txt', source_sha256: sourceHash, start_line: 1, end_line: 1,
        quote: '姐姐名叫阿青，她与母亲一起住在旧宅。' }] }),
    manuscriptCharacterSchema.parse({ character_id: 'mother', name: '母亲',
      evidence: [{ source_path: '/project/source.txt', source_sha256: sourceHash, start_line: 1, end_line: 1,
        quote: '姐姐名叫阿青，她与母亲一起住在旧宅。' }] })],
    relationships: [manuscriptRelationshipSchema.parse({ relationship_id: 'r1', subject_id: 'sister', object_id: 'mother', relation: '女儿',
      status: 'uncertain', scope: { episode: '1', scene_id: '1-1', story_time: '三年前', context: '人物推测，来源尚未确认。' },
      evidence: [{ source_path: '/project/source.txt', source_sha256: sourceHash,
        start_line: 2, end_line: 2, quote: '姐姐猜想她可能是自己的母亲。' }],
      contextual_name: { term: '妈妈', speaker_id: 'sister', target_id: 'mother' } })],
    event_notes: [{ event_id: '钥匙交接', scene_id: 'file-1/scene-1', quote: '父亲把钥匙交给姐姐。',
      source_quote: '父亲把钥匙交给姐姐。', source_path: '/project/source.txt', purpose: 'flashback',
      end_state: '三年前姐姐持有钥匙，妹妹尚不知婚约。', sha256: sceneHash, source_sha256: sourceHash }],
    known_read_sources: 1,
  }
}

function comparison() {
  const path = '/project/source.txt'
  const text = '第1集\n1-1 屋内 日 内\n姐姐：余额10。\n母亲：奖励10。\n姐姐：余额20。'
  const anchor = (line: number, quote: string) => ({ source_path: path, source_sha256: sourceHash,
    start_line: line, end_line: line, quote })
  return annotateComparison(manuscriptComparisonSchema.parse({ comparison_id: 'balance', subject_id: 'sister', quantity: '余额',
    before: { value_text: '10', evidence: [anchor(3, '姐姐：余额10。')] },
    after: { value_text: '20', evidence: [anchor(5, '姐姐：余额20。')] },
    explanation_evidence: [anchor(4, '母亲：奖励10。')], explanation_kind: 'explicit_change',
    interpretation: 'explained_change', rationale: '原文明示奖励后的余额变化。' }),
  [{ path, sha256: sourceHash, text }])
}

it('restores a complete change explanation with actual source scenes and unproven semantics', () => {
  const row = comparison(), result = formatManuscriptCheckpoint({ ...input(), comparisons: [row] }, { maxCharacters: 6000 })
  expect(result.omitted.comparisons).toBe(0)
  expect(result.text).toContain(JSON.stringify(row.record))
  expect(result.text).toContain('母亲：奖励10。')
  expect(result.text).toContain('"heading_setting":"屋内 日 内"')
  expect(result.text).toContain('"contradiction_proven":false')
  expect(result.text).toContain('"labels_verified":false')
  expect(result.text).not.toContain('"previous_section"')
})

it('excludes comparisons when any explanation version or the subject identity is stale', () => {
  const row = comparison()
  for (const evidence of [
    { ...input(), comparisons: [{ ...row, record: { ...row.record, explanation_evidence: row.record.explanation_evidence.map(
      anchor => ({ ...anchor, source_sha256: 'outdated' })) } }] },
    { ...input(), characters: input().characters.filter(character => character.character_id !== 'sister'), comparisons: [row] },
  ]) {
    const result = formatManuscriptCheckpoint(evidence, { maxCharacters: 6000 })
    expect(result.stale.comparisons).toBe(1)
    expect(result.text).not.toContain('"comparison_id":"balance"')
  }
})

it('omits an oversized comparison as a whole with an explicit reread count', () => {
  const row = comparison()
  const result = formatManuscriptCheckpoint({ ...input(), comparisons: [{ ...row,
    record: { ...row.record, rationale: '超长但不可裁成半条的判断'.repeat(1000) } }] }, { maxCharacters: 6000 })
  expect(result.omitted.comparisons).toBe(1)
  expect(result.text).not.toContain('"comparison_id":"balance"')
  expect(result.text.length).toBeLessThanOrEqual(6000)
})

it('preserves relationship direction, uncertainty, story time and complete source quotations', () => {
  const evidence = input()
  const result = formatManuscriptCheckpoint(evidence, { maxCharacters: 6000 })
  expect(result.text).toContain(JSON.stringify(evidence.relationships[0]))
  expect(result.text).toContain(JSON.stringify(evidence.characters[0]))
  expect(result.text).toContain(JSON.stringify(evidence.event_notes[0]))
  expect(result.text).toContain('"missingIntervals"')
  expect(result.text).toContain('"start_line":4,"end_line":7')
  expect(result.text).toContain('"start_column":2001,"end_column":12')
  expect(result.text).toContain('"known_read_sources":1')
  expect(result.omitted).toEqual({ sources: 0, files: 0, missingIntervals: 0, characters: 0,
    relationships: 0, comparisons: 0, eventNotes: 0 })
  expect(result.stale).toEqual({ coverage: 0, characters: 0, relationships: 0, comparisons: 0, eventNotes: 0 })
  expect(result.truncated).toBe(false)
})

it('excludes old source relations and old source or scene event notes from current evidence', () => {
  const evidence = input()
  const relation = evidence.relationships[0]!
  const note = evidence.event_notes[0]!
  const result = formatManuscriptCheckpoint({ ...evidence,
    relationships: [{ ...relation, evidence: relation.evidence.map(anchor => ({ ...anchor, source_sha256: 'old-source' })) }],
    event_notes: [{ ...note, source_sha256: 'old-source' }, { ...note, sha256: 'old-scene' }],
    invalidated_event_notes: 3,
  }, { maxCharacters: 6000 })
  expect(result.text).not.toContain(relation.evidence[0]!.quote)
  expect(result.text).not.toContain(note.end_state)
  expect(result.text).toContain('"invalidated_event_notes":3')
  expect(result.stale).toEqual({ coverage: 0, characters: 0, relationships: 1, comparisons: 0, eventNotes: 2 })
})

it('reports unrecorded current source coverage after an older coverage version expires', () => {
  const evidence = input()
  const result = formatManuscriptCheckpoint({ ...evidence,
    coverage: evidence.coverage.map(row => ({ ...row, sha256: 'old-source' })),
    known_read_sources: 0,
  }, { maxCharacters: 6000 })
  expect(result.stale.coverage).toBe(1)
  expect(result.text).toContain('"unrecorded_sources":1')
  expect(result.text).toContain('"reading":"unrecorded"')
  expect(result.text).not.toContain('"reading":"complete"')
})

it('excludes stale character names and aliases together with relations to their expired identities', () => {
  const evidence = input()
  const result = formatManuscriptCheckpoint({ ...evidence,
    characters: evidence.characters.map(row => ({ ...row,
      evidence: row.evidence.map(anchor => ({ ...anchor, source_sha256: 'old-source' })) })),
  }, { maxCharacters: 6000 })
  expect(result.stale.characters).toBe(2)
  expect(result.stale.relationships).toBe(1)
  expect(result.text).not.toContain('"aliases"')
  expect(result.text).not.toContain('"kind":"characters"')
  expect(result.text).not.toContain('"kind":"relationships"')
})

it('keeps file references bounded when reconciled documents also contain their complete text', () => {
  const evidence = input()
  const source = { ...evidence.sources[0]!, text: '全文不属于文件引用'.repeat(3000) }
  const file = { ...evidence.files[0]!, text: '当前稿全文也不能透传'.repeat(3000) }
  const result = formatManuscriptCheckpoint({ ...evidence, sources: [source], files: [file] }, { maxCharacters: 6000 })
  expect(result.omitted.sources).toBe(0)
  expect(result.omitted.files).toBe(0)
  expect(result.text).toContain('"kind":"sources","value":{"path":"/project/source.txt","sha256":"' + sourceHash)
  expect(result.text).not.toContain('"text"')
  expect(result.text).not.toContain('全文')
})

it('marks a fully covered current source and preserves absent optional read counts', () => {
  const evidence = input()
  delete evidence.known_read_sources
  const result = formatManuscriptCheckpoint({ ...evidence,
    coverage: evidence.coverage.map(row => ({ ...row, missing: [] })),
  }, { maxCharacters: 6000 })
  expect(result.text).toContain('"reading":"complete"')
  expect(result.text).not.toContain('known_read_sources')
})

it('omits oversized complete facts with explicit counts and usable reread directions', () => {
  const evidence = input()
  const result = formatManuscriptCheckpoint({ ...evidence,
    event_notes: evidence.event_notes.map(row => ({ ...row, end_state: '完整状态不可截断'.repeat(1000) })),
  }, { maxCharacters: 1024 })
  expect(result.characters).toBe(result.text.length)
  expect(result.characters).toBeLessThanOrEqual(1024)
  expect(result.text).toContain(version)
  expect(result.omitted.eventNotes).toBe(1)
  expect(result.text).not.toContain('完整状态不可截断')
  expect(result.text).toContain('manuscript_work audit')
  expect(result.text).toContain('source_contexts')
  for (const name of ['read_source', 'source_path', 'source_sha256', 'offset', 'column', 'limit']) {
    expect(result.text).toContain(name)
  }
  expect(result.truncated).toBe(true)
})

it('keeps bounded version recovery when an oversized task label cannot fit', () => {
  const result = formatManuscriptCheckpoint({ ...input(), task_key: '长任务名'.repeat(1000) }, { maxCharacters: 1024 })
  expect(result.characters).toBeLessThanOrEqual(1024)
  expect(result.taskKeyOmitted).toBe(true)
  expect(result.text).toContain('"task_key_omitted":true')
  expect(result.text).toContain(version)
})

it.each([0, 1023, 1024.5, Number.NaN])('rejects an unusable configured checkpoint ceiling %s', (maxCharacters) => {
  expect(() => formatManuscriptCheckpoint(input(), { maxCharacters })).toThrow('MANUSCRIPT_CHECKPOINT_LIMIT')
})

it('fails explicitly when mandatory version information exceeds the entire ceiling', () => {
  expect(() => formatManuscriptCheckpoint({ ...input(), version: 'oversized'.repeat(1000) }, { maxCharacters: 1024 }))
    .toThrow('current version and recovery information')
})

it('restores unchanged-version facts after the actual pruner removes their earlier text', async () => {
  const ctx = new Context()
  try {
    new SessionProjections(ctx)
    new TokenMeter(ctx)
    const pruner = new ToolResultPruner(ctx, { thresholdChars: 8192, headChars: 4096, tailChars: 1024 })
    const evidence = input()
    const storyFact = evidence.event_notes[0]!.end_state
    const result = pruner.pruneContent([{ type: 'text', text: '前文'.repeat(2500) + storyFact + '后文'.repeat(2500) }])
    expect(JSON.stringify(result)).not.toContain(storyFact)
    const restored = formatManuscriptCheckpoint(evidence, { maxCharacters: 6000 })
    expect(restored.text).toContain(storyFact)
    expect(restored.text).toContain(JSON.stringify(evidence.relationships[0]))
    expect(restored.text).toContain(version)
  } finally { await ctx.fiber.dispose() }
})

it('renders deterministically without changing caller-owned evidence', () => {
  const evidence = input(), before = structuredClone(evidence)
  const first = formatManuscriptCheckpoint(evidence, { maxCharacters: 2000 })
  expect(formatManuscriptCheckpoint(evidence, { maxCharacters: 2000 })).toEqual(first)
  expect(evidence).toEqual(before)
})
