// @vitest-environment jsdom
import { fireEvent } from '@testing-library/react'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { MarkdownDelegateProvider } from '@deepseek-ai/dsh-client-ui-primitives'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { expect, it, onTestFinished, vi } from 'vitest'
import { NS, en, zh } from '../src/client/locales.ts'
import { VideoSuggestionLink } from '../src/client/VideoSuggestionLink.tsx'
import { videoWorkspaceAddress } from '../src/client/target-selection.ts'
import type {} from '../src/client/resource-provider.ts'
import { inventory, sessionId, shot, source, whole } from './selection-fixture.client.ts'
import type { ResourceSnapshot } from '@deepseek-ai/dsh-client-resources/client'
import type { SessionVideoInventory } from '@deepseek-ai/dsh-session-video/types'

async function fixture(address: string, available = true) {
  const openResourceLink = vi.fn()
  const openAdvice = vi.fn()
  const runtime = await SlotTestRuntime.create()
  const locale = new LocaleRuntime(runtime.ctx)
  runtime.ctx.provide('locale', locale)
  locale.register(NS, { en, zh }); locale.setLocale('en'); runtime.slots.installLocale(locale)
  const resource = createSnapshotStore<ResourceSnapshot<SessionVideoInventory>>({
    status: 'live', value: available ? inventory([source()]) : undefined, failure: undefined,
  })
  runtime.slots.provideRoot({ keyedHooks: { resource: () => resource } })
  await runtime.sessions.add({ id: sessionId })
  const session = runtime.sessions.retain(sessionId)
  await session.ready
  onTestFinished(async () => { session.release(); await runtime.dispose() })
  const key = 'conversation.chat.markdown.resource-link'
  await runtime.root.declare({ [key]: { kind: 'hoc', scope: 'session', inline: true } },
    ({ renderSlot, SessionProvider }) => <SessionProvider session={session}>
      <MarkdownDelegateProvider openResourceLink={openResourceLink}>
        {renderSlot(key, { address, host: 'session-video' }, { entryKey: 'session-video', children: <a href={address}>Original link</a> })}
      </MarkdownDelegateProvider>
    </SessionProvider>)
  await runtime.mount({ inject: ['slots'], apply: (ctx) => {
    ctx.slots.register({ name: key, key: 'session-video', id: 'muse-video-suggestion', locale: NS,
      inject: () => ({ openAdvice }) }, VideoSuggestionLink)
  } })
  return { view: runtime.renderRoot(), openResourceLink, openAdvice }
}

it('shows the exact time and separate draft action and delegates only their own addresses', async () => {
  const range = { ...shot(source()), startSeconds: 12.2, endSeconds: 15 }
  const inspect = videoWorkspaceAddress(sessionId, range)
  const address = `${inspect}&suggestion=Raise%20the%20brightness.`
  const { view, openResourceLink } = await fixture(address)
  const locate = view.getByRole('link', { name: '00:12.20–00:15' })
  const draft = view.getByRole('link', { name: 'Use this suggestion in chat' })
  expect(locate.getAttribute('title')).toContain(source().label)
  expect(draft.getAttribute('href')).toBe(address)
  expect(draft.getAttribute('title')).toBe('Raise the brightness.')
  expect(openResourceLink).not.toHaveBeenCalled()
  fireEvent.click(locate)
  fireEvent.click(draft)
  expect(openResourceLink.mock.calls).toEqual([[inspect], [address]])
})

it('shows the problem, source requirement and change with distinct seek and draft actions', async () => {
  const target = shot(source())
  const address = `${videoWorkspaceAddress(sessionId, target)}&at=4.25&problem=Eyes%20are%20hidden` +
    '&basis=The%20script%20requires%20an%20eye%20close-up&suggestion=End%20on%20the%20eyes.'
  const { view, openAdvice, openResourceLink } = await fixture(address)
  expect(view.getByRole('group', { name: 'Shot advice' })).toBeDefined()
  expect(view.getByText('Eyes are hidden')).toBeDefined()
  expect(view.getByText('The script requires an eye close-up')).toBeDefined()
  expect(view.getByText('End on the eyes.')).toBeDefined()
  fireEvent.click(view.getByRole('link', { name: '00:04.25' }))
  fireEvent.click(view.getByRole('link', { name: 'Use this suggestion in chat' }))
  expect(openResourceLink).not.toHaveBeenCalled()
  expect(openAdvice.mock.calls).toEqual([
    [{ sessionId, target, seekSeconds: 4.25 }],
    [{ sessionId, target, seekSeconds: 4.25, editSuggestion: 'End on the eyes.',
      issue: { problem: 'Eyes are hidden', basis: 'The script requires an eye close-up' } }],
  ])
})

it.each([true, false])('keeps whole-video advice visible while its inventory is available=%s', async (available) => {
  const item = source()
  const inspect = videoWorkspaceAddress(sessionId, whole(item))
  const address = `${inspect}&suggestion=Adjust%20the%20color.`
  const { view, openResourceLink } = await fixture(address, available)
  const draft = view.getByRole('link', { name: 'Use this suggestion in chat' })
  expect(view.queryByRole('link', { name: item.label })?.getAttribute('href')).toBe(available ? inspect : undefined)
  view.container.addEventListener('click', (event) => { event.preventDefault() }, { once: true })
  fireEvent.click(draft, { ctrlKey: true })
  expect(openResourceLink).not.toHaveBeenCalled()
  fireEvent.click(draft)
  expect(openResourceLink).toHaveBeenCalledExactlyOnceWith(address)
})

it('leaves ordinary and foreign links in their existing Markdown presentation', async () => {
  for (const address of [videoWorkspaceAddress(sessionId, shot(source())),
    `${videoWorkspaceAddress(SessionId('another-chat'), shot(source()))}&suggestion=Adjust%20color`]) {
    const { view, openResourceLink } = await fixture(address)
    expect(view.getByRole('link', { name: 'Original link' }).getAttribute('href')).toBe(address)
    expect(view.queryByRole('link', { name: 'Use this suggestion in chat' })).toBeNull()
    expect(openResourceLink).not.toHaveBeenCalled()
    view.unmount()
  }
})
