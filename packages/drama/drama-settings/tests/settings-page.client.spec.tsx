// @vitest-environment jsdom
/**
 * The short-drama Settings page as a person meets it: the values each group
 * shows, the save and restore paths, and every notice it can print.
 *
 * Props are fed directly (the documented component tier): `t` is built from the
 * package's own `en` dictionary so every assertion reads the copy a user sees,
 * and the injected face is a stub standing in for the namespace scope.
 */
import { cleanup, fireEvent, render, screen, waitFor, act } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import {
  DEFAULT_BGM_DIR, DRAMA_SETTINGS_DEFAULTS, type DramaSettings,
} from '../src/settings.ts'
import { DramaSettingsSection } from '../src/client/DramaSettingsSection.tsx'
import type { DramaSettingsSectionProps } from '../src/client/DramaSettingsSection.tsx'
import { DRAMA_COMPONENTS, type DramaComponentState } from '../src/client/components.ts'
import type { DramaImageRoute, DramaImageRoutes } from '../src/client/routes.ts'
import { draftOf, type DramaWriteOutcome } from '../src/client/section.ts'
import { en, STATUS_COPY, type DramaLocaleKey } from '../src/client/locales.ts'

afterEach(cleanup)

const t = ((key: DramaLocaleKey, params?: Record<string, string | number>): string =>
  Object.entries(params ?? {}).reduce(
    (text, [name, value]) => text.replaceAll(`{${name}}`, String(value)),
    en[key],
  )) as DramaSettingsSectionProps['t']

/** The live account catalogue's shape: two payable gpt-image-2 rows. */
const ROUTES: readonly DramaImageRoute[] = [
  { standardId: 66, platformId: 'KU_AI', unitPrice: 0.12, unit: '元/条' },
  { standardId: 76, platformId: 'DUO_YUAN_TAN_SUO', unitPrice: 1.05, unit: '元/条' },
]

/**
 * The label one payable row shows: platform, its own price, and the id that pins it.
 * @param route - one catalogue row.
 * @returns the option text as the page composes it.
 */
function routeLabel(route: DramaImageRoute): string {
  return en.imageRouteOption
    .replace('{platform}', route.platformId)
    .replace('{price}', `${String(route.unitPrice)} ${route.unit ?? ''}`.trim())
    .replace('{id}', String(route.standardId))
}

/** One snapshot of the bound namespace scope, ready unless a test says otherwise. */
function snapshot(overrides: Partial<SettingsScopeSnapshot<DramaSettings>> = {}): SettingsScopeSnapshot<DramaSettings> {
  return {
    status: 'ready',
    value: DRAMA_SETTINGS_DEFAULTS,
    base: undefined,
    user: undefined,
    revision: 1,
    writable: true,
    mode: 'host',
    ...overrides,
  }
}

interface Bench {
  readonly write: ReturnType<typeof vi.fn<(draft: ReturnType<typeof draftOf>) => Promise<DramaWriteOutcome>>>
  readonly restoreDefaults: ReturnType<typeof vi.fn<() => Promise<DramaWriteOutcome>>>
  readonly components: ReturnType<typeof vi.fn<() => Promise<DramaComponentState[]>>>
  readonly imageRoutes: ReturnType<typeof vi.fn<() => Promise<DramaImageRoutes>>>
  /** Render the page again over one new snapshot, as a commit would. */
  readonly commit: (next: Partial<SettingsScopeSnapshot<DramaSettings>>) => void
  /** Let a pending read — the component list or the account catalogue — settle. */
  readonly settle: () => Promise<void>
}

/** One state per composed package, all in the same status unless a test says otherwise. */
function states(status: DramaComponentState['status'] = 'loaded'): DramaComponentState[] {
  return DRAMA_COMPONENTS.map(component => ({ component, status }))
}

/** Render the page over a scripted namespace snapshot and a stubbed write face. */
function mount(
  initial: Partial<SettingsScopeSnapshot<DramaSettings>> = {},
  answers: {
    write?: DramaWriteOutcome
    restoreDefaults?: DramaWriteOutcome
    components?: DramaComponentState[]
    imageRoutes?: DramaImageRoutes
  } = {},
): Bench {
  let current = snapshot(initial)
  const write = vi.fn(async (): Promise<DramaWriteOutcome> => answers.write ?? 'saved')
  const restoreDefaults = vi.fn(async (): Promise<DramaWriteOutcome> => answers.restoreDefaults ?? 'saved')
  const components = vi.fn(async (): Promise<DramaComponentState[]> => answers.components ?? states())
  const imageRoutes = vi.fn(async (): Promise<DramaImageRoutes> =>
    answers.imageRoutes ?? { status: 'ok', routes: ROUTES })
  const props = (): DramaSettingsSectionProps => ({
    close: vi.fn(),
    t,
    useDrama: ((selector: (value: SettingsScopeSnapshot<DramaSettings>) => unknown) => selector(current)),
    write,
    restoreDefaults,
    components,
    imageRoutes,
  }) as unknown as DramaSettingsSectionProps
  const view = render(<DramaSettingsSection {...props()} />)
  return {
    write,
    restoreDefaults,
    components,
    imageRoutes,
    settle: async () => { await act(async () => { await Promise.resolve() }) },
    commit: (next) => {
      current = snapshot(next)
      view.rerender(<DramaSettingsSection {...props()} />)
    },
  }
}

/** One labeled text box by its accessible name. */
function box(label: string): HTMLInputElement {
  return screen.getByLabelText(label) as HTMLInputElement
}

/** The image-route select by its accessible name. */
function routeSelect(): HTMLSelectElement {
  return screen.getByLabelText(en.imageRouteTitle) as HTMLSelectElement
}

describe('DramaSettingsSection — read states', () => {
  it('holds a loading line until the first section arrives', () => {
    const bench = mount({ status: 'loading', value: undefined })
    expect(screen.getByText(en.loading)).toBeDefined()
    bench.commit({})
    expect(screen.getByText(en.deliveryDirTitle)).toBeDefined()
  })

  it('says the namespace is unavailable instead of drawing an empty form', () => {
    mount({ status: 'unavailable', value: undefined })
    expect(screen.getByText(en.unavailable)).toBeDefined()
    expect(screen.queryByText(en.deliveryDirTitle)).toBeNull()
  })

  it('shows the resolved section in every group', () => {
    mount()
    expect(box(en.deliveryDirTitle).value).toBe('')
    expect(box(en.deliveryDirTitle).placeholder).toBe(en.deliveryDirPlaceholder)
    expect(box(en.jianyingDraftDirTitle).value).toBe('')
    expect(box(en.jianyingDraftDirTitle).placeholder).toBe(en.jianyingDraftDirPlaceholder)
    expect(screen.getByText(en.jianyingDraftDirDescription)).toBeDefined()
    expect(box(en.specWidth).value).toBe('1440')
    expect(box(en.specHeight).value).toBe('2560')
    expect(box(en.specFps).value).toBe('60')
    expect(box(en.specBitrate).value).toBe('4.6')
    expect(box(en.bgmDirTitle).value).toBe(DEFAULT_BGM_DIR)
    expect(box(en.bgmDirTitle).placeholder).toBe(DEFAULT_BGM_DIR)
    expect(routeSelect().value).toBe('')
    expect(box(en.seriesBudgetTitle).value).toBe('4000')
    expect(screen.getByText(en.seriesBudgetDescription.replace('{amount}', '4000'))).toBeDefined()
  })

  it('adopts a commit made elsewhere', () => {
    const bench = mount()
    bench.commit({ value: { ...DRAMA_SETTINGS_DEFAULTS, deliveryDir: 'D:\\out' }, revision: 2 })
    expect(box(en.deliveryDirTitle).value).toBe('D:\\out')
  })

  it('disables both writes and explains why on a read-only deployment', () => {
    mount({ writable: false })
    expect(screen.getByText(en.readOnly)).toBeDefined()
    expect(screen.getByRole('button', { name: en.save }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('button', { name: en.reset }).hasAttribute('disabled')).toBe(true)
  })
})

describe('DramaSettingsSection — writes', () => {
  it('keeps Save disabled until the form differs from the resolved section', () => {
    mount()
    const save = screen.getByRole('button', { name: en.save })
    expect(save.hasAttribute('disabled')).toBe(true)

    fireEvent.change(box(en.deliveryDirTitle), { target: { value: 'D:\\out' } })
    expect(save.hasAttribute('disabled')).toBe(false)

    fireEvent.change(box(en.deliveryDirTitle), { target: { value: '' } })
    expect(save.hasAttribute('disabled')).toBe(true)
  })

  it('sends the whole draft, including a box the person blanked', async () => {
    const bench = mount()
    fireEvent.change(box(en.jianyingDraftDirTitle), { target: { value: 'D:\\draft' } })
    fireEvent.change(box(en.bgmDirTitle), { target: { value: '' } })
    fireEvent.change(box(en.specWidth), { target: { value: '1080' } })
    fireEvent.change(box(en.specHeight), { target: { value: '1920' } })
    fireEvent.change(box(en.specFps), { target: { value: '30' } })
    fireEvent.change(box(en.specBitrate), { target: { value: '3.25' } })
    fireEvent.click(screen.getByRole('button', { name: en.save }))

    await screen.findByText(en.saved)
    expect(bench.write).toHaveBeenCalledWith({
      ...draftOf(DRAMA_SETTINGS_DEFAULTS),
      jianyingDraftDir: 'D:\\draft',
      bgmDir: '',
      width: '1080',
      height: '1920',
      fps: '30',
      minBitrateMbps: '3.25',
    })
  })

  it('edits a yuan budget and preserves it in the draft sent for saving', async () => {
    const bench = mount()
    fireEvent.change(box(en.seriesBudgetTitle), { target: { value: '12.30' } })
    fireEvent.click(screen.getByRole('button', { name: en.save }))
    await screen.findByText(en.saved)
    expect(bench.write).toHaveBeenCalledWith({ ...draftOf(DRAMA_SETTINGS_DEFAULTS), seriesBudgetYuan: '12.30' })
    bench.commit({ value: { ...DRAMA_SETTINGS_DEFAULTS, seriesBudgetCents: 1230 } })
    expect(box(en.seriesBudgetTitle).value).toBe('12.3')
    expect(screen.getByText(en.seriesBudgetDescription.replace('{amount}', '12.3'))).toBeDefined()
  })

  it('refuses blank and invalid budgets without sending a write', () => {
    const bench = mount()
    for (const value of ['', '-1', '1.234', '90071992547409.92']) {
      fireEvent.change(box(en.seriesBudgetTitle), { target: { value } })
      expect(screen.getByRole('button', { name: en.save }).hasAttribute('disabled')).toBe(true)
      expect(screen.getByText(en.invalidNumber)).toBeDefined()
    }
    expect(bench.write).not.toHaveBeenCalled()
  })

  it('shows the busy label while a write is in flight', async () => {
    let settle: (outcome: DramaWriteOutcome) => void = () => {}
    const bench = mount()
    bench.write.mockImplementationOnce(() => new Promise<DramaWriteOutcome>((resolve) => { settle = resolve }))

    fireEvent.change(box(en.deliveryDirTitle), { target: { value: 'D:\\out' } })
    fireEvent.click(screen.getByRole('button', { name: en.save }))

    const saving = screen.getByRole('button', { name: en.saving })
    expect(saving.hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('button', { name: en.resetting }).hasAttribute('disabled')).toBe(true)

    settle('saved')
    await screen.findByText(en.saved)
  })

  it('reports a refused write and leaves the edited form in place', async () => {
    mount({}, { write: 'rejected' })
    fireEvent.change(box(en.deliveryDirTitle), { target: { value: 'D:\\out' } })
    fireEvent.click(screen.getByRole('button', { name: en.save }))

    await screen.findByText(en.rejected)
    expect(box(en.deliveryDirTitle).value).toBe('D:\\out')
    await waitFor(() => {
      expect(screen.getByRole('button', { name: en.save }).hasAttribute('disabled')).toBe(false)
    })
  })

  it('rejects a delivery-spec box that holds no number before sending a write', () => {
    const bench = mount()
    fireEvent.change(box(en.specWidth), { target: { value: '' } })
    expect(screen.getByText(en.invalidNumber)).toBeDefined()
    expect(screen.getByRole('button', { name: en.save }).hasAttribute('disabled')).toBe(true)
    expect(bench.write).not.toHaveBeenCalled()
  })

  it('restores the defaults through the face and reports it', async () => {
    const bench = mount({ value: { ...DRAMA_SETTINGS_DEFAULTS, deliveryDir: 'D:\\out' } })
    fireEvent.click(screen.getByRole('button', { name: en.reset }))

    await screen.findByText(en.resetDone)
    expect(bench.restoreDefaults).toHaveBeenCalledOnce()
    expect(bench.write).not.toHaveBeenCalled()
  })

  it('reports a restore the host refused', async () => {
    mount({ value: { ...DRAMA_SETTINGS_DEFAULTS, deliveryDir: 'D:\\out' } }, { restoreDefaults: 'rejected' })
    fireEvent.click(screen.getByRole('button', { name: en.reset }))
    await screen.findByText(en.rejected)
  })
})

describe('DramaSettingsSection — the asset-image route', () => {
  it('offers every payable row by platform, its own price and the id that pins it', async () => {
    const bench = mount()
    expect(screen.getByText(en.imageRouteLoading)).toBeDefined()
    await bench.settle()

    const select = routeSelect()
    expect([...select.options].map(option => option.textContent))
      .toEqual([en.imageRouteUnset, ...ROUTES.map(route => routeLabel(route))])
  })

  it('shows the pinned row as selected and saves a newly chosen one', async () => {
    const bench = mount({ value: { ...DRAMA_SETTINGS_DEFAULTS, imageStandardId: 66 } })
    await bench.settle()
    expect(routeSelect().value).toBe('66')

    fireEvent.change(routeSelect(), { target: { value: '76' } })
    fireEvent.click(screen.getByRole('button', { name: en.save }))

    await screen.findByText(en.saved)
    expect(bench.write).toHaveBeenCalledWith({ ...draftOf(DRAMA_SETTINGS_DEFAULTS), imageStandardId: '76' })
  })

  it('pins no row again when the select is cleared', async () => {
    const bench = mount({ value: { ...DRAMA_SETTINGS_DEFAULTS, imageStandardId: 66 } })
    await bench.settle()

    fireEvent.change(routeSelect(), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: en.save }))

    await screen.findByText(en.saved)
    expect(bench.write).toHaveBeenCalledWith({ ...draftOf(DRAMA_SETTINGS_DEFAULTS) })
  })

  it('keeps a pinned row the catalogue no longer lists instead of dropping it', async () => {
    const bench = mount({ value: { ...DRAMA_SETTINGS_DEFAULTS, imageStandardId: 99 } })
    await bench.settle()

    expect(routeSelect().value).toBe('99')
    expect(screen.getByText(en.imageRouteMissing.replace('{id}', '99'))).toBeDefined()
    // The row the section pins is still what the form holds, so nothing differs.
    expect(screen.getByRole('button', { name: en.save }).hasAttribute('disabled')).toBe(true)
    expect(bench.write).not.toHaveBeenCalled()
  })

  it('says why there are no rows to offer instead of showing an empty catalogue', async () => {
    const cases: [DramaImageRoutes, string][] = [
      [{ status: 'ok', routes: [] }, en.imageRouteEmpty],
      [{ status: 'unavailable' }, en.imageRouteUnavailable],
      [{ status: 'failed', message: 'Jubian credential is not configured' },
        en.imageRouteFailed.replace('{reason}', 'Jubian credential is not configured')],
    ]
    for (const [routes, copy] of cases) {
      cleanup()
      const bench = mount({}, { imageRoutes: routes })
      expect(screen.getByText(en.imageRouteLoading)).toBeDefined()
      await bench.settle()
      expect(screen.getByText(copy)).toBeDefined()
    }
  })
})

describe('DramaSettingsSection — the component list', () => {
  it('names every composed package, its role and its reported status', async () => {
    const bench = mount({}, { components: states('inactive') })
    expect(screen.getByText(en.componentsLoading)).toBeDefined()
    await bench.settle()

    expect(screen.getByText(en.componentsTitle)).toBeDefined()
    expect(screen.getByText(en.componentsDescription)).toBeDefined()
    for (const component of DRAMA_COMPONENTS) {
      expect(screen.getByText(component.pkg)).toBeDefined()
      expect(screen.getByText(en[component.role])).toBeDefined()
    }
    expect(screen.getAllByText(en[STATUS_COPY.inactive])).toHaveLength(DRAMA_COMPONENTS.length)
    // The BGM package is named as an independent plugin rather than as a drama package.
    expect(en['component.bgm.role']).toContain('bgm_match')
  })

  it('shows each distinct status the inventory can report', async () => {
    const statuses: DramaComponentState['status'][] = ['loaded', 'starting', 'failed', 'conditional', 'inactive']
    const bench = mount({}, {
      components: DRAMA_COMPONENTS.map((component, index) => ({
        component,
        status: statuses[index] ?? 'absent',
        ...index === 3 ? { condition: 'win32' } : {},
      })),
    })
    await bench.settle()

    for (const status of statuses) expect(screen.getByText(en[STATUS_COPY[status]])).toBeDefined()
    expect(screen.getByText(en.componentsCondition.replace('{condition}', 'win32'))).toBeDefined()
    expect(screen.queryByText(en.componentsUnqueried)).toBeNull()
  })

  it('says the run state could not be queried instead of showing a package as loaded', async () => {
    const bench = mount({}, { components: states('unknown') })
    await bench.settle()

    expect(screen.getAllByText(en[STATUS_COPY.unknown])).toHaveLength(DRAMA_COMPONENTS.length)
    expect(screen.getByText(en.componentsUnqueried)).toBeDefined()
    expect(screen.queryByText(en[STATUS_COPY.loaded])).toBeNull()
  })

  it('keeps the list on a deployment whose settings namespace is unavailable', async () => {
    const bench = mount({ status: 'unavailable', value: undefined }, { components: states('absent') })
    await bench.settle()

    expect(screen.getByText(en.unavailable)).toBeDefined()
    expect(screen.getByText(en.componentsTitle)).toBeDefined()
    expect(screen.getAllByText(en[STATUS_COPY.absent])).toHaveLength(DRAMA_COMPONENTS.length)
  })

  it('ignores an inventory answer that arrives after the page is gone', async () => {
    let answer: (next: DramaComponentState[]) => void = () => {}
    const components = vi.fn(() => new Promise<DramaComponentState[]>((resolve) => { answer = resolve }))
    const view = render(
      <DramaSettingsSection
        {...({
          close: vi.fn(),
          t,
          useDrama: ((selector: (value: SettingsScopeSnapshot<DramaSettings>) => unknown) =>
            selector(snapshot())),
          write: vi.fn(),
          restoreDefaults: vi.fn(),
          components,
          imageRoutes: vi.fn(async (): Promise<DramaImageRoutes> => ({ status: 'ok', routes: ROUTES })),
        } as unknown as DramaSettingsSectionProps)}
      />,
    )
    view.unmount()
    answer(states())
    await Promise.resolve()
    expect(view.container.innerHTML).toBe('')
  })
})
