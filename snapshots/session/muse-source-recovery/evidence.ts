/** Independent source-result and recovery evidence for this owner's allocated workspace. */
import { deepStrictEqual, equal, ok } from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, realpath } from 'node:fs/promises'
import { join } from 'node:path'

/** Path-dependent values derived from the committed single-line source and canonical workspace. */
export interface SourceRecoveryEvidence {
  readonly cwd: string
  readonly path: string
  readonly text: string
  readonly pruned: string
  readonly chars: number
  readonly sha256: string
  readonly shadowedTokens: number
  readonly line: string
}

/**
 * Build the independently expected full read result without consulting returned text or hashes.
 * @param cwd - Allocated workspace containing the copied source.
 * @param scenarioDir - Owner with the committed source bytes.
 * @returns Canonical read text, code-point lengths, digest and fixed-density token price.
 */
export async function expectedSourceRecoveryEvidence(cwd: string, scenarioDir: string): Promise<SourceRecoveryEvidence> {
  const source = await readFile(join(scenarioDir, 'workspace/source.txt'), 'utf8')
  const line = source.replace(/\r?\n$/u, '')
  ok(!line.includes('\n'), 'Source recovery recording owns one complete source line')
  const path = await realpath(join(cwd, 'source.txt'))
  const text = `<path>${path}</path>\n<type>file</type>\n<content>\n1: ${line}\n\n(End of file - total 1 lines)\n</content>`
  const points = Array.from(text)
  return { cwd: await realpath(cwd), path, text, line, chars: points.length,
    sha256: createHash('sha256').update(text).digest('hex'),
    pruned: points.slice(0, 60).join('') + '\n\n[... tool result middle pruned ...]\n\n' + points.slice(-40).join(''),
    shadowedTokens: Math.ceil(text.length / 4) + 8 }
}

function entry(evidence: SourceRecoveryEvidence) {
  return { seq: 15, path: evidence.path, offset: 1, returned_lines: 1, total_lines: 1, read_file_scope: 'complete',
    recorded_text_blocks: [{ block: 0, chars: evidence.chars, sha256: evidence.sha256 }],
    recorded_result: 'original_logged_event_not_verified_complete', file_version: 'not_recorded' }
}

function page(evidence: SourceRecoveryEvidence, offset: number, limit: number) {
  const end = Math.min(offset + limit, evidence.chars)
  return { ...entry(evidence), block: 0, offset, next_offset: end < evidence.chars ? end : null,
    total_chars: evidence.chars, text_sha256: evidence.sha256, page_complete: end === evidence.chars,
    text: Array.from(evidence.text).slice(offset, end).join('') }
}

interface Row {
  type: string
  cwd?: string
  surfaceOp?: string | object
  data?: {
    source?: { kind: string }
    content?: { type: string; text?: string }[]
    message?: { toolCallId?: string; content: { type: string; text?: string }[] }
    meta?: object
    shadowedSeqs?: number[]
    shadowedTokenCount?: number
  }
}

/**
 * Verify actual evidence, or derive only the owner's path-dependent expected fields.
 * @param log - Complete actual or committed writer JSONL.
 * @param evidence - Expected values from the committed source bytes and current canonical path.
 * @param verify - Strictly compare actual fields instead of preparing expected records.
 * @returns Complete JSONL with unrelated records and business fields retained.
 */
export function sourceRecoveryLog(log: string, evidence: SourceRecoveryEvidence, verify: boolean): string {
  const found = new Set<string>()
  const rows = log.split('\n').filter(Boolean).map((line) => {
    const row = JSON.parse(line) as Row
    const data = row.data
    if (!verify && row.type === 'session') row.cwd = evidence.cwd
    if (row.type === 'compaction/prune' && data?.shadowedSeqs?.includes(15)) {
      if (verify) equal(data.shadowedTokenCount, evidence.shadowedTokens, 'Read token price differs from independently derived text')
      else data.shadowedTokenCount = evidence.shadowedTokens
      found.add('prune')
    }
    if (row.type === 'user/message' && data?.source?.kind === 'muse-manuscript') {
      const block = data.content?.find(block => block.type === 'text' && block.text?.startsWith('{"source_recovery":'))
      if (block?.text !== undefined) {
        const index = JSON.parse(block.text) as { source_recovery: { entries: object[] } }
        if (verify) deepStrictEqual(index.source_recovery.entries, [entry(evidence)], 'Recovery index differs from independently derived source')
        else { index.source_recovery.entries = [entry(evidence)]; block.text = JSON.stringify(index) }
        found.add('index')
      }
    }
    if (row.type !== 'tool/result' || data?.message === undefined) return row
    const { message } = data
    const call = message.toolCallId
    if (call !== 'call_recovery_1' && call !== 'call_recovery_2' && call !== 'call_recovery_3') return row
    const block = message.content[0]
    ok(message.content.length === 1 && block?.type === 'text' && block.text !== undefined, 'Missing complete source recovery result')
    if (call === 'call_recovery_1') {
      const original = row.surfaceOp === 'append'
      const expected = original ? evidence.text : evidence.pruned
      const meta = { path: evidence.path, offset: 1, lines: [{ number: 1, text: evidence.line }], totalLines: 1 }
      if (verify) {
        equal(block.text, expected, 'Read text differs from independently derived source')
        deepStrictEqual(data.meta, meta, 'Read metadata differs from independently derived source')
      } else { block.text = expected; data.meta = meta }
      found.add(original ? 'read' : 'pruned-read')
    } else {
      const expected = call === 'call_recovery_2' ? page(evidence, 0, 100) : page(evidence, 100, 4000)
      if (verify) deepStrictEqual(JSON.parse(block.text), expected, 'Recovery page differs from independently derived source')
      else block.text = JSON.stringify(expected)
      found.add(call)
    }
    return row
  })
  deepStrictEqual([...found].sort(), ['call_recovery_2', 'call_recovery_3', 'index', 'prune', 'pruned-read', 'read'], 'Incomplete source recovery evidence')
  return rows.map(row => JSON.stringify(row)).join('\n') + '\n'
}
