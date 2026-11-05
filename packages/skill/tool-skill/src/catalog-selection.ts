/** Deterministic, source-bounded skill catalog selection from direct user intent. */

import type { Message, UserMessage } from '@deepseek-ai/dsh-llm'
import type { SkillSummary } from '@deepseek-ai/dsh-skill'

/** A bounded `/name` gesture, excluding paths, fractions, and adjacent punctuation. */
const SKILL_GESTURE = /(^|\s)\/([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)/g

/**
 * Read explicit skill gestures from direct user text in first-seen order.
 * @param messages - accepted user-role messages, including Host context injections.
 * @returns unique gesture names without checking registry availability or invocation policy.
 */
export function invokedSkillNames(messages: readonly UserMessage[]): string[] {
  const names = new Set<string>()
  for (const message of messages) {
    if (message.source.kind !== 'user') continue
    for (const block of message.content) {
      if (block.type !== 'text') continue
      for (const match of block.text.matchAll(SKILL_GESTURE)) {
        names.add(match[2] as string)
      }
    }
  }
  return [...names]
}

/**
 * Select each source's advertised summaries without changing invocation permissions.
 * Sources absent from `limits` remain complete. Explicit gestures outrank lexical
 * matches; tied candidates and the returned catalog retain their input order.
 * New user messages rerank; tool-only continuations retain the previous valid selection.
 * @param skills - invocation-filtered summaries in the registry's stable order.
 * @param messages - accepted messages for the current step.
 * @param history - committed model messages in chronological order.
 * @param limits - validated positive entry limits indexed by exact skill source.
 * @param previousNames - last published names, retained without new direct user input; absent uses visible history.
 * @returns selected summary references in their original order, without loading bodies.
 */
export function selectCatalogSkills(
  skills: readonly SkillSummary[],
  messages: readonly UserMessage[],
  history: readonly Message[],
  limits: Readonly<Record<string, number>>,
  previousNames?: readonly string[],
): SkillSummary[] {
  const sourceLimits = new Map(Object.entries(limits))
  const bounded = new Map<string, {
    limit: number
    candidates: { skill: SkillSummary; index: number }[]
  }>()
  for (const [index, skill] of skills.entries()) {
    const limit = sourceLimits.get(skill.source)
    if (limit === undefined) continue
    const group = bounded.get(skill.source) ?? { limit, candidates: [] }
    group.candidates.push({ skill, index })
    bounded.set(skill.source, group)
  }
  if (bounded.size === 0) return [...skills]

  const currentIntent = directUserIntent(messages, [])
  const preserve = currentIntent.length === 0 && previousNames !== undefined
  const intent = preserve ? [] : currentIntent.length > 0 ? currentIntent : directUserIntent([], history)
  const explicit = new Set(preserve ? previousNames : invokedSkillNames(intent))
  const query = lexicalTerms(intent.flatMap(message => message.content
    .filter(block => block.type === 'text')
    .map(block => block.text)).join(' '))
  const retained = new Set<number>()
  for (const { limit, candidates } of bounded.values()) {
    const ranked = candidates.map(candidate => ({
      ...candidate,
      explicit: explicit.has(candidate.skill.name),
      score: lexicalScore(candidate.skill, query),
    })).sort((left, right) => Number(right.explicit) - Number(left.explicit)
      || right.score - left.score || left.index - right.index)
    for (const candidate of ranked.slice(0, limit)) retained.add(candidate.index)
  }
  return skills.filter((skill, index) => !sourceLimits.has(skill.source) || retained.has(index))
}

function directUserIntent(
  messages: readonly UserMessage[],
  history: readonly Message[],
): readonly UserMessage[] {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.source.kind === 'user') return [message]
  }
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const message = history[index]
    if (message?.role === 'user' && message.source.kind === 'user') return [message]
  }
  return []
}

function lexicalScore(skill: SkillSummary, query: ReadonlySet<string>): number {
  const name = lexicalTerms(skill.name)
  const description = lexicalTerms(skill.description)
  let score = 0
  for (const term of query) {
    if (name.has(term)) score += 3
    if (description.has(term)) score += 1
  }
  return score
}

/** Normalize words and adjacent Han pairs without a model, locale, or external index. */
function lexicalTerms(text: string): Set<string> {
  const terms = new Set<string>()
  for (const match of text.normalize('NFKC').toLowerCase().matchAll(/[\p{L}\p{N}]+/gu)) {
    const word = match[0]
    terms.add(word)
    for (const han of word.matchAll(/\p{Script=Han}+/gu)) {
      let previous: string | undefined
      for (const character of han[0]) {
        if (previous !== undefined) terms.add(previous + character)
        previous = character
      }
    }
  }
  return terms
}
