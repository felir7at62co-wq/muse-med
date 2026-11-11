/** The browser adapter preserves every operation's arguments and structured refusals. */
import { expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { parseMarketPublicationId, parseMarketPublisherId, parseMarketUploadRequestId } from '@deepseek-ai/dsh-muse-market/cloud-values'
import type { MarketMetadata, MarketReleaseId } from '@deepseek-ai/dsh-muse-market/types'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { createMarketOperations } from '../src/client/market-remote.ts'

it('forwards local, activation and cloud requests without replacing Host error details', async () => {
  const error = new RemoteError('muse-market/operation-failed', 'Request refused', { code: 'default-conflict' })
  const refuse = async () => ({ ok: false as const, error })
  const remote = {
    museMarket: {
      sources: vi.fn(refuse), prepare: vi.fn(refuse), installed: vi.fn(refuse),
      importPackage: vi.fn(refuse), exportPackage: vi.fn(refuse), removePackage: vi.fn(refuse),
    },
    museMarketActivation: { defaults: vi.fn(refuse), setDefault: vi.fn(refuse), binding: vi.fn(refuse) },
    museMarketCloud: {
      catalog: vi.fn(refuse), identity: vi.fn(refuse), getPublication: vi.fn(refuse),
      publishDraft: vi.fn(refuse), installPublication: vi.fn(refuse), review: vi.fn(refuse),
    },
  }
  const actions = createMarketOperations(remote)
  const release = brandString<MarketReleaseId>('a'.repeat(64))
  const publication = parseMarketPublicationId('b'.repeat(32)), publisher = parseMarketPublisherId('c'.repeat(32))
  const key = parseMarketUploadRequestId('original-upload')
  const metadata: MarketMetadata = { name: 'author-skill', title: 'Author skill', description: 'Authored skill',
    version: '1.0.0', license: 'MIT', category: 'writing', requirements: [], examples: [] }
  const selection = { skillName: 'author-skill', expected: null, target: release }
  const binding = { sessionId: brandString<Parameters<typeof actions.binding>[0]['sessionId']>('market-session') }
  const checks = [
    { invoke: () => actions.sources(), method: remote.museMarket.sources, args: [] },
    { invoke: () => actions.prepare(metadata, 'author-skill'), method: remote.museMarket.prepare, args: [metadata, 'author-skill'] },
    { invoke: () => actions.installed(), method: remote.museMarket.installed, args: [] },
    { invoke: () => actions.importPackage('emlw'), method: remote.museMarket.importPackage, args: ['emlw'] },
    { invoke: () => actions.exportPackage(release), method: remote.museMarket.exportPackage, args: [release] },
    { invoke: () => actions.removePackage(release), method: remote.museMarket.removePackage, args: [release] },
    { invoke: () => actions.defaults(), method: remote.museMarketActivation.defaults, args: [] },
    { invoke: () => actions.setDefault(selection), method: remote.museMarketActivation.setDefault, args: [selection] },
    { invoke: () => actions.binding(binding), method: remote.museMarketActivation.binding, args: [binding] },
    { invoke: () => actions.catalog('writing', true), method: remote.museMarketCloud.catalog, args: ['writing', true] },
    { invoke: () => actions.identity(), method: remote.museMarketCloud.identity, args: [] },
    { invoke: () => actions.getPublication(publication), method: remote.museMarketCloud.getPublication, args: [publication] },
    { invoke: () => actions.publishDraft(release, publisher, key), method: remote.museMarketCloud.publishDraft,
      args: [release, publisher, key] },
    { invoke: () => actions.installPublication(publication, release), method: remote.museMarketCloud.installPublication,
      args: [publication, release] },
    { invoke: () => actions.review(publication, 3, 'submit', 'Ready for review'), method: remote.museMarketCloud.review,
      args: [publication, 3, 'submit', 'Ready for review'] },
  ]
  for (const check of checks) {
    await expect(check.invoke()).rejects.toBe(error)
    expect(check.method).toHaveBeenCalledExactlyOnceWith(...check.args)
  }
})

it('returns the original successful value and settles successful removal without a replacement value', async () => {
  const unused = async (): Promise<never> => { throw new Error('Unexpected operation') }
  const installed: Awaited<ReturnType<ReturnType<typeof createMarketOperations>['installed']>> = []
  const remote = {
    museMarket: { sources: unused, prepare: unused, importPackage: unused, exportPackage: unused,
      installed: async () => ({ ok: true as const, value: installed }),
      removePackage: async () => ({ ok: true as const, value: undefined }) },
    museMarketActivation: { defaults: unused, setDefault: unused, binding: unused },
    museMarketCloud: { catalog: unused, identity: unused, getPublication: unused, publishDraft: unused,
      installPublication: unused, review: unused },
  }
  const actions = createMarketOperations(remote)
  expect(await actions.installed()).toBe(installed)
  await expect(actions.removePackage(brandString<MarketReleaseId>('a'.repeat(64)))).resolves.toBeUndefined()
})
