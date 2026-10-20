/** Adopted project metadata never replaces live URLs or guesses a life period. */
import { expect, it } from 'vitest'
import { productionMetadata } from '../src/production-metadata.ts'
import type { ProductionAsset, ProductionRequirement } from '../src/production-types.ts'

const image: ProductionAsset = { asset_id: 101, name: '苏晚（白中衣）', kind: 'character', url: 'https://example.test/white.png', material_id: 'image-white', usable: true }
const voice: ProductionAsset = { asset_id: 401, name: '苏晚的声音', kind: 'voice', url: 'https://example.test/voice.wav', material_id: null, usable: true }
const requirement: ProductionRequirement = { shot: 2, kind: 'voice', name: '阿晚' }
const profile = { voice_period_id: 'adult', reference_audio_asset_id: 401, reference_audio: voice.url,
  reference_audio_sha256: 'a'.repeat(64), reference_audio_duration_seconds: 2 }

it('adds source-matched aliases and the adopted voice identity without changing remote names', () => {
  const result = productionMetadata([image, voice], { items: [{ jubian_asset_id: 101, url: image.url,
    character_name: '苏晚', aliases: ['阿晚'], state_or_costume: '青年；白中衣' }] }, {
    project_bible: { characters: [{ character_id: 'su-wan', name: '苏晚', aliases: ['阿晚'], voice_profiles: [profile] }] },
  }, [requirement])
  expect(result.assets[0]).toMatchObject({ name: image.name, aliases: ['阿晚', '苏晚'], state_or_costume: '青年；白中衣' })
  expect(result.assets[1]).toMatchObject({ character_id: 'su-wan', voice_period_id: 'adult', duration_seconds: 2,
    audio_duration_basis: 'project_reference_metadata' })
  expect(result.requirements[0]).toMatchObject({ character_id: 'su-wan', voice_period_id: 'adult' })
  expect(image).not.toHaveProperty('aliases')
})

it('does not reuse stale image registration or a voice URL whose bytes are no longer the adopted reference', () => {
  const result = productionMetadata([image, voice], { items: [{ jubian_asset_id: 101, url: 'https://example.test/stale.png', aliases: ['另一个人'] }] }, {
    project_bible: { characters: [{ character_id: 'su-wan', name: '苏晚', voice_profiles: [{ ...profile, reference_audio: 'https://example.test/stale.wav' }] }] },
  }, [])
  expect(result.assets[0]).not.toHaveProperty('aliases')
  expect(result.assets[1]).not.toHaveProperty('duration_seconds')
})

it('keeps child and adult identities separate and preserves an explicit requested period', () => {
  const result = productionMetadata([voice], undefined, { project_bible: { characters: [{ character_id: 'su-wan', name: '苏晚', aliases: ['阿晚'],
    voice_profiles: [profile, { voice_period_id: 'child', reference_audio: null }] }] } }, [requirement, { ...requirement, shot: 3, voice_period_id: 'child' }])
  expect(result.requirements[0]).not.toHaveProperty('voice_period_id')
  expect(result.requirements[1]).toMatchObject({ character_id: 'su-wan', voice_period_id: 'child' })
  expect(result.assets[0]).toMatchObject({ voice_period_id: 'adult', duration_seconds: 2 })
})

it('does not replace a different shared character or period with local metadata', () => {
  const result = productionMetadata([{ ...voice, character_id: 'other', voice_period_id: 'child' }], undefined,
    { project_bible: { characters: [{ character_id: 'su-wan', name: '苏晚', voice_profiles: [profile] }] } }, [])
  expect(result.assets[0]).toMatchObject({ character_id: 'other', voice_period_id: 'child' })
  expect(result.assets[0]).not.toHaveProperty('duration_seconds')
})
