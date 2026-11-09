/** Complete directory pages expose metadata only and refuse stale or foreign continuation facts. */
import { describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SkillDefinition, SkillSummary } from '@deepseek-ai/dsh-skill'
import { pageSkillCatalog, SkillCatalogError } from '../src/catalog-directory.ts'
import type { SkillCatalogCursor, SkillCatalogPage } from '../src/catalog-directory.ts'

const sessionId = SessionId('catalog-directory-session')
function skill(name: string, description = 'Review a scene.', whenToUse?: string): SkillSummary {
  return { name, source: 'muse-market', description, provider: 'directory-fixture',
    invocation: { modelInvocable: true, userInvocable: true },
    ...(whenToUse === undefined ? {} : { whenToUse }) }
}

function cursorOf(page: SkillCatalogPage): SkillCatalogCursor {
  if (page.nextCursor === undefined) throw new Error('Expected a continuation')
  return page.nextCursor
}

describe('complete metadata directory pages', () => {
  it('uses returned cursors to visit every entry exactly once while allowing a changed page size', () => {
    const skills = ['first', 'second', 'third', 'fourth', 'fifth'].map(name => skill(name))
    const first = pageSkillCatalog(sessionId, skills, {}, 2)
    expect(first.entries.map(entry => entry.name)).toEqual(['first', 'second'])
    expect(first).toMatchObject({ totalMatched: 5, catalogComplete: true,
      nextCursor: { version: 1, sessionId, query: '', offset: 2 } })
    const second = pageSkillCatalog(sessionId, skills, { cursor: cursorOf(first), limit: 1 }, 2)
    expect(second.entries.map(entry => entry.name)).toEqual(['third'])
    const last = pageSkillCatalog(sessionId, skills, { cursor: cursorOf(second) }, 2)
    expect(last.entries.map(entry => entry.name)).toEqual(['fourth', 'fifth'])
    expect(last.nextCursor).toBeUndefined()
    expect([...first.entries, ...second.entries, ...last.entries].map(entry => entry.name))
      .toEqual(skills.map(entry => entry.name))
    for (const page of [first, second, last]) {
      expect(page.totalMatched).toBe(5)
      expect(page.catalogComplete).toBe(true)
    }
  })

  it('excludes instruction bodies, private paths, resource locations and provider details from returned metadata', () => {
    const entry: SkillDefinition = { ...skill('private-source', 'Useful public summary.', 'For continuity review.'),
      path: '/fixture/private/SKILL.md', resourceBase: { kind: 'directory', path: '/fixture/private' },
      content: 'Private instruction body.', metadata: { internal: 'Private metadata.' } }
    const page = pageSkillCatalog(sessionId, [entry], {}, 20)
    expect(page).toEqual({ entries: [{ name: 'private-source', description: 'Useful public summary.',
      source: 'muse-market', whenToUse: 'For continuity review.' }], totalMatched: 1, catalogComplete: true })
    expect(entry.content).toBe('Private instruction body.')
  })

  it('normalizes query text and searches names, descriptions and routing hints', () => {
    const skills = [skill('camera-story'), skill('dialogue', 'Camera story continuity.'),
      skill('third', 'Review a scene.', 'For camera story review.'), skill('unrelated')]
    const first = pageSkillCatalog(sessionId, skills, { query: '  ＣＡＭＥＲＡ   STORY\n', limit: 1 }, 20)
    expect(first.entries.map(entry => entry.name)).toEqual(['dialogue'])
    expect(first.nextCursor?.query).toBe('camera story')
    const second = pageSkillCatalog(sessionId, skills, { cursor: cursorOf(first) }, 20)
    expect(second.entries.map(entry => entry.name)).toEqual(['third'])
    expect(second.nextCursor).toBeUndefined()
    expect(pageSkillCatalog(sessionId, skills, { query: 'camera-story' }, 20).entries.map(entry => entry.name))
      .toEqual(['camera-story'])
  })

  it('returns a complete empty result for no matches and empty directories', () => {
    const empty = { entries: [], totalMatched: 0, catalogComplete: true }
    expect(pageSkillCatalog(sessionId, [skill('first')], { query: 'no-match' }, 20)).toEqual(empty)
    expect(pageSkillCatalog(sessionId, [], {}, 20)).toEqual(empty)
  })

  it('keeps Session identity transparent and refuses a cursor from another Session', () => {
    const skills = [skill('first'), skill('second')]
    const first = pageSkillCatalog(sessionId, skills, {}, 1)
    const otherId = SessionId('catalog-directory-other-session')
    const other = pageSkillCatalog(otherId, skills, {}, 1)
    expect(first.nextCursor?.sessionId).toBe(sessionId)
    expect(other.nextCursor?.sessionId).toBe(otherId)
    expect(first.nextCursor?.digest).toBe(other.nextCursor?.digest)
    expect(() => pageSkillCatalog(otherId, skills, { cursor: cursorOf(first) }, 1))
      .toThrow(expect.objectContaining({ code: 'SKILL_CATALOG_FOREIGN_CURSOR' }))
  })

  it('refuses changed directory facts and changed queries without restarting the page silently', () => {
    const first = skill('first'), second = skill('second'), skills = [first, second]
    const cursor = pageSkillCatalog(sessionId, skills, {}, 1).nextCursor
    if (cursor === undefined) throw new Error('Expected a continuation')
    const changes = [
      [...skills, skill('third')],
      [first],
      [{ ...first, name: 'renamed' }, second],
      [{ ...first, description: 'Changed summary.' }, second],
      [{ ...first, whenToUse: 'Changed routing hint.' }, second],
      [{ ...first, source: 'custom' }, second],
      [{ ...first, invocation: { modelInvocable: true, userInvocable: false } }, second],
      [...skills].reverse(),
    ]
    for (const changed of changes) {
      expect(() => pageSkillCatalog(sessionId, changed, { cursor }, 1))
        .toThrow(expect.objectContaining({ code: 'SKILL_CATALOG_STALE_CURSOR' }))
    }
    expect(() => pageSkillCatalog(sessionId, skills, { cursor, query: 'first' }, 1))
      .toThrow(expect.objectContaining({ code: 'SKILL_CATALOG_STALE_CURSOR' }))
  })

  it('refuses offsets beyond the observed directory and treats its exact end as an empty complete page', () => {
    const skills = [skill('first'), skill('second')]
    const cursor = pageSkillCatalog(sessionId, skills, {}, 1).nextCursor
    if (cursor === undefined) throw new Error('Expected a continuation')
    expect(() => pageSkillCatalog(sessionId, skills, { cursor: { ...cursor, offset: 3 } }, 1))
      .toThrow(SkillCatalogError)
    expect(pageSkillCatalog(sessionId, skills, { cursor: { ...cursor, offset: 2 } }, 1))
      .toEqual({ entries: [], totalMatched: 2, catalogComplete: true })
  })

  it.each([0, 1.5, 101])('refuses a JSON page limit outside the supported integer range: %s', (limit) => {
    expect(() => pageSkillCatalog(sessionId, [skill('first')], { limit }, 20))
      .toThrow(expect.objectContaining({ code: 'SKILL_CATALOG_INVALID_REQUEST' }))
  })

  it('bounds both the received query and its normalized continuation text', () => {
    for (const query of ['x'.repeat(1025), '\uFB03'.repeat(400)]) {
      expect(() => pageSkillCatalog(sessionId, [], { query }, 20))
        .toThrow(expect.objectContaining({ code: 'SKILL_CATALOG_INVALID_REQUEST' }))
    }
  })

  it('refuses malformed continuation values before selecting a page', () => {
    const skills = [skill('first'), skill('second')]
    const cursor = pageSkillCatalog(sessionId, skills, {}, 1).nextCursor
    if (cursor === undefined) throw new Error('Expected a continuation')
    for (const changed of [
      { ...cursor, digest: 'invalid-digest' },
      { ...cursor, offset: -1 },
      { ...cursor, offset: 0.5 },
      { ...cursor, query: '  Unnormalized  ' },
    ]) {
      expect(() => pageSkillCatalog(sessionId, skills, { cursor: changed }, 1))
        .toThrow(expect.objectContaining({ code: 'SKILL_CATALOG_INVALID_REQUEST' }))
    }
  })
})
