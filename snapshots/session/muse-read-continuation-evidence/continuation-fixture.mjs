/** Exercise native read metadata through the real manuscript consumer and ordinary delivery. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, rmdir } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { importSnapshotModule, importSnapshotPackage } from '../muse-fixture-import.mjs'

const revisions = await importSnapshotModule(
  new URL('../../../apps/desktop-host/src/manuscript-revisions.ts', import.meta.url),
  new URL('../../../apps/desktop-host/lib/manuscript-revisions.js', import.meta.url),
)
const reads = await importSnapshotModule(
  new URL('../../../apps/desktop-host/src/manuscript-video-reads.ts', import.meta.url),
  new URL('../../../apps/desktop-host/lib/manuscript-video-reads.js', import.meta.url),
)
const present = await importSnapshotPackage('@deepseek-ai/dsh-tool-present',
  new URL('../../../apps/desktop-host/package.json', import.meta.url))
const { FsVersion } = await importSnapshotPackage('@deepseek-ai/dsh-fs',
  new URL('../../../apps/desktop-host/package.json', import.meta.url))

export const name = 'snapshot-read-continuation-evidence'
export const inject = ['tools', 'fs', 'attachments', 'sandboxPolicy', 'sessionProjections']

/**
 * @param ctx - Shipped headless composition with native read/write and Session persistence.
 */
export async function apply(ctx) {
  await ctx.plugin(revisions)
  await ctx.plugin(present)
  const stat = ctx.fs.stat.bind(ctx.fs)
  ctx.effect(() => {
    ctx.fs.stat = async (target, signal) => {
      const info = await stat(target, signal)
      return info && basename(target.displayPath) === 'source.md'
        ? { ...info, version: FsVersion('snapshot-immutable-read-source') } : info
    }
    return () => { ctx.fs.stat = stat }
  })
  let owner
  ctx.on('agent/created', ({ agent }) => { owner = agent })
  ctx.on('agent/turn-stopping', async ({ agent }) => {
    if (agent !== owner) return
    const events = agent.session.snapshotEvents()
    const result = id => events.find(event => event.type === 'tool/result' && event.data.message.toolCallId === id)?.data
    const first = result('call_read_long_line')
    const continued = result('call_read_continuation')
    assert.equal(first?.message.isError, false)
    assert.equal(continued?.message.isError, false)
    assert.equal(first.meta.totalLines, 1)
    assert.equal(first.meta.lines.length, 1)
    assert.deepEqual(first.meta.continuation, { offset: 1, column: 65 })
    assert.equal(continued.meta.totalLines, 1)
    assert.equal(continued.meta.lines.length, 1)
    assert.equal(continued.meta.offset, first.meta.continuation.offset)
    assert.equal(continued.meta.column, first.meta.continuation.column)
    assert.equal(continued.meta.continuation, undefined)
    const receipt = reads.manuscriptTextReadSnapshots(ctx, agent.session)?.reads[0]
    assert.equal(receipt?.status, 'partial')
    assert.equal(receipt.text, undefined)
    assert.equal(receipt.readTextSha256, undefined)
    const reports = agent.session.deriveMessages().flatMap(message => message.source.kind === 'muse-manuscript'
      ? message.content.flatMap(block => block.type === 'text' && block.text.startsWith('{"manuscript_video_evidence":')
        ? [JSON.parse(block.text).manuscript_video_evidence] : []) : [])
    const sourceReports = reports.flatMap(report => report.scenes.flatMap(scene => scene.read_source_revision
      ? [scene.read_source_revision] : []))
    assert.ok(sourceReports.some(report => report.status === 'truncated'))
    assert.ok(sourceReports.some(report => report.status === 'partial'))
    assert.ok(sourceReports.every(report => !['compared', 'current_source_changed'].includes(report.status)))
    assert.ok(sourceReports.every(report => report.hunks.length === 0 && report.comparison_source === undefined))
    for (const id of ['call_write_preview', 'call_write_final', 'call_present']) assert.equal(result(id)?.message.isError, false)
    assert.ok(events.some(event => event.type === 'deliverables/presented'))
    const cwd = agent.session.header.cwd
    const text = await readFile(join(cwd, 'draft.md'), 'utf8')
    assert.equal(text, '第4集\n4-1 家 日 内\n▲甲把书合上。\n甲：先把后半句读完。\n')
    const ledgerDirectory = join(cwd, '.muse', 'manuscript-revisions')
    const ledger = JSON.parse(await readFile(join(ledgerDirectory, 'ledger.json'), 'utf8'))
    const delivered = ledger.baselines.find(document => document.path === join(cwd, 'draft.md'))
    assert.equal(delivered?.sha256, createHash('sha256').update(text).digest('hex'))
    const privateRoot = join(process.env.DSH_HOME, '.runtime-ledgers')
    await mkdir(privateRoot, { recursive: true, mode: 0o700 })
    await rename(ledgerDirectory, join(privateRoot, 'manuscript-revisions'))
    await rmdir(join(cwd, '.muse'))
  })
}
