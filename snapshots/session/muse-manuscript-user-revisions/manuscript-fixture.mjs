/** Load the real revision plugin and verify its private artifacts before moving them out of the user workspace. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, realpath, rename, rmdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { importSnapshotModule, importSnapshotPackage } from '../muse-fixture-import.mjs'

const revisions = await importSnapshotModule(
  new URL('../../../apps/desktop-host/src/manuscript-revisions.ts', import.meta.url),
  new URL('../../../apps/desktop-host/lib/manuscript-revisions.js', import.meta.url),
)
const present = await importSnapshotPackage('@deepseek-ai/dsh-tool-present',
  new URL('../../../apps/desktop-host/package.json', import.meta.url))
export const name = 'manuscript-fixture'
export const inject = ['tools']
export async function apply(ctx) {
  await ctx.plugin(revisions)
  await ctx.plugin(present)
  let owner
  ctx.on('agent/created', ({ agent }) => { owner = agent })
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
    for (const id of ['call_work_bind', 'call_work_scene', 'call_work_audit']) {
      const result = events.find(event => event.type === 'tool/result' && event.data.message.toolCallId === id)
      assert.equal(result?.data.message.isError, false)
    }
    const advisory = events.filter(event => event.type === 'user/message' && event.data.source.kind === 'muse-manuscript'
      && event.data.content.some(block => block.type === 'text' && block.text.includes('采用稿或来源出现新版本')))
    assert.equal(advisory.length, 2, 'Both actual candidate versions are reconciled once')
    const advisoryText = advisory[0].data.content.find(block => block.type === 'text').text
    const firstVersion = JSON.parse(advisoryText.slice(advisoryText.indexOf('\n') + 1))
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
    assert.equal(shell?.data.name, 'bash')
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
      guidanceDidNotBlockDelivery: true, mixedActionDialogueCandidateVisible: true }
    await writeFile(join(cwd, '_probe.json'), JSON.stringify(probe, null, 2) + '\n')
    // Retain the genuine private ledger bytes under the harness-owned runtime directory. The
    // workspace oracle remains portable without rewriting Session ids, absolute paths, or hashes.
    const destination = join(process.env.DSH_HOME, '.runtime-ledgers')
    await mkdir(destination, { recursive: true, mode: 0o700 })
    await rename(ledgerDirectory, join(destination, 'manuscript-revisions'))
    const workDirectory = join(cwd, '.muse', 'manuscript-work')
    await rename(workDirectory, join(destination, 'manuscript-work'))
    assert.equal(hash(await readFile(join(destination, 'manuscript-revisions', 'ledger.json'))), hash(ledgerBytes))
    await rmdir(join(cwd, '.muse'))
  })
}
