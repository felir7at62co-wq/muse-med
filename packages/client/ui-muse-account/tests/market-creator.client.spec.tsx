// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { MarketCreatorPage } from '../src/client/MarketCreatorPage.tsx'
import type { MarketActions } from '../src/client/market-mount.ts'
import { marketFixture } from './market-fixture.client.ts'

afterEach(cleanup)

const skill = marketFixture.find(row => row.manifest.kind === 'skill')!
const draft = { ...skill, status: 'draft' as const }

function harness() {
  const actions = {
    catalog: vi.fn<MarketActions['catalog']>(),
    legacyCatalog: vi.fn<MarketActions['legacyCatalog']>(),
    installed: vi.fn<MarketActions['installed']>(async () => []),
    identity: vi.fn<MarketActions['identity']>(async () => ({ publishers: [{ id: draft.publisherId, title: 'Studio' }], admin: false })),
    sources: vi.fn<MarketActions['sources']>(async () => ({ website: 'https://muse.test/market',
      bots: [], skills: [{ name: 'review', description: 'Review scenes' }, { name: 'script', description: 'Write a script' }] })),
    prepare: vi.fn<MarketActions['prepare']>(async () => ({ release: draft, enabled: false })),
    publishDraft: vi.fn<MarketActions['publishDraft']>(async () => draft),
    install: vi.fn(), installLegacy: vi.fn(), enable: vi.fn(), remove: vi.fn(),
    exportPackage: vi.fn(), importPackage: vi.fn(), review: vi.fn(),
  } satisfies MarketActions
  return { actions, t: (key: string) => key, onBack: vi.fn(), reportOutcome: vi.fn() }
}

it('prepares one selected local Skill for export even without a publishing login', async () => {
  const props = harness()
  props.actions.identity.mockRejectedValueOnce(new Error('login-required'))
  render(<MarketCreatorPage {...props} />)
  expect(screen.getByRole('heading', { name: 'creatorTitle' })).toBeDefined()
  const review = await screen.findByRole('radio', { name: 'review' })
  expect(screen.queryByRole('combobox', { name: 'sourceBot' })).toBeNull()
  const prepare = screen.getByRole<HTMLButtonElement>('button', { name: 'prepare' })
  expect(prepare.disabled).toBe(true)
  fireEvent.click(screen.getByRole('radio', { name: 'script' }))
  fireEvent.click(review)
  expect(screen.getByRole<HTMLInputElement>('radio', { name: 'script' }).checked).toBe(false)
  for (const [name, value] of Object.entries({ name: 'review', label: 'Scene review', summary: 'Check scenes', license: 'MIT', category: 'script' })) {
    fireEvent.change(screen.getByRole('textbox', { name }), { target: { value } })
  }
  fireEvent.click(prepare)

  expect(props.actions.prepare).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ kind: 'skill', name: 'review', skills: [] }), ['review'], '')
  expect((await screen.findByRole<HTMLButtonElement>('button', { name: 'export' })).disabled).toBe(false)
  expect(screen.getByRole<HTMLButtonElement>('button', { name: 'upload' }).disabled).toBe(true)
  expect(props.actions.publishDraft).not.toHaveBeenCalled()
  expect(props.actions.catalog).not.toHaveBeenCalled()
  expect(props.actions.legacyCatalog).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'creatorBack' }))
  expect(props.onBack).toHaveBeenCalledOnce()
})

it('offers local prepared ZIP packages and uploads only the explicitly selected package', async () => {
  const props = harness()
  props.actions.installed.mockResolvedValue([
    { release: draft, enabled: false },
    { release: { ...draft, id: '2'.repeat(64) as typeof draft.id, manifest: { ...draft.manifest, title: 'Original archive' } },
      enabled: false, legacySource: { id: 'muse/skills/review', sha256: 'f'.repeat(64) } },
    { release: { ...skill, id: '3'.repeat(32) as typeof draft.id, manifest: { ...skill.manifest, title: 'Cloud download' } }, enabled: false },
  ])
  render(<MarketCreatorPage {...props} initialKind="upload" />)
  const selector = await screen.findByRole('combobox', { name: 'localPackages' })
  expect(screen.getAllByRole('option').some(option => option.textContent?.includes('Original archive'))).toBe(false)
  expect(screen.getAllByRole('option').some(option => option.textContent?.includes('Cloud download'))).toBe(false)
  fireEvent.change(selector, { target: { value: draft.id } })
  expect(props.actions.publishDraft).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'upload' }))
  expect(props.actions.publishDraft).toHaveBeenCalledExactlyOnceWith(draft.id, draft.publisherId, expect.any(String))
  expect(await screen.findByRole('dialog', { name: draft.manifest.title })).toBeDefined()
  expect(props.actions.catalog).not.toHaveBeenCalled()
})

it('automatically matches the imported Bot ZIP portrait and passes it with the confirmed upload', async () => {
  const props = harness()
  const source = marketFixture.find(row => row.manifest.kind === 'bot')!
  const imported = { ...source, status: 'draft' as const,
    manifest: { ...source.manifest, title: '电影调色师', category: '影视后期', description: '为短剧统一色彩。' } }
  props.actions.importPackage.mockResolvedValue({ release: imported, enabled: false })
  props.actions.publishDraft.mockResolvedValue(imported)
  render(<MarketCreatorPage {...props} initialKind="upload" />)
  const file = new File(['ZIP'], 'colorist.zip', { type: 'application/zip' })
  Object.defineProperty(file, 'arrayBuffer', { value: async () => new TextEncoder().encode('ZIP').buffer })
  fireEvent.change(await screen.findByLabelText('browserArchive'), { target: { files: [file] } })
  const portrait = await screen.findByRole('img', { name: imported.manifest.title })
  expect(portrait.getAttribute('src')).toContain('colorist')
  expect(screen.queryByRole('combobox', { name: 'releasePortrait' })).toBeNull()
  expect(props.actions.importPackage).toHaveBeenCalledExactlyOnceWith('WklQ')
  expect(props.actions.publishDraft).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'upload' }))
  expect(props.actions.publishDraft).toHaveBeenCalledExactlyOnceWith(imported.id, draft.publisherId, expect.any(String), 'colorist')
  expect(await screen.findByRole('dialog', { name: imported.manifest.title })).toBeDefined()
})
