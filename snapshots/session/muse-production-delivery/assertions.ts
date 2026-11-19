/** Semantic boundaries that a snapshot refresh must never accept as a new baseline. */
import { parseSessionLog } from '@deepseek-ai/dsh-llm-replay'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect } from 'vitest'

/** Check publication, idempotence and real preparation without claiming media acceptance.
 * @param log - Actual persisted session from the shipped headless profile.
 * @param cwd - Isolated fixture workspace containing its non-secret provider receipt.
 */
export function assertProductionDelivery(log: string, cwd: string): void {
  const events = parseSessionLog(log)
  const calls = events.flatMap(event => event.type === 'tool/call' ? [event.data] : [])
  expect(calls.map(call => call.name)).toEqual(['drama_shot', 'muse_production', 'muse_production', 'drama_render'])
  const result = (id: string, isError = false): string => {
    const event = events.find(row => row.type === 'tool/result' && row.data.message.toolCallId === id)
    if (event?.type !== 'tool/result') throw new Error(`Missing production delivery result: ${id}`)
    expect(event.data.message.isError, JSON.stringify(event.data.message.content)).toBe(isError)
    return event.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
  }
  const manifest = { sha256: '5f1850e8435f0307b08d9e28dbe13ba9070a3a3a8f5622b5b0ddbffe5c46fc25' }
  const applied = JSON.parse(result('call_delivery_apply'))
  const receiptPath = join(cwd, 'provider-receipt.json')
  const provider = existsSync(receiptPath) ? readFileSync(receiptPath, 'utf8') : 'Fixture provider receipt was not written.'
  if (applied.saved !== 1 || applied.source_manifest?.status !== 'published') {
    throw new Error(`PRODUCTION_DELIVERY_FIXTURE_FAILURE ${JSON.stringify({ applied, provider })}`)
  }
  expect(applied, JSON.stringify({ applied, provider })).toMatchObject({ method: 'apply', mode: 'advisory',
    paid_requests: 0, total: 1, saved: 1, results: [{ status: 'saved', storyboard_id: 10000 }],
    source_manifest: { ...manifest, status: 'published' } })
  expect(String(applied.source_manifest.path).replaceAll('\\', '/')).toBe('episode_packages/01/package.json')
  expect(JSON.parse(result('call_delivery_reapply'))).toMatchObject({ paid_requests: 0, saved: 1,
    results: [{ status: 'already_saved', storyboard_id: 10000 }], source_manifest: { ...manifest, status: 'unchanged' } })
  const prepared = JSON.parse(result('call_delivery_refuse'))
  expect(prepared).toMatchObject({ method: 'prepare', ok: true, episode: '01', output: '',
    clips: [{ shot: 1, source: join(cwd, 'source.mp4'), start_us: 0, duration_us: 3_000_000 }],
    summary: { shots: 1, encoded: 0, checks: 0 } })
  const packageBytes = readFileSync(join(cwd, 'episode_packages', '01', 'package.json'))
  expect(createHash('sha256').update(packageBytes).digest('hex')).toBe(applied.source_manifest.sha256)
  expect(JSON.parse(packageBytes.toString('utf8'))).toMatchObject({ mode: 'advisory', media_acceptance: false,
    video_tasks: [{ index: 1, storyboard_id: 10000, shots: [1, 2] }] })
  const selected = JSON.parse(readFileSync(join(cwd, 'editing', '01-sources.json'), 'utf8'))
  expect(selected.shots).toEqual([{ shot: 1, package: 1, video: join(cwd, 'source.mp4'), audio: join(cwd, 'source.mp4'),
    sha256: createHash('sha256').update(readFileSync(join(cwd, 'source.mp4'))).digest('hex'),
    package_sha256: applied.source_manifest.sha256 }])
  expect(readFileSync(join(cwd, 'video', '01', 'shot_001.mp4'))).toEqual(readFileSync(join(cwd, 'source.mp4')))
  expect(readFileSync(join(cwd, 'editing', '01.srt'))).toEqual(readFileSync(join(cwd, 'source.srt')))
  expect(prepared.render_preview.audio.master_path).toBe(join(cwd, 'audio', '01.wav'))
  expect(prepared.render_preview.subtitle.path).toBe(join(cwd, 'editing', '01.srt'))
  const audio = readFileSync(join(cwd, 'audio', '01.wav'))
  expect(audio.toString('ascii', 0, 4)).toBe('RIFF')
  expect(audio.toString('ascii', 8, 12)).toBe('WAVE')
  let data: Buffer | undefined
  for (let offset = 12; offset + 8 <= audio.length;) {
    const size = audio.readUInt32LE(offset + 4), name = audio.toString('ascii', offset, offset + 4)
    if (name === 'fmt ') {
      expect([audio.readUInt16LE(offset + 8), audio.readUInt16LE(offset + 10),
        audio.readUInt32LE(offset + 12), audio.readUInt16LE(offset + 22)]).toEqual([1, 1, 48000, 16])
    }
    if (name === 'data') data = audio.subarray(offset + 8, offset + 8 + size)
    offset += 8 + size + size % 2
  }
  expect(data?.length).toBe(3 * 48000 * 2)
  expect(data?.some(byte => byte !== 0)).toBe(false)
  expect(JSON.parse(readFileSync(join(cwd, 'reviews', 'ep01-p01.json'), 'utf8')).status).toBe('pending')
  expect(existsSync(join(cwd, 'exports', '01.mp4'))).toBe(false)
  expect(events.at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
}

/** Expand this case's independent paths and synthesize its declared silent PCM oracle.
 * @param cwd - Isolated actual workspace, also owning the ignored expected-copy directory.
 * @param scenarioDir - Case directory containing the authored complete expected tree.
 * @returns Expected workspace with the current FFmpeg container header and fixed silent samples.
 */
export async function prepareProductionDeliveryExpectedWorkspace(cwd: string, scenarioDir: string): Promise<string> {
  const expectedRoot = join(cwd, '.snapshot-patches', 'expected-production-workspace')
  await cp(join(scenarioDir, 'workspace.expected'), expectedRoot, { recursive: true })
  const file = join(expectedRoot, 'editing', '01-sources.json')
  const sources = JSON.parse(await readFile(file, 'utf8'))
  for (const row of sources.shots) {
    for (const field of ['video', 'audio']) {
      expect(row[field]).toBe('{{cwd}}/source.mp4')
      row[field] = join(cwd, 'source.mp4')
    }
  }
  await writeFile(file, `${JSON.stringify(sources, null, 2)}\n`)
  const timeline = join(expectedRoot, 'editing', '01-timeline.json')
  await writeFile(timeline, (await readFile(timeline, 'utf8')).replaceAll('\r\n', '\n'))
  await mkdir(join(expectedRoot, 'audio'), { recursive: true })
  const output = spawnSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono',
    '-t', '3', '-c:a', 'pcm_s16le', '-ar', '48000', join(expectedRoot, 'audio', '01.wav')],
  { windowsHide: true, encoding: 'utf8', timeout: 10_000 })
  expect(output.error, output.stderr).toBeUndefined()
  expect(output.signal, output.stderr).toBeNull()
  expect(output.status, output.stderr).toBe(0)
  return expectedRoot
}

/** Normalize only this case's native relative manifest path across operating systems.
 * @param logs - Already normalized actual or expected persisted sessions.
 * @returns Sessions retaining all content except platform path separators in the manifest result.
 */
export function normalizeProductionDeliveryPaths(logs: string[]): string[] {
  return logs.map(log => log.split('\n').map(line => {
    if (!line.trim()) return line
    const event = JSON.parse(line)
    if (event.type !== 'tool/result' || !['call_delivery_apply', 'call_delivery_reapply'].includes(event.data.message.toolCallId)) return line
    for (const block of event.data.message.content) {
      if (block.type !== 'text') continue
      const body = JSON.parse(block.text)
      if (typeof body.source_manifest?.path !== 'string') throw new Error('Missing source manifest path in production delivery result')
      body.source_manifest.path = body.source_manifest.path.replaceAll('\\', '/')
      block.text = JSON.stringify(body, null, 2)
    }
    return JSON.stringify(event)
  }).join('\n'))
}
