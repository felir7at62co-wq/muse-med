import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it } from 'vitest'
import { TOOL_BODY_META_KEY } from '@deepseek-ai/dsh-tools'
import { assertVideoObservationReportArtifacts, normalizeVideoObservationReportHashes } from './snapshot-reports.ts'

function fixture(path: string, digest: string, call = 'review-1', metaDigest = digest, preserved = false): string {
  const evidence = { observationReport: path, sha256: metaDigest, sessionId: 'session', reviewId: 'review' }
  return [
    { type: 'tool/call', data: { callId: call, name: 'video_inspect' } },
    { type: 'tool/result', data: { message: { toolCallId: call, content: [{ type: 'text', text: JSON.stringify({ complete: true,
      observation_report: path, observation_report_sha256: digest, observation_session_id: 'session', review_id: 'review',
      transcript_reference: { sha256: digest } }) }] }, meta: { videoReviewEvidence: evidence,
      ...(preserved ? { [TOOL_BODY_META_KEY]: { videoReviewEvidence: { ...evidence } } } : {}) } } },
  ].map(row => JSON.stringify(row)).join('\n') + '\n'
}

it('checks live report bytes before tokenizing and rejects altered tool, metadata or artifact digests', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-review-report-hash-'))
  try {
    const path = join(root, 'report.json'), bytes = '{"id":"review"}\n'
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

it('keeps preserved body evidence tied to the independently checked report and rejects a mismatched copy', () => {
  const digest = 'a'.repeat(64)
  const input = fixture('report.json', digest, 'review-1', digest, true)
  const [output] = normalizeVideoObservationReportHashes([input])
  expect(output?.match(/"sha256":"\{\{videoObservationReportSha256:1\}\}"/gu)).toHaveLength(2)
  const result = JSON.parse(output!.trim().split('\n')[1]!) as { data: { message: { content: { text: string }[] } } }
  const body: unknown = JSON.parse(result.data.message.content[0]!.text)
  expect(body).toMatchObject({ transcript_reference: { sha256: digest } })
  expect(normalizeVideoObservationReportHashes([output!])).toEqual([output])
  const changed = input.replace(`"${TOOL_BODY_META_KEY}":{"videoReviewEvidence":{"observationReport":"report.json","sha256":"${digest}"`,
    `"${TOOL_BODY_META_KEY}":{"videoReviewEvidence":{"observationReport":"report.json","sha256":"${'b'.repeat(64)}"`)
  expect(changed).not.toBe(input)
  expect(() => normalizeVideoObservationReportHashes([changed])).toThrow('preserved body metadata identity or digest mismatch')
})
