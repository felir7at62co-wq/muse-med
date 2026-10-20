/** External ASR results and probe process for legacy split receipt recovery. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmod, mkdir, readFile, realpath, rename, rmdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { importSnapshotPackage } from '../muse-fixture-import.mjs'

const { Service } = await importSnapshotPackage('@deepseek-ai/cordis',
  new URL('../../../apps/desktop-host/package.json', import.meta.url))

export const name = 'snapshot-asr-legacy-account'
export const inject = ['llm']

/** @param {import('@deepseek-ai/cordis').Context} ctx - Shipped Headless Loader context. */
export async function apply(ctx) {
  const cwd = await realpath(process.cwd())
  const jobId = '71000000-0000-4000-8000-000000000001'
  const partIds = ['72000000-0000-4000-8000-000000000001', '72000000-0000-4000-8000-000000000002']
  const source = join(cwd, 'source/fixture.mp4')
  const sourceBytes = Buffer.from('Original media preserved during legacy result recovery.\n')
  const jobs = join(cwd, 'transcript/jobs')
  const receiptFile = join(jobs, 'fixture-v1.json')
  await mkdir(join(cwd, 'source'), { recursive: true })
  await mkdir(jobs, { recursive: true })
  await writeFile(source, sourceBytes, { flag: 'wx' })
  const parts = []
  for (const [index, id] of partIds.entries()) {
    const mp3 = join(jobs, '.' + id + '.wav')
    const audio = Buffer.from('Original staged audio part ' + String(index + 1) + '.\n')
    await writeFile(mp3, audio, { flag: 'wx', mode: 0o600 })
    parts.push({ id, mp3, sha256: createHash('sha256').update(audio).digest('hex'),
      offset: index === 0 ? 0 : 20, duration: index === 0 ? 20 : 10, purpose: 'screenplay' })
  }
  await writeFile(receiptFile, JSON.stringify({
    id: jobId, source, sourceSha256: createHash('sha256').update(sourceBytes).digest('hex'),
    accountUsername: 'fixture', stem: 'fixture', version: 1, language: 'zh', purpose: 'screenplay',
    sha256: 'a'.repeat(64), mp3: join(jobs, '.' + jobId + '.wav'), status: 'processing', parts,
  }, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  const probe = join(cwd, '.dsh/legacy-ffprobe')
  await writeFile(probe, '#!/bin/sh\nprintf "probe\\n" >> .dsh/legacy-probe.calls\nprintf "20.6\\n"\n', { flag: 'wx', mode: 0o700 })
  await chmod(probe, 0o700)
  let uploads = 0
  const queries = []
  class ReceiptAccount extends Service {
    constructor(context) { super(context, 'museAccount') }
    async status() { return { state: 'signed-in', username: 'fixture', verified: false } }
    async submitAudio() { uploads++; throw Error('Legacy result recovery must not upload audio') }
    async audioStatus(id) {
      assert.ok(partIds.includes(id), 'Only the original split tasks are queried')
      queries.push(id)
      return { id, status: 'complete', purpose: 'screenplay', service_version: 'standard-v2',
        segments: [{ start: 0, end: id === partIds[0] ? 20.5 : 1,
          text: id === partIds[0] ? 'Keep the original first words.' : 'Keep the original second words.' }] }
    }
  }
  await ctx.plugin(ReceiptAccount)

  const seen = new Set()
  let initialOutputs
  let outputDeleted = false
  ctx.on('llm/stream', async function* (options, next) {
    for (const message of options.messages) {
      if (message.role !== 'tool' || seen.has(message.toolCallId)) continue
      if (message.toolCallId === 'call_remove_legacy_srt') {
        assert.equal(message.isError, false)
        await assert.rejects(stat(join(cwd, 'transcript/raw/fixture-v1.srt')), { code: 'ENOENT' })
        outputDeleted = true
        seen.add(message.toolCallId)
        continue
      }
      if (!message.toolCallId?.startsWith('call_audio_legacy_')) continue
      seen.add(message.toolCallId)
      assert.equal(message.isError, false)
      const block = message.content.find(item => item.type === 'text')
      assert.ok(block, 'The actual tool result reaches the next model request')
      const result = JSON.parse(block.text)
      assert.equal(result.status, 'complete')
      assert.equal(result.job_id, jobId)
      assert.deepEqual(result.timing_warnings, [{ part_id: partIds[0], planned_seconds: 20, staged_seconds: 20.6 }])
      assert.deepEqual(result.progress, { completed_parts: 2, total_parts: 2 })
      const outputs = await Promise.all([result.output_txt, result.output_json, result.output_srt].map(file => readFile(file, 'utf8')))
      if (message.toolCallId === 'call_audio_legacy_first') {
        initialOutputs = outputs
        assert.equal(queries.length, 2)
        for (const part of parts) await assert.rejects(stat(part.mp3), { code: 'ENOENT' })
      } else {
        assert.deepEqual(outputs, initialOutputs)
        assert.equal(queries.length, message.toolCallId === 'call_audio_legacy_cached' ? 2 : 4)
        if (message.toolCallId === 'call_audio_legacy_recover') assert.equal(outputDeleted, true)
      }
    }
    yield* next()
  })

  ctx.on('agent/turn-stopping', async ({ agent }) => {
    assert.equal(seen.size, 4)
    assert.equal(uploads, 0)
    assert.deepEqual(queries, [...partIds, ...partIds])
    assert.equal(await readFile(join(cwd, '.dsh/legacy-probe.calls'), 'utf8'), 'probe\n')
    assert.deepEqual(await readFile(source), sourceBytes)
    const receipt = JSON.parse(await readFile(receiptFile, 'utf8'))
    assert.equal(receipt.id, jobId)
    assert.equal(receipt.status, 'complete')
    assert.equal(receipt.parts[0].verifiedDurationSeconds, 20.6)
    assert.equal(receipt.parts[1].verifiedDurationSeconds, undefined)
    const calls = agent.session.snapshotEvents().filter(event => event.type === 'tool/call')
    assert.deepEqual(calls.map(event => event.data.name), ['audio_transcribe', 'audio_transcribe', 'bash', 'audio_transcribe'])
    assert.ok(calls.filter(event => event.data.name === 'audio_transcribe')
      .every(event => JSON.parse(event.data.arguments).method === 'inspect'))
    // Retain the real absolute-path receipt outside the independent workspace oracle.
    await rename(receiptFile, join(cwd, '.dsh/legacy-client-receipt.json'))
    await rmdir(jobs)
    const outputSha256 = Object.fromEntries(['txt', 'json', 'srt'].map((extension, index) => [extension,
      createHash('sha256').update(initialOutputs[index]).digest('hex')]))
    await writeFile(join(cwd, 'legacy-recovery-probe.json'), JSON.stringify({
      originalJobIdRetained: receipt.id === jobId, uploads, providerQueries: queries.length,
      durationProbes: 1, cachedReadPreservesWarning: true, cachedReadPreservesProgress: true,
      stagedAudioCleaned: true, srtDeletedByShell: outputDeleted, restoredOutputsIdentical: true,
      verifiedDurationSeconds: receipt.parts[0].verifiedDurationSeconds, sourcePreserved: true, outputSha256,
    }, null, 2) + '\n', { flag: 'wx' })
  })
}
