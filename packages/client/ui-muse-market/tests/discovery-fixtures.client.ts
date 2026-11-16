/** Client-owned resource fixtures for discovery and canonical installation assertions. */
import { brandString } from '@deepseek-ai/dsh-brand'
import type { MarketActions, MarketInstallation, MarketLegacyResource, MarketPublication } from '../src/client/market-actions.ts'

/** A published Skill whose original digest is already the canonical package identity. */
export function publication(name = 'storyboard-review', version = '1.0.0'): MarketPublication {
  return { id: brandString<MarketPublication['id']>('a'.repeat(32)), publisherId: brandString<MarketPublication['publisherId']>('b'.repeat(32)),
    publisher: 'Studio', sha256: 'a'.repeat(64), bytes: 1234, status: 'published', reviewNote: '', revision: 1, createdAt: '2026-11-14T00:00:00.000Z',
    manifest: { formatVersion: 1, kind: 'skill', name, title: name, description: `Use ${name}`, category: 'Writing', version,
      license: 'MIT', examples: [], requirements: [], skills: [{ name, path: `skills/${name}/SKILL.md` }] } }
}

/** One downloadable original Skill, before conversion into a canonical publication. */
export function original(name = 'anime-3d-assets', version = '0.1.0'): MarketLegacyResource {
  return { id: brandString<MarketLegacyResource['id']>(`muse/skills/${name}`), name, title: name, description: `Use ${name}`, category: 'Visual', version,
    sha256: 'b'.repeat(64), bytes: 2345, requirements: [], requiredSkills: [], validation: 'Reviewed', downloadPath: `/market/downloads/${name}.zip` }
}

/** Canonical local record returned after a successful original-package conversion. */
export function installation(item = publication(), digest = 'c'.repeat(64)): MarketInstallation {
  return { enabled: false, release: { id: brandString<MarketInstallation['release']['id']>(digest), sha256: digest, bytes: item.bytes, manifest: item.manifest } }
}

const unavailable = async (): Promise<never> => { throw new Error('Unexpected discovery operation') }
/** Real callback structure with narrow overrides per behavior test. */
export function operations(overrides: Partial<MarketActions> = {}): MarketActions {
  return { sources: async () => ({ skills: [], complete: true }), prepare: unavailable, prepareUpload: unavailable,
    installed: async () => [], importPackage: unavailable,
    exportPackage: unavailable, removePackage: unavailable, defaults: async () => ({ revision: 0, defaults: [] }), setDefault: unavailable,
    binding: unavailable, catalog: async () => [], legacyCatalog: async () => [], installLegacy: unavailable,
    identity: unavailable, getPublication: unavailable, installPublication: unavailable,
    publishDraft: unavailable, review: unavailable, ...overrides }
}
