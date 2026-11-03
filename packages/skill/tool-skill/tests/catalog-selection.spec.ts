import { describe, expect, it } from 'vitest'
import { createAssistantMessage, createUserMessage, type Message, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { SkillSummary } from '@deepseek-ai/dsh-skill'
import { invokedSkillNames, selectCatalogSkills } from '../src/catalog-selection.ts'

function skill(name: string, description = name, source = 'muse-market'): SkillSummary {
  return {
    name, description, source, provider: 'fixture',
    invocation: { modelInvocable: true, userInvocable: true },
  }
}

function user(text: string): UserMessage {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

function injected(text: string): UserMessage {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'system-prompt' } })
}

function names(skills: readonly SkillSummary[]): string[] {
  return skills.map(entry => entry.name)
}

describe('source-bounded catalog selection', () => {
  it('selects three relevant summaries from one hundred market skills', () => {
    const skills = Array.from({ length: 100 }, (_, index) => skill(`market-${index}`, `Topic ${index}`))
    skills[71] = skill('word-export', 'Create Word documents')
    skills[83] = skill('word-layout', 'Layout Word documents')
    skills[96] = skill('word-review', 'Review Word documents')
    const selected = selectCatalogSkills(skills, [user('Word documents')], [], { 'muse-market': 3 })
    expect(names(selected)).toEqual(['word-export', 'word-layout', 'word-review'])
    expect(selected[0]).toBe(skills[71])
  })

  it('keeps every other source and its original interleaved position', () => {
    const skills = [
      skill('native-a', 'Native', 'bundled'), skill('market-a'),
      skill('native-b', 'Native', 'runtime'), skill('market-b', 'Word'),
      skill('native-c', 'Native', 'custom'), skill('market-c'),
    ]
    expect(names(selectCatalogSkills(skills, [user('Word')], [], { 'muse-market': 1 })))
      .toEqual(['native-a', 'native-b', 'market-b', 'native-c'])
  })

  it('prioritizes explicit names over lexical relevance without capping invocation bodies', () => {
    const skills = [skill('word-a', 'Word'), skill('word-b', 'Word'), skill('draw', 'Draw')]
    const messages = [user('/draw Word')]
    expect(names(selectCatalogSkills(skills, messages, [], { 'muse-market': 1 }))).toEqual(['draw'])
    expect(invokedSkillNames(messages)).toEqual(['draw'])
    expect(invokedSkillNames([user('/word-a /word-b /draw')])).toEqual(['word-a', 'word-b', 'draw'])
  })

  it('retains input order when multiple explicit choices exceed the advertised limit', () => {
    const skills = [skill('alpha'), skill('beta'), skill('gamma')]
    expect(names(selectCatalogSkills(skills, [user('/gamma /beta')], [], { 'muse-market': 1 })))
      .toEqual(['beta'])
    expect(invokedSkillNames([user('/gamma /beta')])).toEqual(['gamma', 'beta'])
  })

  it('ignores context injections and assistant text as ranking or gesture intent', () => {
    const skills = [skill('draw', 'Drawing'), skill('word', 'Word')]
    const history: Message[] = [user('Word'), injected('/draw Drawing'), createAssistantMessage({
      content: [{ type: 'text', text: '/draw Drawing' }],
      source: { provider: 'fixture', model: 'fixture' },
    })]
    expect(names(selectCatalogSkills(skills, [injected('/draw Drawing')], history, { 'muse-market': 1 })))
      .toEqual(['word'])
    expect(invokedSkillNames([injected('/draw')])).toEqual([])
  })

  it('reuses the latest committed direct user intent for tool continuations and a fresh caller', () => {
    const skills = [skill('draw', 'Drawing'), skill('word', 'Word')]
    const prompt = user('Word')
    const first = selectCatalogSkills(skills, [prompt], [], { 'muse-market': 1 })
    const history: Message[] = [user('Drawing'), prompt, injected('Drawing')]
    expect(selectCatalogSkills(skills, [], history, { 'muse-market': 1 })).toEqual(first)
    expect(selectCatalogSkills([...skills], [], [...history], { 'muse-market': 1 })).toEqual(first)
  })

  it('uses the latest accepted user message and preserves its selection on continuation', () => {
    const skills = [skill('draw'), skill('word'), skill('excel')]
    const messages = [user('word'), user('excel')]
    const history = [user('/draw'), ...messages, injected('word')]
    const selected = selectCatalogSkills(skills, messages, [user('/draw')], { 'muse-market': 1 })
    expect(names(selected)).toEqual(['excel'])
    expect(selectCatalogSkills(skills, [], history, { 'muse-market': 1 })).toEqual(selected)
  })

  it('does not treat catalog ranking as the explicit invocation list for a multi-user batch', () => {
    const skills = [skill('draw'), skill('word')]
    const messages = [user('/draw'), user('word')]
    expect(names(selectCatalogSkills(skills, messages, [], { 'muse-market': 1 }))).toEqual(['word'])
    expect(invokedSkillNames(messages)).toEqual(['draw'])
    expect(selectCatalogSkills(skills, [], messages, { 'muse-market': 1 }))
      .toEqual(selectCatalogSkills(skills, messages, [], { 'muse-market': 1 }))
  })

  it('does not fall back to old user intent for an empty current direct user message', () => {
    const skills = [skill('alpha'), skill('word')]
    expect(names(selectCatalogSkills(skills, [user('')], [user('/word')], { 'muse-market': 1 })))
      .toEqual(['alpha'])
  })

  it('preserves published names on continuation even when only older user intent remains visible', () => {
    const skills = [skill('alpha'), skill('word'), skill('excel')]
    expect(names(selectCatalogSkills(skills, [], [user('excel')], { 'muse-market': 1 }, ['word'])))
      .toEqual(['word'])
    expect(names(selectCatalogSkills(skills, [user('excel')], [], { 'muse-market': 1 }, ['word'])))
      .toEqual(['excel'])
    expect(names(selectCatalogSkills(skills, [user('')], [], { 'muse-market': 1 }, ['word'])))
      .toEqual(['alpha'])
  })

  it('retains only permitted current candidates and fills vacated slots in stable order', () => {
    const skills = [skill('alpha'), skill('word'), skill('excel')]
    expect(names(selectCatalogSkills(skills, [], [], { 'muse-market': 2 }, ['removed', 'word'])))
      .toEqual(['alpha', 'word'])
    expect(names(selectCatalogSkills(skills, [], [user('excel')], { 'muse-market': 1 }, [])))
      .toEqual(['alpha'])
  })

  it('uses stable input order for empty, missing, and unrelated intent', () => {
    const skills = [skill('gamma'), skill('alpha'), skill('beta')]
    for (const messages of [[], [user('')], [user('Unrelated query')]]) {
      expect(names(selectCatalogSkills(skills, messages, [], { 'muse-market': 2 }))).toEqual(['gamma', 'alpha'])
    }
  })

  it('keeps the complete original catalog when limits are absent or do not match a source', () => {
    const skills = [skill('gamma'), skill('alpha'), skill('beta')]
    for (const limits of [{}, { other: 1 }]) {
      expect(selectCatalogSkills(skills, [user('/beta')], [], limits)).toEqual(skills)
    }
  })

  it('applies each source limit independently without changing the input', () => {
    const skills = [skill('m-a'), skill('c-a', 'Other', 'custom'), skill('m-b', 'Word'),
      skill('c-b', 'Word', 'custom'), skill('native', 'Native', 'bundled')]
    const original = [...skills]
    expect(names(selectCatalogSkills(skills, [user('Word')], [], { 'muse-market': 1, custom: 1 })))
      .toEqual(['m-b', 'c-b', 'native'])
    expect(skills).toEqual(original)
  })

  it('weights name matches above description-only matches and normalizes word case and width', () => {
    const skills = [skill('alpha', 'Word'), skill('word', 'Editor')]
    expect(names(selectCatalogSkills(skills, [user('ＷＯＲＤ')], [], { 'muse-market': 1 })))
      .toEqual(['word'])
  })

  it('matches adjacent Han pairs without requiring whitespace-separated Chinese words', () => {
    const skills = [skill('drawing', '生成插画'), skill('word', '编辑文档和排版')]
    expect(names(selectCatalogSkills(skills, [user('请帮我编辑文档')], [], { 'muse-market': 1 })))
      .toEqual(['word'])
  })

  it('does not repeat lexical weight for repeated query words', () => {
    const skills = [skill('alpha', 'Word'), skill('beta', 'Drawing Word')]
    expect(names(selectCatalogSkills(skills, [user('Word Word Word Drawing')], [], { 'muse-market': 1 })))
      .toEqual(['beta'])
  })

  it('does not treat inherited record properties as configured source limits', () => {
    const skills = [skill('alpha', 'Alpha', 'toString'), skill('beta', 'Beta', 'toString')]
    expect(selectCatalogSkills(skills, [], [], {})).toEqual(skills)
  })
})

describe('explicit skill gestures', () => {
  it('preserves mid-sentence, whitespace-bounded grammar and first-seen deduplication', () => {
    expect(invokedSkillNames([user('Use /alpha now\n/beta /alpha')])).toEqual(['alpha', 'beta'])
    expect(invokedSkillNames([user('/alpha/path foo/beta 5/8 /alpha, //beta /Bad /beta_thing')])).toEqual([])
  })

  it('scans text blocks only and never accepts a Host injection as a direct gesture', () => {
    const mixed = createUserMessage({
      content: [{ type: 'reasoning', text: '/alpha' }, { type: 'text', text: '/beta' }],
      source: { kind: 'user' },
    })
    expect(invokedSkillNames([injected('/alpha'), mixed])).toEqual(['beta'])
    const selected = selectCatalogSkills([skill('alpha'), skill('beta')], [mixed], [], { 'muse-market': 1 })
    expect(names(selected)).toEqual(['beta'])
  })
})
