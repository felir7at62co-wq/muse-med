/** The two sections' absent-document answers, and the row-state reduction. */

import { describe, expect, it } from 'vitest'
import { BridgeSettingsSchema, FEISHU_SETTINGS_DEFAULTS, FeishuSettingsSchema } from '../src/settings.ts'
import { credentialSourceOf, rowStateOf } from '../src/status.ts'

describe('FeishuSettingsSchema', () => {
  it('resolves an absent section to off with no scanner', () => {
    expect(FeishuSettingsSchema({})).toEqual(FEISHU_SETTINGS_DEFAULTS)
  })

  it('keeps a stored switch and scanner', () => {
    const stored = { enabled: true, registeredBy: 'ou_x' }
    expect(FeishuSettingsSchema(stored)).toEqual(stored)
  })
})

describe('BridgeSettingsSchema', () => {
  it('resolves the pair this product writes, and leaves other keys to the bridge', () => {
    const stored = { appId: 'cli_x', appSecret: 'sec_x', requireMention: false, senderAllowlist: ['ou_a'] }
    expect(BridgeSettingsSchema(stored)).toMatchObject({ enabled: true, appId: 'cli_x', appSecret: 'sec_x' })
  })

  it('marks the app secret as a settings secret', () => {
    expect(JSON.stringify(BridgeSettingsSchema.toJSON())).toContain('"secret"')
  })
})

describe('rowStateOf', () => {
  it('reports a composition without the bridge row as unavailable', () => {
    expect(rowStateOf(false, { entryDisabled: undefined, bridgeOverride: undefined })).toBe('unavailable')
    expect(rowStateOf(true, { entryDisabled: undefined, bridgeOverride: false })).toBe('unavailable')
  })

  it('stays disabled while the product switch is off', () => {
    expect(rowStateOf(false, { entryDisabled: true, bridgeOverride: undefined })).toBe('disabled')
    expect(rowStateOf(false, { entryDisabled: false, bridgeOverride: true })).toBe('disabled')
  })

  it('reports the bridge section override ahead of a restart', () => {
    expect(rowStateOf(true, { entryDisabled: true, bridgeOverride: false })).toBe('overridden')
    expect(rowStateOf(true, { entryDisabled: false, bridgeOverride: false })).toBe('overridden')
  })

  it('waits for a restart when the running composition composed the row disabled', () => {
    expect(rowStateOf(true, { entryDisabled: true, bridgeOverride: undefined })).toBe('restart-pending')
  })

  it('is active once the composition enabled the row with nothing overriding it', () => {
    expect(rowStateOf(true, { entryDisabled: false, bridgeOverride: undefined })).toBe('active')
    expect(rowStateOf(true, { entryDisabled: false, bridgeOverride: true })).toBe('active')
  })
})

describe('credentialSourceOf', () => {
  it('reports none while no secret is stored', () => {
    expect(credentialSourceOf(false, '')).toBe('none')
    expect(credentialSourceOf(false, 'ou_x')).toBe('none')
  })

  it('reports the scan that wrote the pair', () => {
    expect(credentialSourceOf(true, 'ou_x')).toBe('registered')
  })

  it('reports a hand-entered pair', () => {
    expect(credentialSourceOf(true, '')).toBe('manual')
  })
})
