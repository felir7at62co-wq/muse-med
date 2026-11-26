// @vitest-environment jsdom
/** The native keyed renderer keeps messages and queue previews compact and Session-bound. */
import { fireEvent } from '@testing-library/react'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { expect, it, onTestFinished, vi } from 'vitest'
import { VideoSelectionText } from '../src/client/VideoSelectionText.tsx'
import { NS, en, zh } from '../src/client/locales.ts'
import { videoSelectionRule } from '../src/client/user-text-rules.ts'
import { serializeVideoTargets, videoWorkspaceAddress } from '../src/client/target-selection.ts'
import { sessionId, shot, source, whole } from './selection-fixture.client.ts'

async function fixture(interactive: boolean, ownSession = sessionId, wholeVideos = false) {
  const runtime = await SlotTestRuntime.create()
  const locale = new LocaleRuntime(runtime.ctx)
  runtime.ctx.provide('locale', locale)
  locale.register(NS, { en, zh }); locale.setLocale('en'); runtime.slots.installLocale(locale)
  const item = { ...source(), label: 'EP31 <literal> video' }
  const second = source('second')
  const serialized = serializeVideoTargets(wholeVideos ? [whole(item), whole(second)] : [shot(item)], [item, second], sessionId)
  if (!serialized.ok) throw new Error('selection fixture is unavailable')
  const node = videoSelectionRule.match(serialized.text, 0)
  if (node?.id !== 'muse-video-selection') throw new Error('selection fixture is malformed')
  const openVideoSelection = vi.fn()
  await runtime.sessions.add({ id: ownSession })
  const session = runtime.sessions.retain(ownSession)
  await session.ready
  onTestFinished(async () => { session.release(); await runtime.dispose() })
  await runtime.root.declare({ 'conversation.user.text.node': { kind: 'keyed', scope: 'session', inline: true } },
    ({ renderSlot, SessionProvider }) => <SessionProvider session={session}>
      {renderSlot('conversation.user.text.node', { node, raw: serialized.text, interactive }, { entryKey: 'muse-video-selection' })}
    </SessionProvider>)
  await runtime.mount({ inject: ['slots'], apply: (ctx) => {
    ctx.slots.register({ name: 'conversation.user.text.node', key: 'muse-video-selection', locale: NS,
      inject: () => ({ openVideoSelection }) }, VideoSelectionText)
  } })
  return { view: runtime.renderRoot(), openVideoSelection, item }
}

it('shows a literal source label and segment range instead of raw JSON and opens its exact resource', async () => {
  const { view, openVideoSelection, item } = await fixture(true)
  const chip = view.getByRole('button', { name: 'EP31 <literal> video · 4.00–8.00 s' })
  expect(view.container.textContent).not.toContain('source_version')
  expect(view.container.textContent).not.toContain('<muse-video-selection>')
  expect(view.container.querySelector('literal')).toBeNull()
  expect(chip.getAttribute('title')).toBe('EP31 <literal> video · 4.00–8.00 s')
  fireEvent.click(chip)
  expect(openVideoSelection).toHaveBeenCalledExactlyOnceWith(videoWorkspaceAddress(sessionId, shot(item)))
})

it('keeps read-only queue previews compact without an activation control', async () => {
  const { view, openVideoSelection } = await fixture(false)
  expect(view.queryByRole('button')).toBeNull()
  expect(view.container.textContent).toContain('EP31 <literal> video · 4.00–8.00 s')
  expect(openVideoSelection).not.toHaveBeenCalled()
})

it('does not activate a reference whose owning conversation differs from its renderer Session', async () => {
  const { view, openVideoSelection } = await fixture(true, SessionId('another-conversation'))
  expect(view.queryByRole('button')).toBeNull()
  expect(view.container.textContent).toContain('EP31 <literal> video')
  expect(openVideoSelection).not.toHaveBeenCalled()
})

it('renders whole-video labels for multiple sources without inventing segment times', async () => {
  const { view } = await fixture(true, sessionId, true)
  expect(view.getByRole('button', { name: 'EP31 <literal> video' })).toBeTruthy()
  expect(view.getByRole('button', { name: 'Video second' })).toBeTruthy()
  expect(view.container.textContent).not.toContain('4.00')
})
