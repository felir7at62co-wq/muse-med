/** Real local length measurement reports an oversized candidate without changing manuscripts or revision history. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, realpath, rename, rmdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { importSnapshotModule } from '../muse-fixture-import.mjs'

const revisions = await importSnapshotModule(
  new URL('../../../apps/desktop-host/src/manuscript-revisions.ts', import.meta.url),
  new URL('../../../apps/desktop-host/lib/manuscript-revisions.js', import.meta.url),
)
export const name = 'manuscript-length-fixture'
export const inject = ['tools']

/** @param {import('@deepseek-ai/cordis').Context} ctx - Isolated shipped headless profile. */
export async function apply(ctx) {
  await ctx.plugin(revisions)
  ctx.effect(() => {
    const original = globalThis.fetch
    globalThis.fetch = async () => { throw Error('Manuscript length snapshot refuses network access') }
    return () => { globalThis.fetch = original }
  })
  const texts = { 'source.txt': '字'.repeat(30_000), 'candidate.txt': '字'.repeat(80_000) }
  const hash = bytes => createHash('sha256').update(bytes).digest('hex')
  let owner, cwd
  ctx.on('agent/created', async ({ agent }) => {
    assert.equal(owner, undefined, 'This scenario creates one real headless Agent')
    owner = agent
    cwd = await realpath(agent.session.header.cwd)
    for (const [name, text] of Object.entries(texts)) await writeFile(join(cwd, name), text, { flag: 'wx' })
  })
  let finalized = false
  ctx.on('agent/turn-stopping', async ({ agent }) => {
    if (agent !== owner || finalized) return
    finalized = true
    assert.ok(cwd)
    const results = agent.session.snapshotEvents().filter(event => event.type === 'tool/result')
    assert.equal(results.length, 1)
    const message = results[0].data.message
    assert.equal(message.toolCallId, 'call_manuscript_measure')
    assert.equal(message.isError, false, 'An oversized candidate remains a successful advisory result')
    const text = message.content.find(block => block.type === 'text')?.text
    assert.equal(typeof text, 'string')
    const result = JSON.parse(text)
    assert.equal(result.state, 'measured')
    assert.equal(result.advisory, true)
    assert.equal(result.source.lettersAndNumbers, 30_000)
    assert.equal(result.candidate.lettersAndNumbers, 80_000)
    assert.equal(result.difference, 50_000)
    assert.equal(result.ratio, 8 / 3)
    assert.equal(result.maxGrowthPercent, 10)
    assert.equal(result.assessment, 'above_requested_growth')
    assert.match(result.notice, /不是精准净正文字数或Word字数/u)
    assert.match(result.notice, /原始ASR通常只有对白/u)
    for (const [group, name] of [['source_files', 'source.txt'], ['candidate_files', 'candidate.txt']]) {
      assert.equal(result[group].length, 1)
      assert.equal(result[group][0].path, join(cwd, name))
      assert.equal(result[group][0].sha256, hash(texts[name]))
      assert.equal(hash(await readFile(join(cwd, name))), hash(texts[name]), 'The actual manuscript bytes remain unchanged')
    }
    const ledgerDirectory = join(cwd, '.muse', 'manuscript-revisions')
    await assert.rejects(readFile(join(ledgerDirectory, 'ledger.json')), { code: 'ENOENT' })
    const probe = { realSession: true, realToolResult: true, sourceLettersAndNumbers: 30_000,
      candidateLettersAndNumbers: 80_000, excessAdvisoryOnly: true, manuscriptBytesUnchanged: true,
      revisionLedgerWritten: false, networkAccessAllowed: false }
    await writeFile(join(cwd, '_probe.json'), JSON.stringify(probe, null, 2) + '\n')
    // Retain generated test manuscripts outside the workspace oracle after verifying their exact bytes.
    const destination = join(process.env.DSH_HOME, '.runtime-manuscripts')
    await mkdir(destination, { recursive: true })
    for (const name of Object.keys(texts)) await rename(join(cwd, name), join(destination, name))
    await rmdir(ledgerDirectory)
    await rmdir(join(cwd, '.muse'))
  })
}
