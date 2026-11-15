/** Independent OCR bytes and digest checks for the unsupported-platform owner. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, realpath } from 'node:fs/promises'
import { join } from 'node:path'

/** Derive the digest from the complete expected report and verify the actual artifact.
 * @param cwd - This run's allocated scenario workspace.
 * @returns Digest of the exact independently constructed report bytes.
 */
export async function expectedCapabilityOcrHash(cwd: string): Promise<string> {
  const expected = {
    schema_version: 1, evidence_algorithm: 'decoded-pts-spatial-v2', path: join(await realpath(cwd), 'fixture.mp4'), source_version: 'fixture-video-version',
    duration_seconds: 4, text_source: 'ocr', language_requested: 'auto',
    interval: { start_seconds: 0, end_seconds: 1 }, scan_status: 'failed', text_status: 'indeterminate',
    coverage: { planned_frame_count: 2, processed_frame_count: 0, failed_frame_count: 2,
      frame_interval_seconds: 0.5, scanned_ranges: [], unscanned_ranges: [], failed_timestamps_seconds: [0, 0.5] },
    frames: [], segments: [], failure_code: 'windows_only',
  }
  const bytes = JSON.stringify(expected, null, 2) + '\n'
  assert.equal(await readFile(join(cwd, '.dsh/ocr/raw.json'), 'utf8'), bytes,
    'OCR report differs from independently constructed unsupported-platform evidence')
  return createHash('sha256').update(bytes).digest('hex')
}

/** Check or project only the three matching digest fields of this owner's OCR result.
 * @param log - Complete actual or expected Session JSONL.
 * @param expectedHash - Independently checked digest, or the fixed writer placeholder.
 * @param verify - Require the actual report and metadata digests to match.
 * @returns Records preserving every other field and event.
 */
export function capabilityOcrRecords(log: string, expectedHash: string, verify: boolean): object[] {
  let found = false
  const rows: object[] = log.split('\n').filter(Boolean).map(line => {
    const row = JSON.parse(line) as { type: string; data?: {
      message?: { toolCallId?: string; isError?: boolean; content?: { type: string; text?: string }[] };
      meta?: { rawJsonSha256?: string; sourceVersion?: string;
        __dsh_tool_body_meta_v1?: { rawJsonSha256?: string; sourceVersion?: string } }
    } }
    if (row.type !== 'tool/result' || row.data?.message?.toolCallId !== 'call_ocr') return row
    const block = row.data.message.content?.[0]
    const meta = row.data.meta
    const bodyMeta = meta?.__dsh_tool_body_meta_v1
    if (row.data.message.isError || block?.type !== 'text' || block.text === undefined || meta === undefined) {
      throw new Error('Missing complete OCR capability result')
    }
    const report = JSON.parse(block.text) as { raw_json_sha256?: string; source_version?: string }
    if (report.source_version !== 'fixture-video-version' || meta.sourceVersion !== report.source_version
      || !/^[a-f0-9]{64}$/u.test(report.raw_json_sha256 ?? '') || meta.rawJsonSha256 !== report.raw_json_sha256
      || bodyMeta?.sourceVersion !== report.source_version || bodyMeta.rawJsonSha256 !== report.raw_json_sha256) {
      throw new Error('OCR result and metadata identity or digest mismatch')
    }
    if (verify && report.raw_json_sha256 !== expectedHash) {
      throw new Error('OCR digest differs from independently constructed report bytes')
    }
    found = true
    if (!verify) {
      report.raw_json_sha256 = expectedHash
      meta.rawJsonSha256 = expectedHash
      bodyMeta.rawJsonSha256 = expectedHash
      block.text = JSON.stringify(report)
    }
    return row
  })
  if (!found) throw new Error('Missing OCR capability tool result')
  return rows
}
