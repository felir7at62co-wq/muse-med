// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { useSyncExternalStore, type ComponentProps } from 'react'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { MarketGuide, rememberMarketGuide, shouldShowMarketGuide } from '../src/client/MarketGuide.tsx'
import { MarketBotModeLink, MarketPage, MarketPanelIcon } from '../src/client/MarketPage.tsx'
import { MarketReleaseDetails } from '../src/client/MarketReleaseDetails.tsx'
import { createMarketFeedback, MarketFeedbackOverlay } from '../src/client/market-feedback.tsx'
import { marketFixture } from './market-fixture.client.ts'

vi.mock('../src/client/MarketGuide.module.css', () => ({ default: {} }))
vi.mock('../src/client/MarketSection.module.css', () => ({ default: {} }))

afterEach(() => { cleanup(); vi.restoreAllMocks() })
const t = (key: string) => key

it('supports moving back through all guide steps and remembers completion', () => {
  const storageKey = 'dsh.muse-market.guide.v1'
  const previous = localStorage.getItem(storageKey)
  onTestFinished(() => {
    if (previous === null) localStorage.removeItem(storageKey)
    else localStorage.setItem(storageKey, previous)
  })
  const close = vi.fn(rememberMarketGuide)
  render(<MarketGuide web={false} t={t} onClose={close} />)
  const guide = screen.getByRole('dialog', { name: 'guideTitle' })
  const click = (name: string) => fireEvent.click(within(guide).getByRole('button', { name }))

  expect(within(guide).getByRole('heading', { name: 'guideKinds' })).toBeDefined()
  click('guideNext')
  expect(within(guide).getByRole('heading', { name: 'guideFind' })).toBeDefined()
  click('guidePrevious')
  expect(within(guide).getByRole('heading', { name: 'guideKinds' })).toBeDefined()
  click('guideNext')
  click('guideNext')
  expect(within(guide).getByText('guideDesktopUseBody')).toBeDefined()
  click('guidePrevious')
  expect(within(guide).getByRole('heading', { name: 'guideFind' })).toBeDefined()
  click('guideNext')
  click('guideStart')
  expect(close).toHaveBeenCalledOnce()
  expect(shouldShowMarketGuide()).toBe(false)
})

it('explains browser use without requiring access to blocked browser storage', () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw Error('storage blocked') })
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw Error('storage blocked') })
  expect(shouldShowMarketGuide()).toBe(false)
  expect(() => { rememberMarketGuide() }).not.toThrow()

  const onClose = vi.fn()
  render(<MarketGuide web t={t} onClose={onClose} />)
  fireEvent.click(screen.getByRole('button', { name: 'guideNext' }))
  fireEvent.click(screen.getByRole('button', { name: 'guideNext' }))
  expect(screen.getByText('guideWebUseBody')).toBeDefined()
  fireEvent.click(screen.getByRole('button', { name: 'guideSkip' }))
  expect(onClose).toHaveBeenCalledOnce()
})

it('renders the shell market and accessible navigation with the library glyph', async () => {
  const navigation = { getSnapshot: () => true, subscribe: () => () => {}, openSession: vi.fn(async () => true) }
  const onOpen = vi.fn()
  const { container } = render(<>
    <MarketPanelIcon size={24} active />
    <MarketBotModeLink t={t} wide navigation={navigation} onOpen={onOpen} />
  </>)
  expect(container.querySelector('svg[width="24"]')).not.toBeNull()
  const shortcut = screen.getByRole('button', { name: 'nav' })
  expect(shortcut.textContent).toContain('nav')
  fireEvent.click(shortcut)
  expect(onOpen).toHaveBeenCalledOnce()

  const unavailable = async (): Promise<never> => { throw Error('unused') }
  render(<MarketPage mode="web" initialView="publish" t={t} reportOutcome={vi.fn()} onOpenCreator={vi.fn()}
    actions={{ archiveBytes: 4096, legacyCatalog: async () => [], catalog: async () => [],
      identity: async () => { throw Error('login-required') }, review: unavailable, uploadArchive: unavailable,
      previewArchive: unavailable, downloadArchive: unavailable }} />)
  expect(await screen.findByText('browserSignInHint')).toBeDefined()
})

it('shows a usable details dialog when stylesheet classes are unavailable', () => {
  const release = marketFixture[1]!
  const onClose = vi.fn()
  const view = render(<MarketReleaseDetails release={release} t={t} enabledOriginalSkill onClose={onClose} />)
  const dialog = screen.getByRole('dialog', { name: release.manifest.title })
  expect(within(dialog).getByText('legacySkillUsage')).toBeDefined()
  fireEvent.click(within(dialog).getByRole('button', { name: 'close' }))
  expect(onClose).toHaveBeenCalledOnce()
  view.rerender(<MarketReleaseDetails release={{ ...release, manifest: { ...release.manifest,
    examples: [], requirements: [], skills: [] } }} t={t} enabledOriginalSkill={false} onClose={onClose} />)
  expect(within(dialog).queryByText('legacySkillUsage')).toBeNull()
  expect(within(dialog).queryByRole('heading', { name: 'examples' })).toBeNull()
})

it('renders success and failure outcomes independently of the market panel', () => {
  const feedback = createMarketFeedback()
  const useOutcome: ComponentProps<typeof MarketFeedbackOverlay>['useOutcome'] = selector =>
    useSyncExternalStore(feedback.hooks.outcome.subscribe, () => selector(feedback.hooks.outcome.getSnapshot()))
  render(<MarketFeedbackOverlay useOutcome={useOutcome} dismiss={feedback.dismiss} t={t} />)
  expect(screen.queryByText('done')).toBeNull()
  act(() => { feedback.report('done', false) })
  expect(screen.getByText('done')).toBeDefined()
  act(() => { feedback.report('error.generic', true) })
  expect(screen.getByText('error.generic')).toBeDefined()
  expect(screen.queryByText('done')).toBeNull()
  act(() => { feedback.dismiss() })
  expect(screen.queryByText('error.generic')).toBeNull()
  feedback.dispose()
})
