// @vitest-environment jsdom
/** The Jingliu tab of the Bot team's details drawer: productions, the workbench and its cards. */
import { act, fireEvent, render, waitFor, within } from '@testing-library/react'
import type { ResourceSnapshot } from '@deepseek-ai/dsh-client-resources/client'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { StudioCatalog, StudioConfig, StudioProjectAssets, StudioShotMedia } from '@deepseek-ai/dsh-jingliu-connection/types'
import { expect, it, onTestFinished, vi } from 'vitest'
import { DrawerJingliu } from '../src/client/DrawerJingliu.tsx'
import { en } from '../src/client/locales.ts'

type Props = Parameters<typeof DrawerJingliu>[0]
type Project = { id: string; title: string }

const resource = (value: unknown, status: ResourceSnapshot<unknown>['status'] = 'live'): ResourceSnapshot<unknown> => ({ status, value, failure: undefined })

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

function setup(selected: Project | null, shown: Project | null = selected, read?: (url: URL) => ResourceSnapshot<unknown> | undefined) {
  const reads: URL[] = []
  const useResource = ((address: string) => {
    if (!address.startsWith('dsh-resource://')) return { status: 'none', failure: undefined, value: undefined }
    const url = new URL(address)
    reads.push(url)
    return read?.(url) ?? resource(url.hostname === 'jingliu-selected' ? selected : data[url.hostname])
  }) as Props['useResource']
  const props = {
    sessionId: 'part-1' as Props['sessionId'], t: makeTranslate(en), useResource, useAccountEpoch: <T,>(select: (value: number) => T) => select(1),
    project: shown, openProject: vi.fn(),
    quote: vi.fn(), compose: vi.fn(), chooseProject: vi.fn(async () => {}), loadVideo: vi.fn(async () => 'blob:video'),
    createProject: vi.fn(async () => ({ id: 'p9', title: 'Lantern Bridge' })), renameProject: vi.fn(async () => {}),
    deleteShot: vi.fn(async () => {}), saveOption: vi.fn(async () => {}), savePreferences: vi.fn(async () => {}),
  } as Props
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
  await waitFor(() => { expect(props.openProject).toHaveBeenCalledWith({ id: 'p1', title: 'Bridge Lions' }) })
  expect(props.chooseProject).toHaveBeenCalledWith('part-1', project)
  view.unmount()
})

it('opens another production in a tab without changing the one the conversation works on', async () => {
  const { props } = setup({ id: 'p1', title: 'Bridge Lions' }, null)
  const view = render(<DrawerJingliu {...props} />)
  expect(view.getByRole('button', { name: /Bridge Lions/u }).textContent).toContain('Current')
  fireEvent.click(view.getByRole('button', { name: /Harbor Night/u }))
  await waitFor(() => { expect(props.openProject).toHaveBeenCalledWith({ id: 'p0', title: 'Harbor Night' }) })
  expect(props.chooseProject).not.toHaveBeenCalled()
  view.unmount()
})

it('makes a production the conversation\'s before a request made from its tab reaches the message box', async () => {
  const { props } = setup({ id: 'p1', title: 'Bridge Lions' }, { id: 'p0', title: 'Harbor Night' })
  const view = render(<DrawerJingliu {...props} />)
  fireEvent.click(view.getByRole('button', { name: 'Make another' }))
  await waitFor(() => { expect(props.compose).toHaveBeenCalledWith('Make another version of Episode 1 · Shot 1: ') })
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
  await waitFor(() => {
    expect(props.createProject).toHaveBeenCalledWith('part-1', {
      title: 'Lantern Bridge', mode: 'anime', artStyle: 'anime_3d', aspect: '9:16', resolution: '1080p', videoModel: '', imageModel: '', generationMode: '',
    })
  })
  await waitFor(() => { expect(props.openProject).toHaveBeenCalledWith({ id: 'p9', title: 'Lantern Bridge' }) })
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
  fireEvent.click(view.getByRole('button', { name: 'Quoted' }))
  expect(view.getByRole('button', { name: 'Quote' }).getAttribute('aria-pressed')).toBe('false')
  expect(props.quote).toHaveBeenCalledTimes(1)
  fireEvent.click(view.getByRole('button', { name: 'Make another' }))
  expect(props.compose).toHaveBeenCalledWith('Make another version of Episode 1 · Shot 1: ')
  view.unmount()
})

it('deletes a shot only after the second press, then reads the episode again', async () => {
  const { props, reads } = setup({ id: 'p1', title: 'Bridge Lions' })
  const remove = vi.mocked(props.deleteShot).mockRejectedValueOnce(new Error('Delete refused'))
  const view = render(<DrawerJingliu {...props} />)
  fireEvent.click(view.getByRole('button', { name: 'Delete Episode 1 · Shot 1' }))
  fireEvent.click(view.getByRole('button', { name: en.cancel }))
  expect(view.queryByRole('button', { name: en.deleteShot })).toBeNull()
  expect(remove).not.toHaveBeenCalled()
  fireEvent.click(view.getByRole('button', { name: 'Delete Episode 1 · Shot 1' }))
  fireEvent.click(view.getByRole('button', { name: 'Delete' }))
  expect((await view.findByRole('alert')).textContent).toBe(en.deleteFailed)
  expect(reads.some(url => url.hostname === 'jingliu-shots' && url.searchParams.get('revision') === '1')).toBe(false)
  fireEvent.click(view.getByRole('button', { name: 'Delete' }))
  await waitFor(() => { expect(reads.some(url => url.hostname === 'jingliu-shots' && url.searchParams.get('revision') === '1')).toBe(true) })
  expect(remove.mock.calls).toEqual([['p1', 's1'], ['p1', 's1']])
  view.unmount()
})

it('plays a shot only when asked, through the Host', async () => {
  const { props } = setup({ id: 'p1', title: 'Bridge Lions' })
  const view = render(<DrawerJingliu {...props} />)
  expect(props.loadVideo).not.toHaveBeenCalled()
  fireEvent.click(view.getByRole('button', { name: 'Play' }))
  await waitFor(() => { expect(props.loadVideo).toHaveBeenCalledWith({ sessionId: 'part-1', projectId: 'p1', path: '/fw/media/generated/s1.mp4' }, expect.any(AbortSignal)) })
  view.unmount()
})

it('prepares a batch export request for the episodes that have video, with the watermark text', () => {
  const { props } = setup({ id: 'p1', title: 'Bridge Lions' })
  const view = render(<DrawerJingliu {...props} />)
  fireEvent.click(view.getByRole('button', { name: 'Batch export' }))
  expect((view.getByRole('button', { name: 'Episode 2, no video yet' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.change(view.getByRole('textbox', { name: en.watermarkText }), { target: { value: ' ' } })
  fireEvent.click(view.getByRole('switch', { name: 'Ending' }))
  fireEvent.click(view.getByRole('button', { name: 'Export CapCut drafts' }))
  expect(props.compose).toHaveBeenCalledWith('Export episodes 1 as CapCut drafts, with subtitles, background music, the “AI generated” watermark.'
    + '\n\n```json\n{"source":"jingliu","project":"p1","episodes":[1],"switches":{"subtitles":true,"music":true,"ending":false,"watermark":true}}\n```')
  view.unmount()
})

it('carries a changed watermark text and every switch in the batch export block', () => {
  const { props } = setup(project, project, url => url.hostname === 'jingliu-episodes'
    ? resource([{ number: 1, title: 'Bridge', hasShots: true }]) : undefined)
  const view = render(<DrawerJingliu {...props} />)
  fireEvent.click(view.getByRole('button', { name: 'Batch export' }))
  const card = within(view.getByRole('dialog', { name: 'Batch export' }))
  expect(card.queryByText(/have no video yet/u)).toBeNull()
  expect(card.getAllByRole('switch').map(item => item.getAttribute('aria-checked'))).toEqual(['true', 'true', 'true', 'true'])
  fireEvent.change(card.getByRole('textbox', { name: 'Watermark text' }), { target: { value: ' 镜流出品 ' } })
  fireEvent.click(card.getByRole('switch', { name: 'BGM' }))
  fireEvent.click(card.getByRole('button', { name: 'Export CapCut drafts' }))
  const text = vi.mocked(props.compose).mock.calls[0]![0]
  const [sentence, fence] = text.split('\n\n')
  expect(sentence).toBe('Export episodes 1 as CapCut drafts, with subtitles, the ending card, the “镜流出品” watermark.')
  expect(JSON.parse(fence!.replace(/^```json\n|\n```$/gu, ''))).toEqual({ source: 'jingliu', project: 'p1', episodes: [1],
    switches: { subtitles: true, music: false, ending: true, watermark: true, watermark_text: '镜流出品' } })
  view.unmount()
})

it('prepares a poster request with the exact title, the ratios and the leads', () => {
  const { props } = setup({ id: 'p1', title: 'Bridge Lions' })
  const view = render(<DrawerJingliu {...props} />)
  fireEvent.click(view.getByRole('tab', { name: 'Assets' }))
  fireEvent.click(view.getByRole('tab', { name: 'Posters' }))
  fireEvent.click(view.getByRole('button', { name: 'Make posters' }))
  fireEvent.click(view.getByRole('button', { name: '16:9' }))
  fireEvent.click(view.getByRole('button', { name: 'Golden Lion' }))
  fireEvent.click(within(view.getByRole('dialog')).getByRole('button', { name: 'Make posters' }))
  expect(props.compose).toHaveBeenCalledWith('Make posters titled exactly “Bridge Lions”: main posters in 1:1, 2:3, 3:4, 7:10, 9:16; character posters of Ah Qiao; 6 in all.')

  fireEvent.click(view.getByRole('button', { name: en.generatePoster }))
  const characters = within(view.getByRole('dialog', { name: en.generatePoster }))
  for (const ratio of ['1:1', '2:3', '3:4', '7:10', '9:16', '16:9']) fireEvent.click(characters.getByRole('button', { name: ratio }))
  fireEvent.click(characters.getByRole('button', { name: 'Golden Lion' }))
  fireEvent.click(characters.getByRole('button', { name: en.generatePoster }))
  expect(props.compose).toHaveBeenLastCalledWith('Make posters titled exactly “Bridge Lions”: main posters in no extras; character posters of Ah Qiao; 1 in all.')
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
  await waitFor(() => { expect(props.openProject).toHaveBeenCalledWith({ id: 'p0', title: 'Harbor Night' }) })
  expect(props.chooseProject).not.toHaveBeenCalled()
  view.unmount()
})

it('keeps the edited title after a refused rename and refreshes the tab after retrying', async () => {
  const { props, reads } = setup(project)
  const rename = vi.mocked(props.renameProject).mockRejectedValueOnce(new Error('Write refused'))
  const view = render(<DrawerJingliu {...props} />)
  fireEvent.click(view.getByRole('button', { name: en.projectConfig }))
  const settings = within(view.getByRole('dialog', { name: en.projectConfig }))
  const label = settings.getByRole('textbox', { name: en.projectName })
  fireEvent.change(label, { target: { value: ' ' } })
  expect(settings.getByRole('button', { name: en.save })).toHaveProperty('disabled', true)
  fireEvent.change(label, { target: { value: ' Bridge finale ' } })
  fireEvent.click(settings.getByRole('button', { name: en.save }))
  expect((await settings.findByRole('alert')).textContent).toBe(en.saveFailed)
  expect(label).toHaveProperty('value', ' Bridge finale ')
  expect(props.openProject).not.toHaveBeenCalled()
  fireEvent.click(settings.getByRole('button', { name: en.save }))
  await waitFor(() => { expect(props.openProject).toHaveBeenCalledExactlyOnceWith({ id: 'p1', title: 'Bridge finale' }) })
  expect(rename.mock.calls).toEqual([['p1', ' Bridge finale '], ['p1', ' Bridge finale ']])
  expect(props.saveOption).not.toHaveBeenCalled()
  expect(reads.some(url => url.hostname === 'jingliu-projects' && url.searchParams.get('revision') === '1')).toBe(true)
  view.unmount()
})

it('renders the project asset thumbnail, audio categories and optional audio duration', () => {
  const image = 'data:image/png;base64,AQID'
  const catalog: StudioProjectAssets = { assets: [{ id: 'qiao', kind: 'character', name: 'Ah Qiao', imagePath: '/fw/media/qiao.png', prompt: '', scope: '' }],
    audio: [{ id: 'voice', kind: 'voice', text: 'Bridge dialogue', path: '/fw/media/voice.wav', durationSec: 1.25 },
      { id: 'ambient', kind: 'ambient', text: '', path: '/fw/media/ambient.wav', durationSec: null }] }
  let assets = resource(undefined, 'loading')
  const { props, reads } = setup(project, project, (url) => {
    if (url.hostname === 'jingliu-project-assets') return assets
    if (url.hostname === 'jingliu-image') return resource(image)
    return undefined
  })
  const view = render(<DrawerJingliu {...props} />)
  fireEvent.click(view.getByRole('tab', { name: en.assetsPage }))
  expect(view.getByText(en.loading)).toBeTruthy()
  assets = resource(undefined, 'failed')
  view.rerender(<DrawerJingliu {...props} />)
  expect(view.getByText(en.failed)).toBeTruthy()
  assets = resource(catalog)
  view.rerender(<DrawerJingliu {...props} />)
  expect(view.getByRole('img', { name: 'Ah Qiao' }).getAttribute('src')).toBe(image)
  expect(reads.some(url => url.hostname === 'jingliu-image' && url.searchParams.get('path') === '/fw/media/qiao.png')).toBe(true)
  fireEvent.click(view.getByRole('tab', { name: en.prop }))
  expect(view.getByText(en.emptyAssets)).toBeTruthy()
  fireEvent.click(view.getByRole('tab', { name: en.audio }))
  expect(view.getByText(en.audioVoice)).toBeTruthy()
  expect(view.getByText('Bridge dialogue')).toBeTruthy()
  expect(view.getByText('1.3s')).toBeTruthy()
  expect(view.getByText(en.audioOther, { selector: 'strong' })).toBeTruthy()
  expect(view.queryByText('0.0s')).toBeNull()
  assets = resource({ ...catalog, audio: [] })
  view.rerender(<DrawerJingliu {...props} />)
  expect(view.getByText(en.emptyAssets)).toBeTruthy()
  fireEvent.click(view.getByRole('tab', { name: en.videosPage }))
  const mention = view.getByText('@Ah Qiao')
  expect(mention.querySelector('img')?.getAttribute('src')).toBe(image)
  view.unmount()
})

it('routes to the explicitly selected episode without loading media for an unmade shot', () => {
  let episodes = resource(undefined, 'loading')
  let shots = resource(undefined, 'loading')
  const { props, reads } = setup(project, project, (url) => {
    if (url.hostname === 'jingliu-episodes') return episodes
    if (url.hostname === 'jingliu-shots') return shots
    return undefined
  })
  const view = render(<DrawerJingliu {...props} />)
  expect(view.getByText(en.loading)).toBeTruthy()
  episodes = resource(undefined, 'failed')
  view.rerender(<DrawerJingliu {...props} />)
  expect(view.getByText(en.failed)).toBeTruthy()
  episodes = resource([])
  view.rerender(<DrawerJingliu {...props} />)
  expect(view.getByText(en.emptyEpisodes)).toBeTruthy()
  expect(reads.some(url => url.hostname === 'jingliu-shots')).toBe(false)

  episodes = resource([{ number: 1, title: 'Bridge', hasShots: false }, { number: 2, title: 'Harbor', hasShots: false }])
  view.rerender(<DrawerJingliu {...props} />)
  expect(view.getByRole('button', { name: '1' }).getAttribute('aria-current')).toBe('true')
  expect(view.getByText(en.loading)).toBeTruthy()
  fireEvent.click(view.getByRole('button', { name: '2' }))
  expect(view.getByRole('button', { name: '2' }).getAttribute('aria-current')).toBe('true')
  expect(reads.filter(url => url.hostname === 'jingliu-shots').at(-1)?.searchParams.get('episode')).toBe('2')
  shots = resource(undefined, 'failed')
  view.rerender(<DrawerJingliu {...props} />)
  expect(view.getByText(en.failed)).toBeTruthy()
  shots = resource([])
  view.rerender(<DrawerJingliu {...props} />)
  expect(view.getByText(en.emptyShots)).toBeTruthy()

  shots = resource([{ ...shot, episode: 2, hasVideo: false, durationSec: null, prompt: '', characters: [] }])
  view.rerender(<DrawerJingliu {...props} />)
  const label = 'Episode 2 · Shot 1'
  const card = within(view.getByRole('article', { name: label }))
  expect(card.getByText(en.noPrompt)).toBeTruthy()
  expect(card.getByText(en.notGenerated)).toBeTruthy()
  expect(card.queryByRole('button', { name: en.playVideo })).toBeNull()
  expect(reads.some(url => url.hostname === 'jingliu-shot-media')).toBe(false)
  fireEvent.click(card.getByRole('button', { name: props.t('copyShotLabel', { shot: label }) }))
  fireEvent.click(card.getByRole('button', { name: en.pickAsset }))
  fireEvent.click(card.getByRole('button', { name: en.generate }))
  expect(vi.mocked(props.compose).mock.calls).toEqual([
    [props.t('copyRequest', { shot: label })], [props.t('pickAssetRequest', { shot: label })], [props.t('generateRequest', { shot: label })],
  ])
  view.unmount()
})

it.each([
  { outcome: 'late object URL', rejected: false, finished: 'blob:current-version' },
  { outcome: 'cancelled Host fetch', rejected: true, finished: '/api/video/scene' },
])('ignores a $outcome after switching versions and lets the current version retry', async ({ rejected, finished }) => {
  const poster = '/fw/media/generated/s1.png'
  const oldPath = '/fw/media/generated/s1-v1.mp4'
  const currentPath = '/fw/media/generated/s1.mp4'
  const media: StudioShotMedia = { shotId: 's1', videoPath: currentPath, firstFramePath: poster, adoptedVersion: 2,
    versions: [{ number: 1, model: 'seed-1', videoPath: oldPath, createdAt: '' }, { number: 2, model: 'seed-2', videoPath: currentPath, createdAt: '' }] }
  const { props, reads } = setup(project, project, url => url.hostname === 'jingliu-shot-media' ? resource(media) : undefined)
  const stale = Promise.withResolvers<string>()
  const loadVideo = vi.mocked(props.loadVideo).mockReturnValueOnce(stale.promise).mockRejectedValueOnce(new Error('Read failed'))
    .mockResolvedValueOnce(finished)
  const revoke = vi.fn<(url: string) => void>()
  vi.stubGlobal('URL', Object.assign(class extends URL {}, { revokeObjectURL: revoke }))
  onTestFinished(() => { vi.unstubAllGlobals() })
  const view = render(<DrawerJingliu {...props} />)
  expect(reads.some(url => url.hostname === 'jingliu-image' && url.searchParams.get('path') === poster)).toBe(true)
  fireEvent.click(view.getByRole('button', { name: en.playVideo }))
  expect(view.getByRole('button', { name: en.playVideo })).toHaveProperty('disabled', true)
  const firstSignal = loadVideo.mock.calls[0]?.[1]
  expect(firstSignal?.aborted).toBe(false)
  fireEvent.click(within(view.getByRole('group', { name: en.versions })).getByRole('button', { name: '1' }))
  expect(firstSignal?.aborted).toBe(true)
  await act(async () => {
    if (rejected) stale.reject(new Error('Previous version was cancelled'))
    else stale.resolve('blob:stale-version')
  })
  expect(revoke.mock.calls).toEqual(rejected ? [] : [['blob:stale-version']])
  expect(view.container.querySelector('video')).toBeNull()
  expect(view.queryByRole('button', { name: en.videoFailed })).toBeNull()

  fireEvent.click(view.getByRole('button', { name: en.playVideo }))
  fireEvent.click(await view.findByRole('button', { name: en.videoFailed }))
  await waitFor(() => { expect(view.container.querySelector('video')?.getAttribute('src')).toBe(finished) })
  expect(loadVideo.mock.calls.map(([request]) => request.path)).toEqual([currentPath, oldPath, oldPath])
  view.unmount()
  expect(revoke.mock.calls).toEqual(rejected ? [] : [['blob:stale-version'], ['blob:current-version']])
})

it('groups missing export episodes and sends only individually selected episodes with extras disabled', () => {
  const episodes = [1, 2, 3, 4, 6].map(number => ({ number, title: '', hasShots: number === 1 || number === 4 }))
  const { props } = setup(project, project, url => url.hostname === 'jingliu-episodes' ? resource(episodes) : undefined)
  const view = render(<DrawerJingliu {...props} />)
  fireEvent.click(view.getByRole('button', { name: en.batchExport }))
  const dialog = within(view.getByRole('dialog', { name: en.batchExport }))
  expect(dialog.getByText(/episodes 2–3, 6 have no video yet/u)).toBeTruthy()
  const selectAll = dialog.getByRole('button', { name: en.selectAll })
  const submit = dialog.getByRole('button', { name: en.exportDrafts })
  fireEvent.click(selectAll)
  expect(submit).toHaveProperty('disabled', true)
  expect(dialog.getByText(/None chosen/u)).toBeTruthy()
  fireEvent.click(selectAll)
  fireEvent.click(dialog.getByRole('button', { name: 'Episode 1' }))
  fireEvent.click(dialog.getByRole('button', { name: 'Episode 1' }))
  fireEvent.click(dialog.getByRole('button', { name: 'Episode 4' }))
  for (const control of dialog.getAllByRole('switch')) fireEvent.click(control)
  expect(dialog.queryByRole('textbox', { name: en.watermarkText })).toBeNull()
  fireEvent.click(submit)
  expect(props.compose).toHaveBeenCalledExactlyOnceWith('Export episodes 1 as CapCut drafts, with no extras.'
    + '\n\n```json\n{"source":"jingliu","project":"p1","episodes":[1],"switches":{"subtitles":false,"music":false,"ending":false,"watermark":false}}\n```')
  view.unmount()
})

it('retries the conversation selection before displaying or opening a production', async () => {
  let selection = resource(undefined, 'loading')
  let projects = resource(undefined, 'loading')
  const narrated = { ...project, id: 'radio', title: 'Harbor radio', mode: 'narration', createdAt: 'unknown',
    profile: { ...project.profile, generationMode: 'legacy-reference' } }
  const undated = { ...older, id: 'archive', title: 'Old archive', mode: '', createdAt: '' }
  const untitled = { ...undated, id: 'untitled', title: ' ' }
  const { props, reads } = setup(null, null, (url) => {
    if (url.hostname === 'jingliu-selected') return url.searchParams.get('revision') === '0' ? selection : resource(null)
    if (url.hostname === 'jingliu-projects') return projects
    return undefined
  })
  const choose = vi.mocked(props.chooseProject).mockRejectedValueOnce(new Error('Selection refused'))
  const view = render(<DrawerJingliu {...props} />)
  expect(view.getByText(en.loading)).toBeTruthy()
  expect(view.queryByRole('button', { name: en.newProject })).toBeNull()
  selection = resource(undefined, 'failed')
  view.rerender(<DrawerJingliu {...props} />)
  expect(view.getByRole('alert').textContent).toContain(en.failed)
  fireEvent.click(within(view.getByRole('alert')).getByRole('button', { name: en.refresh }))
  expect(view.getByText(en.loading)).toBeTruthy()
  expect(reads.some(url => url.hostname === 'jingliu-selected' && url.searchParams.get('id') === 'part-1'
    && url.searchParams.get('revision') === '1')).toBe(true)
  projects = resource([])
  view.rerender(<DrawerJingliu {...props} />)
  expect(view.getByText(en.emptyProjects)).toBeTruthy()
  projects = resource([undated, narrated, untitled])
  view.rerender(<DrawerJingliu {...props} />)
  const target = view.getByRole('button', { name: /Harbor radio/u })
  expect(target.textContent).toContain(en.typeNarration)
  expect(target.textContent).toContain('legacy-reference')
  expect(target.textContent).not.toContain('Invalid Date')
  expect(view.getByRole('button', { name: /Old archive/u }).textContent).not.toContain(en.typeDrama)
  expect(view.getByText('·', { exact: true }).getAttribute('aria-hidden')).toBe('true')
  fireEvent.click(target)
  expect((await view.findByRole('alert')).textContent).toBe(en.navFailed)
  expect(props.openProject).not.toHaveBeenCalled()
  fireEvent.click(target)
  await waitFor(() => { expect(props.openProject).toHaveBeenCalledExactlyOnceWith({ id: narrated.id, title: narrated.title }) })
  expect(choose.mock.calls).toEqual([['part-1', narrated], ['part-1', narrated]])
  view.unmount()
})

it('opens the new-project form from the workbench and keeps unavailable catalog choices out of it', () => {
  let catalog = resource(undefined, 'loading')
  const { props } = setup(project, project, url => url.hostname === 'jingliu-catalog' ? catalog : undefined)
  const view = render(<DrawerJingliu {...props} />)
  fireEvent.click(view.getByRole('button', { name: en.newProject }))
  const dialog = within(view.getByRole('dialog', { name: en.newProject }))
  expect(dialog.getByText(en.loading)).toBeTruthy()
  expect(dialog.queryByRole('button', { name: en.create })).toBeNull()
  catalog = resource(undefined, 'failed')
  view.rerender(<DrawerJingliu {...props} />)
  expect(dialog.getByRole('alert').textContent).toContain(en.failed)
  fireEvent.click(within(dialog.getByRole('alert')).getByRole('button', { name: en.refresh }))
  expect(view.queryByRole('dialog')).toBeNull()
  expect(props.createProject).not.toHaveBeenCalled()
  view.unmount()
})

it('requires a title and at least one poster type even when the project has no character leads', () => {
  const emptyCatalog: StudioProjectAssets = { assets: [], audio: [] }
  const { props } = setup(project, project, url => url.hostname === 'jingliu-project-assets' ? resource(emptyCatalog) : undefined)
  const view = render(<DrawerJingliu {...props} />)
  fireEvent.click(view.getByRole('tab', { name: en.assetsPage }))
  fireEvent.click(view.getByRole('tab', { name: en.poster }))
  fireEvent.click(view.getByRole('button', { name: en.generatePoster }))
  const dialog = within(view.getByRole('dialog', { name: en.generatePoster }))
  const submit = dialog.getByRole('button', { name: en.generatePoster })
  expect(dialog.queryByText(en.posterLeads)).toBeNull()
  const title = dialog.getByRole('textbox', { name: en.posterTitle })
  fireEvent.change(title, { target: { value: ' ' } })
  expect(submit).toHaveProperty('disabled', true)
  fireEvent.change(title, { target: { value: ' Bridge! ' } })
  for (const ratio of ['1:1', '2:3', '3:4', '7:10', '9:16', '16:9']) fireEvent.click(dialog.getByRole('button', { name: ratio, pressed: true }))
  expect(submit).toHaveProperty('disabled', true)
  fireEvent.click(dialog.getByRole('button', { name: '16:9', pressed: false }))
  fireEvent.click(submit)
  expect(props.compose).toHaveBeenCalledExactlyOnceWith('Make posters titled exactly “Bridge!”: main posters in 16:9; character posters of no extras; 1 in all.')
  view.unmount()
})

it('opens settings by the saved project ID even when an older project is absent from the catalog', () => {
  const saved = { id: 'released-cut', title: 'Paper bridge' }
  const config: StudioConfig = { projectId: saved.id, title: saved.title, mode: 'narration_dlg', artStyle: '', aspect: '', resolution: '',
    imageModel: '', videoModel: '' }
  const catalog: StudioCatalog = { modes: [], aspects: [], resolutions: [], imageModels: [], videoModels: [], generationModes: [] }
  const { props, reads } = setup(saved, saved, (url) => {
    if (url.hostname === 'jingliu-projects') return resource([])
    if (url.hostname === 'jingliu-config') return resource(config)
    if (url.hostname === 'jingliu-catalog') return resource(catalog)
    return undefined
  })
  const view = render(<DrawerJingliu {...props} />)
  expect(view.getByRole('button', { name: props.t('switchProjectLabel', { title: saved.title }) })).toBeTruthy()
  expect(view.getAllByText(en.platformDefault)).toHaveLength(1)
  fireEvent.click(view.getByRole('button', { name: en.projectConfig }))
  const settings = within(view.getByRole('dialog', { name: en.projectConfig }))
  expect(settings.getByRole('textbox', { name: en.projectName })).toHaveProperty('value', saved.title)
  expect(settings.getByRole('tab', { name: en.typeNarration }).getAttribute('aria-selected')).toBe('true')
  expect(settings.queryByText(en.artStyle)).toBeNull()
  expect(settings.queryByText(en.formAspect)).toBeNull()
  expect(reads.filter(url => url.hostname === 'jingliu-config').every(url => url.searchParams.get('id') === saved.id)).toBe(true)
  fireEvent.click(settings.getByRole('button', { name: en.cancel }))
  expect(props.renameProject).not.toHaveBeenCalled()
  expect(props.saveOption).not.toHaveBeenCalled()
  view.unmount()
})

it('waits for shot media, uses the primary video when version metadata is incomplete, and shows failure details', async () => {
  const path = '/fw/media/generated/s1.mp4'
  const failed = { ...shot, id: 's2', index: 2, hasVideo: false, failReason: 'Generation stalled' }
  let media = resource(undefined, 'loading')
  const { props, reads } = setup(project, project, (url) => {
    if (url.hostname === 'jingliu-shots') return resource([shot, failed])
    if (url.hostname === 'jingliu-shot-media') return url.searchParams.get('shot') === shot.id ? media : resource(undefined, 'failed')
    return undefined
  })
  const view = render(<DrawerJingliu {...props} />)
  const first = within(view.getByRole('article', { name: 'Episode 1 · Shot 1' }))
  const second = within(view.getByRole('article', { name: 'Episode 1 · Shot 2' }))
  expect(first.getByRole('button', { name: en.playVideo })).toHaveProperty('disabled', true)
  expect(second.getByText(failed.failReason)).toBeTruthy()
  expect(second.queryByRole('button', { name: en.playVideo })).toBeNull()
  expect(reads.some(url => url.hostname === 'jingliu-shot-media' && url.searchParams.get('shot') === failed.id)).toBe(true)
  media = resource({ shotId: shot.id, videoPath: path, firstFramePath: '', adoptedVersion: null, versions: [] } satisfies StudioShotMedia)
  view.rerender(<DrawerJingliu {...props} />)
  expect(first.getByRole('button', { name: en.playVideo })).toHaveProperty('disabled', false)
  media = resource({ shotId: shot.id, videoPath: path, firstFramePath: '', adoptedVersion: 2,
    versions: [{ number: 2, model: 'seed-2', videoPath: '', createdAt: '' }] } satisfies StudioShotMedia)
  view.rerender(<DrawerJingliu {...props} />)
  expect(first.getByText('seed-2')).toBeTruthy()
  fireEvent.click(first.getByRole('button', { name: en.playVideo }))
  await waitFor(() => { expect(props.loadVideo).toHaveBeenCalledExactlyOnceWith({ sessionId: 'part-1', projectId: 'p1', path }, expect.any(AbortSignal)) })
  view.unmount()
})

it('keeps batch export unavailable while episodes are loading and admits them after selection', () => {
  let episodes = resource(undefined, 'loading')
  const { props } = setup(project, project, url => url.hostname === 'jingliu-episodes' ? episodes : undefined)
  const view = render(<DrawerJingliu {...props} />)
  fireEvent.click(view.getByRole('button', { name: en.batchExport }))
  const dialog = within(view.getByRole('dialog', { name: en.batchExport }))
  const select = dialog.getByRole('button', { name: en.selectAll })
  const submit = dialog.getByRole('button', { name: en.exportDrafts })
  expect(select).toHaveProperty('disabled', true)
  expect(submit).toHaveProperty('disabled', true)
  expect(props.compose).not.toHaveBeenCalled()
  episodes = resource([{ number: 1, title: 'Bridge', hasShots: true }])
  view.rerender(<DrawerJingliu {...props} />)
  expect(select).toHaveProperty('disabled', false)
  expect(submit).toHaveProperty('disabled', true)
  fireEvent.click(select)
  expect(submit).toHaveProperty('disabled', false)
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(view.queryByRole('dialog')).toBeNull()
  expect(props.compose).not.toHaveBeenCalled()
  view.unmount()
})

it.each([
  { name: en.newProject, dismissal: 'Escape' },
  { name: en.projectConfig, dismissal: 'Cancel' },
  { name: en.batchExport, dismissal: 'backdrop' },
] as const)('restores focus after dismissing $name with $dismissal and can reopen it', ({ name, dismissal }) => {
  const { props } = setup(project)
  const view = render(<DrawerJingliu {...props} />)
  const opener = view.getByRole('button', { name })
  opener.focus()
  fireEvent.click(opener)
  const dialog = view.getByRole('dialog', { name })
  expect(dialog.contains(document.activeElement)).toBe(true)
  if (dismissal === 'Escape') fireEvent.keyDown(document, { key: dismissal })
  else if (dismissal === 'Cancel') fireEvent.click(within(dialog).getByRole('button', { name: en.cancel }))
  else {
    const backdrop = dialog.previousElementSibling
    if (!backdrop) throw new Error('The modal backdrop is missing')
    expect(backdrop.getAttribute('aria-hidden')).toBe('true')
    fireEvent.click(backdrop)
  }
  expect(view.queryByRole('dialog', { name })).toBeNull()
  expect(document.activeElement).toBe(opener)

  fireEvent.click(opener)
  fireEvent.click(within(view.getByRole('dialog', { name })).getByRole('button', { name: en.close }))
  expect(view.queryByRole('dialog', { name })).toBeNull()
  expect(document.activeElement).toBe(opener)
  expect(props.createProject).not.toHaveBeenCalled()
  expect(props.saveOption).not.toHaveBeenCalled()
  expect(props.compose).not.toHaveBeenCalled()
  view.unmount()
})
