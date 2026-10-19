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
      assert.equal(denied?.isError, true)
      assert.ok(denied.content.some(block => block.type === 'text' && block.text.includes('MANUSCRIPT_USER_EDIT_PROTECTED')))
    }
    for (const id of ['call_manuscript_compare', 'call_manuscript_good_review', 'call_manuscript_present']) {
      assert.equal(results.find(message => message.toolCallId === id)?.isError, false)
    }
    assert.equal(events.filter(event => event.type === 'deliverables/presented').length, 1)
    const probe = { realSession: true, comparisonLoggedFromTool: true, systemMessageCount: 1,
      revertedCandidateRejected: true, revertedDeliveryRejected: true, correctedCandidateAccepted: true,
      correctedDeliveryAccepted: true, userReturnedFilePreserved: true, privateLedgerVerified: true,
      restartVerifiedByThisScenario: false }
    await writeFile(join(cwd, '_probe.json'), JSON.stringify(probe, null, 2) + '\n')
    // Retain the genuine private ledger bytes under the harness-owned runtime directory. The
    // workspace oracle remains portable without rewriting Session ids, absolute paths, or hashes.
    const destination = join(process.env.DSH_HOME, '.runtime-ledgers')
    await mkdir(destination, { recursive: true, mode: 0o700 })
    await rename(ledgerDirectory, join(destination, 'manuscript-revisions'))
    assert.equal(hash(await readFile(join(destination, 'manuscript-revisions', 'ledger.json'))), hash(ledgerBytes))
    await rmdir(join(cwd, '.muse'))
  })
}
