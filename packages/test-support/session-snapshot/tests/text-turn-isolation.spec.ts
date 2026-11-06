/** Text-only migration replay owns its portable header independently of POSIX shell recordings. */
import { lstat, readFile, readlink } from 'node:fs/promises'
import { expect, it } from 'vitest'
import { parseSessionLog } from '@deepseek-ai/dsh-llm-replay'
import { parseSnapshotManifest } from '../src/manifest.ts'
import { parseToolSchemasSnapshot } from '../src/suite.ts'
import { assertSessionFixtureVersion } from '../src/session-files.ts'

const root = new URL('../../../../snapshots/', import.meta.url)
const read = (file: string) => readFile(new URL(file, root), 'utf8')
const manifest = async (file: string) => parseSnapshotManifest(await read(file), file)
const namesOf = (schemas: readonly unknown[]) => schemas.map((schema) => {
  if (!schema || typeof schema !== 'object' || !('name' in schema) || typeof schema.name !== 'string') {
    throw Error('Expected a named tool schema')
  }
  return schema.name
})

it('retains V1 migration coverage and gives the text composition one authored current-writer pin', async () => {
  const legacy = await manifest('session/text-turn/snapshot.yml')
  const current = await manifest('session/text-turn-current/snapshot.yml')
  const shared = await manifest('session/tool-call-turn/snapshot.yml')
  expect(legacy.composition).toBe('text-turn')
  expect(legacy.sessionFormat).toEqual({ version: 1, coverage: ['adjacent-migration'] })
  expect(legacy.header?.pin).not.toBe(true)
  expect(current).toMatchObject({ composition: 'text-turn', recording: 'authored', writerOutput: true,
    header: { class: legacy.header?.class, pin: true, systemPromptSource: 'text-turn', toolSchemasSource: 'text-turn' } })
  expect(current.sessionFormat).toBeUndefined()
  expect(shared).toMatchObject({ composition: 'default', platform: 'posix', header: { class: 'default', pin: true } })
  expect(shared.header?.systemPromptSource).toBeUndefined()
  expect(shared.header?.toolSchemasSource).toBeUndefined()
})

it('limits text replay changes to disabling both unused shells while keeping the shared replay patch exact', async () => {
  const shared = await read('session/tool-call-turn/cordis.snapshot.yml')
  const text = await read('session/text-turn/cordis.snapshot.yml')
  const overrides = '\n# This fixture has no tool calls; omit both platform shell schemas.\n- id: tool-bash\n  disabled: true\n- id: tool-pwsh\n  disabled: true\n'
  expect(text).toBe(shared + overrides)
  expect(await read('session/text-turn/cordis.yml')).toBe(overrides.trimStart())
  const sharedNames = namesOf(parseToolSchemasSnapshot(await read('session/tool-call-turn/tool-schemas.expected.json')).initial)
  const textNames = namesOf(parseToolSchemasSnapshot(await read('session/text-turn/tool-schemas.expected.json')).initial)
  expect(sharedNames).toContain('bash')
  expect(sharedNames).not.toContain('pwsh')
  expect(textNames).toEqual(sharedNames.filter(name => name !== 'bash' && name !== 'pwsh'))
})

it('keeps identical user and final text with zero tool dispatches in the retained and authored inputs', async () => {
  const legacy = parseSessionLog(await read('session/text-turn/session.v1.jsonl'))
  const currentText = await read('session/text-turn-current/session.v4.jsonl')
  const current = parseSessionLog(currentText)
  expect(assertSessionFixtureVersion('session.v4.jsonl', currentText)).toBe(4)
  const words = (events: typeof legacy) => events.flatMap(event => event.type === 'user/message'
    ? event.data.content.flatMap(block => block.type === 'text' ? [block.text] : [])
    : event.type === 'assistant/message'
      ? event.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : []) : [])
  expect(words(current)).toEqual(words(legacy))
  for (const events of [legacy, current]) expect(events.filter(event => event.type === 'tool/call')).toEqual([])
  const shell = parseSessionLog(await read('session/tool-call-turn/session.v4.jsonl'))
  expect(shell.some(event => event.type === 'tool/call' && event.data.name === 'bash')).toBe(true)
})

it('keeps the ACP aliases pointed at shared headers without borrowing the shell Session input', async () => {
  const acp = await manifest('acp/escalation-approved/snapshot.yml')
  expect(acp.header).toMatchObject({ systemPromptSource: 'session/tool-call-turn', toolSchemasSource: 'session/tool-call-turn' })
  for (const filename of ['system-prompt.expected.md', 'tool-schemas.expected.json']) {
    const file = new URL(`acp/escalation-approved/${filename}`, root)
    const target = (await lstat(file)).isSymbolicLink() ? await readlink(file) : await readFile(file, 'utf8')
    expect(target).toBe(`../../session/tool-call-turn/${filename}`)
  }
  expect(acp.session).toBeUndefined()
})
