/** Shared coordination refuses mismatched scopes and never forwards private account transport fields. */
import { Context } from '@deepseek-ai/cordis'
import { expect, it, vi } from 'vitest'
import { museVoiceCoordinator, readVoiceCoordination } from '../src/voice-coordination.ts'
import { encodeVoiceSlot } from '../src/voice-slot.ts'
const request = { action: 'acquire' as const, script_id: 2708, character_id: 'zhou', voice_period_id: 'adult', operation_key: 'original-key' }
const reserved = { ...request, state: 'reserved', owner_operation: true, lease_id: 'a'.repeat(43) }
const tag = encodeVoiceSlot(2708, 'zhou', 'adult')
const asset = { asset_id: 7, script_id: 2708, asset_type: 4, name: `Voice ${tag}`, url: 'https://media.example/voice.wav',
  character_id: 'zhou', voice_period_id: 'adult', voice_slot_tag: tag }
it('projects only finite response fields and validates an exact ready voice', () => {
  expect(readVoiceCoordination({ ...reserved, cookie: 'private', token: 'private' }, request)).toEqual({ state: 'reserved', script_id: 2708,
    character_id: 'zhou', voice_period_id: 'adult', owner_operation: true, lease_id: 'a'.repeat(43) })
  expect(readVoiceCoordination({ ...request, state: 'ready', asset }, request)).toMatchObject({ state: 'ready', asset })
})
it.each([null, [], 3, {}, { ...reserved, state: 'unknown' }, { ...reserved, script_id: 9 }, { ...reserved, character_id: 'other' },
  { ...reserved, voice_period_id: 'child' }, { ...reserved, owner_operation: 'true' }, { ...reserved, started_now: 'true' },
  { ...reserved, started_now: true }, { ...reserved, lease_id: '' }, { ...reserved, lease_id: 5 }, { ...reserved, owner_operation: false },
  { ...request, state: 'reserved', owner_operation: true }, { ...request, state: 'busy' },
  { ...request, state: 'busy', blocking_state: 'ready' }, { ...request, state: 'busy', blocking_state: 'submitted', lease_id: 'foreign' },
  { ...request, state: 'busy', blocking_state: 'submitted', owner_operation: true }, { ...reserved, asset },
  { ...request, state: 'submitted', started_now: true, owner_operation: false }])('rejects invalid coordinator response %j', (value) => {
  expect(() => readVoiceCoordination(value, request)).toThrow('Unreadable shared voice coordination response')
})
it.each([{ asset_id: 0 }, { asset_id: 1.2 }, { script_id: 9 }, { asset_type: 1 }, { character_id: 'other' }, { voice_period_id: 'child' },
  { voice_slot_tag: encodeVoiceSlot(9, 'zhou', 'adult') }, { name: 'untagged' }, { name: 5 }, { url: 'broken' },
  { url: 5 }, { url: 'https://media.example/voice\\bad.wav' }, { url: 'http://media.example/voice.wav' },
  { url: 'https://user:secret@media.example/voice.wav' }, { url: 'https://media.example/voice.wav#hash' }])('rejects mismatched or unsafe ready audio %j', (change) => {
  expect(() => readVoiceCoordination({ ...request, state: 'ready', asset: { ...asset, ...change } }, request)).toThrow()
})
it('accepts only an explicit start-now permission and a credential-free busy disposition', () => {
  expect(readVoiceCoordination({ ...reserved, state: 'submitted', started_now: true }, request)).toMatchObject({ started_now: true })
  expect(readVoiceCoordination({ ...request, state: 'busy', blocking_state: 'reserved' }, request)).toMatchObject({ blocking_state: 'reserved' })
  expect(readVoiceCoordination({ ...request, state: 'available' }, request)).toMatchObject({ state: 'available' })
})
it('keeps credentials in the Host provider and strips provider text from failures', async () => {
  const ctx = new Context()
  const call = vi.fn(async () => reserved)
  ctx.provide('museAccount', { requestVoiceSlot: call } as never)
  const coordinator = museVoiceCoordinator(ctx, async () => 'jubian-private')
  expect(await coordinator.request(request)).toMatchObject({ state: 'reserved' })
  expect(call).toHaveBeenCalledWith(request, 'jubian-private')
  call.mockRejectedValueOnce(new Error('private secret remote body'))
  await expect(coordinator.request(request)).rejects.toMatchObject({ code: 'unavailable' })
  await ctx.fiber.dispose()
})
it('refuses missing Muse login provider before resolving any provider secret', async () => {
  const ctx = new Context(), credential = vi.fn(async () => 'secret')
  await expect(museVoiceCoordinator(ctx, credential).request(request)).rejects.toMatchObject({ code: 'not-configured' })
  expect(credential).not.toHaveBeenCalled()
  await ctx.fiber.dispose()
})

it.each(['sign-in-required', 'account-changed', 'not-configured', 'network', 'unavailable', 'response-invalid'])('keeps structured account failure %s bounded', async (code) => {
  const ctx = new Context()
  ctx.provide('museAccount', { requestVoiceSlot: async () => {
    throw Object.assign(new Error('private provider body'), { code })
  } } as never)
  const expected = code === 'response-invalid' ? 'unavailable' : code
  await expect(museVoiceCoordinator(ctx, async () => 'private-token').request(request)).rejects.toMatchObject({ code: expected,
    message: `Shared voice coordination: ${expected}` })
  await ctx.fiber.dispose()
})
it('does not infer a failure reason from arbitrary response or exception text', async () => {
  const ctx = new Context()
  ctx.provide('museAccount', { requestVoiceSlot: async () => { throw { code: 'sign-in-required', message: 'private' } } } as never)
  await expect(museVoiceCoordinator(ctx, async () => 'private-token').request(request)).rejects.toMatchObject({ code: 'unavailable' })
  await ctx.fiber.dispose()
})
