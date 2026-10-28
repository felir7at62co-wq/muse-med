/** Story parsing validates JSON independently of the tool schema's earlier field checks. */
import { expect, it } from 'vitest'
import { parseStory } from '../src/story.ts'

it.each([
  null, [], 42, { intent: ' ' }, { intent: 'x'.repeat(601) },
  { intent: 'real', desired_tags: [] }, { intent: 'real', desired_tags: ['invented'] },
  { intent: 'real', desired_tags: ['family'], avoid_tags: 'action' },
  { intent: 'real', desired_tags: ['family'], avoid_tags: ['invented'] },
  { intent: 'real', desired_tags: ['family'], dialogue_density: 'silent' },
])('rejects invalid story JSON: %j', (value) => {
  expect(() => parseStory(value)).toThrow('story')
})
