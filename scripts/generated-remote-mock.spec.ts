import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { generatedRemoteMockPlugin } from './generated-remote-mock.ts'

describe('owning generated Remote mocks', () => {
  it.each([
    ['@deepseek-ai/dsh-muse-account/remote', 'packages/client/ui-muse-account', 'index.ts', 'browser-plugin.client.spec.tsx'],
    ['@deepseek-ai/dsh-muse-market/remote', 'packages/client/ui-muse-account', 'market-mount.ts', 'market-panel.client.spec.tsx'],
    ['@deepseek-ai/dsh-feishu-settings/remote', 'packages/host/feishu-settings', 'index.ts', 'browser-plugin.client.spec.tsx'],
  ])('resolves %s only for its two owning importers', (remote, directory, entry, test) => {
    const resolver = generatedRemoteMockPlugin(process.cwd())
    const owner = join(process.cwd(), directory, 'src/client', entry)
    const virtual = resolver.resolveId(remote, owner)
    expect(virtual).toBeDefined()
    expect(resolver.resolveId(remote, `${owner}?source-test`)).toBe(virtual)
    expect(resolver.resolveId(remote, join(process.cwd(), directory, 'tests', test))).toBe(virtual)
    expect(resolver.resolveId(remote, owner.replaceAll('/', '\\'))).toBe(virtual)
    expect(resolver.resolveId(remote, undefined)).toBeUndefined()
    expect(resolver.resolveId(remote, `${owner}.unrelated`)).toBeUndefined()
    expect(resolver.resolveId('@deepseek-ai/dsh-api-session-controller/remote', owner)).toBeUndefined()
    expect(resolver.load('unrelated-module')).toBeUndefined()
    if (virtual === undefined) throw new Error('owning Remote import was not resolved')
    expect(resolver.load(virtual)).toContain('throw new Error("Generated Remote contribution requires an explicit owning-test mock")')
  })
})
