/** Inference evidence must retain audio identity, actual coverage and its unreviewed status. */
import { expect, it } from 'vitest'
import { parseAudioProfile } from '../src/audio-profile.ts'
import { compareStoryFits, parseStory, storyFit } from '../src/story.ts'
import { audioProfileFixture } from './audio-profile.fixture.ts'

const hash = `sha256:${'a'.repeat(64)}`

it('keeps raw similarities, measured windows and unreviewed status without requiring analysis at lookup', () => {
  expect(parseAudioProfile(undefined, hash)).toBeUndefined()
  const profile = audioProfileFixture(hash)
  expect(parseAudioProfile(profile, hash)).toEqual(profile)
  expect(parseAudioProfile({ ...profile, estimated_tempo_bpm: null }, hash)?.estimated_tempo_bpm).toBeNull()
})

it.each([
  null, [], { human_reviewed: true }, { source_sha256: `sha256:${'b'.repeat(64)}` },
  { model_revision: 'unversioned' }, { model_id: '' }, { recipe_sha256: 'unversioned' },
  { analyzed_at: 'not a date' }, { sample_count: 9 }, { tags: [] },
  { windows: [{ start_seconds: 5, end_seconds: 5, tags: [] }], sample_count: 1 },
  { sampled_seconds: 60 }, { tags: [{ tag: 'family', similarity: 90 }] },
  { tags: [{ tag: 'made_up', similarity: 0.4 }] }, { tags: [{ tag: 'family', similarity: 0.01 }] },
  { tags: [{ tag: 'family', similarity: 0.4 }, { tag: 'family', similarity: 0.4 }] },
  { windows: [{ start_seconds: 50, end_seconds: 80, tags: [] }] }, { tag_scores: {} },
])('rejects detached, inflated or unverifiable catalogue metadata: %j', (changes) => {
  const value = changes === null || Array.isArray(changes) ? changes : { ...audioProfileFixture(hash), ...changes }
  expect(() => parseAudioProfile(value, hash)).toThrow('audio_profile')
})

it('counts overlapping sample intervals once instead of claiming full-song semantic analysis', () => {
  const profile = audioProfileFixture(hash)
  profile.windows[1] = { ...profile.windows[1]!, start_seconds: 5, end_seconds: 15 }
  expect(parseAudioProfile({ ...profile, sampled_seconds: 15 }, hash)?.sampled_seconds).toBe(15)
  expect(() => parseAudioProfile(profile, hash)).toThrow('coverage')
})

it('prefers available sampled-audio label evidence while keeping title and audio conflicts separate', () => {
  const story = parseStory({ intent: '亲情', desired_tags: ['family'], avoid_tags: ['action'] })
  if (!story) throw new Error('Missing fixture request')
  const audio = storyFit('opaque.mp3', [], story, ['family', 'action'])
  const title = storyFit('感动亲情.mp3', [], story)
  expect(compareStoryFits(audio, title, story)).toBeLessThan(0)
  expect(audio).toMatchObject({ status: 'supported', audio_matches: ['family'], audio_conflicts: ['action'], title_conflicts: [] })
  expect(storyFit('战斗.mp3', [], story, ['family'])).toMatchObject({ status: 'title_conflict', title_conflicts: ['action'] })
})
