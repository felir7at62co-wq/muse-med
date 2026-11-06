/** Verify real source pagination and logged fact recovery across provider-overflow compaction. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { importSnapshotModule } from '../muse-fixture-import.mjs'

const revisions = await importSnapshotModule(
  new URL('../../../apps/desktop-host/src/manuscript-revisions.ts', import.meta.url),
  new URL('../../../apps/desktop-host/lib/manuscript-revisions.js', import.meta.url))
const compaction = await importSnapshotModule(
  new URL('../../../packages/compaction/compaction-basic/src/index.ts', import.meta.url),
  new URL('../../../packages/compaction/compaction-basic/lib/index.js', import.meta.url))
export const name = 'reading-recovery-fixture'
export const inject = ['tools', 'llm', 'toolResultPruner']

function text(blocks) { return blocks.filter(block => block.type === 'text').map(block => block.text).join('\n') }
function checkpoint(messages) {
  const content = messages.map(message => text(message.content)).findLast(value => value.includes('当前版本文稿资料检查点。'))
  assert.ok(content, 'The retried request must contain a logged manuscript checkpoint')
  return JSON.parse(content.split('\n').find(line => line.startsWith('{')))
}

function comparison(row, projected) {
  assert.equal(row.literal_difference, true)
  assert.equal(row.semantic_assessment, 'model_authored')
  assert.equal(row.contradiction_proven, false)
  assert.equal(row.labels_verified, false)
  if (row.record.comparison_id === 'balance-change') {
    assert.equal(row.record.explanation_kind, 'explicit_change')
    assert.equal(row.record.before.value_text, '三十')
    assert.equal(row.record.after.value_text, '二十')
    assert.equal(row.record.explanation_evidence[0].quote, '▲阿青从账户取出十元。')
    assert.equal(row.effective_interpretation, 'explained_change')
    assert.deepEqual(row.bridge_ranges.map(range => [range.start_line, range.end_line]), [[6, 8]])
  } else if (row.record.comparison_id === 'principal-difference') {
    assert.equal(row.record.before.value_text, '三十')
    assert.equal(row.record.after.value_text, '五十')
    assert.equal(row.effective_interpretation, 'potential_conflict')
  } else {
    assert.equal(row.record.comparison_id, 'points-rule')
    assert.equal(row.record.explanation_kind, 'general_rule')
    assert.equal(row.record.interpretation, 'possible_change')
    assert.equal(row.effective_interpretation, 'possible_change')
    assert.ok(row.interpretation_reasons.includes('general_rule_does_not_establish_occurrence'))
  }
  const context = projected ? row.source_contexts.before[0] : row.source_contexts.before[0].context
  assert.equal(context.sections[0].heading, row.record.comparison_id === 'points-rule' ? '1-2 旧楼 日/夜·先导快切' : '1-1 老宅 夜 内')
  assert.ok(row.source_contexts.before[0].time_basis.length > 0)
}

/** Mount production services into the shipped headless profile; only LLM output is prerecorded.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Isolated profile context.
 * @returns {Promise<void>} Completion after the real services and assertions are mounted.
 */
export async function apply(ctx) {
  assert.ok(process.env.DSH_SNAPSHOT_FILE)
  const recorded = (await readFile(process.env.DSH_SNAPSHOT_FILE, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  const originalTask = text(recorded.find(event => event.type === 'user/message' && event.data.source.kind === 'user').data.content)
  const questionIds = Array.from({ length: 20 }, (_, index) => `SYNTHETIC_Q_${String(index + 1).padStart(2, '0')}`)
  assert.ok(questionIds.every(id => originalTask.includes(id)))
  // This compaction case keeps its complete audit; muse-manuscript-report owns default-budget pagination.
  await ctx.plugin(revisions, { sourceReadMaxResultCharacters: 30000, manuscriptCheckpointChars: 20000,
    manuscriptReportMaxResultCharacters: 64000 }).await()
  assert.equal(ctx.toolResultPruner.config.thresholdChars, 8192)
  await ctx.plugin(compaction.default, { thresholdRatio: 0.99, headroomTokens: 1024, retainTokens: 0, maxTokens: 1024 }).await()
  let owner, retried = false
  ctx.on('agent/created', ({ agent }) => { owner = agent })
  ctx.effect(() => {
    const original = globalThis.fetch
    globalThis.fetch = async () => { throw Error('Reading recovery snapshot refuses network access') }
    return () => { globalThis.fetch = original }
  })
  ctx.on('llm/stream', async function* (options, next) {
    const summary = owner?.session.snapshotEvents().find(event => event.type === 'compaction/summary')
    if (summary && options.purpose !== 'compaction') {
      const events = owner.session.snapshotEvents()
      const request = events.findLast(event => event.type === 'user/message' && event.seq > summary.seq
        && event.data.source.kind === 'muse-manuscript' && event.data.source.summary === '原始用户任务与问题ID恢复')
      assert.ok(request, 'Original question IDs must be restored as a logged Muse notice after compaction')
      assert.equal(request.data.source.form, 'notice')
      const requestText = text(request.data.content)
      const binding = JSON.parse(requestText.split('\n').find(line => line.startsWith('{')))
      assert.equal(binding.task_key, 'letter-recovery')
      assert.deepEqual(binding.initial.map(message => message.text), [originalTask])
      assert.deepEqual(binding.updates, [])
      assert.ok(questionIds.every(id => requestText.includes(id)))
      assert.ok(options.messages.some(message => message.source.kind === 'muse-manuscript'
        && message.source.summary === '原始用户任务与问题ID恢复' && text(message.content) === requestText),
      'The immediate retried request must receive the exact logged original questions')
      assert.ok(!events.some(event => event.type === 'user/message' && event.seq > summary.seq && event.data.source.kind === 'user'),
        'Recovery must not manufacture a new genuine user message')
      assert.ok(owner.session.snapshotEvents().some(event => event.type === 'user/message' && event.seq > summary.seq
        && event.data.source.kind === 'muse-manuscript' && text(event.data.content).includes('当前版本文稿资料检查点。')),
      'Recovery must be logged after compaction before the retried model call')
      const restored = checkpoint(options.messages)
      const entries = restored.entries
      const character = entries.find(entry => entry.kind === 'characters' && entry.value.character_id === 'aqing')?.value
      assert.equal(character?.name, '阿青')
      assert.deepEqual(character?.aliases, ['青儿'])
      const relation = entries.find(entry => entry.kind === 'relationships')?.value
      assert.equal(relation?.subject_id, 'aqing')
      assert.equal(relation?.object_id, 'sulan')
      assert.equal(relation?.relation, '女儿')
      assert.equal(relation?.status, 'uncertain')
      assert.equal(relation?.scope.story_time, '三年前')
      assert.equal(relation?.scope.scene_id, '1-1')
      assert.equal(relation?.source_contexts[0].sections[0].heading, '1-1 老宅 夜 内')
      assert.equal(relation?.source_contexts[0].time_basis[0].kind, 'quote')
      assert.equal(relation?.contextual_name, undefined, 'Narrative attribution is not a literal speaker label')
      assert.ok(entries.some(entry => entry.kind === 'missingIntervals' && entry.value.start_line === 15), 'The long source tail must remain visibly unread')
      assert.ok(entries.some(entry => entry.kind === 'eventNotes' && entry.value.purpose === 'flashback'
        && entry.value.end_state === '三年前阿青持有钥匙，苏岚仍未确认母女关系。'), 'Recovery must restore the scoped flashback end state')
      assert.equal(restored.excluded_stale.relationships, 0)
      assert.equal(restored.excluded_stale.characters, 0)
      assert.equal(restored.excluded_stale.eventNotes, 0)
      assert.equal(restored.omitted.relationships, 0)
      assert.equal(restored.omitted.characters, 0)
      assert.equal(restored.omitted.eventNotes, 0)
      const comparisons = entries.filter(entry => entry.kind === 'comparisons')
      assert.equal(comparisons.length, 3, 'All comparison records must be restored with their source context')
      for (const entry of comparisons) comparison(entry.value, true)
      assert.equal(restored.omitted.comparisons, 0)
      retried = true
    }
    yield* next()
  })
  ctx.on('agent/turn-stopping', async ({ agent }) => {
    assert.equal(agent, owner)
    assert.ok(retried, 'The same turn must reach the model again after actual compaction')
    const events = agent.session.snapshotEvents()
    const summaries = events.filter(event => event.type === 'compaction/summary')
    assert.equal(summaries.length, 1)
    const sourceResult = events.find(event => event.type === 'tool/result' && event.data.message.toolCallId === 'call_source_start')
    assert.ok(sourceResult, 'The first real source read must be present in the Session log')
    assert.ok(events.some(event => event.type === 'compaction/prune' && event.data.shadowedSeqs.includes(sourceResult.seq)),
      'Production head/middle/tail pruning must replace the actual source page')
    assert.ok(events.some(event => event.type === 'assistant/attempt'), 'The provider overflow must remain logged as an unsuccessful attempt')
    const results = events.filter(event => event.type === 'tool/result').map(event => event.data.message)
    assert.ok(results.length >= 14, 'Every authored manuscript operation must produce a real tool result')
    const rejected = results.find(message => message.toolCallId === 'call_relationship_bad_scope')
    assert.equal(rejected?.isError, true)
    assert.match(text(rejected.content), /MANUSCRIPT_RELATION_SCOPE/u)
    const badTime = results.find(message => message.toolCallId === 'call_comparison_bad_time')
    assert.equal(badTime?.isError, true)
    assert.match(text(badTime.content), /MANUSCRIPT_COMPARISON_TIME/u)
    assert.ok(results.filter(message => !['call_relationship_bad_scope', 'call_comparison_bad_time'].includes(message.toolCallId))
      .every(message => !message.isError),
      JSON.stringify(results.filter(message => message.isError)))
    const page = JSON.parse(text(results.find(message => message.toolCallId === 'call_source_start').content))
    assert.equal(page.coverage_basis, 'returned_source_text')
    assert.equal(page.semantic_assessment, 'not_performed')
    assert.equal(page.reading_coverage.complete, false)
    assert.ok(page.lines.some(line => line.number === 6 && line.text.includes('医院')))
    assert.equal(page.source_contexts.sections.find(section => section.scene_id === '1-1')?.heading_setting, '老宅 夜 内')
    const continuation = JSON.parse(text(results.find(message => message.toolCallId === 'call_source_long').content))
    assert.deepEqual(continuation.continuation, { offset: 15, column: 2001 })
    assert.equal(continuation.reading_coverage.complete, false)
    assert.equal(continuation.reading_coverage.missing[0].start_column, 2001)
    const cwd = await realpath(agent.session.header.cwd)
    const source = join(cwd, 'documents', 'source.docx')
    const expectedSource = await readFile(new URL('./workspace/documents/source.docx', import.meta.url))
    assert.deepEqual(await readFile(source), expectedSource, 'Word bytes must remain unchanged')
    const digest = createHash('sha256').update(expectedSource).digest('hex')
    assert.equal(page.source_sha256, digest)
    assert.equal(continuation.source_sha256, digest)
    const restored = checkpoint(agent.session.deriveMessages())
    assert.ok(restored.entries.some(entry => entry.kind === 'sources' && entry.value.sha256 === digest), 'The restored source row must identify the exact original Word bytes')
    const audit = JSON.parse(text(results.find(message => message.toolCallId === 'call_after_audit').content))
    assert.equal(audit.relationships.length, 1)
    assert.equal(audit.relationships_needing_recheck.length, 0)
    assert.equal(audit.comparisons.length, 3)
    assert.equal(audit.comparisons_needing_recheck.length, 0)
    for (const row of audit.comparisons) comparison(row, false)
    await writeFile(join(cwd, '_probe.json'), JSON.stringify({ realSession: true, realPruning: true,
      realCompaction: true, sameTurnRetry: true, sourceBytesPreserved: true, wordSourceRead: true,
      longLineContinuation: true, returnedTextCoverageIncomplete: true, relationshipDirectionPreserved: true,
      uncertainRelationshipPreserved: true, flashbackStateRestored: true, sourceSceneOwnershipVerified: true,
      dialogueLocationKeptAsMention: true, adoptedSceneScopeRejected: true, normalChangeComparisonRestored: true,
      potentialConflictRestored: true, generalRuleDowngraded: true, unsupportedComparisonTimeRejected: true,
      originalQuestionIdsRestored: true, contradictionProven: false, semanticUnderstandingAssessed: false }, null, 2) + '\n')
    const runtime = join(process.env.DSH_HOME, '.runtime-ledgers')
    await mkdir(runtime, { recursive: true, mode: 0o700 })
    await rename(join(cwd, '.muse'), join(runtime, 'manuscript-state'))
  })
}
