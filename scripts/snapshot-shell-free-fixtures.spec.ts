/** Shell-free native scenarios keep the same tool availability on every replay platform. */
import { readFile, readdir } from 'node:fs/promises'
import { expect, it } from 'vitest'
import { loadCordisYaml } from './cordis-yaml.ts'

const scenarios = [
  'drama-bgm-preview',
  'muse-image-material-readback',
  'muse-native-flat-child-claim',
  'muse-native-generate-alias',
  'muse-native-legacy-key-conflict',
  'muse-native-missing-episode-claim',
  'muse-native-saved-duration-string',
  'muse-storyboard-empty-history-delete',
  'muse-upscale-pricing',
] as const

interface RecordedCallProjection {
  readonly type: string
  readonly data: {
    readonly name?: string
    readonly header?: { readonly tools?: readonly string[] | string }
    readonly message?: { readonly content?: readonly { type: string; name?: string; toolName?: string }[] }
  }
}

function recordedToolNames(source: string): string[] {
  const records = source.trim().split('\n').map(line => JSON.parse(line) as RecordedCallProjection)
  return records.flatMap(record => record.type === 'tool/call'
    ? [record.data.name]
    : record.type === 'assistant/message'
      ? record.data.message?.content?.filter(block => block.type === 'tool-call').map(block => block.name) ?? []
      : []).filter((name): name is string => typeof name === 'string')
}

function requireShellFreeRecording(source: string): void {
  const names = recordedToolNames(source)
  expect(names.length).toBeGreaterThan(0)
  expect(names.filter(name => name === 'bash' || name === 'pwsh')).toEqual([])
}

function requireShellDisabled(source: string): void {
  const rows = loadCordisYaml(source) as { id?: string; disabled?: unknown }[]
  for (const id of ['tool-bash', 'tool-pwsh']) {
    expect(rows.filter(row => row.id === id)).toEqual([{ id, disabled: true }])
  }
}

function requireShellFreeCatalog(source: string): void {
  const records = source.trim().split('\n').map(line => JSON.parse(line) as RecordedCallProjection)
  const tools = records.flatMap((record) => {
    if (record.type === 'request/header') {
      const names = record.data.header?.tools
      return typeof names === 'string' ? [] : names ?? []
    }
    return record.type === 'developer/message'
      ? record.data.message?.content?.filter(block => block.type === 'tool-addition')
        .flatMap(block => block.toolName === undefined ? [] : [block.toolName]) ?? []
      : []
  })
  expect(tools.length).toBeGreaterThan(0)
  expect(tools.filter(name => name === 'bash' || name === 'pwsh')).toEqual([])
}

it.each(['', '.win32'])('keeps the %s parent inheritance catalog aligned with its shell-free composition', async (platform) => {
  const root = new URL('../apps/cli/tests/profiles/headless/', import.meta.url)
  requireShellDisabled(await readFile(new URL('subagent-inheritance-snapshot.patch.yml', root), 'utf8'))
  requireShellFreeCatalog(await readFile(new URL(`tests/expected/subagent-inheritance/parent${platform}.expected.jsonl`, root), 'utf8'))
})

it.each(['bash', 'pwsh'])('rejects a disabled %s tool in either a request header or registry update', (name) => {
  for (const record of [
    { type: 'request/header', data: { header: { tools: [name] } } },
    { type: 'developer/message', data: { message: { content: [{ type: 'tool-addition', toolName: name }] } } },
  ]) expect(() => { requireShellFreeCatalog(JSON.stringify(record)) }).toThrow()
})

it.each(scenarios)('%s has no recorded shell calls and disables both platform shell tools', async (scenario) => {
  const directory = new URL(`../snapshots/session/${scenario}/`, import.meta.url)
  for (const file of ['cordis.yml', 'cordis.snapshot.yml']) {
    requireShellDisabled(await readFile(new URL(file, directory), 'utf8'))
  }
  const recordings = (await readdir(directory)).filter(file =>
    /^(?:session(?:\.\d+)?(?:\.v\d+)?|writer(?:\.\d+)?\.expected)\.jsonl$/u.test(file))
  expect(recordings.some(file => file.startsWith('session'))).toBe(true)
  expect(recordings.some(file => file.startsWith('writer'))).toBe(true)
  for (const file of recordings) requireShellFreeRecording(await readFile(new URL(file, directory), 'utf8'))
})

it.each(['bash', 'pwsh'])('rejects a recorded %s call in either the assistant message or tool event', (name) => {
  for (const record of [
    { type: 'tool/call', data: { name } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'tool-call', name }] } } },
  ]) expect(() => { requireShellFreeRecording(JSON.stringify(record)) }).toThrow()
})

it('requires explicit literal disables for both shell tools', () => {
  expect(() => { requireShellDisabled('- id: tool-bash\n  disabled: true\n') }).toThrow()
  expect(() => { requireShellDisabled('- id: tool-bash\n  disabled: true\n- id: tool-pwsh\n  disabled: false\n') }).toThrow()
})

it('does not treat ordinary message text mentioning a shell as a shell call', () => {
  const source = [
    { type: 'tool/call', data: { name: 'jubian_storyboard' } },
    { type: 'user/message', data: { message: { content: [{ type: 'text', text: 'Do not use bash or pwsh.' }] } } },
  ].map(record => JSON.stringify(record)).join('\n')
  expect(() => { requireShellFreeRecording(source) }).not.toThrow()
})
