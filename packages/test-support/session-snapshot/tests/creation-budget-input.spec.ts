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
const recordings: readonly { owner: CreationBudgetOwner; index: number }[] = [
  ...owners.map(owner => ({ owner, index: 0 })),
  { owner: 'muse-skill-market-creation-binding-ptc', index: 1 },
  { owner: 'muse-skill-market-creation-binding-ptc', index: 2 },
]
const sessionId = 'session-00000000-0000-4000-8000-000000000001'

function calls(owner: CreationBudgetOwner, index: number): readonly string[] {
  if (owner === 'muse-creation-review-guidance') return ['call_creation_skill', 'call_creation_workflow', 'call_creation_format', 'call_creation_quality']
  if (owner === 'muse-skill-market-bounded-catalog-ptc') return ['call_bounded_ptc_load']
  if (owner === 'muse-skill-market-creation-binding-ptc') return index === 0
    ? ['call_creation_skill_old_1', 'call_creation_skill_old_2']
    : [index === 1 ? 'call_creation_skill_blank_1' : 'call_creation_skill_fresh_1']
  return ['call_creation_skill']
}

async function fixture(owner: CreationBudgetOwner, cwd: string, index = 0): Promise<WorkingBudgetOracleInput> {
  const suffix = index === 0 ? '' : `.${index}`
  const log = await readFile(new URL(`../../../../snapshots/session/${owner}/writer${suffix}.expected.jsonl`, import.meta.url), 'utf8')
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

it.each(recordings)('preserves $owner recording $index outside its declared POSIX and Windows result strings', async ({ owner, index }) => {
  for (const [path, cwd] of [[posix, '/tmp/creation'], [win32, 'C:\\snapshot\\creation']] as const) {
    const input = await fixture(owner, cwd, index)
    const before = rows(input)
    const projected = creationBudgetInput(owner, input, path, sessionId, index)
    const after = rows(projected)
    if (owner === 'muse-skill-market-bounded-catalog-ptc') {
      const catalog = result(after, 'call_bounded_ptc_catalog')
      expect(catalog.text.split(sessionId)).toHaveLength(8)
      catalog.text = catalog.text.replaceAll(sessionId, '{{session:1}}')
    }
    const callIds = calls(owner, index)
    for (const callId of callIds) {
      const previous = result(before, callId).text
      const current = result(after, callId)
      expect(current.text).not.toBe(previous)
      const paths = owner === 'muse-creation-stage-diagnostics'
        ? ['missing-scene.json', 'invalid-scene.json']
        : owner === 'muse-skill-market-bounded-catalog-ptc'
          ? [['.dsh', 'bounded-market', 'packages', 'a2346e1c0efd03f2719a84f6b57376e748f7014cc128ae5631e486d032aaac1c', 'skills', 'market-scene-14'].join('/')]
          : owner === 'muse-skill-market-creation-binding-ptc'
            ? [['.dsh', 'market-creation', 'packages', index === 0
              ? '36c57f2b809312cd6b4c2f9e4fe9ab7cd98daebb1b1f55ead14e9d1158bbd5d5'
              : 'eb745655ecbe60ef1b8b5aeae2e13db9777cb9e12d59c3c089d79a5d0037db32', 'skills', 'version-bound-review'].join('/')]
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
    expect(input.log).toBe((await fixture(owner, cwd, index)).log)
  }
})

it.each(recordings)('rejects a changed path and call id in $owner recording $index', async ({ owner, index }) => {
  const input = await fixture(owner, '/tmp/creation', index)
  const changedPath = rows(input)
  const firstCall = calls(owner, index)[0]!
  const block = result(changedPath, firstCall)
  block.text = block.text.replace('{{cwd}}/', '{{cwd}}/unreviewed/')
  expect(() => creationBudgetInput(owner, { ...input,
    log: changedPath.map(row => JSON.stringify(row)).join('\n') + '\n',
  }, posix, sessionId, index)).toThrow('unexpected')

  const changedCall = rows(input)
  const call = changedCall.find(row => row.type === 'tool/call' && row.data?.callId === firstCall)
  if (call?.data === undefined) throw new Error('Missing fixture call')
  call.data.callId = 'call_other'
  expect(() => creationBudgetInput(owner, { ...input,
    log: changedCall.map(row => JSON.stringify(row)).join('\n') + '\n',
  }, posix, sessionId, index)).toThrow('exactly one tool/call')
})

it('refuses undeclared child recordings', async () => {
  const input = await fixture('muse-skill-market-creation-binding-ptc', '/tmp/creation', 1)
  expect(() => creationBudgetInput('muse-skill-market-creation-binding-ptc', input, posix, sessionId, 3)).toThrow('no declared child')
  expect(() => creationBudgetInput('muse-creation-ptc', input, posix, sessionId, 1)).toThrow('no declared child')
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
