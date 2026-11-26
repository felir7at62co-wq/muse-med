// @vitest-environment jsdom
import type { ComponentProps } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { afterEach, expect, it, vi } from 'vitest'
import { StudioMaterials } from '../src/client/StudioMaterials.tsx'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

type UseSessions = ComponentProps<typeof StudioMaterials>['useSessions']
type SessionList = Parameters<Parameters<UseSessions>[0]>[0]
const sessionId = SessionId('production')

it('uses the session working directory to expose the materials action', () => {
  const list: SessionList = { ids: [], byId: {}, phase: 'ready', projectionsBySession: {} }
  const useSessions: UseSessions = select => select(list)
  const openMaterials = vi.fn()
  const button = <StudioMaterials sessionId={sessionId} useSessions={useSessions} openMaterials={openMaterials} t={makeTranslate(en)} />
  const subject = render(button)
  expect(screen.queryByRole('button', { name: 'Materials folder' })).toBeNull()
  list.ids = [sessionId]
  list.byId[sessionId] = {
    id: sessionId, displayTitle: 'Production', cwd: '/studio/footage',
    running: false, retainedBy: {}, blank: false, updatedAt: 0,
  }
  subject.rerender(<StudioMaterials sessionId={sessionId} useSessions={useSessions} openMaterials={openMaterials} t={makeTranslate(en)} />)
  fireEvent.click(screen.getByRole('button', { name: 'Materials folder' }))
  expect(openMaterials).toHaveBeenCalledOnce()
})
