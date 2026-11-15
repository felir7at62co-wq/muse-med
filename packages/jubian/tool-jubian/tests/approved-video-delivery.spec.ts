/** Deliver an approved video without invoking an editor or re-encoding it. */
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { publishApprovedVideo, readApprovedVideoDelivery } from '../src/video-recovery.ts'

const bytes = Buffer.from('000000106674797069736f6d00000000', 'hex')
const sha256 = createHash('sha256').update(bytes).digest('hex')
const digest = 'a'.repeat(64)
const taskId = 42
const path = 'exports/Muse-approved-42-' + digest + '.mp4'

async function fixture() {
  const project = await realpath(await mkdtemp(join(tmpdir(), 'muse-direct-delivery-')))
  onTestFinished(async () => { await rm(project, { recursive: true, force: true, maxRetries: 3 }) })
  const reviewDir = join(project, 'video_tasks', 'review')
  await mkdir(reviewDir, { recursive: true })
  const source = join(reviewDir, 'original-' + sha256 + '.mp4')
  await writeFile(source, bytes)
  return {
    project, reviewDir, source, output: join(project, path),
    deliver: () => publishApprovedVideo(project, taskId, digest, source, sha256, new AbortController().signal),
    receipt: () => readApprovedVideoDelivery(project, taskId, digest, sha256),
  }
}

it('copies exact bytes once, retains a separate durable receipt and leaves the editor receipt intact', async () => {
  const { project, reviewDir, source, output, deliver, receipt } = await fixture()
  const editorReceiptPath = join(reviewDir, digest + '.delivery.json')
  const editorReceipt = JSON.stringify({ draft: { path: 'existing draft', name: 'existing name' } })
  await writeFile(editorReceiptPath, editorReceipt)
  const expected = { path, sha256 }

  expect(await receipt()).toBeUndefined()
  expect(await Promise.all([deliver(), deliver()])).toEqual([expected, expected])
  expect(await receipt()).toEqual(expected)
  expect(await readFile(output)).toEqual(bytes)
  expect(await readdir(join(project, 'exports'))).toEqual([path.slice('exports/'.length)])
  expect(await readFile(editorReceiptPath, 'utf8')).toBe(editorReceipt)

  await writeFile(source, 'changed review media')
  await expect(deliver()).resolves.toEqual(expected)
  expect(await readFile(output)).toEqual(bytes)
})

it('resumes a previously copied export and refuses to overwrite an occupied destination', async () => {
  const { project, output, deliver, receipt } = await fixture()
  await mkdir(join(project, 'exports'))
  await writeFile(output, 'unrelated export')

  await expect(deliver()).rejects.toThrow('Direct delivery destination already contains different bytes')
  expect(await readFile(output, 'utf8')).toBe('unrelated export')
  expect(await receipt()).toBeUndefined()

  await writeFile(output, bytes)
  expect(await deliver()).toEqual({ path, sha256 })
  expect(await receipt()).toEqual({ path, sha256 })

  await writeFile(output, 'changed export')
  await expect(deliver()).rejects.toThrow('Direct delivery destination already contains different bytes')
  expect(await readFile(output, 'utf8')).toBe('changed export')
})


it('reuses actual approved bytes without a source and repairs only a missing receipt', async () => {
  const f = await fixture()
  await f.deliver()
  const identity = await stat(f.output)
  await unlink(f.source)
  expect(await f.deliver()).toEqual({ path, sha256 })
  await unlink(join(f.reviewDir, digest + '.direct-delivery.json'))
  expect(await f.deliver()).toEqual({ path, sha256 })
  expect(await stat(f.output)).toMatchObject({ ino: identity.ino, dev: identity.dev })
  expect(await readFile(f.output)).toEqual(bytes)
})
