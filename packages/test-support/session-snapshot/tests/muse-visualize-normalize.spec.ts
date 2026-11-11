import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { expect, it } from 'vitest'
import { normalizeVisualizeHomePaths } from '../../../../snapshots/session/muse-visualize/normalize.ts'

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-visualize-normalize-')))
  const home = join(root, 'home')
  const cwd = join(home, 'run')
  const session = 'same-session'
  const ownedRoot = join(cwd, '.dsh', 'visualize', 'sessions', session)
  const card = join(ownedRoot, 'visualization-315b444e.whale.html')
  await mkdir(ownedRoot, { recursive: true })
  await writeFile(card, 'V2')
  const display = `~${card.slice(home.length)}`
  const normalized = `${cwd}/.dsh/visualize/sessions/${session}/visualization-315b444e.whale.html`
  const rows = (metadataPath = display) => [
    { type: 'session', version: 4, id: session, cwd },
    { type: 'tool/call', data: { name: 'visualize', callId: 'create', arguments: '{}' } },
    { type: 'tool/result', data: { message: { toolCallId: 'create', content: [{ type: 'text', text: `Rendered (saved copy at ${display}). Prefix ${display}.backup remains literal.` }] },
      meta: { kind: 'visualize', path: metadataPath, fragment: 'V1' } } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'tool-call', name: 'visualize', id: 'update', arguments: JSON.stringify({ path: display }) }] } } },
    { type: 'tool/call', data: { name: 'visualize', callId: 'update', arguments: JSON.stringify({ path: display }) } },
    { type: 'tool/result', data: { message: { toolCallId: 'update', content: [{ type: 'text', text: `Patched (updated card at ${display}).` }] },
      meta: { kind: 'visualize', path: metadataPath, fragment: 'V2' } } },
    { type: 'user/message', data: { content: [{ type: 'text', text: display }] } },
    { type: 'tool/result', data: { message: { toolCallId: 'unrelated', content: [{ type: 'text', text: display }] } } },
  ]
  const log = (metadataPath?: string) => rows(metadataPath).map(row => JSON.stringify(row)).join('\n') + '\n'
  return { root, home, cwd, card, ownedRoot, display, normalized, log,
    async [Symbol.asyncDispose]() { await rm(root, { recursive: true, force: true }) } }
}

it.each(['display', 'absolute'])('normalizes verified HOME display paths with %s metadata and preserves unrelated text', async (kind) => {
  await using f = await fixture()
  const output = await normalizeVisualizeHomePaths(f.log(kind === 'absolute' ? f.card : f.display), f.home, f.cwd)
  const rows = output.trim().split('\n').map(line => JSON.parse(line) as { data?: { arguments?: string; message?: { content: { text?: string; arguments?: string }[] }; meta?: { path: string } } })
  expect(rows[2]?.data?.meta?.path).toBe(f.normalized)
  expect(rows[2]?.data?.message?.content[0]?.text).toBe(`Rendered (saved copy at ${f.normalized}). Prefix ${f.display}.backup remains literal.`)
  expect(JSON.parse(rows[3]?.data?.message?.content[0]?.arguments ?? '{}')).toEqual({ path: f.normalized })
  expect(JSON.parse(rows[4]?.data?.arguments ?? '{}')).toEqual({ path: f.normalized })
  expect(rows[5]?.data?.message?.content[0]?.text).toBe(`Patched (updated card at ${f.normalized}).`)
  expect(output.split('\n')[6]).toBe(f.log().split('\n')[6])
  expect(rows[7]?.data?.message?.content[0]?.text).toBe(f.display)
  expect(await readFile(f.card, 'utf8')).toBe('V2')
})

it('recognizes native tool-result framing and mixed path separators', async () => {
  await using f = await fixture()
  const rows = f.log(f.display.replaceAll('\\', '/')).trim().split('\n').map(line => JSON.parse(line) as {
    type: string
    data?: { message?: { toolCallId?: string; role?: string; source?: object; content: unknown[] } }
  })
  for (const row of rows) {
    if (row.type !== 'tool/result' || row.data?.message?.toolCallId === undefined) continue
    const { toolCallId, content } = row.data.message
    row.data.message = { role: 'user', source: { kind: 'tool', callId: toolCallId },
      content: [{ type: 'tool-result', toolCallId, isError: false, content }] }
  }
  const output = await normalizeVisualizeHomePaths(rows.map(row => JSON.stringify(row)).join('\n') + '\n', f.home, f.cwd)
  expect(JSON.parse(output.split('\n')[2] ?? '{}')).toMatchObject({ data: {
    meta: { path: f.normalized }, message: { content: [{ content: [{ text: `Rendered (saved copy at ${f.normalized}). Prefix ${f.display}.backup remains literal.` }] }] },
  } })
})

it.each(['different-session', 'similar-workspace', 'similar-home'])('does not normalize an unowned %s path', async (kind) => {
  await using f = await fixture()
  const foreign = kind === 'different-session' ? f.display.replace('same-session', 'different-session')
    : kind === 'similar-workspace' ? f.display.replace(`${sep}run${sep}`, `${sep}run-other${sep}`)
      : join(f.home + '-other', 'run', '.dsh', 'visualize', 'sessions', 'same-session', 'visualization-315b444e.whale.html')
  if (kind === 'similar-home') {
    await mkdir(dirname(foreign), { recursive: true })
    await writeFile(foreign, 'V2')
  }
  const log = f.log(foreign)
  expect(await normalizeVisualizeHomePaths(log, f.home, f.cwd)).toBe(log)
})

it('normalizes a workspace alias only after proving its filesystem identity', async () => {
  await using f = await fixture()
  const parent = join(f.root, 'alias')
  const alias = join(parent, 'run')
  await mkdir(parent)
  await symlink(f.cwd, alias, process.platform === 'win32' ? 'junction' : 'dir')
  const path = join(alias, '.dsh', 'visualize', 'sessions', 'same-session', 'visualization-315b444e.whale.html')
  const output = await normalizeVisualizeHomePaths(f.log(path), f.home, f.cwd)
  expect(JSON.parse(output.split('\n')[2] ?? '{}')).toMatchObject({ data: { meta: { path: f.normalized } } })
})

it('refuses stale metadata instead of hiding a changed saved file', async () => {
  await using f = await fixture()
  await writeFile(f.card, 'unexpected bytes')
  await expect(normalizeVisualizeHomePaths(f.log(), f.home, f.cwd)).rejects.toThrow('Saved visualization must match its final metadata')
})

it('refuses a private card whose directory resolves outside this workspace', async () => {
  await using f = await fixture()
  const outside = join(f.root, 'outside')
  await mkdir(outside)
  await writeFile(join(outside, 'visualization-315b444e.whale.html'), 'V2')
  await rm(f.ownedRoot, { recursive: true })
  await symlink(outside, f.ownedRoot, process.platform === 'win32' ? 'junction' : 'dir')
  await expect(normalizeVisualizeHomePaths(f.log(), f.home, f.cwd)).rejects.toThrow('Visualization card must retain its workspace and Session identity')
})

it('refuses a Session from another allocated workspace', async () => {
  await using f = await fixture()
  const other = join(f.home, 'other')
  await mkdir(other)
  await expect(normalizeVisualizeHomePaths(f.log(), f.home, other)).rejects.toThrow('Visualization Session must belong to this test workspace')
})
