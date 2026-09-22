/**
 * The composed-package fold: which status one read-only inventory answer yields
 * for each package, and what an absent answer yields instead.
 *
 * Pure functions, so this lane drives them directly with the two row shapes the
 * inventory reports — preset rows and Loader entries.
 */
import { describe, expect, it } from 'vitest'
import type { PluginInventorySnapshot } from '@deepseek-ai/dsh-api-remotes/client'
import { DRAMA_COMPONENTS, componentStates } from '../src/client/components.ts'

type Row = { moduleName: string; enabled: boolean | 'conditional'; fiberPhase: string | null; condition?: string }

/** One inventory answer over preset rows and Loader entries. */
function snapshot(
  presets: Row[] = [],
  entries: Row[] = [],
): PluginInventorySnapshot {
  return {
    entries: entries.map(entry => ({ ...entry, entryId: entry.moduleName })),
    agentPresets: [{ id: 'short-drama', trust: 'system', isDefault: false, rows: presets }],
  } as unknown as PluginInventorySnapshot
}

/** The status one module got out of one answer. */
function statusOf(snapshotValue: PluginInventorySnapshot | undefined, pkg: string): string {
  const state = componentStates(snapshotValue).find(entry => entry.component.pkg === pkg)
  return state?.status ?? 'missing'
}

describe('DRAMA_COMPONENTS', () => {
  it('names the six packages a short-drama production is built from, in pipeline order', () => {
    expect(DRAMA_COMPONENTS.map(entry => entry.pkg)).toEqual([
      '@deepseek-ai/dsh-guard-drama',
      '@deepseek-ai/dsh-tool-drama-assets',
      '@deepseek-ai/dsh-tool-shot-script',
      '@deepseek-ai/dsh-perception-bgm',
      '@deepseek-ai/dsh-tool-bgm-compose',
      '@deepseek-ai/dsh-tool-episode-render',
    ])
  })
})

describe('componentStates', () => {
  it('reports a preset row with a live fiber as loaded', () => {
    const states = componentStates(snapshot([
      { moduleName: '@deepseek-ai/dsh-guard-drama', enabled: true, fiberPhase: 'active' },
    ]))
    expect(states).toHaveLength(DRAMA_COMPONENTS.length)
    expect(states[0]).toEqual({
      component: DRAMA_COMPONENTS[0],
      status: 'loaded',
    })
  })

  it('falls back to a Loader entry when no preset row names the package', () => {
    expect(statusOf(snapshot([], [
      { moduleName: '@deepseek-ai/dsh-perception-bgm', enabled: true, fiberPhase: 'active' },
    ]), '@deepseek-ai/dsh-perception-bgm')).toBe('loaded')
  })

  it('prefers the preset row over a Loader entry for the same module', () => {
    const states = componentStates(snapshot(
      [{ moduleName: '@deepseek-ai/dsh-guard-drama', enabled: false, fiberPhase: 'active' }],
      [{ moduleName: '@deepseek-ai/dsh-guard-drama', enabled: true, fiberPhase: 'active' }],
    ))
    expect(states[0]?.status).toBe('inactive')
  })

  it('keeps the first preset row for a module that appears twice', () => {
    const states = componentStates(snapshot([
      { moduleName: '@deepseek-ai/dsh-guard-drama', enabled: true, fiberPhase: 'failed' },
      { moduleName: '@deepseek-ai/dsh-guard-drama', enabled: true, fiberPhase: 'active' },
    ]))
    expect(states[0]?.status).toBe('failed')
  })

  it('reads every fiber phase and enablement as its own state', () => {
    const pkg = '@deepseek-ai/dsh-guard-drama'
    const cases: [Row, string][] = [
      [{ moduleName: pkg, enabled: true, fiberPhase: 'pending' }, 'starting'],
      [{ moduleName: pkg, enabled: true, fiberPhase: 'loading' }, 'starting'],
      [{ moduleName: pkg, enabled: true, fiberPhase: 'active' }, 'loaded'],
      [{ moduleName: pkg, enabled: true, fiberPhase: 'failed' }, 'failed'],
      [{ moduleName: pkg, enabled: true, fiberPhase: 'unloading' }, 'inactive'],
      [{ moduleName: pkg, enabled: true, fiberPhase: null }, 'inactive'],
      [{ moduleName: pkg, enabled: false, fiberPhase: 'active' }, 'inactive'],
      [{ moduleName: pkg, enabled: 'conditional', fiberPhase: null }, 'conditional'],
    ]
    for (const [row, expected] of cases) {
      expect(statusOf(snapshot([row]), pkg)).toBe(expected)
    }
  })

  it('carries the row’s own load condition through to the row', () => {
    const states = componentStates(snapshot([
      { moduleName: '@deepseek-ai/dsh-guard-drama', enabled: 'conditional', fiberPhase: null, condition: 'win32' },
    ]))
    expect(states[0]).toEqual({
      component: DRAMA_COMPONENTS[0],
      status: 'conditional',
      condition: 'win32',
    })
  })

  it('separates a package the answer does not name from an answer that never came', () => {
    expect(statusOf(snapshot(), '@deepseek-ai/dsh-guard-drama')).toBe('absent')
    expect(statusOf(undefined, '@deepseek-ai/dsh-guard-drama')).toBe('unknown')
    expect(componentStates(undefined).every(entry => entry.status === 'unknown')).toBe(true)
  })
})
