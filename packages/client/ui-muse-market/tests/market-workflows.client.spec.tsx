// @vitest-environment jsdom
/** Market journeys through the registered panel, retained store and operation feedback. */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotTestRuntime, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { brandString } from '@deepseek-ai/dsh-brand'
import { parseMarketIdentity, parseMarketPublication } from '@deepseek-ai/dsh-muse-market/cloud-values'
import type { MarketAccountId } from '@deepseek-ai/dsh-muse-market/cloud-values'
import type { MarketReleaseId } from '@deepseek-ai/dsh-muse-market/types'
import { expect, it, onTestFinished, vi } from 'vitest'
import type { MarketActions, MarketInstallation } from '../src/client/market-actions.ts'
import { MarketController } from '../src/client/market-controller.ts'
import { registerMuseMarket } from '../src/client/market-registration.tsx'
import { createMarketOperations } from '../src/client/market-remote.ts'
import { marketEn as copy } from '../src/client/market-locales.ts'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
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

async function fixture() {
  const ops = operations()
  const success = <Args extends unknown[], Result>(operation: (...args: Args) => Promise<Result>) => async (...args: Args) =>
    ({ ok: true as const, value: await operation(...args) })
  const remote = createMarketOperations({
    museMarket: { sources: success(ops.sources), prepare: success(ops.prepare), installed: success(ops.installed),
      importPackage: success(ops.importPackage), exportPackage: success(ops.exportPackage), removePackage: success(ops.removePackage) },
    museMarketActivation: { defaults: success(ops.defaults), setDefault: success(ops.setDefault), binding: success(ops.binding) },
    museMarketCloud: { catalog: success(ops.catalog), identity: success(ops.identity), getPublication: success(ops.getPublication),
      publishDraft: success(ops.publishDraft), installPublication: success(ops.installPublication), review: success(ops.review) },
  })
  const runtime = await SlotTestRuntime.create(), controller = new MarketController(remote)
  onTestFinished(async () => { controller.dispose(); await runtime.dispose(); vi.restoreAllMocks() })
  const locale = new LocaleRuntime(runtime.ctx)
  runtime.ctx.provide('locale', locale)
  runtime.slots.installLocale(locale)
  const selectPanel = vi.fn()
  runtime.ctx.provide('layout', { selectPanel })
  await runtime.declare({ main: { kind: 'keyed', scope: 'root' }, 'sidebar.panellist': { kind: 'list', scope: 'root' },
    'settings.section': { kind: 'list', scope: 'root' }, 'shell.overlay': { kind: 'list', scope: 'root' } })
  const dispose = await registerMuseMarket(runtime.ctx, controller.operations, controller.access,
    revision => controller.isCurrentAccess(revision))
  onTestFinished(dispose)
  locale.setLocale('en')
  const panel = runtime.renderSlot('main', {}, { entryKey: 'muse-market' })
  runtime.renderSlot('shell.overlay', {})
  await panel.view.findByRole('heading', { name: publication.manifest.title })
  return { ops, runtime, panel, controller, selectPanel }
}

const click = (label: string) => { fireEvent.click(screen.getByRole('button', { name: label })) }
const tab = (label: string) => { fireEvent.click(screen.getByRole('tab', { name: label })) }

function publications(overrides: Partial<Parameters<typeof MarketPublications>[0]> = {}) {
  const ops = operations(), current = { value: true }
  const input = { accessRevision: 1, isCurrentAccess: () => current.value, items: [{ ...publication, status: 'draft' as const }],
    identity, actions: ops, busy: false, onReplace: vi.fn(), onDetails: vi.fn(), onInstall: vi.fn(),
    reportOutcome: vi.fn(), t: makeTranslate(copy), ...overrides }
  const view = render(<MarketPublications {...input} />)
  onTestFinished(() => { view.unmount() })
  return { ops, current, input, view }
}

function OtherMarketPanel() { return <div data-market-other-panel /> }

async function leaveMarket({ runtime, panel }: Pick<Awaited<ReturnType<typeof fixture>>, 'runtime' | 'panel'>) {
  await runtime.mount({ inject: ['slots'], apply(ctx) {
    ctx.slots.register({ name: 'main', key: 'other-market-test' }, OtherMarketPanel)
  } })
  panel.update({}, { entryKey: 'other-market-test' })
  expect(panel.container.querySelector('[data-market-other-panel]')).toBeTruthy()
}

function fillCreator(form: HTMLElement) {
  fireEvent.change(within(form).getByLabelText(copy.source), { target: { value: 'scene-review' } })
  for (const field of ['name', 'title', 'description', 'version', 'license', 'category'] as const) {
    fireEvent.change(within(form).getByLabelText(copy[`field.${field}`]), { target: { value: publication.manifest[field] } })
  }
}

it('keeps installation disabled until a separate confirmed default change, then allows disabling and removal', async () => {
  const { ops } = await fixture()
  click(copy.details)
  expect((await screen.findByRole('dialog')).textContent).toContain(publication.sha256)
  expect(screen.getByText('Keep the source.')).toBeTruthy()
  click(copy.close)
  click(copy.install)
  await screen.findByRole('button', { name: copy.useVersion })
  expect(ops.installPublication).toHaveBeenCalledExactlyOnceWith(publication.id, publication.sha256)
  expect(ops.setDefault).not.toHaveBeenCalled()
  click(copy.useVersion)
  expect(ops.setDefault).not.toHaveBeenCalled()
  click(copy.confirm)
  await waitFor(() => { expect(screen.getByRole('button', { name: copy.default }).hasAttribute('disabled')).toBe(true) })
  expect(ops.setDefault).toHaveBeenLastCalledWith({ skillName: 'scene-review', expected: null, target: installation.release.id })
  tab(copy.installed)
  await screen.findByRole('button', { name: copy.disable })
  expect(screen.getByRole('button', { name: copy.remove }).hasAttribute('disabled')).toBe(true)
  click(copy.disable); click(copy.confirm)
  await screen.findByRole('button', { name: copy.useVersion })
  expect(ops.setDefault).toHaveBeenLastCalledWith({ skillName: 'scene-review', expected: installation.release.id, target: null })
  click(copy.remove)
  await screen.findByText(copy.empty)
  expect(ops.removePackage).toHaveBeenCalledExactlyOnceWith(installation.release.id)
})

it('retains catalog content after a failed refresh and retries the current query without exposing upstream text', async () => {
  const { ops } = await fixture()
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'scene' } })
  ops.catalog.mockRejectedValueOnce({ details: { status: 409, code: 'catalog-changed' }, message: 'private upstream trace' })
  click(copy.search)
  await screen.findByRole('alert')
  expect(screen.getByRole('heading', { name: publication.manifest.title })).toBeTruthy()
  expect(screen.queryByText('private upstream trace')).toBeNull()
  click(copy.retry)
  await waitFor(() => { expect(screen.queryByRole('alert')).toBeNull() })
  expect(ops.catalog).toHaveBeenLastCalledWith('scene', false)
  click('writing')
  expect(screen.getByRole('button', { name: 'writing' }).getAttribute('aria-pressed')).toBe('true')
  click(copy.allCategories)
})

it('refetches the authoritative default after a conflicting confirmation', async () => {
  const { ops } = await fixture()
  click(copy.install); await screen.findByRole('button', { name: copy.useVersion })
  ops.setDefault.mockRejectedValueOnce({ details: { status: 409, code: 'default-conflict' } })
  ops.defaults.mockResolvedValue({ revision: 8, defaults: [{ skillName: 'scene-review', releaseId: installation.release.id }] })
  click(copy.useVersion); click(copy.confirm)
  await screen.findByText(copy.defaultConflict)
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(screen.getByRole('button', { name: copy.default }).hasAttribute('disabled')).toBe(true)
  expect(ops.setDefault).toHaveBeenCalledTimes(1)
})

it('prepares the selected local Skill and uploads a private draft without setting a default', async () => {
  const { ops } = await fixture()
  tab(copy.publish)
  const form = await screen.findByRole('region', { name: copy.creator })
  fillCreator(form)
  fireEvent.change(within(form).getByLabelText(copy['field.requirements']), { target: { value: 'Keep source.\n\nCheck dialogue.' } })
  fireEvent.change(within(form).getByLabelText(copy['field.examples']), { target: { value: 'Review one.\n' } })
  fireEvent.submit(within(form).getByRole('button', { name: copy.prepare }).closest('form')!)
  await within(form).findByRole('button', { name: copy.upload })
  expect(ops.prepare).toHaveBeenCalledExactlyOnceWith({ name: 'scene-review', title: 'Scene review', description: 'Review the original scene.',
    version: '1.0.0', license: 'MIT', category: 'writing', requirements: ['Keep source.', 'Check dialogue.'], examples: ['Review one.'] }, 'scene-review')
  fireEvent.change(within(form).getByLabelText(copy.publisher), { target: { value: publication.publisherId } })
  click(copy.upload)
  await screen.findByText(copy.draftDone)
  expect(ops.publishDraft).toHaveBeenCalledOnce()
  expect(ops.publishDraft.mock.calls[0]?.slice(0, 2)).toEqual([installation.release.id, publication.publisherId])
  expect(ops.setDefault).not.toHaveBeenCalled()
})

it('imports the original ZIP bytes and reports a refused local deletion without removing the row', async () => {
  const { ops } = await fixture()
  tab(copy.installed)
  await screen.findByText(copy.empty)
  const file = new File([new Uint8Array([0, 255, 1, 128])], 'scene.zip', { type: 'application/zip' })
  Object.defineProperty(file, 'arrayBuffer', { value: async () => new Uint8Array([0, 255, 1, 128]).buffer })
  fireEvent.change(screen.getByLabelText(copy.import), { target: { files: [file] } })
  await screen.findByRole('heading', { name: publication.manifest.title })
  expect(ops.importPackage).toHaveBeenCalledExactlyOnceWith('AP8BgA==')
  ops.removePackage.mockRejectedValueOnce({ details: { status: 409, code: 'release-in-use' } })
  click(copy.remove)
  await screen.findByText(copy.releaseInUse)
  expect(screen.getByRole('heading', { name: publication.manifest.title })).toBeTruthy()
  fireEvent.change(screen.getByLabelText(copy.import), { target: { files: [] } })
  expect(ops.importPackage).toHaveBeenCalledTimes(1)
})

it('keeps one upload request identity across creator remounts and refuses retry under another account', async () => {
  const { ops, controller } = await fixture()
  click(copy.install); await screen.findByRole('button', { name: copy.useVersion })
  tab(copy.publish)
  await screen.findByRole('region', { name: copy.creator })
  fireEvent.change(screen.getByLabelText(copy.chooseLocal), { target: { value: installation.release.id } })
  fireEvent.change(screen.getByLabelText(copy.publisher), { target: { value: publication.publisherId } })
  ops.publishDraft.mockRejectedValueOnce({ details: { status: 409, code: 'uncertain-write' } })
  click(copy.upload)
  await screen.findByText(copy.failed)
  const original = ops.publishDraft.mock.calls[0]
  expect(original).toBeDefined()
  tab(copy.installed); await screen.findByRole('button', { name: copy.remove })
  tab(copy.publish)
  await screen.findByRole('button', { name: copy.retryUpload })
  expect(screen.getByLabelText(copy.source).hasAttribute('disabled')).toBe(true)
  ops.identity.mockResolvedValue({ ...identity, accountId: brandString<MarketAccountId>('e'.repeat(16)) })
  await act(async () => { controller.invalidateAccess() })
  await waitFor(() => { expect(screen.getByRole('button', { name: copy.retryUpload }).hasAttribute('disabled')).toBe(true) })
  expect(ops.publishDraft).toHaveBeenCalledTimes(1)
  ops.identity.mockResolvedValue(identity)
  await act(async () => { controller.invalidateAccess() })
  await waitFor(() => { expect(screen.getByRole('button', { name: copy.retryUpload }).hasAttribute('disabled')).toBe(false) })
  click(copy.retryUpload)
  await screen.findByText(copy.draftDone)
  expect(ops.publishDraft.mock.calls[1]).toEqual(original)
  expect(screen.queryByRole('button', { name: copy.discardUpload })).toBeNull()
})

it('requires explicit confirmation before discarding an uncertain upload attempt', async () => {
  const { ops } = await fixture()
  click(copy.install); await screen.findByRole('button', { name: copy.useVersion })
  tab(copy.publish); await screen.findByRole('region', { name: copy.creator })
  fireEvent.change(screen.getByLabelText(copy.chooseLocal), { target: { value: installation.release.id } })
  fireEvent.change(screen.getByLabelText(copy.publisher), { target: { value: publication.publisherId } })
  ops.publishDraft.mockRejectedValueOnce({ details: { status: 409, code: 'uncertain-write' } })
  click(copy.upload); await screen.findByText(copy.failed)
  click(copy.discardUpload)
  expect(await screen.findByText(copy.discardUploadHint)).toBeTruthy()
  click(copy.close)
  expect(screen.getByRole('button', { name: copy.retryUpload })).toBeTruthy()
  click(copy.discardUpload); click(copy.confirm)
  await screen.findByRole('button', { name: copy.upload })
  expect(screen.getByLabelText(copy.source).hasAttribute('disabled')).toBe(false)
  expect(ops.publishDraft).toHaveBeenCalledTimes(1)
})

it.each([
  { status: 'draft', action: 'submit', next: 'pending' },
  { status: 'rejected', action: 'submit', next: 'pending' },
  { status: 'pending', action: 'approve', next: 'published' },
  { status: 'pending', action: 'reject', next: 'rejected' },
  { status: 'published', action: 'withdraw', next: 'withdrawn' },
] as const)('confirms $action using the original publication revision and displays the returned $next status', async ({ status, action, next }) => {
  const { ops } = await fixture()
  ops.catalog.mockResolvedValue([{ ...publication, status, reviewNote: status === 'rejected' ? 'Revise examples.' : '' }])
  ops.review.mockResolvedValue({ ...publication, status: next, revision: 2 })
  tab(copy.publish)
  await screen.findByText(copy[`publication.${status}`])
  click(copy.details)
  await screen.findByRole('dialog')
  click(copy.close)
  click(copy[`review.${action}`])
  if (action === 'approve') expect(screen.getByText(copy.reviewPackageFirst)).toBeTruthy()
  if (action === 'reject') {
    expect(screen.getByRole('button', { name: copy.confirm }).hasAttribute('disabled')).toBe(true)
    fireEvent.change(screen.getByLabelText(copy.reviewNote), { target: { value: '  Add a complete example.  ' } })
  }
  click(copy.confirm)
  await screen.findByText(copy[`publication.${next}`])
  expect(ops.review).toHaveBeenCalledExactlyOnceWith(publication.id, 1, action, action === 'reject' ? 'Add a complete example.' : '')
  expect(ops.setDefault).not.toHaveBeenCalled()
})

it.each([true, false])('reads the original publication after an uncertain review without resubmitting (readback=%s)', async (readback) => {
  const { ops } = await fixture()
  ops.catalog.mockResolvedValue([{ ...publication, status: 'draft' }])
  ops.review.mockRejectedValueOnce({ details: { status: 409, code: 'uncertain-write' } })
  if (readback) ops.getPublication.mockResolvedValue({ ...publication, status: 'pending', revision: 2 })
  else ops.getPublication.mockRejectedValueOnce({ details: { status: 409, code: 'uncertain-read' } })
  tab(copy.publish); await screen.findByText(copy['publication.draft'])
  click(copy['review.submit']); click(copy.confirm)
  await screen.findByText(copy.reviewUnconfirmed)
  expect(ops.getPublication).toHaveBeenCalledExactlyOnceWith(publication.id)
  expect(ops.review).toHaveBeenCalledTimes(1)
  expect(screen.getByText(copy[readback ? 'publication.pending' : 'publication.draft'])).toBeTruthy()
})

it('opens the main panel from the settings link and renders the navigation icon', async () => {
  const { runtime, selectPanel } = await fixture()
  runtime.renderSlot('sidebar.panellist', { size: 20, active: false })
  const close = vi.fn()
  const settings = runtime.renderSlot('settings.section', { close })
  expect(runtime.slots.entries('settings.section').map(entry => resolveSlotLabel(entry.options.label))).toEqual([copy.nav])
  fireEvent.click(settings.view.getByRole('button', { name: copy.openMarket }))
  expect(selectPanel).toHaveBeenCalledExactlyOnceWith('muse-market')
  expect(close).toHaveBeenCalledOnce()
})

it('retains local rows across a failed inventory refresh and ignores a cloud result after switching tabs', async () => {
  const { ops, panel } = await fixture()
  click(copy.install); await screen.findByRole('button', { name: copy.useVersion })
  ops.installed.mockRejectedValueOnce(Error('Local storage is unavailable'))
  click(copy.refresh)
  await panel.view.findByRole('alert')
  expect(screen.getByRole('heading', { name: publication.manifest.title })).toBeTruthy()
  click(copy.retry)
  await waitFor(() => { expect(panel.view.queryByRole('alert')).toBeNull() })
  const old = Promise.withResolvers<Awaited<ReturnType<MarketActions['catalog']>>>()
  ops.catalog.mockReturnValueOnce(old.promise)
  const prior = ops.catalog.mock.calls.length
  click(copy.refresh)
  await waitFor(() => { expect(ops.catalog).toHaveBeenCalledTimes(prior + 1) })
  tab(copy.installed)
  await screen.findByRole('button', { name: copy.remove })
  await act(async () => { old.resolve([]) })
  expect(screen.getByRole('heading', { name: publication.manifest.title })).toBeTruthy()
  expect(screen.queryByText(copy.empty)).toBeNull()
})

it('reports unavailable sources without blocking installed management and restores incomplete source choices', async () => {
  const { ops } = await fixture()
  ops.sources.mockRejectedValueOnce(Error('Source inventory unavailable'))
  click(copy.refresh)
  await waitFor(() => { expect(screen.getByRole('button', { name: copy.refresh }).hasAttribute('disabled')).toBe(false) })
  tab(copy.installed); await screen.findByText(copy.empty)
  ops.sources.mockResolvedValue({ complete: false, skills: [] })
  ops.identity.mockResolvedValue({ ...identity, publishers: [], admin: false })
  tab(copy.publish)
  await screen.findByText(copy.sourcesIncomplete)
  await screen.findByText(copy.noPublisher)
  expect(screen.getByRole('button', { name: copy.prepare }).hasAttribute('disabled')).toBe(true)
  expect(screen.queryByRole('button', { name: copy['review.withdraw'] })).toBeNull()
})

it('exports the Host archive from both installed management and the selected creator package', async () => {
  const { ops } = await fixture()
  const create = vi.fn().mockReturnValue('blob:market-export'), revoke = vi.fn()
  const NativeURL = URL
  vi.stubGlobal('URL', class extends NativeURL { static override createObjectURL = create; static override revokeObjectURL = revoke })
  onTestFinished(() => { vi.unstubAllGlobals() })
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  click(copy.install); await screen.findByRole('button', { name: copy.useVersion })
  tab(copy.installed); await screen.findByRole('button', { name: copy.export })
  click(copy.details); await screen.findByRole('dialog'); click(copy.close)
  click(copy.export)
  await waitFor(() => { expect(ops.exportPackage).toHaveBeenCalledTimes(1) })
  tab(copy.publish); await screen.findByRole('region', { name: copy.creator })
  fireEvent.change(screen.getByLabelText(copy.chooseLocal), { target: { value: installation.release.id } })
  click(copy.export)
  await waitFor(() => { expect(ops.exportPackage).toHaveBeenCalledTimes(2) })
  await waitFor(() => { expect(revoke).toHaveBeenCalledTimes(2) })
  ops.exportPackage.mockRejectedValueOnce({ details: { status: 409, code: 'invalid-archive' } })
  click(copy.export); await screen.findByText(copy.invalidPackage)
  fireEvent.change(screen.getByLabelText(copy.chooseLocal), { target: { value: '' } })
  expect(screen.queryByRole('button', { name: copy.export })).toBeNull()
})

it('installs a creator publication without implicitly activating it and cancels review confirmation', async () => {
  const { ops } = await fixture()
  tab(copy.publish); await screen.findByText(copy['publication.published'])
  click(copy['review.withdraw']); await screen.findByRole('dialog'); click(copy.close)
  expect(ops.review).not.toHaveBeenCalled()
  click(copy.install)
  await screen.findByText(copy.installedDone)
  expect(ops.installPublication).toHaveBeenCalledExactlyOnceWith(publication.id, publication.sha256)
  expect(ops.setDefault).not.toHaveBeenCalled()
})

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

it('reports a preparation failure without selecting or uploading a local package', async () => {
  const { ops } = await fixture()
  ops.prepare.mockRejectedValueOnce({ details: { status: 409, code: 'invalid-manifest' } })
  tab(copy.publish)
  const form = await screen.findByRole('region', { name: copy.creator })
  fillCreator(form)
  fireEvent.submit(within(form).getByRole('button', { name: copy.prepare }).closest('form')!)
  await screen.findByText(copy.invalidPackage)
  expect(screen.getByLabelText(copy.chooseLocal)).toHaveProperty('value', '')
  expect(ops.publishDraft).not.toHaveBeenCalled()
})

it('retains a prepared package when the creator form leaves before preparation completes', async () => {
  const { ops } = await fixture()
  const pending = Promise.withResolvers<MarketInstallation>()
  ops.prepare.mockReturnValueOnce(pending.promise)
  tab(copy.publish)
  const form = await screen.findByRole('region', { name: copy.creator })
  fillCreator(form)
  fireEvent.submit(within(form).getByRole('button', { name: copy.prepare }).closest('form')!)
  await waitFor(() => { expect(ops.prepare).toHaveBeenCalledOnce() })
  tab(copy.installed)
  await screen.findByText(copy.empty)
  await act(async () => { pending.resolve(installation) })
  await screen.findByRole('heading', { name: publication.manifest.title })
  expect(ops.publishDraft).not.toHaveBeenCalled()
})

it('settles an upload after leaving its form without starting another publication read', async () => {
  const { ops } = await fixture()
  click(copy.install); await screen.findByRole('button', { name: copy.useVersion })
  tab(copy.publish); await screen.findByRole('region', { name: copy.creator })
  fireEvent.change(screen.getByLabelText(copy.chooseLocal), { target: { value: installation.release.id } })
  fireEvent.change(screen.getByLabelText(copy.publisher), { target: { value: publication.publisherId } })
  const pending = Promise.withResolvers<Awaited<ReturnType<MarketActions['publishDraft']>>>()
  ops.publishDraft.mockReturnValueOnce(pending.promise)
  click(copy.upload)
  await waitFor(() => { expect(ops.publishDraft).toHaveBeenCalledOnce() })
  tab(copy.installed); await screen.findByRole('button', { name: copy.remove })
  const reads = ops.catalog.mock.calls.length
  await act(async () => { pending.resolve({ ...publication, status: 'draft' }) })
  await screen.findByText(copy.draftDone)
  expect(ops.catalog).toHaveBeenCalledTimes(reads)
})

it('reports an export failure after leaving its creator form without restoring that form', async () => {
  const { ops } = await fixture()
  click(copy.install); await screen.findByRole('button', { name: copy.useVersion })
  tab(copy.publish); await screen.findByRole('region', { name: copy.creator })
  fireEvent.change(screen.getByLabelText(copy.chooseLocal), { target: { value: installation.release.id } })
  const pending = Promise.withResolvers<Awaited<ReturnType<MarketActions['exportPackage']>>>()
  ops.exportPackage.mockReturnValueOnce(pending.promise)
  click(copy.export)
  await waitFor(() => { expect(ops.exportPackage).toHaveBeenCalledOnce() })
  tab(copy.installed); await screen.findByRole('button', { name: copy.remove })
  await act(async () => { pending.reject({ details: { status: 409, code: 'invalid-archive' } }) })
  await screen.findByText(copy.invalidPackage)
  expect(screen.queryByRole('region', { name: copy.creator })).toBeNull()
})

it('closes discard confirmation safely when its upload has already completed', async () => {
  const { ops } = await fixture()
  click(copy.install); await screen.findByRole('button', { name: copy.useVersion })
  tab(copy.publish); await screen.findByRole('region', { name: copy.creator })
  fireEvent.change(screen.getByLabelText(copy.chooseLocal), { target: { value: installation.release.id } })
  fireEvent.change(screen.getByLabelText(copy.publisher), { target: { value: publication.publisherId } })
  const pending = Promise.withResolvers<Awaited<ReturnType<MarketActions['publishDraft']>>>()
  ops.publishDraft.mockReturnValueOnce(pending.promise)
  click(copy.upload); click(copy.discardUpload)
  await act(async () => { pending.resolve({ ...publication, status: 'draft' }) })
  await screen.findByText(copy.draftDone)
  click(copy.confirm)
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(screen.queryByRole('button', { name: copy.retryUpload })).toBeNull()
  expect(ops.publishDraft).toHaveBeenCalledOnce()
})

it('does not start cloud reads after leaving while a local inventory is pending', async () => {
  const f = await fixture()
  const pending = Promise.withResolvers<MarketInstallation[]>()
  f.ops.installed.mockReturnValueOnce(pending.promise)
  click(copy.refresh)
  await waitFor(() => { expect(f.ops.installed).toHaveBeenCalledTimes(2) })
  const reads = f.ops.catalog.mock.calls.length
  await leaveMarket(f)
  await act(async () => { pending.resolve([installation]) })
  expect(f.ops.catalog).toHaveBeenCalledTimes(reads)
  expect(f.panel.container.querySelector('[data-market-other-panel]')).toBeTruthy()
})

it('does not restore an obsolete failed inventory after a newer tab read succeeds', async () => {
  const { ops } = await fixture()
  const pending = Promise.withResolvers<MarketInstallation[]>()
  ops.installed.mockReturnValueOnce(pending.promise)
  click(copy.refresh)
  await waitFor(() => { expect(ops.installed).toHaveBeenCalledTimes(2) })
  tab(copy.installed); await screen.findByText(copy.empty)
  await act(async () => { pending.reject(Error('Obsolete inventory failed')) })
  expect(screen.queryByRole('alert')).toBeNull()
  expect(screen.getByRole('tab', { name: copy.installed }).getAttribute('aria-selected')).toBe('true')
})

it('keeps stale source choices out of the next creator form while its new inventory is pending', async () => {
  const { ops } = await fixture()
  const old = Promise.withResolvers<Awaited<ReturnType<MarketActions['sources']>>>()
  const fresh = Promise.withResolvers<Awaited<ReturnType<MarketActions['sources']>>>()
  ops.sources.mockReturnValueOnce(old.promise)
  click(copy.refresh)
  await waitFor(() => { expect(ops.sources).toHaveBeenCalledTimes(2) })
  tab(copy.installed); await screen.findByText(copy.empty)
  await act(async () => { old.resolve({ complete: true, skills: [{ name: 'stale-source', description: 'Old inventory.' }] }) })
  ops.sources.mockReturnValueOnce(fresh.promise)
  tab(copy.publish)
  const form = await screen.findByRole('region', { name: copy.creator })
  expect(within(form).queryByRole('option', { name: 'stale-source' })).toBeNull()
  expect(within(form).getByRole('option', { name: 'scene-review' })).toBeTruthy()
  await act(async () => { fresh.resolve({ complete: true, skills: [{ name: 'scene-review', description: 'Current source.' }] }) })
})

it('keeps an unresolved default conflict available for dismissal and refuses dismissal during its write', async () => {
  const { ops } = await fixture()
  click(copy.install); await screen.findByRole('button', { name: copy.useVersion })
  const pending = Promise.withResolvers<Awaited<ReturnType<MarketActions['setDefault']>>>()
  ops.setDefault.mockReturnValueOnce(pending.promise)
  ops.defaults.mockRejectedValueOnce(Error('Default read unavailable'))
  click(copy.useVersion); click(copy.confirm); click(copy.close)
  expect(screen.getByRole('dialog')).toBeTruthy()
  await act(async () => { pending.reject({ details: { status: 409, code: 'default-conflict' } }) })
  await screen.findByText(copy.defaultConflict)
  expect(screen.getByRole('dialog')).toBeTruthy()
  click(copy.close)
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(ops.setDefault).toHaveBeenCalledOnce()
})

it('does not reopen a default confirmation when conflict readback arrives after navigation', async () => {
  const f = await fixture()
  click(copy.install); await screen.findByRole('button', { name: copy.useVersion })
  const pending = Promise.withResolvers<Awaited<ReturnType<MarketActions['defaults']>>>()
  f.ops.setDefault.mockRejectedValueOnce({ details: { status: 409, code: 'default-conflict' } })
  f.ops.defaults.mockReturnValueOnce(pending.promise)
  click(copy.useVersion); click(copy.confirm)
  await waitFor(() => { expect(f.ops.defaults).toHaveBeenCalledTimes(2) })
  await leaveMarket(f)
  await act(async () => { pending.resolve({ revision: 9, defaults: [] }) })
  await screen.findByText(copy.defaultConflict)
  expect(f.panel.container.querySelector('[data-market-other-panel]')).toBeTruthy()
  expect(screen.queryByRole('dialog')).toBeNull()
})

it('confirms an update against the existing default while keeping the old local release', async () => {
  const { ops } = await fixture()
  const oldId = brandString<MarketReleaseId>('f'.repeat(64))
  ops.installed.mockResolvedValue([{ ...installation, release: { ...installation.release, id: oldId, sha256: oldId } }])
  ops.defaults.mockResolvedValue({ revision: 3, defaults: [{ skillName: 'scene-review', releaseId: oldId }] })
  click(copy.refresh)
  await screen.findByRole('button', { name: copy.installUpdate })
  click(copy.installUpdate)
  await screen.findByRole('button', { name: copy.useVersion })
  click(copy.useVersion); click(copy.confirm)
  await screen.findByText(copy.defaultDone)
  expect(ops.setDefault).toHaveBeenCalledExactlyOnceWith({ skillName: 'scene-review', expected: oldId, target: installation.release.id })
  expect(ops.removePackage).not.toHaveBeenCalled()
})

it('withdraws private publication details when their account generation changes', async () => {
  const { ops, controller } = await fixture()
  ops.catalog.mockResolvedValue([{ ...publication, status: 'draft' }])
  tab(copy.publish); await screen.findByText(copy['publication.draft'])
  click(copy.details); await screen.findByRole('dialog')
  await act(async () => { controller.invalidateAccess() })
  await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
  expect(ops.review).not.toHaveBeenCalled()
})

it('replaces only the reviewed publication while preserving a different draft', async () => {
  const { ops } = await fixture()
  const other = parseMarketPublication({ ...publication, id: 'e'.repeat(32), status: 'draft' }, { archiveBytes: 1024, recordBytes: 4096 })
  ops.catalog.mockResolvedValue([{ ...publication, status: 'draft' }, other])
  tab(copy.publish)
  await waitFor(() => { expect(screen.getAllByText(copy['publication.draft'])).toHaveLength(2) })
  const card = document.querySelector<HTMLElement>(`[data-market-publication="${publication.id}"]`)!
  fireEvent.click(within(card).getByRole('button', { name: copy['review.submit'] })); click(copy.confirm)
  await screen.findByText(copy['publication.pending'])
  expect(screen.getAllByText(copy['publication.draft'])).toHaveLength(1)
  expect(ops.review).toHaveBeenCalledExactlyOnceWith(publication.id, publication.revision, 'submit', '')
})

it.each(['discover', 'publish'] as const)('finishes a %s install after leaving without replacing the newly selected panel', async (surface) => {
  const f = await fixture()
  if (surface === 'publish') { tab(copy.publish); await screen.findByText(copy['publication.published']) }
  const pending = Promise.withResolvers<Awaited<ReturnType<MarketActions['installPublication']>>>()
  f.ops.installPublication.mockReturnValueOnce(pending.promise)
  click(copy.install)
  await waitFor(() => { expect(f.ops.installPublication).toHaveBeenCalledOnce() })
  await leaveMarket(f)
  await act(async () => { pending.resolve({ publication, installation }) })
  await screen.findByText(copy.installedDone)
  expect(f.panel.container.querySelector('[data-market-other-panel]')).toBeTruthy()
  expect(f.ops.setDefault).not.toHaveBeenCalled()
})

it('finishes a default write after navigation without reopening its confirmation', async () => {
  const f = await fixture()
  click(copy.install); await screen.findByRole('button', { name: copy.useVersion })
  const pending = Promise.withResolvers<Awaited<ReturnType<MarketActions['setDefault']>>>()
  f.ops.setDefault.mockReturnValueOnce(pending.promise)
  click(copy.useVersion); click(copy.confirm)
  await waitFor(() => { expect(f.ops.setDefault).toHaveBeenCalledOnce() })
  await leaveMarket(f)
  await act(async () => { pending.resolve({ revision: 1, defaults: [{ skillName: 'scene-review', releaseId: installation.release.id }] }) })
  await screen.findByText(copy.defaultDone)
  expect(f.panel.container.querySelector('[data-market-other-panel]')).toBeTruthy()
  expect(screen.queryByRole('dialog')).toBeNull()
})

it('settles a review after panel navigation without restoring its publication cards', async () => {
  const f = await fixture()
  f.ops.catalog.mockResolvedValue([{ ...publication, status: 'draft' }])
  tab(copy.publish); await screen.findByText(copy['publication.draft'])
  const pending = Promise.withResolvers<Awaited<ReturnType<MarketActions['review']>>>()
  f.ops.review.mockReturnValueOnce(pending.promise)
  click(copy['review.submit']); click(copy.confirm)
  await waitFor(() => { expect(f.ops.review).toHaveBeenCalledOnce() })
  await leaveMarket(f)
  await act(async () => { pending.resolve({ ...publication, status: 'pending', revision: 2 }) })
  await screen.findByText(copy.reviewDone)
  expect(f.panel.container.querySelector('[data-market-other-panel]')).toBeTruthy()
})

it('finishes archive import and removal after leaving their installed views', async () => {
  const first = await fixture()
  tab(copy.installed); await screen.findByText(copy.empty)
  const imported = Promise.withResolvers<MarketInstallation>()
  first.ops.importPackage.mockReturnValueOnce(imported.promise)
  const file = new File([new Uint8Array([0, 255, 1, 128])], 'scene.zip', { type: 'application/zip' })
  Object.defineProperty(file, 'arrayBuffer', { value: async () => new Uint8Array([0, 255, 1, 128]).buffer })
  fireEvent.change(screen.getByLabelText(copy.import), { target: { files: [file] } })
  await waitFor(() => { expect(first.ops.importPackage).toHaveBeenCalledOnce() })
  await leaveMarket(first)
  await act(async () => { imported.resolve(installation) })
  await screen.findByText(copy.installedDone)
  expect(first.panel.container.querySelector('[data-market-other-panel]')).toBeTruthy()
  await first.runtime.dispose()

  const second = await fixture()
  click(copy.install); await screen.findByRole('button', { name: copy.useVersion })
  tab(copy.installed); await screen.findByRole('button', { name: copy.remove })
  const removed = Promise.withResolvers<Awaited<ReturnType<MarketActions['removePackage']>>>()
  second.ops.removePackage.mockReturnValueOnce(removed.promise)
  click(copy.remove)
  await waitFor(() => { expect(second.ops.removePackage).toHaveBeenCalledOnce() })
  await leaveMarket(second)
  await act(async () => { removed.resolve() })
  await screen.findByText(copy.done)
  expect(second.panel.container.querySelector('[data-market-other-panel]')).toBeTruthy()
})
