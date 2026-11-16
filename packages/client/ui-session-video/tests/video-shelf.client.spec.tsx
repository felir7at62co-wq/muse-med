// @vitest-environment jsdom
/** The Chat header opens the native workspace without loading media or replacing a draft. */
import { fireEvent, screen } from '@testing-library/react'
import { expect, it } from 'vitest'
import { en } from '../src/client/locales.ts'
import { fixture } from './video-fixture.tsx'

it('opens the same Session workspace without detecting or submitting from the launcher', async () => {
  const { openWorkspace, detectShots, inputActions, input, panel } = await fixture()
  const draft = input.getSnapshot()
  fireEvent.click(screen.getByRole('button', { name: en.library }))
  expect(openWorkspace).toHaveBeenCalledOnce()
  expect(detectShots).not.toHaveBeenCalled()
  expect(inputActions.insertText).not.toHaveBeenCalled()
  expect(input.getSnapshot()).toBe(draft)
  expect(panel.container.querySelector('video')).toBeNull()
  expect(panel.container.querySelector('[data-muse-video-shelf]')).toBeNull()
})

it('hides the launcher for another conversation view and restores it on return', async () => {
  const { panel, reference, openWorkspace } = await fixture()
  panel.update({ activeView: 'trajectory' }, { session: reference })
  expect(screen.queryByRole('button', { name: en.library })).toBeNull()
  panel.update({ activeView: 'chat' }, { session: reference })
  fireEvent.click(screen.getByRole('button', { name: en.library }))
  expect(openWorkspace).toHaveBeenCalledOnce()
})
