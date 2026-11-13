// @vitest-environment jsdom
/** Market journeys through the registered panel, retained store and operation feedback. */
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
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

const publication = parseMarketPublication({ id: 'a'.repeat(32), publisherId: 'b'.repeat(32), publisher: 'Writing team',
  manifest: { formatVersion: 1, kind: 'skill', name: 'scene-review', title: 'Scene review', description: 'Review the original scene.',
    version: '1.0.0', license: 'MIT', category: 'writing', requirements: ['Keep the source.'], examples: ['Review chapter one.'],
    skills: [{ name: 'scene-review', path: 'skills/scene-review/SKILL.md' }] },
  sha256: 'c'.repeat(64), bytes: 512, status: 'published', reviewNote: '', revision: 1, createdAt: '2026-11-09T00:00:00.000Z',
}, { archiveBytes: 1024, recordBytes: 4096 })
const installation: MarketInstallation = { enabled: false, release: { id: brandString<MarketReleaseId>(publication.sha256),
  sha256: publication.sha256, bytes: publication.bytes, manifest: publication.manifest } }
const identity = parseMarketIdentity({ accountId: 'd'.repeat(16), publishers: [{ id: publication.publisherId, title: publication.publisher }], admin: true })

async function fixture() {
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
  fireEvent.change(within(form).getByLabelText(copy.source), { target: { value: 'scene-review' } })
  for (const field of ['name', 'title', 'description', 'version', 'license', 'category'] as const) {
    fireEvent.change(within(form).getByLabelText(copy[`field.${field}`]), { target: { value: publication.manifest[field] } })
  }
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
