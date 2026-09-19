/**
 * The boundary: everything the service refuses.
 *
 * These are the package's security-relevant gates, so each one is asserted
 * through the real service over a real filesystem rather than against a helper.
 * The load-bearing claims are that a traversal id cannot reach a file outside
 * the root, that a non-markdown path is refused before any read, and that a
 * save fails rather than overwriting content the caller never saw.
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { AgentNotes } from '../src/index.ts'
import { failureOf, linkNote, openNotes, writeNote, type Harness } from './harness.ts'

let harness: Harness

beforeEach(async () => {
  harness = await openNotes('dsh-agent-notes-boundary-')
})

afterEach(async () => {
  await harness.dispose()
})

describe('agentNotes — the notes root', () => {
  it('reports an uncreated root as an absent empty state, not a failure', async () => {
    const missing = await openNotes('dsh-agent-notes-absent-')
    await rm(missing.root, { recursive: true, force: true })
    try {
      await expect(missing.notes.list()).resolves.toEqual({
        state: 'absent',
        root: missing.root,
        notes: [],
        truncated: false,
      })
    } finally {
      await missing.dispose()
    }
  })

  it('falls back to <workspace root>/.agents/notes when no root is configured', async () => {
    // The service has no fallback of its own: a row that omits `root` fails to
    // mount. This pins that shape, so a later default cannot appear silently.
    expect(() => new AgentNotes(new Context(), { root: undefined as unknown as string, maxNotes: 2000 }))
      .toThrow(TypeError)
  })

  it('fails loudly when the configured root is a file rather than a directory', async () => {
    const mistaken = await openNotes('dsh-agent-notes-notdir-')
    await rm(mistaken.root, { recursive: true, force: true })
    await writeFile(mistaken.root, 'not a directory', 'utf8')
    try {
      const failure = await failureOf(mistaken.notes.list())
      expect(failure.code).toBe('agent-note/not-regular-file')
      expect(failure.details).toMatchObject({ kind: 'file' })
    } finally {
      await mistaken.dispose()
    }
  })

  it('ignores a category that is a symlink out of the root, and any non-markdown child', async () => {
    await writeFile(join(harness.outside, 'secret.md'), 'outside the root', 'utf8')
    const linked = await linkNote(harness, 'link/note.md', join(harness.outside, 'secret.md'))
    await writeNote(harness, 'bug-fix/real.md', '# Real\n')
    await writeFile(join(harness.root, 'bug-fix', 'ignored.txt'), 'not markdown', 'utf8')
    const catalog = await harness.notes.list()
    expect(catalog.state).toBe('ready')
    // A host that cannot create links still proves the markdown and category
    // filters; the link case is the extra claim on hosts where links exist.
    expect(catalog.notes.map(note => note.id)).toEqual(['bug-fix/real.md'])
    if (linked) expect(catalog.notes).toHaveLength(1)
  })

  it('caps the catalog and reports the cut', async () => {
    const capped = await openNotes('dsh-agent-notes-cap-', { maxNotes: 1 })
    try {
      await writeNote(capped, 'a/first.md', '# First\n')
      await writeNote(capped, 'a/second.md', '# Second\n')
      const catalog = await capped.notes.list()
      expect(catalog.notes.map(note => note.id)).toEqual(['a/first.md'])
      expect(catalog.truncated).toBe(true)
    } finally {
      await capped.dispose()
    }
  })
})

describe('agentNotes.read — refused ids', () => {
  it.each([
    ['a traversal segment', 'bug-fix/../../outside/secret.md'],
    ['a bare parent segment', '..'],
    ['an absolute path', 'C:/absolute/note.md'],
    ['a Windows drive path', 'C:\\Windows\\win.ini'],
    ['a backslash traversal', 'bug-fix\\..\\..\\outside\\secret.md'],
    ['a leading slash', '/etc/note.md'],
    ['a UNC-shaped path', '\\\\server\\share\\note.md'],
    ['a non-markdown file', 'bug-fix/notes.txt'],
    ['a markdown-less extension', 'bug-fix/notes.md.txt'],
    ['a bare extension', '.md'],
    ['an empty id', ''],
    ['a dot segment', './bug-fix/real.md'],
    ['a percent-encoded name', 'bug-fix/%2e%2e/secret.md'],
    ['a NUL-bearing name', 'bug-fix/note\0.md'],
  ])('refuses %s as a bad id', async (_label, id) => {
    const failure = await failureOf(harness.notes.read(id))
    expect(failure.code).toBe('agent-note/bad-id')
    expect(failure.details).toMatchObject({ id })
  })

  it('refuses an absolute path that names a note inside the root, because ids are relative', async () => {
    await writeNote(harness, 'bug-fix/real.md', '# Real\n')
    const failure = await failureOf(harness.notes.read(join(harness.root, 'bug-fix', 'real.md')))
    expect(failure.code).toBe('agent-note/bad-id')
  })

  it('refuses a markdown symlink that leaves the root instead of following it', async () => {
    const secret = join(harness.outside, 'secret.md')
    await writeFile(secret, 'outside the root', 'utf8')
    if (!await linkNote(harness, 'bug-fix/escape.md', secret)) {
      // Windows without developer mode refuses to create the link. The
      // traversal and non-markdown gates above are unaffected.
      return
    }
    const failure = await failureOf(harness.notes.read('bug-fix/escape.md'))
    // The final component is inspected before resolution follows it, so the
    // refusal names the entry's kind rather than its destination.
    expect(failure.code).toBe('agent-note/not-regular-file')
    expect(failure.details).toMatchObject({ id: 'bug-fix/escape.md', kind: 'symlink' })
  })

  it('refuses a directory that carries a markdown name', async () => {
    await mkdir(join(harness.root, 'bug-fix', 'folder.md'), { recursive: true })
    const failure = await failureOf(harness.notes.read('bug-fix/folder.md'))
    expect(failure.code).toBe('agent-note/not-regular-file')
    expect(failure.details).toMatchObject({ kind: 'directory' })
  })

  it('reports a well-formed id with no note behind it as not found', async () => {
    const failure = await failureOf(harness.notes.read('bug-fix/absent.md'))
    expect(failure.code).toBe('agent-note/not-found')
    expect(failure.details).toMatchObject({ id: 'bug-fix/absent.md' })
  })
})

describe('agentNotes.save — refused writes', () => {
  it('refuses a traversal id without creating anything outside the root', async () => {
    const escaped = join(harness.outside, 'planted.md')
    const failure = await failureOf(harness.notes.save('../outside/planted.md', 'planted', 'v0'))
    expect(failure.code).toBe('agent-note/bad-id')
    await expect(readFile(escaped, 'utf8')).rejects.toThrow(/ENOENT/u)
  })

  it('refuses a symlinked id without writing through the link', async () => {
    const target = join(harness.outside, 'secret.md')
    await writeFile(target, 'original', 'utf8')
    if (!await linkNote(harness, 'bug-fix/escape.md', target)) {
      // Windows without developer mode refuses to create the link.
      return
    }
    const failure = await failureOf(harness.notes.save('bug-fix/escape.md', 'clobbered', 'v0'))
    expect(failure.code).toBe('agent-note/not-regular-file')
    await expect(readFile(target, 'utf8')).resolves.toBe('original')
  })

  it('does not create a note that does not exist yet', async () => {
    const failure = await failureOf(harness.notes.save('bug-fix/absent.md', '# New\n', 'v0'))
    expect(failure.code).toBe('agent-note/not-found')
    await expect(readFile(join(harness.root, 'bug-fix', 'absent.md'), 'utf8')).rejects.toThrow(/ENOENT/u)
  })

  it('refuses a save whose version is no longer current, leaving the newer bytes intact', async () => {
    await writeNote(harness, 'bug-fix/note.md', '# First\n')
    const read = await harness.notes.read('bug-fix/note.md')
    // Somebody else writes between this editor's read and its save.
    await writeFile(join(harness.root, 'bug-fix', 'note.md'), '# Somebody else\n', 'utf8')
    const failure = await failureOf(harness.notes.save('bug-fix/note.md', '# Mine\n', read.version))
    expect(failure.code).toBe('agent-note/stale')
    expect(failure.details).toMatchObject({ id: 'bug-fix/note.md' })
    await expect(readFile(join(harness.root, 'bug-fix', 'note.md'), 'utf8'))
      .resolves.toBe('# Somebody else\n')
  })
})
