/** Pin the paginated source version and verify incomplete manuscript read receipts through Session replay. */
import assert from 'node:assert/strict'
import { basename } from 'node:path'
import { importSnapshotModule } from '../muse-fixture-import.mjs'
const reads = await importSnapshotModule(
  new URL('../../../apps/desktop-host/src/manuscript-video-reads.ts', import.meta.url),
  new URL('../../../apps/desktop-host/lib/types/manuscript-video-reads.js', import.meta.url),
)
export const name = 'read-version-fixture'
export const inject = ['fs', 'sessionProjections']
/** @param {import('@deepseek-ai/cordis').Context} ctx - Shipped headless profile context. */
export function apply(ctx) {
  reads.installManuscriptVideoReads(ctx, () => true, { maxTextChars: 50_000, maxDocuments: 10, maxLedgerBytes: 50_000 })
  ctx.on('agent/turn-stopping', ({ agent }) => {
    const receipt = reads.manuscriptTextReadSnapshots(ctx, agent.session)?.reads[0]
    assert.equal(receipt?.status, 'partial')
    assert.equal(receipt.offset, 5)
    assert.equal(receipt.returnedLines, 4)
    assert.equal(receipt.text, undefined)
    assert.equal(receipt.readTextSha256, undefined)
  })
  ctx.effect(() => {
    const stat = ctx.fs.stat.bind(ctx.fs)
    ctx.fs.stat = async (target, signal) => {
      const info = await stat(target, signal)
      return info && basename(target.displayPath) === 'big.txt' ? { ...info, version: 'fixture-big-text-v1' } : info
    }
    return () => { ctx.fs.stat = stat }
  })
}
