/**
 * REAL-composition coverage: a test-only `cordis.yml` booted through the
 * vendored Loader, resolving this package by its bare published name and
 * mounting it as an ordinary row.
 *
 * The composition owns a real directory tree on disk. Only the Loader's module
 * resolver is substituted — `ctx.loader.internal` is a module map here, so the
 * Loader resolves nothing through Node (the convention this repository's
 * in-process Loader specs share) — while the filesystem backend, the service,
 * and the notes themselves are all real. What the test asserts is durable,
 * user-visible output: text that a person edited in the Settings section is on
 * disk afterwards, and it is still there after a cold reboot.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { remoteMethods, remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import AgentNotesService from '../src/index.ts'

/** A complete Agent Note as the repository's own convention writes one. */
const NOTE = [
  '# Agent Note: Capability seams',
  '',
  'Status: implemented',
  '',
  '## Problem',
  '',
  'One service had four consumers.',
  '',
].join('\n')

let root: string | undefined
const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/**
 * Boot one composition through the real Loader.
 * @param configPath - absolute path of the `cordis.yml` to include.
 * @returns the booted root context, every row active.
 */
async function loadComposition(configPath: string): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  ctx.baseUrl = pathToFileURL(root as string).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-fs-local', LocalFileSystem],
    ['@deepseek-ai/dsh-api-agent-notes', AgentNotesService],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await ctx.loader.await()
  const unloaded = [...ctx.loader.entries()]
    .filter(entry => entry.fiber === undefined && !entry.disabled)
    .map(entry => entry.options.name)
  expect(unloaded).toEqual([])
  return ctx
}

describe('agent notes through a real Loader composition', () => {
  it('lists, reads, and edits the configured tree across a cold reboot', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-agent-notes-loader-'))
    const notesRoot = join(root, 'notes')
    await mkdir(join(notesRoot, 'implemented', 'architecture'), { recursive: true })
    await mkdir(join(notesRoot, 'bug-fix'), { recursive: true })
    await writeFile(join(notesRoot, 'implemented', 'architecture', '2026-06-13-capability-seams.md'), NOTE, 'utf8')
    await writeFile(join(notesRoot, 'bug-fix', '2026-01-02-a-defect.md'), '# Agent Note: A defect\n', 'utf8')
    // A non-markdown sibling, to prove the catalog filters rather than trusting the tree.
    await writeFile(join(notesRoot, 'bug-fix', 'README.txt'), 'not a note', 'utf8')
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      "- name: '@deepseek-ai/dsh-fs-local'",
      '  config:',
      `    cwd: ${JSON.stringify(root)}`,
      "- name: '@deepseek-ai/dsh-api-agent-notes'",
      '  config:',
      `    root: ${JSON.stringify(notesRoot)}`,
      '',
    ].join('\n'))

    const first = await loadComposition(configPath)

    // The row published the service under its own name and namespace, and the
    // generated Host contract carries exactly the three Remote endpoints.
    expect(first.agentNotes.typertRemote).toMatchObject({ serviceKey: 'agentNotes', namespace: 'agentNotes' })
    expect(remoteMethods(first.agentNotes).map(marker => marker.method)).toEqual(['list', 'read', 'save'])

    const catalog = await first.agentNotes.list()
    expect(catalog).toMatchObject({ state: 'ready', root: notesRoot, truncated: false })
    // Ordered by category, then by title, with the non-markdown sibling absent.
    expect(catalog.notes.map(({ id, category, title, status, summary }) => ({ id, category, title, status, summary })))
      .toEqual([
        { id: 'bug-fix/2026-01-02-a-defect.md', category: 'bug-fix', title: 'A defect' },
        {
          id: 'implemented/architecture/2026-06-13-capability-seams.md',
          category: 'implemented',
          title: 'Capability seams',
          status: 'implemented',
          summary: 'One service had four consumers.',
        },
      ].map(row => ({ status: undefined, summary: undefined, ...row })))
    // The last-modification time comes from the note's own file, so the section
    // can order rows by recency without a Host-side index.
    for (const note of catalog.notes) expect(note.modifiedMs).toBeGreaterThan(0)

    const id = 'implemented/architecture/2026-06-13-capability-seams.md'
    const opened = await first.agentNotes.read(id)
    expect(opened).toMatchObject({ id, title: 'Capability seams', status: 'implemented', text: NOTE })
    expect(opened.bytes).toBe(Buffer.byteLength(NOTE, 'utf8'))

    // A save written against the version this read returned is accepted, and
    // the bytes that land on disk are the caller's.
    const edited = `${NOTE}\n## Consequences\n\nReads are bounded.\n`
    const saved = await first.agentNotes.save(id, edited, opened.version)
    expect(saved).toMatchObject({ id })
    await expect(readFile(join(notesRoot, 'implemented', 'architecture', '2026-06-13-capability-seams.md'), 'utf8'))
      .resolves.toBe(edited)

    // The tree is Host-owned state, so it must survive the process that served
    // it: a cold reboot of the same composition reads the edit back.
    await first.fiber.dispose()
    contexts.splice(contexts.indexOf(first), 1)

    const second = await loadComposition(configPath)
    const cold = await second.agentNotes.read(id)
    expect(cold.text).toBe(edited)
    expect(cold.version).not.toBe(opened.version)
    // The edited note re-lists under its new version, so the Settings section
    // never shows a row whose version the next save would refuse.
    expect((await second.agentNotes.list()).notes.find(note => note.id === id))
      .toMatchObject({ title: 'Capability seams', status: 'implemented' })
  })

  it('refuses a traversal id at the composition boundary, leaving the tree untouched', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-agent-notes-loader-escape-'))
    const notesRoot = join(root, 'notes')
    await mkdir(join(notesRoot, 'bug-fix'), { recursive: true })
    const sibling = join(root, 'secret.md')
    await writeFile(sibling, 'not part of the notes tree', 'utf8')
    await writeFile(join(notesRoot, 'bug-fix', 'note.md'), '# A note\n', 'utf8')
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      "- name: '@deepseek-ai/dsh-fs-local'",
      '  config:',
      `    cwd: ${JSON.stringify(root)}`,
      "- name: '@deepseek-ai/dsh-api-agent-notes'",
      '  config:',
      `    root: ${JSON.stringify(notesRoot)}`,
      '',
    ].join('\n'))

    const ctx = await loadComposition(configPath)
    const readFailure = await ctx.agentNotes.read('../secret.md').catch((error: unknown) => error)
    expect(remoteErrorOf(readFailure)).toMatchObject({ code: 'agent-note/bad-id' })
    const saveFailure = await ctx.agentNotes.save('../secret.md', 'clobbered', 'v0').catch((error: unknown) => error)
    expect(remoteErrorOf(saveFailure)).toMatchObject({ code: 'agent-note/bad-id' })
    // The refused save reached nothing: the sibling outside the root is intact.
    await expect(readFile(sibling, 'utf8')).resolves.toBe('not part of the notes tree')
  })
})
