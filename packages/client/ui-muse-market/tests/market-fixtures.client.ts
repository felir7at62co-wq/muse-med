/** Typed publication data and operation doubles for the market's Client presentation tests. */
import { brandString } from '@deepseek-ai/dsh-brand'
import { parseMarketIdentity, parseMarketPublicationId, parseMarketPublisherId } from '@deepseek-ai/dsh-muse-market/cloud-values'
import type { MarketActions, MarketInstallation, MarketPublication, MarketTranslate } from '../src/client/market-actions.ts'
import type { MarketMetadata, MarketReleaseId } from '@deepseek-ai/dsh-muse-market/types'
import { marketEn } from '../src/client/market-locales.ts'

export const metadata: MarketMetadata = { name: 'writer', title: 'Writer', description: 'Write a scene', version: '1.0.0',
  license: 'MIT', category: 'writing', requirements: ['A script'], examples: ['A short scene'] }
export const installation: MarketInstallation = { enabled: false, release: {
  id: brandString<MarketReleaseId>('a'.repeat(64)), sha256: 'a'.repeat(64), bytes: 40,
  manifest: { ...metadata, kind: 'skill', formatVersion: 1, skills: [{ name: 'writer', path: 'skills/writer/SKILL.md' }] },
} }
export const identity = parseMarketIdentity({ accountId: 'b'.repeat(16), admin: false,
  publishers: [{ id: 'c'.repeat(32), title: 'Writers' }] })
export const publication: MarketPublication = { id: parseMarketPublicationId('d'.repeat(32)),
  publisherId: parseMarketPublisherId('c'.repeat(32)), publisher: 'Writers', manifest: installation.release.manifest,
  sha256: installation.release.sha256, bytes: installation.release.bytes, status: 'draft', reviewNote: '', revision: 2,
  createdAt: '2026-11-01T00:00:00Z' }
export const sources: Awaited<ReturnType<MarketActions['sources']>> = {
  skills: [{ name: 'writer', description: 'Write a scene' }], complete: true,
}
export const marketTranslate: MarketTranslate = key => key in marketEn ? marketEn[key as keyof typeof marketEn] : key

/** Create strict operation doubles so unexpected interaction fails its test. */
export function marketActions(overrides: Partial<MarketActions> = {}): MarketActions {
  const unexpected = async (): Promise<never> => { throw new Error('Unexpected market operation') }
  return { sources: unexpected, prepare: unexpected, installed: unexpected, importPackage: unexpected,
    exportPackage: unexpected, removePackage: unexpected, defaults: unexpected, setDefault: unexpected,
    binding: unexpected, catalog: unexpected, identity: unexpected, getPublication: unexpected,
    publishDraft: unexpected, installPublication: unexpected, review: unexpected, ...overrides }
}
