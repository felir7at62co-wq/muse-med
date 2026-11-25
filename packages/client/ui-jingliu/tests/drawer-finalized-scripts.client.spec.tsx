// @vitest-environment jsdom
/** Finalized Workshop scripts keep their selected version and project across library and drawer actions. */
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { StudioProject } from '@deepseek-ai/dsh-jingliu-connection/types'
import type { MuseDataWorkDetail } from '@deepseek-ai/dsh-muse-account/types'
import type { ScriptDetail, ScriptDraftList, ScriptList, ScriptSummary } from '@deepseek-ai/dsh-workbench-connection/types'
import { afterEach, expect, it, vi } from 'vitest'
import { DrawerScripts, type DrawerScriptsProps } from '../src/client/DrawerScripts.tsx'
import { en } from '../src/client/locales.ts'

const t = makeTranslate(en)
const owner = { id: 11, name: 'Yan' }
const initialScript: ScriptSummary = {
  id: 42, title: 'Paper Bridges', owner, rights: 'licensed', originWorkId: 'fanqie:700', originTitle: 'An old bridge',
  kind: 'drama', style: 'realistic', episodes: 2, words: 2200, status: 'waiting', latestVersion: 2, picked: null,
  project: null, createdAt: null, updatedAt: null,
}
const openScript = { id: String(initialScript.id), title: initialScript.title }

function detail(script: ScriptSummary, version: number): ScriptDetail {
  return {
    script, canPick: true,
    versions: [{ number: 2, words: 2200, createdAt: '2026-11-21T12:00:00Z', by: owner },
      { number: 1, words: 1850, createdAt: null, by: owner }],
    content: { version, episodes: [
      { order: 1, title: 'The crossing', content: '# Dusk at the bridge\r\n\r\n△Yan steps onto the bridge.\r\nYan(softly): Wait here.\r\nA bell rings.' },
      { order: 2, title: '', content: version === 1 ? 'The first ending.' : 'The revised ending.' },
    ] },
  }
}

function live<T>(value: T) { return { status: 'live' as const, value, failure: undefined } }
const failed = { status: 'failed', value: undefined, failure: undefined } as const
const loading = { ...failed, status: 'loading' } as const
const drafts: ScriptDraftList = { items: [], nextOffset: null }

function setup(read: (url: URL) => ReturnType<DrawerScriptsProps['useResource']> | undefined) {
  const requests: URL[] = []
  const useResource = ((address: string) => {
    const url = new URL(address)
    requests.push(url)
    if (url.hostname === 'workshop-drafts') return live(drafts)
    return read(url) ?? { status: 'none', value: undefined, failure: undefined }
  }) as DrawerScriptsProps['useResource']
  const pick = vi.fn<DrawerScriptsProps['pick']>()
  const link = vi.fn<DrawerScriptsProps['link']>()
  const props = {
    t, useResource, useAccountEpoch: select => select(3), script: null,
    openScript: vi.fn(), quote: vi.fn(), compose: vi.fn(), pick, link,
    draftActions: {
      applyCandidate: vi.fn(), saveEpisode: vi.fn(), discardCandidate: vi.fn(), finalizeDraft: vi.fn(),
      createDraft: vi.fn(), saveStoryboard: vi.fn(), restoreHistory: vi.fn(), exportDraft: vi.fn(),
    },
  } satisfies DrawerScriptsProps
  return { props, requests }
}

afterEach(cleanup)

it('retries, searches and pages through finalized scripts while keeping the active account and filters', () => {
  let pageReady = false
  const { props, requests } = setup((url) => {
    if (url.hostname !== 'workshop-scripts') return undefined
    const page = Number(url.searchParams.get('page'))
    if (url.searchParams.get('revision') === '0') return failed
    if (!pageReady) return loading
    if (url.searchParams.get('status') === 'in_production') return live<ScriptList>({
      items: [], total: 0, page, limit: 50, counts: { all: 51, waiting: 45, picked: 6, inProduction: 0 }, canPick: true,
    })
    const script = page === 2 ? { ...initialScript, id: 43, title: 'A Letter Across the Bridge',
      owner: { id: 13, name: null }, kind: 'narration' as const, style: '3d' as const } : initialScript
    const items = page === 2 ? [script, { ...script, id: 44, title: ' ', owner: { id: 15, name: 'Workshop archive' } }] : [script]
    return live<ScriptList>({ items, total: 51, page, limit: 50,
      counts: { all: 51, waiting: 45, picked: 6, inProduction: 0 }, canPick: true })
  })
  const lastSearch = () => Object.fromEntries(requests.filter(url => url.hostname === 'workshop-scripts').at(-1)!.searchParams)
  const view = render(<DrawerScripts {...props} />)
  fireEvent.click(view.getByRole('tab', { name: en.scriptLibrary }))
  const library = within(view.getByRole('region', { name: en.scriptLibrary }))
  expect(library.getByRole('alert').textContent).toContain(en.scriptsFailed)
  fireEvent.click(library.getByRole('button', { name: en.refresh }))
  expect(library.getByText(en.loading)).toBeTruthy()
  pageReady = true
  view.rerender(<DrawerScripts {...props} />)
  expect(library.getByRole('button', { name: /Paper Bridges/u })).toBeTruthy()
  expect(lastSearch()).toEqual({ epoch: '3', revision: '1', status: '', q: '', mine: '', page: '1', limit: '50' })

  const input = library.getByRole('textbox', { name: en.searchScripts })
  fireEvent.change(input, { target: { value: '  bridge  ' } })
  fireEvent.submit(library.getByRole('search'))
  fireEvent.click(library.getByRole('button', { name: /^Waiting/u }))
  fireEvent.click(library.getByRole('button', { name: en.onlyMine }))
  fireEvent.click(library.getByRole('button', { name: en.next }))
  expect(lastSearch()).toMatchObject({ status: 'waiting', q: 'bridge', mine: '1', page: '2' })
  expect(library.getByRole('button', { name: en.next })).toHaveProperty('disabled', true)
  const result = library.getByRole('button', { name: /A Letter Across the Bridge/u })
  expect(result.textContent).toContain(t('memberName', { id: '13' }))
  expect(library.getByRole('button', { name: /Workshop archive/u }).textContent?.startsWith('·')).toBe(true)
  fireEvent.click(result)
  expect(props.openScript).toHaveBeenCalledExactlyOnceWith({ id: '43', title: 'A Letter Across the Bridge' })

  fireEvent.click(library.getByRole('button', { name: en.previous }))
  expect(lastSearch()).toMatchObject({ page: '1', q: 'bridge' })
  fireEvent.click(library.getByRole('button', { name: en.next }))
  fireEvent.change(input, { target: { value: '' } })
  expect(lastSearch()).toMatchObject({ page: '1', q: '' })
  fireEvent.click(library.getByRole('button', { name: /^In production/u }))
  expect(lastSearch()).toMatchObject({ status: 'in_production', mine: '1' })
  expect(library.getByText(en.nothingHere)).toBeTruthy()
})

it('retries a failed finalized detail without switching scripts or losing its account', () => {
  let detailReady = false
  const { props, requests } = setup((url) => {
    if (url.hostname !== 'workshop-script') return undefined
    if (url.searchParams.get('revision') === '0') return failed
    return detailReady ? live(detail(initialScript, 2)) : loading
  })
  const drawer = <DrawerScripts {...props} script={openScript} />
  const view = render(drawer)
  const alert = within(view.getByRole('alert'))
  expect(alert.getByText(en.scriptsFailed)).toBeTruthy()
  fireEvent.click(alert.getByRole('button', { name: en.refresh }))
  expect(view.getByText(en.loading)).toBeTruthy()
  expect(view.queryByRole('alert')).toBeNull()
  detailReady = true
  view.rerender(<DrawerScripts {...props} script={openScript} />)
  expect(view.getByRole('region', { name: initialScript.title })).toBeTruthy()
  expect(view.getByRole('heading', { name: 'The crossing' })).toBeTruthy()
  expect(requests.filter(url => url.hostname === 'workshop-script').map(url => Object.fromEntries(url.searchParams))).toEqual([
    { epoch: '3', revision: '0', id: '42' }, { epoch: '3', revision: '1', id: '42' }, { epoch: '3', revision: '1', id: '42' },
  ])
})

it.each([null, 'Original manuscript'])('opens an original narration without episodes and uses the available version (%s)', (originTitle) => {
  const script: ScriptSummary = {
    ...initialScript, id: 43, title: 'Bridge stories', rights: 'original', originWorkId: null, originTitle,
    kind: 'narration', style: '3d', episodes: 0, words: 800, latestVersion: 4, status: 'picked',
  }
  const contents: ScriptDetail = { script, canPick: true, versions: [], content: { version: 4, episodes: [] } }
  const { props } = setup(url => url.hostname === 'workshop-script' ? live(contents) : undefined)
  const view = render(<DrawerScripts {...props} script={{ id: '43', title: script.title }} />)
  const info = within(view.getByRole('complementary', { name: en.scriptParams }))
  expect(info.getByText(en.rightsOriginal)).toBeTruthy()
  expect(info.getByText(en.scriptOrigin).nextElementSibling?.textContent).toBe(originTitle ?? '—')
  expect(info.getByText(en.scriptWords).nextElementSibling?.textContent).toBe(t('wordsValue', { value: '800' }))
  expect(info.getByText(t('versionLabel', { number: 4 }))).toBeTruthy()
  expect(info.queryByRole('combobox', { name: en.scriptVersion })).toBeNull()
  expect(view.getByText(en.nothingHere)).toBeTruthy()
  expect(view.queryByRole('article')).toBeNull()
  fireEvent.click(info.getByRole('button', { name: en.newJingliuProject }))
  expect(props.compose).toHaveBeenCalledExactlyOnceWith(t('scriptProjectRequest', {
    title: script.title, id: '43', version: '4', form: en.typeNarration, look: en.look3d, episodes: '0',
  }))
})

it('quotes the viewed episode but bases a new production on the accepted version', async () => {
  let script = initialScript
  const { props, requests } = setup(url => url.hostname === 'workshop-script'
    ? live(detail(script, Number(url.searchParams.get('version') ?? 2))) : undefined)
  props.pick.mockRejectedValueOnce(new Error('Workshop temporarily unavailable')).mockImplementationOnce(async ({ version }) => {
    script = { ...script, status: 'picked', picked: { version, by: owner, at: null } }
  })
  const view = render(<DrawerScripts {...props} script={openScript} />)
  expect(view.getByRole('heading', { name: 'Dusk at the bridge' })).toBeTruthy()
  expect(view.getByText('△Yan steps onto the bridge.')).toBeTruthy()
  expect(view.getByText('Yan(softly)').nextSibling?.textContent).toBe('Wait here.')
  expect(view.getByText('A bell rings.')).toBeTruthy()

  const version = () => view.getByRole('combobox', { name: en.scriptVersion })
  fireEvent.change(version(), { target: { value: '1' } })
  fireEvent.click(view.getByRole('button', { name: t('episodeTab', { order: '2' }) }))
  const episode = within(view.getByRole('article'))
  expect(episode.getByText('The first ending.')).toBeTruthy()
  fireEvent.click(episode.getByRole('button', { name: en.quoteAsset }))
  expect(props.quote).toHaveBeenCalledExactlyOnceWith(t('episodeReference', { title: script.title, id: '42', version: '1', order: '2' }))

  const pickVersion = () => view.getByRole('button', { name: en.pickVersion })
  fireEvent.click(pickVersion())
  expect((await view.findByRole('alert')).textContent).toBe(en.pickFailed)
  expect(view.queryByRole('button', { name: en.newJingliuProject })).toBeNull()
  fireEvent.click(pickVersion())
  await view.findByText(t('pickedBy', { version: '1', name: owner.name }))
  expect(view.queryByRole('button', { name: en.pickVersion })).toBeNull()
  expect(props.pick.mock.calls).toEqual([[{ id: 42, version: 1 }], [{ id: 42, version: 1 }]])
  expect(requests.some(url => url.hostname === 'workshop-script' && url.searchParams.get('version') === '1'
    && url.searchParams.get('revision') === '1')).toBe(true)

  fireEvent.change(version(), { target: { value: '2' } })
  fireEvent.click(view.getByRole('button', { name: en.newJingliuProject }))
  expect(props.compose).toHaveBeenCalledExactlyOnceWith(t('scriptProjectRequest', {
    title: script.title, id: '42', version: '1', form: en.typeDrama, look: en.lookLive, episodes: '2',
  }))
  const settings = within(view.getByRole('complementary', { name: en.scriptParams }))
  fireEvent.click(settings.getByRole('button', { name: en.quoteAsset }))
  expect(props.quote).toHaveBeenLastCalledWith(t('scriptReference', { title: script.title, id: '42', version: '2' }))
})

it('retries a failed project link and updates the script to the chosen production', async () => {
  let script: ScriptSummary = { ...initialScript, status: 'picked', picked: { version: 2, by: owner, at: null } }
  let projects: StudioProject[] | undefined
  const project: StudioProject = {
    id: 'p-1', title: 'Bridge pilot', episodes: 0, shots: 0, completed: 0, role: 'owner', thumbnail: '',
    mode: 'drama', aspect: '9:16', createdAt: '', profile: { videoModel: '', generationMode: '', resolution: '' },
  }
  const { props, requests } = setup((url) => {
    if (url.hostname === 'workshop-script') return live(detail(script, 2))
    if (url.hostname !== 'jingliu-projects') return undefined
    if (url.searchParams.get('revision') === '0') return failed
    return projects === undefined ? loading : live(projects)
  })
  props.link.mockRejectedValueOnce(new Error('Workshop write failed')).mockImplementationOnce(async ({ projectId, projectTitle }) => {
    script = { ...script, status: 'in_production', project: { id: projectId, title: projectTitle } }
  })
  const view = render(<DrawerScripts {...props} script={openScript} />)
  fireEvent.click(view.getByRole('button', { name: en.linkProject }))
  const error = within(view.getByRole('alert'))
  fireEvent.click(error.getByRole('button', { name: en.refresh }))
  expect(view.getByText(en.loading)).toBeTruthy()
  projects = []
  view.rerender(<DrawerScripts {...props} script={openScript} />)
  expect(view.getByText(en.emptyProjects)).toBeTruthy()
  expect(view.queryByRole('combobox', { name: en.chooseProject })).toBeNull()
  expect(props.link).not.toHaveBeenCalled()
  projects = [project, { ...project, id: 'p-2', title: 'Bridge production' }]
  view.rerender(<DrawerScripts {...props} script={openScript} />)
  const picker = view.getByRole('combobox', { name: en.chooseProject })
  expect(picker).toHaveProperty('value', 'p-1')
  fireEvent.change(picker, { target: { value: 'p-2' } })
  const submit = () => view.getAllByRole('button', { name: en.linkProject }).find(button => !button.hasAttribute('aria-expanded'))!
  fireEvent.click(submit())
  expect((await view.findByRole('alert')).textContent).toBe(en.linkFailed)
  expect(picker).toHaveProperty('value', 'p-2')
  fireEvent.click(submit())
  await view.findByText(t('inProductionAs', { title: 'Bridge production' }))
  expect(view.queryByRole('combobox', { name: en.chooseProject })).toBeNull()
  expect(view.queryByRole('button', { name: en.newJingliuProject })).toBeNull()
  expect(props.link.mock.calls).toEqual(Array.from({ length: 2 }, () => [{ id: 42, projectId: 'p-2', projectTitle: 'Bridge production' }]))
  expect(requests.some(url => url.hostname === 'workshop-script' && url.searchParams.get('revision') === '1')).toBe(true)
})

it('fetches source rankings on demand and retries without losing the displayed script', async () => {
  let sourceReady = false
  const work: MuseDataWorkDetail = {
    id: 'fanqie:700', platform: 'fanqie', sourceId: '700', title: 'An old bridge: original', author: 'Song',
    tags: ['Family', 'Mystery'], episodeCount: 32, wordCount: 16000, board: 'Adaptations', rank: 4,
    observedAt: '2026-11-21T12:00:00Z', metrics: [
      { key: 'unreported', label: 'Unavailable metric', value: null },
      ...['Readers', 'Saves', 'Likes', 'Reviews', 'Shares'].map((label, n) => ({ key: label, label, value: 100 - n })),
    ],
  }
  const { props, requests } = setup((url) => {
    if (url.hostname === 'workshop-script') return live(detail(initialScript, 2))
    if (url.hostname !== 'muse-data-work') return undefined
    if (url.searchParams.get('revision') === '0') return failed
    return sourceReady ? live(work) : loading
  })
  const view = render(<DrawerScripts {...props} script={openScript} />)
  expect(requests.some(url => url.hostname === 'muse-data-work')).toBe(false)
  const origin = view.getByRole('button', { name: initialScript.originTitle! })
  fireEvent.click(origin)
  expect(view.getByRole('alert').textContent).toContain(en.dataFailed)
  fireEvent.click(within(view.getByRole('alert')).getByRole('button', { name: en.refresh }))
  expect(view.getByText(en.loading)).toBeTruthy()
  sourceReady = true
  view.rerender(<DrawerScripts {...props} script={openScript} />)
  await waitFor(() => {
    expect(view.getByText(work.title!)).toBeTruthy()
  })
  const data = within(view.getByLabelText(en.originData))
  expect(data.getByText(/Adaptations · No\. 4/u)).toBeTruthy()
  expect(data.getByText('Readers').nextSibling?.textContent).toBe('100')
  expect(data.queryByText('Unavailable metric')).toBeNull()
  expect(data.queryByText('Shares')).toBeNull()
  const sourceRequests = requests.filter(url => url.hostname === 'muse-data-work')
  expect(sourceRequests.map(url => ({ id: url.searchParams.get('id'), revision: url.searchParams.get('revision') }))).toEqual([
    { id: work.id, revision: '0' }, { id: work.id, revision: '1' }, { id: work.id, revision: '1' },
  ])
  fireEvent.click(origin)
  expect(view.queryByLabelText(en.originData)).toBeNull()
  expect(view.getByRole('heading', { name: 'The crossing' })).toBeTruthy()
})

it('shows an unranked source by its ID when the catalog has no title, counts or valid date', () => {
  const work: MuseDataWorkDetail = {
    id: 'fanqie:700', platform: 'fanqie', sourceId: '700', title: null, author: null,
    tags: [], episodeCount: null, wordCount: null, board: 'Adaptations', rank: null, observedAt: '', metrics: [],
  }
  const script = { ...initialScript, originTitle: null }
  const { props, requests } = setup((url) => {
    if (url.hostname === 'workshop-script') return live(detail(script, 2))
    return url.hostname === 'muse-data-work' ? live(work) : undefined
  })
  const view = render(<DrawerScripts {...props} script={openScript} />)
  fireEvent.click(view.getByRole('button', { name: work.id }))
  const data = within(view.getByLabelText(en.originData))
  expect(data.getByText(work.sourceId)).toBeTruthy()
  expect(data.getByText(en.platformFanqie)).toBeTruthy()
  expect(data.getByText(work.board)).toBeTruthy()
  expect(data.queryByText(/No\. |observed|episodes|words/iu)).toBeNull()
  expect(requests.find(url => url.hostname === 'muse-data-work')?.searchParams.get('id')).toBe(work.id)
})
