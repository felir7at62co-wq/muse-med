/** Owner-local source recovery digests, Unicode pages and allocated-path expectations. */
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { expectedSourceRecoveryEvidence, sourceRecoveryLog } from '../snapshots/session/muse-source-recovery/evidence.ts'

const owner = new URL('../snapshots/session/muse-source-recovery/', import.meta.url)
const template = await readFile(new URL('writer.expected.jsonl', owner), 'utf8')

async function fixture(source = '请保持道具位置。'.repeat(30) + '\n', segment = 'workspace') {
  const root = await mkdtemp(join(tmpdir(), 'dsh-source-evidence-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const cwd = join(root, segment), scenario = join(root, 'owner')
  await mkdir(cwd, { recursive: true })
  await mkdir(join(scenario, 'workspace'), { recursive: true })
  await writeFile(join(cwd, 'source.txt'), source)
  await writeFile(join(scenario, 'workspace/source.txt'), source)
  const evidence = await expectedSourceRecoveryEvidence(cwd, scenario)
  const log = sourceRecoveryLog(template, evidence, false)
  return { cwd, root, scenario, evidence, log }
}

function replaceText(log: string, predicate: (row: Row) => boolean, change: (text: string) => string) {
  return log.trimEnd().split('\n').map((line) => {
    const row = JSON.parse(line) as Row
    if (predicate(row)) {
      const block = row.data?.message?.content[0] ?? row.data?.content?.[0]
      if (block === undefined) throw new Error('Missing fixture result text')
      block.text = change(block.text)
    }
    return JSON.stringify(row)
  }).join('\n') + '\n'
}
interface Row {
  type: string
  surfaceOp?: string | object
  data?: { source?: { kind: string }; content?: { text: string }[]; message?: { toolCallId: string; content: { text: string }[] } }
}

it('derives distinct complete evidence for different allocated path lengths without changing the source oracle', async () => {
  const short = await fixture(), long = await fixture(undefined, 'long-workspace-'.repeat(4))
  expect(short.evidence.path.length).toBeLessThan(long.evidence.path.length)
  expect(short.evidence.sha256).not.toBe(long.evidence.sha256)
  expect(() => sourceRecoveryLog(short.log, short.evidence, true)).not.toThrow()
  expect(() => sourceRecoveryLog(long.log, long.evidence, true)).not.toThrow()
  expect(() => sourceRecoveryLog(short.log, long.evidence, true)).toThrow()
  expect(await readFile(new URL('writer.expected.jsonl', owner), 'utf8')).toBe(template)
})

it('counts Unicode recovery pages and pruning by code point while pricing text by UTF-16 units', async () => {
  const run = await fixture('原文🙂𠮷'.repeat(40) + '\n', '工作间🙂')
  const expected = `<path>${run.evidence.path}</path>\n<type>file</type>\n<content>\n1: ${'原文🙂𠮷'.repeat(40)}\n\n(End of file - total 1 lines)\n</content>`
  expect(run.evidence.text).toBe(expected)
  expect(run.evidence.sha256).toBe(createHash('sha256').update(expected).digest('hex'))
  expect(run.evidence.chars).toBe(Array.from(expected).length)
  expect(run.evidence.chars).toBeLessThan(expected.length)
  expect(run.evidence.shadowedTokens).toBe(Math.ceil(expected.length / 4) + 8)
  expect(run.evidence.pruned).toBe(Array.from(expected).slice(0, 60).join('')
    + '\n\n[... tool result middle pruned ...]\n\n' + Array.from(expected).slice(-40).join(''))
  const pages = run.log.trimEnd().split('\n').map(line => JSON.parse(line) as Row)
    .filter(row => row.type === 'tool/result' && ['call_recovery_2', 'call_recovery_3'].includes(row.data?.message?.toolCallId ?? ''))
    .map(row => JSON.parse(row.data!.message!.content[0]!.text) as {
      text: string
      offset: number
      next_offset: number | null
      total_chars: number
    })
  expect(pages.map(page => page.offset)).toEqual([0, 100])
  expect(Array.from(pages[0]!.text)).toHaveLength(100)
  expect(pages[0]!.next_offset).toBe(100)
  expect(pages[1]!.next_offset).toBeNull()
  expect(pages[0]!.text + pages[1]!.text).toBe(expected)
  expect(pages.every(page => page.total_chars === Array.from(expected).length)).toBe(true)
  expect(() => sourceRecoveryLog(run.log, run.evidence, true)).not.toThrow()
})

it('resolves directory aliases to the physical source identity', async () => {
  const run = await fixture()
  const alias = join(run.root, 'alias')
  await symlink(run.cwd, alias, process.platform === 'win32' ? 'junction' : 'dir')
  expect(await expectedSourceRecoveryEvidence(alias, run.scenario)).toEqual(run.evidence)
})

it.each(['index', 'call_recovery_2', 'call_recovery_3'])('rejects a changed %s digest', async (target) => {
  const run = await fixture()
  const changed = replaceText(run.log, row => target === 'index'
    ? row.type === 'user/message' && row.data?.source?.kind === 'muse-manuscript'
    : row.type === 'tool/result' && row.data?.message?.toolCallId === target,
  text => text.replaceAll(run.evidence.sha256, '0'.repeat(64)))
  expect(changed).not.toBe(run.log)
  expect(() => sourceRecoveryLog(changed, run.evidence, true)).toThrow('independently derived source')
})

it.each(['call_recovery_1', 'call_recovery_2', 'call_recovery_3'])('rejects changed %s text while keeping its recorded digest', async (target) => {
  const run = await fixture()
  const changed = replaceText(run.log, row => row.type === 'tool/result' && row.data?.message?.toolCallId === target
    && row.surfaceOp === 'append', (text) => {
    if (target === 'call_recovery_1') return text + 'changed source'
    const page = JSON.parse(text) as { text: string }
    page.text += 'changed page'
    return JSON.stringify(page)
  })
  expect(() => sourceRecoveryLog(changed, run.evidence, true)).toThrow('independently derived source')
})

it('rejects altered pruning instead of treating it as an allowed volatile field', async () => {
  const run = await fixture()
  const changed = replaceText(run.log, row => row.type === 'tool/result' && row.data?.message?.toolCallId === 'call_recovery_1'
    && typeof row.surfaceOp === 'object', text => text + 'changed tail')
  expect(() => sourceRecoveryLog(changed, run.evidence, true)).toThrow('Read text differs')
})

it('leaves unrelated records and business data unchanged when deriving expected source fields', async () => {
  const run = await fixture()
  const before = template.trimEnd().split('\n').map(line => JSON.parse(line) as Row)
  const after = sourceRecoveryLog(template, run.evidence, false).trimEnd().split('\n').map(line => JSON.parse(line) as Row)
  const unrelated = (row: Row) => !['session', 'compaction/prune'].includes(row.type)
    && !(row.type === 'user/message' && row.data?.source?.kind === 'muse-manuscript')
    && !(row.type === 'tool/result' && ['call_recovery_1', 'call_recovery_2', 'call_recovery_3'].includes(row.data?.message?.toolCallId ?? ''))
  expect(after.filter(unrelated)).toEqual(before.filter(unrelated))
})
