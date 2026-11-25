// @vitest-environment jsdom
/** Production controls use the selected project and the current conversation's workspace. */
import { cleanup, fireEvent, render, within } from '@testing-library/react'
import type { WorkspaceId, WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { brandString } from '@deepseek-ai/dsh-brand'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { DirectoryFlowOwnerProps } from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { StudioAsset, StudioBalance, StudioLibrary, StudioOptions, StudioPreferences, StudioProject } from '@deepseek-ai/dsh-jingliu-connection/types'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { afterEach, expect, it, vi } from 'vitest'
import { Assets, CreditEntry, ProductionSettings, WorkspaceTab } from '../src/client/Production.tsx'
import { en } from '../src/client/locales.ts'

const t = makeTranslate(en)
const live = <T,>(value: T) => ({ status: 'live' as const, value, failure: undefined })
const bridgeProject: StudioProject = {
  id: 'bridge', title: 'Bridge production', episodes: 2, shots: 0, completed: 0, role: 'owner', thumbnail: '',
  mode: 'drama', aspect: '9:16', createdAt: '', profile: { videoModel: '', generationMode: '', resolution: '' },
}

afterEach(cleanup)

it('keeps the workspace picker tied to the current conversation and recovers from read and add failures', async () => {
  type Props = Parameters<typeof WorkspaceTab>[0]
  const sessionId = SessionId('bridge-conversation')
  const studioPath = '/productions/bridge'
  const otherPath = '/productions/unrelated'
  const activeWorkspace = {
    workspaceId: brandString<WorkspaceId>('bridge'), path: studioPath, title: 'Bridge production', sessionIds: [sessionId],
    createdAt: '2026-11-21T12:00:00Z', updatedAt: '2026-11-21T12:00:00Z',
  }
  let canChoose = false
  let list: WorkspaceSnapshot = { items: [{ ...activeWorkspace, workspaceId: brandString<WorkspaceId>('other'),
    path: otherPath, sessionIds: [SessionId('another-conversation')] }],
  archivedSessionIds: [], pinnedSessionIds: [], state: 'idle', phase: 'ready', error: null }
  const addWorkspace = vi.fn<Props['addWorkspace']>().mockRejectedValueOnce(new Error('Write failed')).mockImplementationOnce(async () => {
    list = { ...list, items: [...list.items, activeWorkspace] }
  })
  const renderSlot: Props['renderSlot'] = (_key: string, owner: object) => {
    const { open, busy, onPicked, onCancel, onError } = owner as DirectoryFlowOwnerProps
    return open ? <div role="dialog" aria-label="Directory picker">
      <button type="button" disabled={busy} onClick={() => { onPicked(studioPath) }}>Choose Bridge folder</button>
      <button type="button" onClick={onCancel}>Cancel picker</button>
      <button type="button" onClick={() => { onError('Listing denied') }}>Report listing failure</button>
    </div> : null
  }
  const props: Pick<Props, 'sessionId' | 't' | 'useWorkspaceList' | 'useDirectoryFlow' | 'addWorkspace' | 'renderSlot'> = {
    sessionId, t, addWorkspace, renderSlot, useWorkspaceList: select => select(list), useDirectoryFlow: select => select(canChoose),
  }
  const view = render(<WorkspaceTab {...props as Props} />)
  const add = view.getByRole('button', { name: en.addWorkspace })
  expect(add).toHaveProperty('disabled', true)
  expect(view.queryByText(otherPath)).toBeNull()

  canChoose = true
  view.rerender(<WorkspaceTab {...props as Props} />)
  const openPicker = () => {
    fireEvent.click(add)
    return within(view.getByRole('dialog', { name: 'Directory picker' }))
  }
  fireEvent.click(openPicker().getByRole('button', { name: 'Cancel picker' }))
  expect(view.queryByRole('dialog')).toBeNull()
  expect(view.queryByRole('alert')).toBeNull()
  fireEvent.click(openPicker().getByRole('button', { name: 'Report listing failure' }))
  expect(view.getByRole('alert').textContent).toBe(en.workspaceUnavailable)
  expect(addWorkspace).not.toHaveBeenCalled()

  fireEvent.click(openPicker().getByRole('button', { name: 'Choose Bridge folder' }))
  expect(add).toHaveProperty('disabled', true)
  expect(view.queryByRole('dialog')).toBeNull()
  expect((await view.findByRole('alert')).textContent).toBe(en.workspaceUnavailable)
  fireEvent.click(openPicker().getByRole('button', { name: 'Choose Bridge folder' }))
  expect(await view.findByText(studioPath)).toBeTruthy()
  expect(view.getByText(activeWorkspace.title)).toBeTruthy()
  expect(view.queryByText(otherPath)).toBeNull()
  expect(view.queryByRole('alert')).toBeNull()
  expect(addWorkspace.mock.calls).toEqual([[studioPath], [studioPath]])
})

it('saves the selected project’s settings after a rejected write and refreshes its displayed preferences', async () => {
  type Props = Parameters<typeof ProductionSettings>[0]
  const projects = [bridgeProject, { ...bridgeProject, id: 'pilot', title: 'Pilot production' }]
  const options: StudioOptions = {
    projectId: 'pilot', resolution: '720p', resolutions: ['720p', '1080p'], projectModel: 'Studio Image',
    models: [{ id: 'cinema', name: 'Cinema' }], character: '', location: '', prop: '',
  }
  let current = { ...options }
  let preferences: StudioPreferences = { projectId: 'pilot', hidePromptChips: false }
  const credit: StudioBalance = { unlimited: false, available: '21.25', usedFen: 120, heldFen: 35, enforced: true }
  const requests: URL[] = []
  const useResource = ((address: string) => {
    const url = new URL(address)
    requests.push(url)
    const id = url.searchParams.get('id') ?? ''
    switch (url.hostname) {
      case 'jingliu-credit': return live(credit)
      case 'jingliu-projects': return live(projects)
      case 'jingliu-options': return live({ ...(id === 'pilot' ? current : options), projectId: id })
      case 'jingliu-prefs': return live({ ...preferences, projectId: id })
      default: return { status: 'none', value: undefined, failure: undefined }
    }
  }) as Props['useResource']
  const saveOption = vi.fn<Props['saveOption']>().mockRejectedValueOnce(new Error('Write rejected')).mockImplementation(async (id, key, value) => {
    current = { ...current, projectId: id, [key]: value }
  })
  const savePreferences = vi.fn<Props['savePreferences']>().mockImplementation(async (input) => { preferences = input })
  const props: Pick<Props, 't' | 'useResource' | 'useAccountEpoch' | 'saveOption' | 'savePreferences'> = {
    t, useResource, useAccountEpoch: select => select(3), saveOption, savePreferences,
  }
  const view = render(<ProductionSettings {...props as Props} />)
  expect(view.getByText('¥21.25')).toBeTruthy()
  expect(view.getByText(t('usage', { spent: '1.20', held: '0.35' }))).toBeTruthy()
  expect(view.getByRole('combobox', { name: en.project })).toHaveProperty('value', 'bridge')
  fireEvent.change(view.getByRole('combobox', { name: en.project }), { target: { value: 'pilot' } })
  expect(view.getAllByRole('option', { name: `${en.projectDefault} · Studio Image` })).toHaveLength(3)
  const resolution = view.getByRole('combobox', { name: en.resolution })
  fireEvent.change(resolution, { target: { value: '1080p' } })
  expect(resolution).toHaveProperty('disabled', true)
  expect((await view.findByRole('alert')).textContent).toContain(en.failed)
  expect(resolution).toHaveProperty('value', '720p')
  fireEvent.change(resolution, { target: { value: '1080p' } })
  await view.findByRole('option', { name: '1080p', selected: true })
  expect(resolution).toHaveProperty('value', '1080p')
  expect(view.queryByRole('alert')).toBeNull()
  expect(saveOption.mock.calls).toEqual([['pilot', 'resolution', '1080p'], ['pilot', 'resolution', '1080p']])

  fireEvent.click(view.getByRole('checkbox', { name: en.chips }))
  expect(await view.findByRole('checkbox', { name: en.chips, checked: true })).toBeTruthy()
  expect(savePreferences).toHaveBeenCalledExactlyOnceWith({ projectId: 'pilot', hidePromptChips: true })
  const preferenceRead = requests.filter(url => url.hostname === 'jingliu-prefs').at(-1)
  expect(preferenceRead && Object.fromEntries(preferenceRead.searchParams)).toEqual({ id: 'pilot', epoch: '3', revision: '2' })
})

it('retries the balance and keeps project settings inactive until a production is available', () => {
  type Props = Parameters<typeof ProductionSettings>[0]
  const unavailable = { status: 'none', value: undefined, failure: undefined } as const
  const balance: StudioBalance = { unlimited: true, available: '0.00', usedFen: 200, heldFen: 0, enforced: false }
  const reads: URL[] = []
  const useResource = ((address: string) => {
    const url = new URL(address)
    reads.push(url)
    const revision = url.searchParams.get('revision')
    switch (url.hostname) {
      case 'jingliu-credit': return revision === '0' ? { ...unavailable, status: 'failed' } : live(balance)
      case 'jingliu-projects': return revision === '0' ? { ...unavailable, status: 'loading' } : live(revision === '1' ? [] : [bridgeProject])
      default: return unavailable
    }
  }) as Props['useResource']
  const saveOption = vi.fn<Props['saveOption']>()
  const savePreferences = vi.fn<Props['savePreferences']>()
  const props: Pick<Props, 't' | 'useResource' | 'useAccountEpoch' | 'saveOption' | 'savePreferences'> = {
    t, useResource, useAccountEpoch: select => select(7), saveOption, savePreferences,
  }
  const view = render(<ProductionSettings {...props as Props} />)
  expect(view.getByText('—')).toBeTruthy()
  expect(view.queryByRole('combobox')).toBeNull()
  expect(reads.slice(-2).map(url => url.href)).toEqual(['studio://inactive', 'studio://inactive'])

  fireEvent.click(within(view.getByRole('alert')).getByRole('button', { name: en.refresh }))
  expect(view.getByText(en.unlimited)).toBeTruthy()
  expect(view.queryByRole('alert')).toBeNull()
  expect(view.queryByRole('combobox')).toBeNull()
  expect(reads.slice(-2).map(url => url.href)).toEqual(['studio://inactive', 'studio://inactive'])

  fireEvent.click(view.getByRole('button', { name: en.refresh }))
  expect(view.getByRole('combobox', { name: en.project })).toHaveProperty('value', 'bridge')
  expect(view.queryByRole('checkbox', { name: en.chips })).toBeNull()
  expect(reads.slice(-2).map(url => [url.hostname, Object.fromEntries(url.searchParams)])).toEqual([
    ['jingliu-options', { epoch: '7', revision: '2', id: 'bridge' }], ['jingliu-prefs', { epoch: '7', revision: '2', id: 'bridge' }],
  ])
  expect(saveOption).not.toHaveBeenCalled()
  expect(savePreferences).not.toHaveBeenCalled()
})

it('shows live allowance only on the wide sidebar and removes the previous amount on account failure', () => {
  type Props = Parameters<typeof CreditEntry>[0]
  let epoch = 3
  const reads: URL[] = []
  const balance: StudioBalance = { unlimited: false, available: '21.25', usedFen: 0, heldFen: 0, enforced: true }
  const useResource = ((address: string) => {
    reads.push(new URL(address))
    if (epoch === 5) return { status: 'failed', value: balance, failure: undefined }
    return live({ ...balance, unlimited: epoch === 4 })
  }) as Props['useResource']
  const props: Pick<Props, 't' | 'useResource' | 'useAccountEpoch'> = { t, useResource, useAccountEpoch: select => select(epoch) }
  const view = render(<CreditEntry {...props as Props} wide={false} />)
  expect(view.queryByTitle(en.balance)).toBeNull()
  view.rerender(<CreditEntry {...props as Props} wide />)
  expect(view.getByTitle(en.balance).textContent).toContain('¥21.25')
  epoch = 4
  view.rerender(<CreditEntry {...props as Props} wide />)
  expect(view.getByTitle(en.balance).textContent).toContain(en.unlimited)
  epoch = 5
  view.rerender(<CreditEntry {...props as Props} wide />)
  expect(view.queryByTitle(en.balance)).toBeNull()
  expect(reads.at(-1)?.searchParams.get('epoch')).toBe('5')
})

it('retries the shared asset catalog, pages through it and keeps an unavailable image out of the preview', () => {
  type Props = Parameters<typeof Assets>[0]
  let waiting = true
  const failure = { status: 'failed', value: undefined, failure: undefined } as const
  const requests: URL[] = []
  const front: StudioAsset = { id: 'dock', name: 'Riverside dock', kind: 'location', thumbnail: '', description: '', referenceOnly: false, uses: 2 }
  const last: StudioAsset = { ...front, id: 'bridge', name: 'Paper bridge', thumbnail: '/fw/media/bridge.png' }
  const useResource = ((address: string) => {
    const url = new URL(address)
    requests.push(url)
    if (url.protocol === 'studio:') return { status: 'none', value: undefined, failure: undefined }
    if (url.hostname === 'jingliu-image') return failure
    if (url.searchParams.get('revision') === '0') return waiting ? { ...failure, status: 'loading' } : failure
    if (url.searchParams.get('offset') === '24' && url.searchParams.get('revision') === '1') return { ...failure, status: 'none' }
    return live<StudioLibrary>({ total: 25, items: [url.searchParams.get('offset') === '24' ? last : front] })
  }) as Props['useResource']
  const props: Props = { t, useResource, useAccountEpoch: select => select(3) }
  const view = render(<Assets {...props} />)
  expect(view.getByText(en.loading)).toBeTruthy()
  waiting = false
  view.rerender(<Assets {...props} />)
  fireEvent.click(within(view.getByRole('alert')).getByRole('button', { name: en.refresh }))
  expect(view.queryByRole('img')).toBeNull()
  expect(view.getByRole('button', { name: front.name })).toBeTruthy()
  const refreshCatalog = view.getByRole('button', { name: en.refresh })
  fireEvent.click(view.getByRole('tab', { name: en.location }))
  fireEvent.click(view.getByRole('button', { name: en.next }))
  expect(view.getByRole('alert').textContent).toContain(en.failed)
  expect(view.getByRole('button', { name: en.previous })).toHaveProperty('disabled', false)
  expect(view.getByRole('button', { name: en.next })).toHaveProperty('disabled', true)
  expect(requests.some(url => url.hostname === 'jingliu-library' && url.searchParams.get('kind') === 'location'
    && url.searchParams.get('offset') === '24' && url.searchParams.get('revision') === '1')).toBe(true)

  fireEvent.click(refreshCatalog)
  expect(view.queryByRole('alert')).toBeNull()
  expect(requests.some(url => url.hostname === 'jingliu-library' && url.searchParams.get('kind') === 'location'
    && url.searchParams.get('offset') === '24' && url.searchParams.get('revision') === '2')).toBe(true)

  fireEvent.click(view.getByRole('button', { name: last.name }))
  const preview = within(view.getByRole('dialog', { name: last.name }))
  expect(preview.getByRole('status').textContent).toBe(en.imageFailed)
  expect(preview.queryByRole('img')).toBeNull()
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(view.queryByRole('dialog')).toBeNull()
  fireEvent.click(view.getByRole('button', { name: en.previous }))
  expect(view.getByRole('button', { name: front.name })).toBeTruthy()
  expect(view.getByRole('button', { name: en.previous })).toHaveProperty('disabled', true)
})
