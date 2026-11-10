/** Desktop Workspace routing retains the user's actual original backend. */
import { describe, expect, it } from 'vitest'
import { workspaceStorageLayer } from '../src/workspace-storage-composition.ts'
import { generationLoopLayer } from '../src/generation-loop-composition.ts'

describe('Desktop Workspace successor routing', () => {
  it('retains a custom source route and unrelated domain configuration', () => {
    const config = { backend: 'json-custom', routes: { workspace: 'json-workspace', credentials: 'private' } }
    const result = workspaceStorageLayer([{ id: 'storage-domain', config }], '/private/muse/storages')
    expect(result).toEqual([{ insert: [{ id: 'muse-workspace-owned-storage', name: 'muse-workspace-owned-storage',
      config: { sourceBackend: 'json-workspace', root: '/private/muse/storages/workspace-owned-v1' } }] },
    { id: 'storage-domain', config: { backend: 'json-custom', routes: { workspace: 'muse-workspace-owned', credentials: 'private' } } }])
    expect(config.routes.workspace).toBe('json-workspace')
  })

  it('uses the original default backend when Workspace has no override', () => {
    expect(workspaceStorageLayer([{ id: 'storage-domain', config: { backend: 'custom-json' } }], '/muse')[0])
      .toMatchObject({ insert: [{ config: { sourceBackend: 'custom-json' } }] })
  })

  it('preserves a deferred backend expression for Loader evaluation', () => {
    const expression = { value: 'process.env.TEST_WORKSPACE_BACKEND', type: 'js' }
    expect(workspaceStorageLayer([{ id: 'storage-domain', config: { backend: expression } }], '/muse')[0])
      .toMatchObject({ insert: [{ config: { sourceBackend: expression } }] })
  })

  it.each([[], [{ id: 'storage-domain', config: {} }],
    [{ id: 'storage-domain', config: { backend: 'muse-workspace-owned' } }],
    [{ id: 'storage-domain', config: { backend: 'json', routes: 'invalid' } }]])('refuses a missing or invalid original route', (entries) => {
    expect(() => workspaceStorageLayer(entries, '/muse')).toThrow()
  })
})


it('retains all configured driver options while enabling durable continuation', () => {
  const config = { agents: [], maxParallelToolCalls: 3, durableInboxClaims: false }
  expect(generationLoopLayer([{ id: 'agent-loop', config }])).toEqual([
    { id: 'agent-loop', config: { ...config, durableInboxClaims: true } },
  ])
  expect(config.durableInboxClaims).toBe(false)
  expect(() => generationLoopLayer([])).toThrow('no agent-loop')
})
