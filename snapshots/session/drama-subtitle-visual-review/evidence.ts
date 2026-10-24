/** Derive this owner's path-dependent digest from committed inputs, never from the returned digest. */
import { createHash } from 'node:crypto'
import { readFile, realpath } from 'node:fs/promises'
import { join } from 'node:path'

const digest = (bytes: string | Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

/**
 * Compute the expected digest using the fixed scenario files and this run's actual project path.
 * @param cwd - Atomically allocated workspace.
 * @param scenarioDir - Owner containing the independently authored input files.
 * @returns The one expected source/SRT/recognition digest for this run.
 */
export async function expectedVisualSpeechHash(cwd: string, scenarioDir: string): Promise<string> {
  const project = await realpath(cwd)
  const files: [string, string][] = []
  for (const [actual, seed] of [
    ['editing/01.srt', 'source.srt'], ['receipts.json', 'receipts.json'], ['source.mp4', 'source.mp4'],
    ['transcript/jobs/source-v1.json', 'transcript/jobs/source-v1.json'],
    ['transcript/raw/source-v1.json', 'transcript/raw/source-v1.json'],
  ] as const) {
    files.push([join(project, actual), digest(await readFile(join(scenarioDir, 'workspace', seed)))])
  }
  return digest(JSON.stringify({ files, clips: [{ shot: 1, startUs: 0, durationUs: 5_000_000 }],
    sources: [[1, join(project, 'source.mp4')]] }))
}

/**
 * Change only this owner's expected digest after independently validating the complete actual result.
 * @param log - Complete actual or expected Session JSONL, not a model request replacement.
 * @param expectedHash - Digest independently derived from the owned input bytes and current cwd.
 * @param verify - Reject a differing digest instead of deriving the expected representation.
 * @returns Complete records; every other field and record is retained.
 */
export function visualSpeechRecords(log: string, expectedHash: string, verify: boolean): object[] {
  let found = false
  const rows: object[] = log.split('\n').filter(Boolean).map((line) => {
    const row = JSON.parse(line) as { type: string; data?: { message?: {
      toolCallId?: string; content?: { type: string; text?: string }[]
    } } }
    if (row.type !== 'tool/result' || row.data?.message?.toolCallId !== 'call_visual_speech') return row
    const block = row.data.message.content?.[0]
    if (block?.type !== 'text' || block.text === undefined) throw new Error('Missing complete speech result')
    const report = JSON.parse(block.text) as { speech_coverage?: { evidence_sha256: string } }
    if (report.speech_coverage === undefined) throw new Error('Missing speech comparison')
    if (verify && report.speech_coverage.evidence_sha256 !== expectedHash) throw new Error('Speech evidence digest differs from independently derived inputs')
    found = true
    if (!verify) {
      report.speech_coverage.evidence_sha256 = expectedHash
      block.text = JSON.stringify(report, null, 2)
    }
    return row
  })
  if (!found) throw new Error('Missing speech tool result')
  return rows
}
