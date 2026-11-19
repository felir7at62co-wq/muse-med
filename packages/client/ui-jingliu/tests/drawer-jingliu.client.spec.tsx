// @vitest-environment jsdom
/** The Jingliu tab of the Bot team's details drawer: choosing a production, shot cards and the export request. */
import { fireEvent, render, waitFor } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { expect, it, vi } from 'vitest'
import { DrawerJingliu } from '../src/client/DrawerJingliu.tsx'
import { en } from '../src/client/locales.ts'

type Props = Parameters<typeof DrawerJingliu>[0]

const project = { id: 'p1', title: 'Bridge Lions', episodes: 2, shots: 3, completed: 1, role: 'owner', thumbnail: '' }
const shot = { id: 's1', order: 1, episode: 1, index: 1, prompt: 'Ah Qiao walks past Golden Lion at the night market.',
  characters: ['Ah Qiao'], location: 'night market', props: [], durationSec: 4, hasVideo: true, failReason: '', stale: false }
const data: Record<string, unknown> = {
  'jingliu-projects': [project],
  'jingliu-config': { projectId: 'p1', title: 'Bridge Lions', aspect: '9:16', artStyle: 'ink', mode: 'drama', resolution: '1080p', imageModel: '', videoModel: 'seed-1' },
  'jingliu-episodes': [{ number: 1, title: '', hasShots: true }, { number: 2, title: '', hasShots: false }],
  'jingliu-shots': [shot],
  'jingliu-shot-media': { shotId: 's1', videoPath: '/fw/media/generated/s1.mp4', firstFramePath: '', adoptedVersion: 2,
    versions: [{ number: 1, model: 'seed-1', videoPath: '/fw/media/generated/s1-v1.mp4', createdAt: '' }, { number: 2, model: 'seed-2', videoPath: '/fw/media/generated/s1.mp4', createdAt: '' }] },
  'jingliu-project-assets': { assets: [{ id: 'a1', kind: 'character', name: 'Ah Qiao', imagePath: '', prompt: 'A young porter' }], audio: [] },
}

function setup(selected: { id: string; title: string } | null) {
  const reads: URL[] = []
  const useResource = ((address: string) => {
    if (!address.startsWith('dsh-resource://')) return { status: 'none', failure: undefined, value: undefined }
    const url = new URL(address)
    reads.push(url)
    return { status: 'live', failure: undefined, value: url.hostname === 'jingliu-selected' ? selected : data[url.hostname] }
  }) as Props['useResource']
  const props = {
    sessionId: 'part-1', t: makeTranslate(en), useResource, useAccountEpoch: <T,>(select: (value: number) => T) => select(1),
    quote: vi.fn(), compose: vi.fn(), chooseProject: vi.fn(async () => {}), loadVideo: vi.fn(async () => 'blob:video'),
  } as Props
  return { props, reads }
}

it('ties the picked production to the Bot conversation the drawer belongs to', async () => {
  const { props } = setup(null)
  const view = render(<DrawerJingliu {...props} />)
  fireEvent.click(view.getByRole('button', { name: /Bridge Lions/u }))
  await waitFor(() => expect(props.chooseProject).toHaveBeenCalledWith('part-1', project))
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
  fireEvent.click(view.getByRole('button', { name: 'Make another' }))
  expect(props.compose).toHaveBeenCalledWith('Make another version of Episode 1 · Shot 1: ')
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

it('prepares a batch export request for the episodes that have shots', () => {
  const { props } = setup({ id: 'p1', title: 'Bridge Lions' })
  const view = render(<DrawerJingliu {...props} />)
  fireEvent.click(view.getByRole('button', { name: 'Batch export' }))
  expect((view.getByRole('checkbox', { name: 'Episode 2' }) as HTMLInputElement).disabled).toBe(true)
  fireEvent.click(view.getByRole('switch', { name: 'Ending' }))
  fireEvent.click(view.getByRole('button', { name: 'Export CapCut drafts' }))
  expect(props.compose).toHaveBeenCalledWith('Export episodes 1 as CapCut drafts, with subtitles, background music, the “AI generated” watermark.')
  view.unmount()
})
