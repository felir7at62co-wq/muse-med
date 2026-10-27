/** Load the real revision plugin and verify its private artifacts before moving them out of the user workspace. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, realpath, rename, rm, rmdir, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { importSnapshotModule, importSnapshotPackage } from '../muse-fixture-import.mjs'

const revisions = await importSnapshotModule(
  new URL('../../../apps/desktop-host/src/manuscript-revisions.ts', import.meta.url),
  new URL('../../../apps/desktop-host/lib/manuscript-revisions.js', import.meta.url),
)
const present = await importSnapshotPackage('@deepseek-ai/dsh-tool-present',
  new URL('../../../apps/desktop-host/package.json', import.meta.url))
const video = await importSnapshotPackage('@deepseek-ai/dsh-tool-video-inspect',
  new URL('../../../apps/desktop-host/package.json', import.meta.url))
const { FsVersion } = await importSnapshotPackage('@deepseek-ai/dsh-fs',
  new URL('../../../apps/desktop-host/package.json', import.meta.url))
export const name = 'manuscript-fixture'
export const inject = ['tools', 'fs', 'attachments', 'sandboxPolicy', 'sessionProjections']
export async function apply(ctx, { correctionTool = 'bash' } = {}) {
  assert.ok(correctionTool === 'bash' || correctionTool === 'pwsh', 'correctionTool must be bash or pwsh')
  await ctx.plugin(video, { requireCompleteReview: true })
  await ctx.plugin(revisions)
  await ctx.plugin(present)
  const originalStat = ctx.fs.stat.bind(ctx.fs)
  ctx.effect(() => {
    ctx.fs.stat = async (target, signal) => {
      const info = await originalStat(target, signal)
      const name = basename(target.displayPath)
      return info && ['manuscript-source.mp4', 'manuscript-asr.json'].includes(name)
        ? { ...info, version: FsVersion(`snapshot-${name}`) } : info
    }
    return () => { ctx.fs.stat = originalStat }
  })
  let owner
  ctx.on('agent/created', async ({ agent }) => {
    owner = agent
    const cwd = await realpath(agent.session.header.cwd), sourceDirectory = join(cwd, '.muse', 'video-source-fixture')
    await mkdir(sourceDirectory, { recursive: true })
    const path = join(sourceDirectory, 'manuscript-source.mp4'), transcript = join(sourceDirectory, 'manuscript-asr.json')
    await writeFile(path, 'Deterministic source identity; the material reader does not invoke a decoder.\n')
    const text = JSON.stringify([{ start: 0, end: 1, text: '我不会走。', speaker_id: '1' },
      { start: 1, end: 2, text: '你必需留下。', speaker_id: '2' }])
    await writeFile(transcript, text)
    const image = await ctx.attachments.saveImage({ mediaType: 'image/png',
      data: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWNgZGIGAAAOAAeCcsnOAAAAAElFTkSuQmCC', 'base64') })
    const frames = [{ id: 'F00001', time: 1.5, reasons: ['opening'], image, exposed: true,
      observation: { visible: '测试用单像素图像只用于核对缓存图片回灌通路。', change: '没有人物动作语义结论。', uncertainty: '' } }]
    agent.session.append('video/review', { kind: 'start', review: { id: video.VideoReviewId('manuscript-source-review'),
      episode: '第1集', path, source_version: 'snapshot-manuscript-source.mp4', duration: 2, scanned_until: 2, scan_complete: true,
      frames, event_groups: [{ event_id: 'fixture-cache-event', frame_ids: ['F00001'], actor: '',
        action: '仅验证既有事件引用的缓存图返回顺序。', object: '', before: '', after: '', uncertainty: '单像素测试不认证动作。',
        start_seconds: 1.5, end_seconds: 1.5,
        observation_digest: 'f5466b6f5eaf34c6d02886ba2bcc64507a55d5b85bed57f27be58ceccda1a33d' }],
    } })
  })
  ctx.effect(() => {
    const original = globalThis.fetch
    globalThis.fetch = async () => { throw Error('Manuscript snapshot refuses network access') }
    return () => { globalThis.fetch = original }
  })
  let finalized = false
  ctx.on('agent/turn-stopping', async ({ agent }) => {
    if (agent !== owner || finalized) return
    finalized = true
    assert.ok(owner, 'The shipped headless profile must create a real Agent')
    const cwd = await realpath(owner.session.header.cwd)
    const ledgerDirectory = join(cwd, '.muse', 'manuscript-revisions')
    const ledgerBytes = await readFile(join(ledgerDirectory, 'ledger.json'))
    const ledger = JSON.parse(ledgerBytes)
    const review = ledger.reviews[owner.id]
    const hash = bytes => createHash('sha256').update(bytes).digest('hex')
    for (const [field, name] of [['baseline', 'baseline.md'], ['revised', 'user-returned.md']]) {
      assert.equal(review[field].path, await realpath(join(cwd, 'documents', name)))
      assert.equal(review[field].sha256, hash(await readFile(review[field].path)))
      assert.equal(review[field].text, await readFile(review[field].path, 'utf8'))
    }
    assert.deepEqual(review.allowed, [])
    const delivered = ledger.baselines.find(document => document.path === join(cwd, 'documents', 'candidate.md'))
    assert.ok(delivered, 'Successful present must snapshot the actual protected candidate')
    assert.equal(delivered.sha256, hash(await readFile(delivered.path)))
    const events = owner.session.snapshotEvents()
    const sourceNotices = owner.session.deriveMessages().filter(message => message.role === 'user'
      && message.source.kind === 'muse-manuscript' && message.content.some(block => block.type === 'text'
        && block.text.startsWith('{"manuscript_video_evidence":')))
    assert.ok(sourceNotices.length >= 2, 'Actual changed manuscript versions return source materials into logged model context')
    const candidateSource = sourceNotices.find(message => JSON.parse(message.content.find(block => block.type === 'text'
      && block.text.startsWith('{"manuscript_video_evidence":')).text)
      .manuscript_video_evidence.receipt.path === join(cwd, 'documents', 'candidate.md'))
    assert.ok(candidateSource, 'The source comparison must belong to the actual saved candidate, not the earlier returned document')
    assert.equal(candidateSource.content[0].type, 'text')
    assert.ok(candidateSource.content[0].text.startsWith('第1集当前结尾：'), 'The ending cue precedes structured source materials')
    assert.ok(candidateSource.content[0].text.includes('未找到【下集钩子】标识'))
    const firstSource = JSON.parse(candidateSource.content.find(block => block.type === 'text'
      && block.text.startsWith('{"manuscript_video_evidence":')).text).manuscript_video_evidence
    assert.equal(firstSource.semantic_assessment, 'not_performed')
    assert.equal(firstSource.format_reference, undefined, 'Automatic source refresh uses the ending cue, not the full format reference')
    assert.equal(firstSource.presentation_evidence.semantic_assessment, 'not_performed')
    const readRevision = firstSource.scenes[0].read_source_revision
    assert.equal(readRevision.status, 'compared')
    assert.equal(readRevision.relationship, 'explicit_work_source_path')
    assert.equal(readRevision.adopted_authorization, 'not_inferred')
    assert.equal(readRevision.comparison_source.read_call_id, 'call_manuscript_source_read')
    const returnedText = await readFile(join(cwd, 'documents', 'user-returned.md'), 'utf8')
    assert.equal(readRevision.comparison_source.read_text_sha256, hash(returnedText.trimEnd()))
    assert.ok(readRevision.hunks.flatMap(hunk => hunk.before).some(line => line.text === '秦明枝：这一次，我替自己作主。'))
    assert.ok(readRevision.hunks.flatMap(hunk => hunk.after).some(line => line.text === '秦明枝：我不会走。'))
    const sourcePackets = candidateSource.content.filter(block => block.type === 'text' && block.text.startsWith('{"manuscript_source_packet":'))
      .map(block => JSON.parse(block.text).manuscript_source_packet)
    const sourceIndex = JSON.parse(candidateSource.content.find(block => block.type === 'text'
      && block.text.startsWith('{"manuscript_video_source":')).text).manuscript_video_source
    assert.equal(sourceIndex.presentation_version, 'source-and-line-temporal-packets-v7')
    assert.equal(sourceIndex.document_sha256, firstSource.receipt.sha256)
    assert.equal(sourceIndex.source_change_timeline.interpretation_source, 'unverified_prior_model_observations')
    assert.deepEqual(sourceIndex.draft_speech_lines.find(line => line.line === 6).candidate_segment_ids, [],
      'An ASR character difference remains unmatched rather than becoming a corrected-name anchor')
    const widerAction = sourceIndex.visual_query_anchor_skips.find(query => query.line === 7)
    assert.deepEqual(widerAction.nearest_aligned_dialogue_lines, { previous_line: 5 })
    assert.deepEqual(widerAction.skipped_unaligned_dialogue_lines, [6])
    assert.equal(widerAction.scope, 'nearest_literal_dialogue_candidates_not_semantic_alignment')
    const initialWrite = events.find(event => event.type === 'tool/call' && event.data.callId === 'call_manuscript_write_bad')
    const initialText = JSON.parse(initialWrite.data.arguments).content
    assert.equal(hash(initialText), sourceIndex.document_sha256)
    assert.ok(sourceIndex.changed_visual_line_sampling.length > 0, 'Changed visual line candidates stay visible in the logged source return')
    for (const row of sourceIndex.changed_visual_line_sampling) {
      assert.equal(row.actual_current_line.quote, initialText.split('\n')[row.actual_current_line.line - 1])
      assert.ok(['action_line', 'dialogue_parenthetical'].includes(row.actual_current_line.kind))
      assert.ok(['temporal_samples_not_action_verification', 'no_distinct_cached_sample_after_shared_selection',
        'no_literal_time_candidate', 'no_available_cached_sample', 'not_selected_within_shared_image_allowance'].includes(row.sampling_status))
    }
    assert.ok(sourceIndex.visual_candidates.some(packet => packet.changed_visual_line_candidates?.length > 0),
      'Actual changed-line candidates remain visible when the independent source tail uses the only cached image')
    const sourceTail = sourcePackets.find(packet => packet.time_candidate.relation === 'source_tail_not_aligned_to_draft_ending')
    assert.ok(sourceTail)
    assert.deepEqual(sourceTail.actual_current_lines, [])
    assert.equal(sourceTail.origin, 'source_timeline')
    assert.ok(sourceTail.candidate_current_lines.some(line => line.line === 7),
      'An existing event can relate tail images to same-scene literal candidates without asserting ending alignment')
    assert.equal(sourceTail.previous_text.mapping, 'text_diff_hunk_not_semantic_line_pair')
    assert.equal(sourceTail.previous_text.adoption, 'not_asserted')
    assert.ok(sourceTail.previous_text.hunks.some(hunk => hunk.basis === 'complete_read_source_difference'))
    const lastImageIndex = candidateSource.content.findLastIndex(block => block.type === 'image')
    const eventIndex = candidateSource.content.findIndex(block => block.type === 'text'
      && block.text.startsWith('{"manuscript_prior_event_interpretations":'))
    assert.ok(eventIndex > lastImageIndex, 'Unverified event interpretation follows the actual referenced cached image')
    const priorEvents = JSON.parse(candidateSource.content[eventIndex].text).manuscript_prior_event_interpretations
    assert.equal(priorEvents.interpretation_source, 'prior_model_authored_unverified')
    assert.equal(priorEvents.events.length, 1)
    assert.equal(priorEvents.events[0].event.event_id, 'fixture-cache-event')
    const sourceSpeech = candidateSource.content.filter(block => block.type === 'text' && block.text.startsWith('{"manuscript_source_speech":'))
      .flatMap(block => JSON.parse(block.text).manuscript_source_speech.original_asr_remaining)
    const originalRows = [...sourcePackets.flatMap(packet => packet.original_asr_first_occurrences), ...sourceSpeech]
    assert.ok(originalRows.some(row => row.text === '我不会走。'))
    assert.equal(new Set(originalRows.map(row => row.segment_id)).size, originalRows.length)
    assert.ok(sourcePackets.every(packet => packet.document_sha256 === firstSource.receipt.sha256))
    assert.ok(sourcePackets.every(packet => packet.scene_sha256 === firstSource.scenes
      .find(scene => scene.manuscript.current.id === packet.scene_id)?.manuscript.current.sha256))
    assert.ok(candidateSource.content.filter(block => block.type === 'text' && block.text.startsWith('VIDEO_FRAME '))
      .every(block => block.text.startsWith(`VIDEO_FRAME ${firstSource.scenes[0].source.review_id}/`)))
    assert.equal(firstSource.scenes[0].transcript_resolution.kind, 'successful_read_candidate')
    assert.equal(firstSource.scenes[0].transcript_resolution.read_receipts[0].readCallId, 'call_manuscript_asr_read')
    assert.ok(candidateSource.content.some(block => block.type === 'image'), 'The candidate source return carries the cached image block')
    assert.equal(sourceNotices[0].content.some(block => block.type === 'image'), true,
      'A cached source-tail image is available before ASR without claiming alignment to manuscript lines')
    const initialSourcePackets = sourceNotices[0].content
      .filter(block => block.type === 'text' && block.text.startsWith('{"manuscript_source_packet":'))
      .map(block => JSON.parse(block.text).manuscript_source_packet)
    assert.ok(initialSourcePackets.every(packet => packet.origin === 'source_timeline' && packet.actual_current_lines.length === 0))
    assert.equal(firstSource.image_delivery, 'cached_blocks_returned_not_admission_or_understanding')
    for (const id of ['call_work_bind', 'call_work_scene', 'call_work_audit']) {
      const result = events.find(event => event.type === 'tool/result' && event.data.message.toolCallId === id)
      assert.equal(result?.data.message.isError, false)
    }
    const correction = events.find(event => event.type === 'tool/result' && event.data.message.toolCallId === 'call_manuscript_correct')
    assert.equal(correction?.data.message.isError, false,
      `The real shell correction must succeed: ${JSON.stringify(correction?.data.message)}`)
    const advisory = events.filter(event => event.type === 'user/message' && event.data.source.kind === 'muse-manuscript'
      && event.data.content.some(block => block.type === 'text' && block.text.includes('采用稿或来源出现新版本')))
    assert.equal(advisory.length, 2, 'Both actual candidate versions are reconciled once')
    const advisoryText = advisory[0].data.content.find(block => block.type === 'text').text
    const firstVersion = JSON.parse(advisoryText.slice(advisoryText.indexOf('\n') + 1))
    assert.ok(firstVersion.presentation_summary.some(episode => episode.marker_status === 'not_found'),
      'The missing ending marker is structural context, not a delivery rejection')
    const structure = firstVersion.structure
    assert.equal(structure.episode_heading_count, 2)
    assert.equal(structure.unique_episode_label_count, 1)
    assert.equal(structure.duplicate_episode_labels.length, 1, 'Repeated episode labels remain visible without blocking delivery')
    assert.equal(firstVersion.screenplay_candidate_summary.mixed_action_dialogue_lines, 1)
    const mixed = firstVersion.screenplay_candidates.mixed_action_dialogue_lines
    assert.equal(mixed.total, 1)
    assert.equal(mixed.findings[0].quote, '▲贺景川（眉头拧紧）：妈，你非要这么咄咄逼人吗？')
    assert.equal(mixed.findings[0].line, 8)
    const shell = events.find(event => event.type === 'tool/call' && event.data.callId === 'call_manuscript_correct')
    assert.equal(shell?.data.name, correctionTool)
    assert.ok(advisory.at(-1).seq > shell.seq, 'Shell writes use the same actual-file reconciliation')
    assert.equal(events.filter(event => event.type === 'system/message').length, 1, 'Revision context must not replace the system prompt')
    const compare = events.find(event => event.type === 'tool/call' && event.data.callId === 'call_manuscript_compare')
    assert.ok(compare)
    const forwarded = events.find(event => event.type === 'user/message' && event.data.source.kind === 'muse-manuscript'
      && event.data.content.some(block => block.type === 'text' && block.text.includes('mc_')))
    assert.ok(forwarded, 'The real compare must forward the actual diff into logged model context')
    assert.ok(forwarded.seq > compare.seq)
    const compareResult = events.find(event => event.type === 'tool/result' && event.data.message.toolCallId === 'call_manuscript_compare')
    assert.ok(compareResult)
    assert.deepEqual(forwarded.data.content, compareResult.data.message.content, 'Deferred model context must contain the exact real comparison result')
    const results = events.filter(event => event.type === 'tool/result').map(event => event.data.message)
    for (const id of ['call_manuscript_bad_review', 'call_manuscript_bad_present']) {
      const denied = results.find(message => message.toolCallId === id)
      assert.equal(denied?.isError, false)
    }
    for (const id of ['call_manuscript_compare', 'call_manuscript_good_review', 'call_manuscript_present']) {
      assert.equal(results.find(message => message.toolCallId === id)?.isError, false)
    }
    const sceneResult = results.find(message => message.toolCallId === 'call_work_scene')
    const scene = JSON.parse(sceneResult.content.find(block => block.type === 'text').text)
    assert.equal(scene.screenplay_candidates.mixed_action_dialogue_lines.total, 1)
    const auditResult = results.find(message => message.toolCallId === 'call_work_audit')
    const audit = JSON.parse(auditResult.content.find(block => block.type === 'text').text)
    assert.equal(audit.screenplay_candidates.mixed_action_dialogue_lines.total, 0, 'Final corrected manuscript omits the format sample')
    const bindResult = results.find(message => message.toolCallId === 'call_work_bind')
    const bound = JSON.parse(bindResult.content.find(block => block.type === 'text').text)
    for (const report of [bound, scene, audit]) {
      assert.deepEqual(Object.keys(report.format_reference), ['action_line', 'parenthetical', 'dialogue', 'ending', 'source_scope'])
      assert.ok(report.format_reference.action_line.includes('▲'))
      assert.ok(report.format_reference.parenthetical.includes('人物名（括注）：台词'))
      assert.ok(report.format_reference.ending.includes('【下集钩子】'))
      assert.equal(report.presentation_evidence.advisory, true)
      assert.equal(report.presentation_evidence.semantic_assessment, 'not_performed')
    }
    const presentation = audit.presentation_evidence.episodes[0]
    const finalText = await readFile(join(cwd, 'documents', 'candidate.md'), 'utf8')
    assert.equal(presentation.ending.marker_status, 'not_found')
    assert.equal(presentation.ending.marker_count, 0)
    assert.equal(presentation.ending.suspense_assessment, 'not_performed')
    assert.deepEqual(presentation.action_locations.findings.map(line => line.quote),
      finalText.split('\n').filter(line => line.startsWith('▲')))
    for (const line of [...presentation.action_locations.findings, ...presentation.ending.last_scene_lines.findings]) {
      assert.equal(line.quote, finalText.split('\n')[line.line - 1])
    }
    for (const [id, attribution] of [['call_guidance_write', 'current_model_tool_mutation'],
      ['call_guidance_read', 'document_read_authorship_unknown']]) {
      const result = results.find(message => message.toolCallId === id)
      assert.equal(result?.isError, false, 'Guidance inspection must not reject a successful read or write')
      const block = result.content.find(block => block.type === 'text' && block.text.startsWith('{"manuscript_guidance":'))
      assert.ok(block, 'The actual tool result must log the scoped guidance advisory')
      const report = JSON.parse(block.text).manuscript_guidance
      assert.equal(report.attribution, attribution)
      assert.equal(report.authority_assessment, 'not_performed')
      assert.equal(report.total, 2)
      assert.ok(report.findings.every(finding => finding.user_basis === 'no_literal_user_text_found'))
    }
    assert.equal(await readFile(join(cwd, 'documents', '写作规范.md'), 'utf8'), '不合并台词。\n每句对白必须带括注。\n')
    const guidanceRead = events.find(event => event.type === 'tool/result' && event.data.message.toolCallId === 'call_guidance_read')
    const finalPresent = events.find(event => event.type === 'tool/result' && event.data.message.toolCallId === 'call_manuscript_present')
    assert.ok(finalPresent.seq > guidanceRead.seq, 'Delivery remains available after guidance candidates are reported')
    assert.equal(events.filter(event => event.type === 'deliverables/presented').length, 2)
    const probe = { realSession: true, comparisonLoggedFromTool: true, systemMessageCount: 1,
      revertedCandidateRejected: false, revertedDeliveryRejected: false, correctedCandidateAccepted: true,
      correctedDeliveryAccepted: true, userReturnedFilePreserved: true, privateLedgerVerified: true,
      restartVerifiedByThisScenario: false, shellWriteReconciled: true, duplicateHeadingAdvisoryVisible: true,
      guidanceWriteAccepted: true, guidanceReadAttributed: true, guidanceUnsourcedCandidateVisible: true,
      guidanceDidNotBlockDelivery: true, mixedActionDialogueCandidateVisible: true,
      savedDraftSourceMaterialsLogged: true, cachedSourceImageReturned: true,
      successfulAsrReadCandidateUsed: true, explicitTranscriptReferenceRequired: false,
      completeReadSourceDiffLogged: true, readSourceAdoptionNotInferred: true,
      screenplayFormatReferenceReturned: true, endingAndActionLocationsReturned: true,
      missingEndingMarkerDidNotBlockDelivery: true, changedVisualLineSamplesBoundToCurrentDraft: true,
      endingCuePrecedesStructuredSourceEvidence: true, sourceTailImagesNotClaimedAsChangedLineCoverage: true }
    await writeFile(join(cwd, '_probe.json'), JSON.stringify(probe, null, 2) + '\n')
    // Retain the genuine private ledger bytes under the harness-owned runtime directory. The
    // workspace oracle remains portable without rewriting Session ids, absolute paths, or hashes.
    const destination = join(process.env.DSH_HOME, '.runtime-ledgers')
    await mkdir(destination, { recursive: true, mode: 0o700 })
    await rename(ledgerDirectory, join(destination, 'manuscript-revisions'))
    const workDirectory = join(cwd, '.muse', 'manuscript-work')
    await rename(workDirectory, join(destination, 'manuscript-work'))
    await rm(join(cwd, '.muse', 'video-source-fixture'), { recursive: true })
    assert.equal(hash(await readFile(join(destination, 'manuscript-revisions', 'ledger.json'))), hash(ledgerBytes))
    await rmdir(join(cwd, '.muse'))
  })
}
