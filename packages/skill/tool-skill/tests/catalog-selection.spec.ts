/** Source quotas preserve catalog order and keep omitted names available to directory queries. */
import { describe, expect, it } from 'vitest'
import type { SkillSummary } from '@deepseek-ai/dsh-skill'
import { needsCatalogSelection, selectCatalogSkills } from '../src/catalog-selection.ts'

function skill(name: string, source = 'muse-market', description = 'Review a scene.', whenToUse?: string): SkillSummary {
  return { name, source, description, provider: 'selection-fixture',
    invocation: { modelInvocable: true, userInvocable: true },
    ...(whenToUse === undefined ? {} : { whenToUse }) }
}

describe('bounded catalog summary selection', () => {
  it('preserves every original summary when no source exceeds its own limit', () => {
    const skills = [skill('first'), skill('second'), skill('third', 'custom')]
    const before = structuredClone(skills)
    expect(needsCatalogSelection(skills, {})).toBe(false)
    expect(needsCatalogSelection(skills, { 'muse-market': 2 })).toBe(false)
    for (const limits of [{}, { 'muse-market': 2 }]) {
      const selected = selectCatalogSkills(skills, limits, 'third', ['second'])
      expect(selected).toEqual(skills)
      selected.forEach((entry, index) => { expect(entry).toBe(skills[index]) })
    }
    expect(skills).toEqual(before)
  })

  it('caps only exact configured sources and preserves the final registry order', () => {
    const skills = [skill('global', 'custom'), skill('market-first'), skill('project-first', 'project-dsh'),
      skill('market-second'), skill('similar-source', 'muse-market-preview'), skill('project-second', 'project-dsh'),
      skill('market-third'), skill('tail', 'bundled')]
    const limits = { 'muse-market': 1, 'project-dsh': 1 }
    expect(needsCatalogSelection(skills, limits)).toBe(true)
    expect(selectCatalogSkills(skills, limits, '', ['market-third', 'project-second']).map(entry => entry.name))
      .toEqual(['global', 'similar-source', 'project-second', 'market-third', 'tail'])
    expect(skills.map(entry => entry.name)).toEqual(['global', 'market-first', 'project-first',
      'market-second', 'similar-source', 'project-second', 'market-third', 'tail'])
  })

  it('gives explicit names priority over lexical matches and ignores absent names', () => {
    const skills = [skill('camera-review', 'muse-market', 'Camera story review.'), skill('dialogue-review')]
    const selected = selectCatalogSkills(skills, { 'muse-market': 1 }, 'camera story', ['missing', 'dialogue-review'])
    expect(selected).toEqual([skills[1]])
    expect(selected[0]).toBe(skills[1])
  })

  it('matches normalized user terms against descriptions and routing hints without counting repeats', () => {
    const skills = [skill('camera-only', 'muse-market', 'Camera.'),
      skill('scene-review', 'muse-market', 'Story continuity.', 'Use for camera planning.')]
    expect(selectCatalogSkills(skills, { 'muse-market': 1 }, 'ＣＡＭＥＲＡ camera camera STORY', []))
      .toEqual([skills[1]])
    const chinese = [skill('sound-review', 'muse-market', '检查声音'), skill('picture-review', 'muse-market', '检查画面')]
    expect(selectCatalogSkills(chinese, { 'muse-market': 1 }, '画面', [])).toEqual([chinese[1]])
  })

  it('keeps previous displayed names on a tool-only continuation and refills missing names stably', () => {
    const skills = [skill('first'), skill('second'), skill('third'), skill('fourth')]
    expect(selectCatalogSkills(skills, { 'muse-market': 2 }, '', ['fourth', 'third']))
      .toEqual([skills[2], skills[3]])
    expect(selectCatalogSkills(skills, { 'muse-market': 2 }, '', ['removed', 'fourth']))
      .toEqual([skills[0], skills[3]])
  })

  it('uses original order for equal scores and detects only an actual quota overflow', () => {
    const skills = [skill('first'), skill('second'), skill('third')]
    expect(selectCatalogSkills(skills, { 'muse-market': 2 }, 'review scene', [])).toEqual(skills.slice(0, 2))
    expect(needsCatalogSelection(skills.slice(0, 2), { 'muse-market': 2 })).toBe(false)
    expect(needsCatalogSelection(skills, { 'muse-market': 2 })).toBe(true)
    expect(needsCatalogSelection([], { 'muse-market': 2 })).toBe(false)
    expect(selectCatalogSkills([], { 'muse-market': 2 }, 'review', ['first'])).toEqual([])
  })

  it('treats prototype property names as unconfigured sources unless they have an explicit own quota', () => {
    const skills = [skill('constructor-first', 'constructor'), skill('market-first'),
      skill('constructor-second', 'constructor'), skill('prototype-source', 'toString'), skill('market-second')]
    expect(selectCatalogSkills(skills, { 'muse-market': 1 }, '', []).map(entry => entry.name))
      .toEqual(['constructor-first', 'market-first', 'constructor-second', 'prototype-source'])
    expect(selectCatalogSkills(skills, { 'muse-market': 1, constructor: 1 }, '', []).map(entry => entry.name))
      .toEqual(['constructor-first', 'market-first', 'prototype-source'])
    expect(needsCatalogSelection(skills.filter(entry => entry.source !== 'muse-market'), { 'muse-market': 1 }))
      .toBe(false)
  })
})
