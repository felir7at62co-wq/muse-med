/** Owner-local handling of complete-review artifacts whose bytes include volatile Session identities. */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

type Row = Record<string, unknown>
const HASH = /^[a-f0-9]{64}$/u
const TOKEN = /^\{\{videoObservationReportSha256:[1-9]\d*\}\}$/u
function object(value: unknown): value is Row { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function rows(log: string): Row[] {
  return log.split(/\r?\n/u).filter(Boolean).map((line) => {
    const row: unknown = JSON.parse(line)
    if (!object(row)) throw Error('Video-review snapshot requires JSON objects')
    return row
  })
}
function pairs(records: readonly Row[]) {
  const calls = new Set<string>()
  const reports: { path: string; digest: string; body: Row; block: Row; meta: Row }[] = []
  for (const row of records) {
    const data = row.data
    if (!object(data)) continue
    if (row.type === 'tool/call' && (data.name === 'video_inspect' || data.name === 'video_source_review')
      && typeof data.callId === 'string') calls.add(data.callId)
    const message = data.message
    if (row.type !== 'tool/result' || !object(message) || message.isError === true
      || typeof message.toolCallId !== 'string' || !calls.has(message.toolCallId) || !Array.isArray(message.content)) continue
    for (const block of message.content) {
      if (!object(block) || block.type !== 'text' || typeof block.text !== 'string') continue
      let body: unknown
      try { body = JSON.parse(block.text) }
      catch (error) { if (!(error instanceof SyntaxError)) throw error; continue }
      if (!object(body) || body.observation_report === undefined) continue
      const meta = object(data.meta) ? data.meta.videoReviewEvidence : undefined
      if (typeof body.observation_report !== 'string' || !object(meta) || body.complete !== true
        || meta.observationReport !== body.observation_report || meta.sha256 !== body.observation_report_sha256
        || meta.reviewId !== body.review_id || meta.sessionId !== body.observation_session_id
        || typeof body.observation_report_sha256 !== 'string') throw Error('Video-review report tool/meta identity or digest mismatch')
      reports.push({ path: body.observation_report, digest: body.observation_report_sha256, body, block, meta })
    }
  }
  return reports
}

/** Check exact live files before snapshot-only replacement; a forged matching pair still fails.
 * @param logs - Actual current-writer logs read before the scenario workspace is disposed.
 * @returns After both emitted digests agree with each complete report's real bytes.
 */
export async function assertVideoObservationReportArtifacts(logs: readonly string[]): Promise<void> {
  for (const log of logs) for (const report of pairs(rows(log))) {
    if (!HASH.test(report.digest) || createHash('sha256').update(await readFile(report.path)).digest('hex') !== report.digest) {
      throw Error('Video-review report digest differs from actual artifact bytes')
    }
  }
}

/** Replace only paired complete-report digest fields; all other hashes and tool text remain meaningful.
 * @param logs - Actual logs whose artifacts were checked, or the two owners' current-writer oracles.
 * @returns Relationship tokens preserving repeated files and keeping distinct files distinct.
 */
export function normalizeVideoObservationReportHashes(logs: readonly string[]): string[] {
  const identities = new Map<string, { digest: string; token: string }>()
  return logs.map((log) => {
    const records = rows(log)
    for (const report of pairs(records)) {
      if (!HASH.test(report.digest) && !TOKEN.test(report.digest)) throw Error('Video-review report digest is neither raw nor its owner token')
      let identity = identities.get(report.path)
      if (identity === undefined) {
        identity = { digest: report.digest, token: `{{videoObservationReportSha256:${identities.size + 1}}}` }
        identities.set(report.path, identity)
      }
      if (identity.digest !== report.digest || TOKEN.test(report.digest) && report.digest !== identity.token) {
        throw Error('Video-review report path changed digest within one snapshot')
      }
      report.body.observation_report_sha256 = identity.token
      report.block.text = JSON.stringify(report.body)
      report.meta.sha256 = identity.token
    }
    return records.map(row => JSON.stringify(row)).join('\n') + (log.endsWith('\n') ? '\n' : '')
  })
}
