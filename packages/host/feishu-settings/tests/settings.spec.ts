/** The switch row's schema, its row ids, and the state reductions the page reads. */

import { describe, expect, it } from 'vitest'
import { Config, FEISHU_CHANNEL_ROW_ID, FEISHU_SETTINGS_NAMESPACE } from '../src/index.ts'
import { credentialSourceOf, rowStateOf } from '../src/status.ts'

describe('the feishu switch schema', () => {
  it('resolves an absent row to off', () => {
    expect(Config({}).enabled.get()).toBe(false)
  })

  it('keeps a stored switch', () => {
    expect(Config({ enabled: true }).enabled.get()).toBe(true)
  })

  it('marks the switch volatile, which is what makes the field a writable section', () => {
    expect(Config.dict?.['enabled']?.meta.volatile).toBe(true)
  })

  it('namespaces the switch after this row and the pair after the bridge row', () => {
    expect(FEISHU_SETTINGS_NAMESPACE).toBe('feishu')
    expect(FEISHU_CHANNEL_ROW_ID).toBe('feishu-channel')
  })
})

describe('rowStateOf', () => {
  it('reports a composition without the bridge row as unavailable', () => {
    expect(rowStateOf(false, { composed: false, bridgeEnabled: undefined })).toBe('unavailable')
    expect(rowStateOf(true, { composed: false, bridgeEnabled: true })).toBe('unavailable')
  })

  it('stays disabled while the product switch is off, whatever the row carries', () => {
    expect(rowStateOf(false, { composed: true, bridgeEnabled: false })).toBe('disabled')
    expect(rowStateOf(false, { composed: true, bridgeEnabled: true })).toBe('disabled')
  })

  it('waits for a restart when this boot did not compose the switch yet', () => {
    expect(rowStateOf(true, { composed: true, bridgeEnabled: false })).toBe('restart-pending')
    expect(rowStateOf(true, { composed: true, bridgeEnabled: undefined })).toBe('restart-pending')
  })

  it('is active once the composition carried the switch into the row', () => {
    expect(rowStateOf(true, { composed: true, bridgeEnabled: true })).toBe('active')
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
