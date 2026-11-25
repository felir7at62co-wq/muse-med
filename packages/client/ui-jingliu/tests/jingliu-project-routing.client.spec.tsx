// @vitest-environment jsdom
/** Project navigation only opens a workbench or sends a request after its account operation succeeds. */
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { SelectedProject, StudioCatalog, StudioConfig, StudioProject, StudioShot } from '@deepseek-ai/dsh-jingliu-connection/types'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { afterEach, expect, it, vi } from 'vitest'
import { DrawerJingliu } from '../src/client/DrawerJingliu.tsx'
import { en } from '../src/client/locales.ts'

type Props = Parameters<typeof DrawerJingliu>[0]
const t = makeTranslate(en)
const sessionId = SessionId('bridge-work')
const project: StudioProject = {
  id: 'p3', title: 'The Paper Bridge', episodes: 2, shots: 1, completed: 0, role: 'owner', thumbnail: '',
  mode: 'narration_dlg', aspect: '9:16', createdAt: '2026-11-21T12:00:00Z',
  profile: { videoModel: 'archived-model', generationMode: 'references', resolution: '720p' },
}
const selected = { id: project.id, title: project.title }
const other = { ...project, id: 'p4', title: 'Old Harbor', createdAt: '', mode: 'narration' }
const catalog: StudioCatalog = {
  modes: [
    { key: 'drama', label: 'Story', styles: [{ key: 'city', label: 'City', enabled: true }] },
    { key: 'narration', label: 'Narrated', styles: [{ key: 'city', label: 'City', enabled: true }] },
    { key: 'narration_dlg', label: 'Narrated 3D', styles: [{ key: 'city', label: 'City', enabled: true },
      ...['clay', 'paper', 'ink', 'watercolor', 'retired'].map(key => ({ key, label: key, enabled: key !== 'retired' }))] },
  ],
  aspects: ['9:16', '16:9'], resolutions: ['480p', '720p'],
  videoModels: [{ id: 'motion-v2', name: 'Motion' }], imageModels: [{ id: 'draw-v3', name: 'Draw' }],
  generationModes: [{ id: 'references', name: 'Reference set' }],
}
const live = <T,>(value: T) => ({ status: 'live' as const, value, failure: undefined })
const failed = { status: 'failed', value: undefined, failure: undefined } as const
const loading = { ...failed, status: 'loading' } as const

function setup(read: (url: URL) => ReturnType<Props['useResource']> | undefined, shown: SelectedProject | null = null) {
  const reads: URL[] = []
  const useResource = ((address: string) => {
    const url = new URL(address)
    if (url.protocol !== 'dsh-resource:') return { status: 'none', value: undefined, failure: undefined }
    reads.push(url)
    const snapshot = read(url)
    if (snapshot !== undefined) return snapshot
    switch (url.hostname) {
      case 'jingliu-selected': return live(null)
      case 'jingliu-projects': return live([project, other])
      case 'jingliu-catalog': return live(catalog)
      default: return loading
    }
  }) as Props['useResource']
  const props = {
    t, sessionId, useResource, project: shown, useAccountEpoch: <T,>(select: (value: number) => T) => select(4),
    openProject: vi.fn(), quote: vi.fn(), compose: vi.fn(), chooseProject: vi.fn<Props['chooseProject']>().mockResolvedValue(undefined),
    createProject: vi.fn<Props['createProject']>(), renameProject: vi.fn<Props['renameProject']>().mockResolvedValue(undefined),
    saveOption: vi.fn<Props['saveOption']>().mockResolvedValue(undefined), savePreferences: vi.fn<Props['savePreferences']>(),
    loadVideo: vi.fn<Props['loadVideo']>(), deleteShot: vi.fn<Props['deleteShot']>(),
  }
  const draw = () => <DrawerJingliu {...props as Props} />
  return { draw, props, reads }
}

afterEach(cleanup)

it('retries a failed project catalog and opens a search result only after the conversation can take it', async () => {
  const { draw, props, reads } = setup(url => url.hostname === 'jingliu-projects' && url.searchParams.get('revision') === '0'
    ? failed : undefined)
  props.chooseProject.mockRejectedValueOnce(new Error('Conversation binding failed'))
  const view = render(draw())
  expect(view.getByRole('alert').textContent).toContain(en.failed)
  fireEvent.click(within(view.getByRole('alert')).getByRole('button', { name: en.refresh }))
  expect(view.getByRole('button', { name: /The Paper Bridge/u })).toBeTruthy()
  expect(reads.some(url => url.hostname === 'jingliu-projects' && url.searchParams.get('revision') === '1'
    && url.searchParams.get('epoch') === '4')).toBe(true)

  fireEvent.click(view.getByRole('button', { name: en.searchProjects }))
  const dialog = within(view.getByRole('dialog', { name: en.searchProjects }))
  const search = dialog.getByRole('textbox', { name: en.searchProjects })
  fireEvent.change(search, { target: { value: 'high cliffs' } })
  expect(dialog.getByText(en.noSuchProject)).toBeTruthy()
  fireEvent.change(search, { target: { value: '  PAPER BRIDGE ' } })
  expect(dialog.queryByRole('button', { name: /Old Harbor/u })).toBeNull()
  const result = dialog.getByRole('button', { name: /The Paper Bridge/u })
  fireEvent.click(result)
  expect((await dialog.findByRole('alert')).textContent).toBe(en.navFailed)
  expect(search).toHaveProperty('value', '  PAPER BRIDGE ')
  expect(props.openProject).not.toHaveBeenCalled()
  fireEvent.click(result)
  await waitFor(() => { expect(view.queryByRole('dialog')).toBeNull() })
  expect(props.chooseProject.mock.calls).toEqual([[sessionId, project], [sessionId, project]])
  expect(props.openProject).toHaveBeenCalledExactlyOnceWith(selected)
})

it('creates a narrated 3D production with the chosen catalog values after a failed write', async () => {
  const { draw, props, reads } = setup(() => undefined)
  const result = { id: 'created', title: 'The Clay Door' }
  props.createProject.mockRejectedValueOnce(new Error('Studio write failed')).mockResolvedValueOnce(result)
  const view = render(draw())
  fireEvent.click(view.getByRole('button', { name: en.newProject }))
  const dialog = within(view.getByRole('dialog', { name: en.newProject }))
  const title = dialog.getByRole('textbox', { name: en.projectName })
  const submit = dialog.getByRole('button', { name: en.create })
  fireEvent.change(title, { target: { value: '   ' } })
  expect(submit).toHaveProperty('disabled', true)
  fireEvent.change(title, { target: { value: result.title } })
  fireEvent.click(dialog.getByRole('tab', { name: en.typeNarration }))
  fireEvent.click(dialog.getByRole('tab', { name: en.look3d }))
  const styles = within(dialog.getByRole('radiogroup', { name: en.artStyle }))
  expect(styles.queryByRole('radio', { name: 'City' })).toBeNull()
  expect(styles.getByRole('radio', { name: 'retired' })).toHaveProperty('disabled', true)
  fireEvent.click(styles.getByRole('radio', { name: 'paper' }))
  fireEvent.click(dialog.getByRole('tab', { name: '16:9' }))
  fireEvent.click(dialog.getByRole('tab', { name: '720p' }))
  fireEvent.change(dialog.getByRole('combobox', { name: en.videoModel }), { target: { value: 'motion-v2' } })
  fireEvent.change(dialog.getByRole('combobox', { name: en.imageModel }), { target: { value: 'draw-v3' } })
  fireEvent.change(dialog.getByRole('combobox', { name: en.generationMode }), { target: { value: 'references' } })

  fireEvent.click(submit)
  expect((await dialog.findByRole('alert')).textContent).toBe(en.saveFailed)
  expect(styles.getByRole('radio', { name: 'paper' }).getAttribute('aria-checked')).toBe('true')
  expect(props.openProject).not.toHaveBeenCalled()
  fireEvent.click(submit)
  await waitFor(() => { expect(view.queryByRole('dialog')).toBeNull() })
  const request = { title: result.title, artStyle: 'paper', mode: 'narration_dlg', aspect: '16:9', resolution: '720p',
    videoModel: 'motion-v2', imageModel: 'draw-v3', generationMode: 'references' }
  expect(props.createProject.mock.calls).toEqual([[sessionId, request], [sessionId, request]])
  expect(props.openProject).toHaveBeenCalledExactlyOnceWith(result)
  expect(reads.some(url => url.hostname === 'jingliu-projects' && url.searchParams.get('revision') === '1')).toBe(true)
})

it('loads project settings after a read failure and separates a resolution save from reopening a renamed project', async () => {
  let configReady = false
  let config: StudioConfig = { projectId: project.id, title: project.title, mode: project.mode, artStyle: 'paper', aspect: project.aspect,
    resolution: '720p', videoModel: project.profile.videoModel, imageModel: '' }
  const { draw, props, reads } = setup((url) => {
    if (url.hostname === 'jingliu-config') return configReady ? live(config) : failed
    if (url.hostname === 'jingliu-selected') return live(selected)
    return undefined
  }, selected)
  props.saveOption.mockImplementation(async (_id, _key, resolution) => { config = { ...config, resolution } })
  props.renameProject.mockImplementation(async (_id, title) => { config = { ...config, title } })
  const view = render(draw())
  const openSettings = () => {
    fireEvent.click(view.getByRole('button', { name: en.projectConfig }))
    return within(view.getByRole('dialog', { name: en.projectConfig }))
  }
  const unavailable = openSettings()
  fireEvent.click(within(unavailable.getByRole('alert')).getByRole('button', { name: en.refresh }))
  expect(view.queryByRole('dialog')).toBeNull()
  configReady = true
  const dialog = openSettings()
  const model = dialog.getByRole('combobox', { name: en.videoModel })
  expect(model).toHaveProperty('value', 'archived-model')
  expect(model).toHaveProperty('disabled', true)
  expect(dialog.getByRole('tab', { name: en.look3d })).toHaveProperty('disabled', true)
  fireEvent.click(dialog.getByRole('tab', { name: '480p' }))
  fireEvent.click(dialog.getByRole('button', { name: en.save }))
  await waitFor(() => { expect(view.queryByRole('dialog')).toBeNull() })
  expect(props.saveOption).toHaveBeenCalledExactlyOnceWith(project.id, 'resolution', '480p')
  expect(props.renameProject).not.toHaveBeenCalled()
  expect(props.openProject).not.toHaveBeenCalled()

  const rename = openSettings()
  fireEvent.change(rename.getByRole('textbox', { name: en.projectName }), { target: { value: 'Bridge Finale' } })
  fireEvent.click(rename.getByRole('button', { name: en.save }))
  await waitFor(() => { expect(view.queryByRole('dialog')).toBeNull() })
  expect(props.renameProject).toHaveBeenCalledExactlyOnceWith(project.id, 'Bridge Finale')
  expect(props.saveOption).toHaveBeenCalledTimes(1)
  expect(props.openProject).toHaveBeenCalledExactlyOnceWith({ id: project.id, title: 'Bridge Finale' })
  expect(reads.some(url => url.hostname === 'jingliu-projects' && url.searchParams.get('revision') === '2')).toBe(true)
})

it('keeps a generation request out of the conversation until the viewed project is bound', async () => {
  let tied = { id: other.id, title: other.title }
  const shot: StudioShot = { id: 's1', order: 1, episode: 2, index: 1, prompt: '', characters: [], location: '', props: [],
    durationSec: null, hasVideo: false, failReason: '', stale: false }
  const { draw, props, reads } = setup((url) => {
    switch (url.hostname) {
      case 'jingliu-selected': return live(tied)
      case 'jingliu-episodes': return live([{ number: 1, title: 'Setup', hasShots: false }, { number: 2, title: 'Bridge', hasShots: true }])
      case 'jingliu-shots': return live(url.searchParams.get('episode') === '2' ? [shot] : [])
      default: return undefined
    }
  }, selected)
  const release = Promise.withResolvers<undefined>()
  props.chooseProject.mockImplementationOnce(async () => {
    await release.promise
    throw new Error('Binding rejected')
  }).mockImplementationOnce(async (_id, next) => { tied = { id: next.id, title: project.title } })
  const view = render(draw())
  const episodeNav = within(view.getByRole('navigation', { name: en.episodes }))
  fireEvent.click(episodeNav.getByRole('button', { name: '1' }))
  expect(view.getByText(en.emptyShots)).toBeTruthy()
  fireEvent.click(episodeNav.getByRole('button', { name: '2' }))
  const label = t('shotLabel', { episode: 2, index: 1 })
  const card = within(view.getByRole('article', { name: label }))
  const generate = card.getByRole('button', { name: en.generate })
  try {
    fireEvent.click(generate)
    fireEvent.click(card.getByRole('button', { name: t('copyShotLabel', { shot: label }) }))
    expect(props.chooseProject).toHaveBeenCalledExactlyOnceWith(sessionId, selected)
    expect(props.compose).not.toHaveBeenCalled()
  } finally {
    await act(async () => { release.resolve(undefined) })
  }
  expect(view.getByRole('alert').textContent).toBe(en.navFailed)
  expect(props.compose).not.toHaveBeenCalled()
  fireEvent.click(generate)
  await waitFor(() => { expect(props.compose).toHaveBeenCalledExactlyOnceWith(t('generateRequest', { shot: label })) })
  expect(props.chooseProject.mock.calls).toEqual([[sessionId, selected], [sessionId, selected]])
  expect(view.queryByRole('alert')).toBeNull()
  expect(reads.some(url => url.hostname === 'jingliu-shots' && url.searchParams.get('id') === project.id
    && url.searchParams.get('episode') === '2')).toBe(true)
})
