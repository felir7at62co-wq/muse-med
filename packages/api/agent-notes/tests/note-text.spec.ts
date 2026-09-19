/**
 * Note headline parsing over real Agent Note shapes.
 *
 * The parsing is what makes an edited note re-list correctly without a sidecar
 * index, so these cases pin the precedence the catalog depends on: the Agent
 * Note heading before any other heading, front matter before the body status
 * line, and a graceful fall back to the file stem for a note outside the
 * repository's convention.
 */
import { describe, expect, it } from 'vitest'
import { noteIdSegments, noteStem, readHeadline } from '../src/note-text.ts'

describe('readHeadline', () => {
  it('reads the Agent Note heading, its status line, and the first prose line', () => {
    const text = [
      '# Agent Note: Capability seams',
      '',
      'Status: implemented',
      '',
      '## Problem',
      '',
      'One service had four consumers.',
      '',
    ].join('\n')
    expect(readHeadline('2026-06-13-capability-seams', text)).toEqual({
      title: 'Capability seams',
      status: 'implemented',
      summary: 'One service had four consumers.',
    })
  })

  it('prefers front matter over the body for status and description', () => {
    const text = [
      '---',
      'status: proposed',
      'description: "Package map for the api group."',
      'kind: "package-group"',
      '---',
      '',
      '# api/ — Remote API layers',
      '',
      'Status: implemented',
      '',
      'Body first line.',
      '',
    ].join('\n')
    // Front matter is the note's own declaration and wins over a body status
    // line, so a note whose header was edited without its front matter still
    // reports the authoritative value.
    expect(readHeadline('api-readme', text)).toEqual({
      title: 'api/ — Remote API layers',
      status: 'proposed',
      summary: 'Package map for the api group.',
    })
  })

  it('falls back to the body status line when front matter carries none', () => {
    const text = [
      '---',
      'kind: "package-group"',
      '---',
      '',
      '# Agent Note: A title',
      '',
      'Status: implemented',
      '',
      'Body.',
      '',
    ].join('\n')
    expect(readHeadline('stem', text)).toMatchObject({ title: 'A title', status: 'implemented' })
  })

  it('reads a front matter status when the body carries none', () => {
    const text = '---\nstatus: proposed\n---\n\n# A proposal\n'
    expect(readHeadline('proposal', text)).toMatchObject({ status: 'proposed' })
  })

  it('falls back to the file stem when the note declares no title', () => {
    const text = 'Just prose, with no heading at all.\n'
    expect(readHeadline('bare-note', text)).toEqual({
      title: 'bare-note',
      status: undefined,
      summary: 'Just prose, with no heading at all.',
    })
  })

  it('treats an unterminated front matter fence as body text', () => {
    const text = '---\nstatus: implemented\n\n# Still the body\n'
    expect(readHeadline('unterminated', text).title).toBe('Still the body')
  })

  it('skips headings, fences, list markers, and quotes when looking for prose', () => {
    const text = [
      '# Title',
      '',
      '## Problem',
      '',
      '> a quotation',
      '',
      '- a list item',
      '',
      '```ts',
      'const x = 1',
      '```',
      '',
      'The actual first sentence.',
      '',
    ].join('\n')
    expect(readHeadline('stem', text).summary).toBe('The actual first sentence.')
  })

  it('normalizes CRLF notes', () => {
    const text = '# Agent Note: Windows\r\n\r\nStatus: implemented\r\n\r\nBody.\r\n'
    expect(readHeadline('crlf', text)).toEqual({
      title: 'Windows',
      status: 'implemented',
      summary: 'Body.',
    })
  })

  it('reports no status and no summary for an empty note, keeping the stem', () => {
    expect(readHeadline('empty', '')).toEqual({
      title: 'empty',
      status: undefined,
      summary: undefined,
    })
  })

  it('unquotes a front matter value and ignores an entry with an empty value', () => {
    const text = "---\ntitle: 'Quoted title'\ndescription:\n---\n\n# Heading\n"
    expect(readHeadline('stem', text)).toEqual({
      title: 'Quoted title',
      status: undefined,
      summary: undefined,
    })
  })

  it('ignores a front matter line that is not a simple scalar entry', () => {
    const text = '---\n- a list entry\nstatus: implemented\n---\n\n# Heading\n'
    expect(readHeadline('stem', text).status).toBe('implemented')
  })

  it('accepts an Agent Note heading with no other body content', () => {
    expect(readHeadline('stem', '# Agent Note: Only a title')).toEqual({
      title: 'Only a title',
      status: undefined,
      summary: undefined,
    })
  })
})

describe('noteIdSegments', () => {
  it.each([
    'a.md',
    'bug-fix/2026-01-01-a.md',
    'implemented/architecture/2026-06-13-capability-seams.md',
    'a/b/c/D.E.F.MD',
    'under_score/with-dash/and.dot.md',
  ])('accepts %s', (id) => {
    expect(noteIdSegments(id)).toBeDefined()
  })

  it.each([
    ['', 'empty'],
    ['..', 'parent'],
    ['a/../b.md', 'traversal'],
    ['/a.md', 'absolute'],
    ['C:/a.md', 'drive'],
    ['a\\b.md', 'traversal with backslashes'],
    ['a.txt', 'wrong extension'],
    ['a.md.txt', 'trailing extension'],
    ['a/.md', 'empty stem'],
    ['a/./b.md', 'dot segment'],
    ['a//b.md', 'empty segment'],
    ['a/%2e%2e/b.md', 'percent escape'],
    ['a/b\u0000.md', 'NUL'],
    ['a/b!.md', 'punctuation outside the grammar'],
    ['a/ b.md', 'space'],
    ['a/子.md', 'non-ASCII segment'],
  ])('refuses %s (%s)', (id) => {
    expect(noteIdSegments(id)).toBeUndefined()
  })

  it('normalizes a Windows separator into segments rather than one literal name', () => {
    expect(noteIdSegments('a\\b.md')).toBeUndefined()
    expect(noteIdSegments('category\\note.md')).toBeUndefined()
  })
})

describe('noteStem', () => {
  it('drops the directory and the extension', () => {
    expect(noteStem('implemented/architecture/2026-06-13-capability-seams.md')).toBe('2026-06-13-capability-seams')
    expect(noteStem('plain.md')).toBe('plain')
  })
})
