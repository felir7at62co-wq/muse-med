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
  'muse-skill-market-bounded-catalog-ptc', 'muse-skill-market-creation-binding-ptc', 'muse-video-screenplay-entry-creation',
]
const sessionId = 'session-00000000-0000-4000-8000-000000000001'

function calls(owner: CreationBudgetOwner): readonly string[] {
  if (owner === 'muse-creation-review-guidance') return ['call_creation_skill', 'call_creation_workflow', 'call_creation_format', 'call_creation_quality']
  if (owner === 'muse-skill-market-bounded-catalog-ptc') return ['call_bounded_ptc_load']
  if (owner === 'muse-skill-market-creation-binding-ptc') return ['call_creation_skill_old_1', 'call_creation_skill_old_2']
  return ['call_creation_skill']
}

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
    const projected = creationBudgetInput(owner, input, path, sessionId)
    const after = rows(projected)
    if (owner === 'muse-skill-market-bounded-catalog-ptc') {
      const catalog = result(after, 'call_bounded_ptc_catalog')
      expect(catalog.text.split(sessionId)).toHaveLength(8)
      catalog.text = catalog.text.replaceAll(sessionId, '{{session:1}}')
    }
    const callIds = calls(owner)
    for (const callId of callIds) {
      const previous = result(before, callId).text
      const current = result(after, callId)
      expect(current.text).not.toBe(previous)
      const paths = owner === 'muse-creation-stage-diagnostics'
        ? ['missing-scene.json', 'invalid-scene.json']
        : owner === 'muse-skill-market-bounded-catalog-ptc'
          ? ['.dsh/bounded-market/packages/a2346e1c0efd03f2719a84f6b57376e748f7014cc128ae5631e486d032aaac1c/skills/market-scene-14']
          : owner === 'muse-skill-market-creation-binding-ptc'
            ? ['.dsh/market-creation/packages/36c57f2b809312cd6b4c2f9e4fe9ab7cd98daebb1b1f55ead14e9d1158bbd5d5/skills/version-bound-review']
            : owner === 'muse-video-screenplay-entry-creation'
              ? ['.dsh/product-video-skills/video-to-screenplay']
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
  const firstCall = calls(owner)[0]!
  const block = result(changedPath, firstCall)
  block.text = block.text.replace('{{cwd}}/', '{{cwd}}/unreviewed/')
  expect(() => creationBudgetInput(owner, { ...input,
    log: changedPath.map(row => JSON.stringify(row)).join('\n') + '\n',
  }, posix, sessionId)).toThrow('unexpected')

  const changedCall = rows(input)
  const call = changedCall.find(row => row.type === 'tool/call' && row.data?.callId === firstCall)
  if (call?.data === undefined) throw new Error('Missing fixture call')
  call.data.callId = 'call_other'
  expect(() => creationBudgetInput(owner, { ...input,
    log: changedCall.map(row => JSON.stringify(row)).join('\n') + '\n',
  }, posix, sessionId)).toThrow('exactly one tool/call')
})

it('requires the independent primary Session identity and all seven catalog cursor identities', async () => {
  const owner = 'muse-skill-market-bounded-catalog-ptc'
  const input = await fixture(owner, '/tmp/creation')
  expect(() => creationBudgetInput(owner, input, posix)).toThrow('requires the replay Session identity')
  const records = rows(input)
  const catalog = result(records, 'call_bounded_ptc_catalog')
  catalog.text = catalog.text.replace('{{session:1}}', '{{session:2}}')
  expect(() => creationBudgetInput(owner, { ...input,
    log: records.map(row => JSON.stringify(row)).join('\n') + '\n',
  }, posix, sessionId)).toThrow('cursor must identify the primary Session')
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
