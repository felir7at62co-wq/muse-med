// @vitest-environment jsdom
/** Empty-conversation file intake keeps the mounted composer's ownership and busy guard. */
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { InputState } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { makeTranslate, sessionSnapshot } from '@deepseek-ai/dsh-client-test-runtime'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { ChatStartFiles } from '../src/client/chat/ChatStartFiles.tsx'
import { zh } from '../src/client/locale.ts'

afterEach(cleanup)

it('opens the existing file action and disables it while the draft is locked or the Session is removed', () => {
  let input: InputState = { draft: 'Keep my instruction', draftRev: 3, attachmentIds: [], phase: 'plain', occurrences: [], queue: [] }
  let session = sessionSnapshot(SessionId('file-start'))
  const addFiles = vi.fn()
  const props: Parameters<typeof ChatStartFiles>[0] = {
    useInput: select => select(input), useSession: select => select(session), addFiles, t: makeTranslate(zh),
  }
  const view = render(<ChatStartFiles {...props} />)
  fireEvent.click(view.getByRole('button', { name: '添加文件' }))
  expect(addFiles).toHaveBeenCalledOnce()
  input = { ...input, phase: 'sending' }
  view.rerender(<ChatStartFiles {...props} />)
  expect(view.getByRole('button', { name: '添加文件' }).hasAttribute('disabled')).toBe(true)
  fireEvent.click(view.getByRole('button', { name: '添加文件' }))
  expect(addFiles).toHaveBeenCalledOnce()
  input = { ...input, phase: 'plain' }; session = { ...session, removed: true }
  view.rerender(<ChatStartFiles {...props} />)
  expect(view.getByRole('button', { name: '添加文件' }).hasAttribute('disabled')).toBe(true)
  expect(input.draft).toBe('Keep my instruction')
})
