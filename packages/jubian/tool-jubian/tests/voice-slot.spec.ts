/** Shared voice tags expose exact IDs while malformed or foreign tags remain ordinary names. */
import { expect, it } from 'vitest'
import { encodeVoiceSlot, readVoiceSlot } from '../src/voice-slot.ts'

const rawTag = (json: string) => `⟦muse-voice:v1:${Buffer.from(json).toString('base64url')}⟧`

it('roundtrips explicit Unicode identities and exposes metadata only for the owning project', () => {
  const tag = encodeVoiceSlot(2708, '角色/周海生', '童年')
  expect(readVoiceSlot(`周海生声音 ${tag}`, 2708)).toEqual({ character_id: '角色/周海生', voice_period_id: '童年', voice_slot_tag: tag })
  expect(readVoiceSlot(`周海生声音 ${tag}`, 2709)).toBeUndefined()
})

it.each([null, '普通声音', '⟦muse-voice:v1:⟧', '⟦muse-voice:v2:abcd⟧', '⟦muse-voice:v1:abcd=⟧',
  '⟦muse-voice:v1:abcd/⟧', `${encodeVoiceSlot(2708, 'zhou', 'child')} trailing text`])('leaves untagged or unsupported name %s readable', (name) => {
  expect(readVoiceSlot(name, 2708)).toBeUndefined()
})

it.each(['broken', '{}', '[]', '[2708,"zhou"]', '[2708,"zhou","adult","extra"]',
  '["2708","zhou","adult"]', '[0,"zhou","adult"]', '[2708,null,"adult"]', '[2708,"","adult"]',
  '[2708," ","adult"]', '[2708,"zhou",null]', '[2708,"zhou",""]', '[2708,"zhou"," "]',
  '[2708, "zhou", "adult"]'])('refuses malformed or noncanonical decoded identity %s', (json) => {
  expect(readVoiceSlot(rawTag(json), 2708)).toBeUndefined()
})
