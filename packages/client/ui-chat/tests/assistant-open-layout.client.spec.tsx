// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { AssistantMarkdown } from '../src/client/chat/AssistantMarkdown.tsx'
import { zh } from '../src/client/locale.ts'
import { useDisclosure } from '../src/client/chat/use-disclosure.ts'
import { useSearchableHidden } from '../src/client/chat/searchable-hidden.ts'
import { useDetailedPresentation } from './presentation-fixture.client.ts'
import { renderReasoningSlot, unusedImageLoader } from './reasoning-component-fixture.tsx'

afterEach(cleanup)

const props = {
  renderSlot: renderReasoningSlot,
  useDisclosure,
  useGroupAction: useSearchableHidden,
  usePresentation: useDetailedPresentation,
  loadImage: unusedImageLoader,
  t: makeTranslate(zh, commonZh),
}

describe('open assistant replies', () => {
  it('keeps the same prose and code nodes as a streaming reply settles', () => {
    const view = render(<AssistantMarkdown {...props} streaming blocks={[{ kind: 'text', text: 'First paragraph.' }]} />)
    const body = view.container.querySelector('[data-assistant-body]')
    const paragraph = view.getByText('First paragraph.')
    expect(body).not.toBeNull()
    expect(view.container.querySelector('[data-message-bubble]')).toBeNull()
    view.rerender(<AssistantMarkdown {...props} streaming blocks={[
      { kind: 'text', text: 'First paragraph.\n\n```ts\nconst frame = 1\n```' },
    ]} />)
    const code = view.getByText('frame', { exact: false }).closest('pre')
    expect(code).not.toBeNull()
    expect(view.getByText('First paragraph.')).toBe(paragraph)
    view.rerender(<AssistantMarkdown {...props} streaming={false} blocks={[
      { kind: 'text', text: 'First paragraph.\n\n```ts\nconst frame = 1\n```' },
    ]} />)
    expect(view.container.querySelector('[data-assistant-body]')).toBe(body)
    expect(view.container.querySelector('[data-message-bubble]')).toBeNull()
    expect(view.container.querySelector('pre')).toBe(code)
  })

  it('leaves reasoning-only and empty streaming rows without reply chrome', () => {
    const view = render(<AssistantMarkdown {...props} streaming blocks={[]} />)
    expect(view.container.querySelector('[data-message-bubble]')).toBeNull()
    view.rerender(<AssistantMarkdown {...props} streaming blocks={[{ kind: 'reasoning', text: 'Inspect the workspace.' }]} />)
    expect(view.container.querySelector('[data-message-bubble]')).toBeNull()
    expect(view.getByRole('button')).toBeTruthy()
  })

  it('renders split reasoning and response content without reply bubble chrome', () => {
    const blocks = [{ kind: 'reasoning' as const, text: 'Inspect the workspace.' }, { kind: 'text' as const, text: 'Reply content.' }]
    const view = render(<AssistantMarkdown {...props} streaming={false} blocks={blocks} groupPart="reasoning" />)
    expect(view.container.querySelector('[data-message-bubble]')).toBeNull()
    expect(view.queryByText('Reply content.')).toBeNull()
    view.rerender(<AssistantMarkdown {...props} streaming={false} blocks={blocks} groupPart="response" />)
    expect(view.getByText('Reply content.').closest('[data-assistant-body]')).not.toBeNull()
    expect(view.container.querySelector('[data-message-bubble]')).toBeNull()
    expect(view.queryByRole('button', { name: '思考' })).toBeNull()
  })

  it('does not add a bubble around tool-call protocol blocks', () => {
    const view = render(<AssistantMarkdown {...props} streaming={false} blocks={[
      { kind: 'tool-call', callId: 'fixture-call', name: 'read', argsRaw: '{}' },
    ]} />)
    expect(view.container.innerHTML).toBe('')
  })
})
