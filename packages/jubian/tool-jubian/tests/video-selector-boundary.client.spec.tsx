// @vitest-environment jsdom
/** A stale menu command must not submit a key absent from the current live catalogue. */
import type { ReactNode } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { VideoModelSelect, type VideoModelSelectProps } from '../src/client/VideoModelSelect.tsx'
import type { VideoDirectoryState } from '../src/client/video-directory.ts'
import { en } from '../src/client/locales.ts'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', async original => ({
  ...await original<typeof import('@deepseek-ai/dsh-client-ui-primitives')>(),
  Menu: ({ anchor, children, open, onSelect }: {
    anchor: ReactNode
    children: ReactNode
    open: boolean
    onSelect: (key: string) => void
  }) => <>{anchor}{open ? <div role="menu">{children}
    <button onClick={() => { onSelect('removed-catalogue-option') }}>Deliver stale menu choice</button>
  </div> : null}</>,
}))
afterEach(cleanup)

it('ignores a menu command for an option removed before selection delivery', () => {
  const select = vi.fn(async () => {})
  const state: VideoDirectoryState = { current: null, defaultModel: null, options: [], loading: false, selecting: false, error: null }
  const props = { t: (key: keyof typeof en) => en[key], load: async () => {}, select,
    useVideoState: (selector: (value: VideoDirectoryState) => unknown) => selector(state) } as VideoModelSelectProps
  render(<VideoModelSelect {...props} />)
  fireEvent.click(screen.getByRole('button', { name: 'Video model' }))
  fireEvent.click(screen.getByRole('button', { name: 'Deliver stale menu choice' }))
  expect(select).not.toHaveBeenCalled()
  expect(screen.getByRole('button', { name: 'Video model' }).getAttribute('aria-expanded')).toBe('true')
})
