/** The creation fixtures price only their declared native JSON path fields. */
import { readFile } from 'node:fs/promises'
import { posix, win32 } from 'node:path'
import { expect, it } from 'vitest'
import { creationBudgetInput } from '../../../../snapshots/session/muse-creation-ptc/budget.ts'
import type { CreationBudgetOwner } from '../../../../snapshots/session/muse-creation-ptc/budget.ts'
import type { WorkingBudgetOracleInput } from '../../../../snapshots/session/working-budget-oracle.ts'

interface Row {
  type: string
  data?: {
    callId?: string
    message?: { toolCallId: string; content: { type: string; text: string }[] }
  }
}

const owners: readonly CreationBudgetOwner[] = [
  'muse-creation-ptc', 'muse-creation-review-guidance', 'muse-creation-stage-diagnostics',
]

async function fixture(owner: CreationBudgetOwner, cwd: string): Promise<WorkingBudgetOracleInput> {
  const log = await readFile(new URL(`../../../../snapshots/session/${owner}/writer.expected.jsonl`, import.meta.url), 'utf8')
  return { log, cwd, prompt: 'Unchanged prompt', schemas: [[{ name: 'run_code' }]] }
}

function rows(input: WorkingBudgetOracleInput): Row[] {
  return input.log.trim().split('\n').map(line => JSON.parse(line) as Row)
}

function result(records: readonly Row[], callId: string): { type: string; text: string } {
  const blocks = records.find(row => row.type === 'tool/result' && row.data?.message?.toolCallId === callId)?.data?.message?.content
  if (blocks?.length !== 1 || blocks[0] === undefined) throw new Error('Missing fixture result')
  return blocks[0]
}

it.each(owners)('preserves %s outside its declared POSIX and Windows result strings', async (owner) => {
  for (const [path, cwd] of [[posix, '/tmp/creation'], [win32, 'C:\\snapshot\\creation']] as const) {
    const input = await fixture(owner, cwd)
    const before = rows(input)
    const projected = creationBudgetInput(owner, input, path)
    const after = rows(projected)
    const callIds = owner === 'muse-creation-review-guidance'
      ? ['call_creation_skill', 'call_creation_workflow', 'call_creation_format', 'call_creation_quality']
      : ['call_creation_skill']
    for (const callId of callIds) {
      const previous = result(before, callId).text
      const current = result(after, callId)
      expect(current.text).not.toBe(previous)
      const paths = owner === 'muse-creation-stage-diagnostics'
        ? ['missing-scene.json', 'invalid-scene.json']
        : callId === 'call_creation_quality'
          ? ['.dsh/skills/screenplay-format/references/writing-quality.md', '.dsh/skills/muse-llm-wiki']
          : [`.dsh/skills/${owner === 'muse-creation-ptc' ? 'audio-transcribe'
            : callId === 'call_creation_skill' ? 'screenplay-project'
              : callId === 'call_creation_workflow' ? 'video-review' : 'screenplay-format'}`]
      let restored = current.text
      for (const suffix of paths) {
        const native = path.join(cwd, ...suffix.split('/'))
        expect(current.text).toContain(JSON.stringify(native).slice(1, -1))
        restored = restored.replace(JSON.stringify(native).slice(1, -1), '{{cwd}}/' + suffix)
      }
      expect(restored).toBe(previous)
      current.text = previous
    }
    expect(after).toEqual(before)
    expect(projected.prompt).toBe(input.prompt)
    expect(projected.schemas).toBe(input.schemas)
    expect(input.log).toBe((await fixture(owner, cwd)).log)
  }
})

it.each(owners)('rejects a changed path and call id in %s', async (owner) => {
  const input = await fixture(owner, '/tmp/creation')
  const changedPath = rows(input)
  const block = result(changedPath, 'call_creation_skill')
  block.text = block.text.replace('{{cwd}}/', '{{cwd}}/unreviewed/')
  expect(() => creationBudgetInput(owner, { ...input,
    log: changedPath.map(row => JSON.stringify(row)).join('\n') + '\n',
  }, posix)).toThrow('unexpected')

  const changedCall = rows(input)
  const call = changedCall.find(row => row.type === 'tool/call' && row.data?.callId === 'call_creation_skill')
  if (call?.data === undefined) throw new Error('Missing fixture call')
  call.data.callId = 'call_other'
  expect(() => creationBudgetInput(owner, { ...input,
    log: changedCall.map(row => JSON.stringify(row)).join('\n') + '\n',
  }, posix)).toThrow('exactly one tool/call')
})

it('preserves printed JSON spacing and rejects duplicate path literals', async () => {
  const input = await fixture('muse-creation-ptc', 'C:\\snapshot\\creation')
  const records = rows(input)
  const block = result(records, 'call_creation_skill')
  block.text = block.text.replace('  "resourceBase": {', '       "resourceBase" : {')
  const spaced = { ...input, log: records.map(row => JSON.stringify(row)).join('\n') + '\n' }
  const actual = result(rows(creationBudgetInput('muse-creation-ptc', spaced, win32)), 'call_creation_skill').text
  expect(actual).toContain('       "resourceBase" : {')
  expect(actual).toContain('"path": "C:\\\\snapshot\\\\creation\\\\.dsh\\\\skills\\\\audio-transcribe"')

  block.text = block.text.replace('"resourceBase" : {', '"duplicate": "{{cwd}}/.dsh/skills/audio-transcribe", "resourceBase" : {')
  expect(() => creationBudgetInput('muse-creation-ptc', { ...input,
    log: records.map(row => JSON.stringify(row)).join('\n') + '\n',
  }, win32)).toThrow('one exact JSON spelling')
})
