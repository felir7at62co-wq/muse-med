import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it } from 'vitest'
import { assertVideoObservationReportArtifacts, normalizeVideoObservationReportHashes } from './snapshot-reports.ts'

function fixture(path: string, digest: string, call = 'review-1', metaDigest = digest): string {
  return [
    { type: 'tool/call', data: { callId: call, name: 'video_inspect' } },
    { type: 'tool/result', data: { message: { toolCallId: call, isError: false, content: [{ type: 'text', text: JSON.stringify({ complete: true,
      observation_report: path, observation_report_sha256: digest, observation_session_id: 'session', review_id: 'review',
      path: 'source.mp4', source_version: 'source-version',
      transcript_reference: { sha256: digest } }) }] }, meta: { videoReviewEvidence: { observationReport: path,
      sha256: metaDigest, sessionId: 'session', reviewId: 'review', path: 'source.mp4', sourceVersion: 'source-version' } } } },
  ].map(row => JSON.stringify(row)).join('\n') + '\n'
}

it('checks live report bytes before tokenizing and rejects altered tool, metadata or artifact digests', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-review-report-hash-'))
  try {
    const path = join(root, 'report.json'), bytes = '{"id":"review","path":"source.mp4","source_version":"source-version"}\n'
    await writeFile(path, bytes)
    const digest = createHash('sha256').update(bytes).digest('hex'), wrong = '0'.repeat(64)
    await expect(assertVideoObservationReportArtifacts([fixture(path, digest)])).resolves.toBeUndefined()
    await expect(assertVideoObservationReportArtifacts([fixture(path, digest, 'review-1', wrong)]))
      .rejects.toThrow('tool/meta identity or digest mismatch')
    await expect(assertVideoObservationReportArtifacts([fixture(path, wrong)]))
      .rejects.toThrow('differs from actual artifact bytes')
    await writeFile(path, bytes + ' ')
    await expect(assertVideoObservationReportArtifacts([fixture(path, digest)]))
      .rejects.toThrow('differs from actual artifact bytes')
  } finally { await rm(root, { recursive: true, force: true }) }
})

function reference(path: string, digest: string, change: Record<string, unknown> = {}): string {
  return JSON.stringify({ type: 'tool/result', data: { message: { toolCallId: 'comparison', isError: false,
    content: [{ type: 'text', text: JSON.stringify({ comparison: { sha256: digest, scene: 'keep' } }) }] },
  meta: { videoReviewEvidence: { observationReport: path, sha256: digest, sessionId: 'session', reviewId: 'review',
    path: 'source.mp4', sourceVersion: 'source-version', ...change }, unrelatedSha256: digest } } }) + '\n'
}

it('normalizes later report metadata only after a matching prior issuance and keeps business hashes intact', () => {
  const digest = 'a'.repeat(64), input = fixture('report.json', digest) + reference('report.json', digest)
  const [output] = normalizeVideoObservationReportHashes([input])
  const last = JSON.parse(output!.trim().split('\n').at(-1)!) as { data: {
    message: { content: { text: string }[] }
    meta: { videoReviewEvidence: { sha256: string }; unrelatedSha256: string }
  } }
  expect(last.data.meta.videoReviewEvidence.sha256).toBe('{{videoObservationReportSha256:1}}')
  expect(last.data.message.content[0]?.text).toBe(JSON.stringify({ comparison: { sha256: digest, scene: 'keep' } }))
  expect(last.data.meta.unrelatedSha256).toBe(digest)
  expect(normalizeVideoObservationReportHashes([output!])).toEqual([output])
  expect(() => normalizeVideoObservationReportHashes([reference('report.json', digest) + fixture('report.json', digest)]))
    .toThrow('no matching prior issuance')
  expect(() => normalizeVideoObservationReportHashes([fixture('report.json', digest).replace('"isError":false', '"isError":true')
    + reference('report.json', digest)])).toThrow('no matching prior issuance')
})

it.each(['observationReport', 'sha256', 'sessionId', 'reviewId', 'path', 'sourceVersion'])(
  'rejects a later report reference with changed %s', (key) => {
    const digest = 'a'.repeat(64)
    expect(() => normalizeVideoObservationReportHashes([fixture('report.json', digest)
      + reference('report.json', digest, { [key]: 'changed' })])).toThrow('no matching prior issuance')
  },
)

it.each(['observationReport', 'sha256', 'sessionId', 'reviewId', 'path', 'sourceVersion'])(
  'requires the saved body metadata copy to retain the issued %s', (key) => {
    const digest = 'a'.repeat(64)
    const duplicate = (change: Record<string, unknown>) => {
      const row = JSON.parse(reference('report.json', digest)) as { data: { meta: {
        videoReviewEvidence: Record<string, unknown>
        __dsh_tool_body_meta_v1?: { videoReviewEvidence: Record<string, unknown>; otherHash: string }
      } } }
      row.data.meta.__dsh_tool_body_meta_v1 = {
        videoReviewEvidence: { ...row.data.meta.videoReviewEvidence, ...change }, otherHash: digest,
      }
      return JSON.stringify(row) + '\n'
    }
    const [output] = normalizeVideoObservationReportHashes([fixture('report.json', digest) + duplicate({})])
    expect(output).toContain(
      '"__dsh_tool_body_meta_v1":{"videoReviewEvidence":{"observationReport":"report.json","sha256":"{{videoObservationReportSha256:1}}"',
    )
    expect(output).toContain(`"otherHash":"${digest}"`)
    expect(normalizeVideoObservationReportHashes([output!])).toEqual([output])
    expect(() => normalizeVideoObservationReportHashes([fixture('report.json', digest) + duplicate({ [key]: 'changed' })]))
      .toThrow('no matching prior issuance')
  },
)

it('rejects report bytes with a matching digest but a different source identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-review-report-identity-'))
  try {
    const path = join(root, 'report.json'), bytes = '{"id":"review","path":"other.mp4","source_version":"source-version"}\n'
    await writeFile(path, bytes)
    const digest = createHash('sha256').update(bytes).digest('hex')
    await expect(assertVideoObservationReportArtifacts([fixture(path, digest)]))
      .rejects.toThrow('artifact identity differs from its issuance')
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('preserves report identity relationships, unrelated hashes, distinct same-byte files and normalization fixed points', () => {
  const digest = 'a'.repeat(64)
  const input = fixture('first.json', digest) + fixture('second.json', digest, 'review-2') + fixture('first.json', digest, 'review-3')
  const [output] = normalizeVideoObservationReportHashes([input])
  const reports = output!.trim().split('\n').map(line => JSON.parse(line) as { type: string
    data: { message?: { content: { text: string }[] }; meta?: { videoReviewEvidence: { sha256: string } } } })
    .filter(row => row.type === 'tool/result')
  const bodies = reports.map(row => JSON.parse(row.data.message!.content[0]!.text) as { observation_report_sha256: string
    transcript_reference: { sha256: string } })
  expect(bodies.map(body => body.observation_report_sha256))
    .toEqual(['{{videoObservationReportSha256:1}}', '{{videoObservationReportSha256:2}}', '{{videoObservationReportSha256:1}}'])
  expect(reports.map(row => row.data.meta?.videoReviewEvidence.sha256))
    .toEqual(['{{videoObservationReportSha256:1}}', '{{videoObservationReportSha256:2}}', '{{videoObservationReportSha256:1}}'])
  expect(bodies.map(body => body.transcript_reference.sha256))
    .toEqual([digest, digest, digest])
  expect(normalizeVideoObservationReportHashes([output!])).toEqual([output])
  expect(() => normalizeVideoObservationReportHashes([fixture('first.json', digest) + fixture('first.json', 'b'.repeat(64), 'review-2')]))
    .toThrow('path changed digest')
})
