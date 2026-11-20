// @vitest-environment jsdom
/** The Jingliu tab of the Bot team's details drawer: productions, the workbench and its cards. */
import { fireEvent, render, waitFor, within } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { expect, it, vi } from 'vitest'
import { DrawerJingliu } from '../src/client/DrawerJingliu.tsx'
import { en } from '../src/client/locales.ts'

type Props = Parameters<typeof DrawerJingliu>[0]

const project = { id: 'p1', title: 'Bridge Lions', episodes: 2, shots: 3, completed: 1, role: 'owner', thumbnail: '',
  mode: 'drama', aspect: '9:16', createdAt: '2026-11-02T08:00:00+00:00', profile: { videoModel: 'seed-1', generationMode: 'full_reference', resolution: '1080p' } }
const older = { ...project, id: 'p0', title: 'Harbor Night', mode: 'anime', createdAt: '2026-10-01T08:00:00+00:00' }
const shot = { id: 's1', order: 1, episode: 1, index: 1, prompt: 'Ah Qiao walks past Golden Lion at the night market.',
  characters: ['Ah Qiao'], location: 'night market', props: [], durationSec: 4, hasVideo: true, failReason: '', stale: false }
const data: Record<string, unknown> = {
  'jingliu-projects': [older, project],
  'jingliu-catalog': {
    modes: [
      { key: 'drama', label: 'Story', styles: [{ key: 'urban', label: 'Urban', enabled: true }, { key: 'period', label: 'Period', enabled: true }] },
      { key: 'anime', label: 'Anime', styles: [{ key: 'guofeng_3d', label: 'Guofeng 3D', enabled: true }, { key: 'anime_3d', label: '3D real', enabled: true }] },
      { key: 'narration', label: 'Narrated', styles: [{ key: 'urban', label: 'Urban', enabled: true }] },
    ],
    aspects: ['9:16', '16:9'], resolutions: ['720p', '1080p'],
    imageModels: [{ id: 'img-1', name: 'Image One' }], videoModels: [{ id: 'seed-1', name: 'seed-1' }],
    generationModes: [{ id: 'full_reference', name: 'Reference' }],
  },
  'jingliu-config': { projectId: 'p1', title: 'Bridge Lions', aspect: '9:16', artStyle: 'urban', mode: 'drama', resolution: '1080p', imageModel: '', videoModel: 'seed-1' },
  'jingliu-episodes': [{ number: 1, title: '', hasShots: true }, { number: 2, title: '', hasShots: false }],
  'jingliu-shots': [shot],
  'jingliu-shot-media': { shotId: 's1', videoPath: '/fw/media/generated/s1.mp4', firstFramePath: '', adoptedVersion: 2,
    versions: [{ number: 1, model: 'seed-1', videoPath: '/fw/media/generated/s1-v1.mp4', createdAt: '' }, { number: 2, model: 'seed-2', videoPath: '/fw/media/generated/s1.mp4', createdAt: '' }] },
  'jingliu-project-assets': { assets: [{ id: 'a1', kind: 'character', name: 'Ah Qiao', imagePath: '', prompt: 'A young porter' }, { id: 'a2', kind: 'character', name: 'Golden Lion', imagePath: '', prompt: '' },
    { id: 'a3', kind: 'blocking', name: 'Night market blocking', imagePath: '', prompt: '', scope: 'Night market · episode 1 shots 2–4' }], audio: [] },
}

function setup(selected: { id: string; title: string } | null, shown: { id: string; title: string } | null = selected) {
  const reads: URL[] = []
  const useResource = ((address: string) => {
    if (!address.startsWith('dsh-resource://')) return { status: 'none', failure: undefined, value: undefined }
    const url = new URL(address)
    reads.push(url)
    return { status: 'live', failure: undefined, value: url.hostname === 'jingliu-selected' ? selected : data[url.hostname] }
  }) as Props['useResource']
  const props = {
    sessionId: 'part-1', t: makeTranslate(en), useResource, useAccountEpoch: <T,>(select: (value: number) => T) => select(1),
    project: shown, openProject: vi.fn(),
    quote: vi.fn(), compose: vi.fn(), chooseProject: vi.fn(async () => {}), loadVideo: vi.fn(async () => 'blob:video'),
    createProject: vi.fn(async () => ({ id: 'p9', title: 'Lantern Bridge' })), renameProject: vi.fn(async () => {}),
    deleteShot: vi.fn(async () => {}), saveOption: vi.fn(async () => {}),
  } as unknown as Props
  return { props, reads }
}

it('lists the newest production first with its tags; the first one picked becomes the conversation\'s and opens in a tab', async () => {
  const { props } = setup(null)
  const view = render(<DrawerJingliu {...props} />)
  const cards = view.getAllByRole('button', { name: /Bridge Lions|Harbor Night/u })
  expect(cards[0]?.textContent).toContain('Bridge Lions')
  expect(cards[0]?.textContent).toContain('Story')
  expect(cards[0]?.textContent).toContain('Live action')
  expect(cards[0]?.textContent).toContain('Reference')
  expect(cards[1]?.textContent).toContain('3D')
  fireEvent.click(view.getByRole('button', { name: /Bridge Lions/u }))
  await waitFor(() => expect(props.openProject).toHaveBeenCalledWith({ id: 'p1', title: 'Bridge Lions' }))
  expect(props.chooseProject).toHaveBeenCalledWith('part-1', project)
  view.unmount()
})

it('opens another production in a tab without changing the one the conversation works on', async () => {
  const { props } = setup({ id: 'p1', title: 'Bridge Lions' }, null)
  const view = render(<DrawerJingliu {...props} />)
  expect(view.getByRole('button', { name: /Bridge Lions/u }).textContent).toContain('Current')
  fireEvent.click(view.getByRole('button', { name: /Harbor Night/u }))
  await waitFor(() => expect(props.openProject).toHaveBeenCalledWith({ id: 'p0', title: 'Harbor Night' }))
  expect(props.chooseProject).not.toHaveBeenCalled()
  view.unmount()
})

it('makes a production the conversation\'s before a request made from its tab reaches the message box', async () => {
  const { props } = setup({ id: 'p1', title: 'Bridge Lions' }, { id: 'p0', title: 'Harbor Night' })
  const view = render(<DrawerJingliu {...props} />)
  fireEvent.click(view.getByRole('button', { name: 'Make another' }))
  await waitFor(() => expect(props.compose).toHaveBeenCalledWith('Make another version of Episode 1 · Shot 1: '))
  expect(props.chooseProject).toHaveBeenCalledWith('part-1', { id: 'p0', title: 'Harbor Night' })
  view.unmount()
})

it('creates a 3D story production with the chosen style and studio-default models', async () => {
  const { props } = setup(null)
  const view = render(<DrawerJingliu {...props} />)
  fireEvent.click(view.getByRole('button', { name: 'New project' }))
  fireEvent.change(view.getByRole('textbox', { name: 'Name' }), { target: { value: 'Lantern Bridge' } })
  fireEvent.click(view.getByRole('tab', { name: '3D' }))
  fireEvent.click(view.getByRole('tab', { name: '3D real' }))
  fireEvent.click(view.getByRole('button', { name: 'Create' }))
  await waitFor(() => expect(props.createProject).toHaveBeenCalledWith('part-1', {
    title: 'Lantern Bridge', mode: 'anime', artStyle: 'anime_3d', aspect: '9:16', resolution: '1080p', videoModel: '', imageModel: '', generationMode: '',
  }))
  await waitFor(() => expect(props.openProject).toHaveBeenCalledWith({ id: 'p9', title: 'Lantern Bridge' }))
  view.unmount()
})

it('shows the shot with its asset named in the prompt, and quotes or prepares a new version', () => {
  const { props, reads } = setup({ id: 'p1', title: 'Bridge Lions' })
  const view = render(<DrawerJingliu {...props} />)
  const card = view.getByRole('article', { name: 'Episode 1 · Shot 1' })
  expect(card.textContent).toContain('@Ah Qiao')
  expect(card.textContent).toContain('seed-2')
  expect(reads.some(url => url.hostname === 'jingliu-shots' && url.searchParams.get('episode') === '1')).toBe(true)
  fireEvent.click(view.getByRole('button', { name: 'Quote' }))
  expect(props.quote).toHaveBeenCalledWith('Episode 1 · Shot 1')
  expect(view.getByRole('button', { name: 'Quoted' })).toBeTruthy()
  fireEvent.click(view.getByRole('button', { name: 'Make another' }))
  expect(props.compose).toHaveBeenCalledWith('Make another version of Episode 1 · Shot 1: ')
  view.unmount()
})

it('deletes a shot only after the second press, then reads the episode again', async () => {
  const { props, reads } = setup({ id: 'p1', title: 'Bridge Lions' })
  const view = render(<DrawerJingliu {...props} />)
  fireEvent.click(view.getByRole('button', { name: 'Delete Episode 1 · Shot 1' }))
  expect(props.deleteShot).not.toHaveBeenCalled()
  fireEvent.click(view.getByRole('button', { name: 'Delete' }))
  await waitFor(() => expect(props.deleteShot).toHaveBeenCalledWith('p1', 's1'))
  await waitFor(() => expect(reads.some(url => url.hostname === 'jingliu-shots' && url.searchParams.get('revision') === '1')).toBe(true))
  view.unmount()
})

it('plays a shot only when asked, through the Host', async () => {
  const { props } = setup({ id: 'p1', title: 'Bridge Lions' })
  const view = render(<DrawerJingliu {...props} />)
  expect(props.loadVideo).not.toHaveBeenCalled()
  fireEvent.click(view.getByRole('button', { name: 'Play' }))
  await waitFor(() => expect(props.loadVideo).toHaveBeenCalledWith('/fw/media/generated/s1.mp4', expect.any(AbortSignal)))
  view.unmount()
})

it('prepares a batch export request for the episodes that have video, with the watermark text', () => {
  const { props } = setup({ id: 'p1', title: 'Bridge Lions' })
  const view = render(<DrawerJingliu {...props} />)
  fireEvent.click(view.getByRole('button', { name: 'Batch export' }))
  expect((view.getByRole('button', { name: 'Episode 2, no video yet' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(view.getByRole('switch', { name: 'Ending' }))
  fireEvent.click(view.getByRole('button', { name: 'Export CapCut drafts' }))
  expect(props.compose).toHaveBeenCalledWith('Export episodes 1 as CapCut drafts, with subtitles, background music, the “AI generated” watermark.')
  view.unmount()
})

it('prepares a poster request with the exact title, the ratios and the leads', () => {
  const { props } = setup({ id: 'p1', title: 'Bridge Lions' })
  const view = render(<DrawerJingliu {...props} />)
  fireEvent.click(view.getByRole('tab', { name: 'Assets' }))
  fireEvent.click(view.getByRole('tab', { name: 'Posters' }))
  fireEvent.click(view.getByRole('button', { name: 'Make posters' }))
  fireEvent.click(view.getByRole('button', { name: '16:9' }))
  fireEvent.click(within(view.getByRole('dialog')).getByRole('button', { name: 'Make posters' }))
  expect(props.compose).toHaveBeenCalledWith('Make posters titled exactly “Bridge Lions”: main posters in 1:1, 2:3, 3:4, 7:10, 9:16; character posters of Ah Qiao, Golden Lion; 7 in all.')
  view.unmount()
})

it('lists the blocking diagrams in a tab of their own, right after the locations', () => {
  const { props } = setup({ id: 'p1', title: 'Bridge Lions' })
  const view = render(<DrawerJingliu {...props} />)
  fireEvent.click(view.getByRole('tab', { name: 'Assets' }))
  const kinds = ['Characters', 'Locations', 'Blocking', 'Props'].map(name => view.getByRole('tab', { name }))
  expect(kinds[1]?.compareDocumentPosition(kinds[2] as Node)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
  expect(kinds[2]?.compareDocumentPosition(kinds[3] as Node)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
  expect(view.queryByText('Night market blocking')).toBeNull()
  fireEvent.click(view.getByRole('tab', { name: 'Blocking' }))
  // The card says where the diagram applies, as the studio words it.
  expect(view.getByText('Night market · episode 1 shots 2–4')).toBeTruthy()
  fireEvent.click(view.getByRole('button', { name: /Night market blocking/u }))
  expect(props.quote).toHaveBeenCalledWith('Asset “Night market blocking”')
  view.unmount()
})

it('opens another production from the search card', async () => {
  const { props } = setup({ id: 'p1', title: 'Bridge Lions' })
  const view = render(<DrawerJingliu {...props} />)
  fireEvent.click(view.getByRole('button', { name: 'Bridge Lions, switch or search projects' }))
  fireEvent.change(view.getByRole('textbox', { name: 'Search cloud projects' }), { target: { value: 'harbor' } })
  fireEvent.click(view.getByRole('button', { name: /Harbor Night/u }))
  await waitFor(() => expect(props.openProject).toHaveBeenCalledWith({ id: 'p0', title: 'Harbor Night' }))
  expect(props.chooseProject).not.toHaveBeenCalled()
  view.unmount()
})
