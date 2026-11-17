// @vitest-environment jsdom
/** Revision-fenced publication review across delayed replies and account revocation. */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'

import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { brandString } from '@deepseek-ai/dsh-brand'

import { parseMarketIdentity, parseMarketPublication } from '@deepseek-ai/dsh-muse-market/cloud-values'

import type { MarketReleaseId } from '@deepseek-ai/dsh-muse-market/types'

import { expect, it, onTestFinished, vi } from 'vitest'

import type { MarketActions, MarketInstallation } from '../src/client/market-actions.ts'

import { marketEn as copy } from '../src/client/market-locales.ts'

import { MarketPublications } from '../src/client/MarketPublications.tsx'

const publication = parseMarketPublication({ id: 'a'.repeat(32), publisherId: 'b'.repeat(32), publisher: 'Writing team',
  manifest: { formatVersion: 1, kind: 'skill', name: 'scene-review', title: 'Scene review', description: 'Review the original scene.',
    version: '1.0.0', license: 'MIT', category: 'writing', requirements: ['Keep the source.'], examples: ['Review chapter one.'],
    skills: [{ name: 'scene-review', path: 'skills/scene-review/SKILL.md' }] },
  sha256: 'c'.repeat(64), bytes: 512, status: 'published', reviewNote: '', revision: 1, createdAt: '2026-11-09T00:00:00.000Z',
}, { archiveBytes: 1024, recordBytes: 4096 })

const installation: MarketInstallation = { enabled: false, release: { id: brandString<MarketReleaseId>(publication.sha256),
  sha256: publication.sha256, bytes: publication.bytes, manifest: publication.manifest } }

const identity = parseMarketIdentity({ accountId: 'd'.repeat(16), publishers: [{ id: publication.publisherId, title: publication.publisher }], admin: true })

function operations() {
  let local: MarketInstallation[] = []
  let defaults: Awaited<ReturnType<MarketActions['defaults']>> = { revision: 0, defaults: [] }
  const ops = {
    sources: vi.fn<MarketActions['sources']>().mockResolvedValue({ complete: true, skills: [{ name: 'scene-review', description: 'Review scenes.' }] }),
    prepareUpload: vi.fn<MarketActions['prepareUpload']>().mockResolvedValue(installation),
    legacyCatalog: vi.fn<MarketActions['legacyCatalog']>().mockResolvedValue([]),
    installLegacy: vi.fn<MarketActions['installLegacy']>(),
    prepare: vi.fn<MarketActions['prepare']>().mockImplementation(async () => { local = [installation]; return installation }),
    installed: vi.fn<MarketActions['installed']>().mockImplementation(async () => local),
    importPackage: vi.fn<MarketActions['importPackage']>().mockImplementation(async () => { local = [installation]; return installation }),
    exportPackage: vi.fn<MarketActions['exportPackage']>().mockResolvedValue({ name: 'scene-review.zip', base64: 'AP8BgA==' }),
    removePackage: vi.fn<MarketActions['removePackage']>().mockImplementation(async () => { local = [] }),
    defaults: vi.fn<MarketActions['defaults']>().mockImplementation(async () => defaults),
    setDefault: vi.fn<MarketActions['setDefault']>().mockImplementation(async (request) => {
      defaults = { revision: defaults.revision + 1,
        defaults: request.target === null ? [] : [{ skillName: request.skillName, releaseId: request.target }] }
      return defaults
    }),
    binding: vi.fn<MarketActions['binding']>().mockResolvedValue({ phase: 'blank', releases: [] }),
    catalog: vi.fn<MarketActions['catalog']>().mockResolvedValue([publication]),
    identity: vi.fn<MarketActions['identity']>().mockResolvedValue(identity),
    getPublication: vi.fn<MarketActions['getPublication']>().mockResolvedValue(publication),
    publishDraft: vi.fn<MarketActions['publishDraft']>().mockResolvedValue({ ...publication, status: 'draft' }),
    installPublication: vi.fn<MarketActions['installPublication']>().mockImplementation(async () => {
      local = [installation]; return { publication, installation }
    }),
    review: vi.fn<MarketActions['review']>().mockResolvedValue({ ...publication, status: 'pending', revision: 2 }),
  }
  return ops
}

const click = (label: string) => { fireEvent.click(screen.getByRole('button', { name: label })) }

function publications(overrides: Partial<Parameters<typeof MarketPublications>[0]> = {}) {
  const ops = operations(), current = { value: true }
  const input = { accessRevision: 1, isCurrentAccess: () => current.value, items: [{ ...publication, status: 'draft' as const }],
    identity, actions: ops, busy: false, onReplace: vi.fn(), onDetails: vi.fn(), onInstall: vi.fn(),
    reportOutcome: vi.fn(), t: makeTranslate(copy), ...overrides }
  const view = render(<MarketPublications {...input} />)
  onTestFinished(() => { view.unmount() })
  return { ops, current, input, view }
}

it('admits publisher-owned review controls without admin authority and withholds them from other publishers', () => {
  const { view, input } = publications({ identity: { ...identity, admin: false } })
  expect(view.getByRole('button', { name: copy['review.submit'] })).toBeTruthy()
  view.rerender(<MarketPublications {...input} identity={{ ...identity, admin: false, publishers: [] }} />)
  expect(view.queryByRole('button', { name: copy['review.submit'] })).toBeNull()
})

it('refuses a review when access is revoked before the visible confirmation receives its click', () => {
  const { ops, current, input } = publications()
  click(copy['review.submit'])
  current.value = false
  click(copy.confirm)
  expect(ops.review).not.toHaveBeenCalled()
  expect(input.reportOutcome).not.toHaveBeenCalled()
})

it.each(['returned', 'rejected'] as const)('ignores a %s review after its access generation ends', async (result) => {
  const { ops, current, input } = publications()
  const pending = Promise.withResolvers<Awaited<ReturnType<MarketActions['review']>>>()
  ops.review.mockReturnValueOnce(pending.promise)
  click(copy['review.submit']); click(copy.confirm)
  expect(screen.getByRole('button', { name: copy.confirm }).hasAttribute('disabled')).toBe(true)
  click(copy.confirm)
  expect(ops.review).toHaveBeenCalledOnce()
  click(copy.close)
  expect(screen.getByRole('dialog')).toBeTruthy()
  current.value = false
  await act(async () => {
    if (result === 'returned') pending.resolve({ ...publication, status: 'pending' })
    else pending.reject(Error('Review reply lost after sign-out'))
  })
  expect(input.onReplace).not.toHaveBeenCalled()
  expect(input.reportOutcome).not.toHaveBeenCalled()
  expect(ops.getPublication).not.toHaveBeenCalled()
})

it.each(['muse-market/access-changed', 'uncertain-review'])('handles the original %s refusal without repeating review', async (code) => {
  const { ops, input } = publications()
  ops.review.mockRejectedValueOnce({ code })
  click(copy['review.submit']); click(copy.confirm)
  if (code === 'muse-market/access-changed') {
    await waitFor(() => { expect(screen.getByRole('button', { name: copy.confirm }).hasAttribute('disabled')).toBe(false) })
    expect(ops.getPublication).not.toHaveBeenCalled()
    expect(input.onReplace).not.toHaveBeenCalled()
    expect(input.reportOutcome).not.toHaveBeenCalled()
  } else {
    await waitFor(() => { expect(input.reportOutcome).toHaveBeenCalledWith('reviewUnconfirmed', true) })
    expect(ops.getPublication).toHaveBeenCalledExactlyOnceWith(publication.id)
    expect(input.onReplace).toHaveBeenCalledWith(publication)
  }
  expect(ops.review).toHaveBeenCalledOnce()
})

it('ignores review readback and feedback after its original authority is withdrawn', async () => {
  const { ops, current, input } = publications()
  const pending = Promise.withResolvers<Awaited<ReturnType<MarketActions['getPublication']>>>()
  ops.review.mockRejectedValueOnce({ details: { status: 409 } })
  ops.getPublication.mockReturnValueOnce(pending.promise)
  click(copy['review.submit']); click(copy.confirm)
  await waitFor(() => { expect(ops.getPublication).toHaveBeenCalledOnce() })
  current.value = false
  await act(async () => { pending.resolve(publication) })
  expect(input.onReplace).not.toHaveBeenCalled()
  expect(input.reportOutcome).not.toHaveBeenCalled()
})
