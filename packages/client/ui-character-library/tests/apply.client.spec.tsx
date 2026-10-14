// @vitest-environment jsdom
/** The shipped roster must register and unload the read-only page without a remote catalog. */
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect } from 'vitest'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { createClientTest, webApp } from '@deepseek-ai/dsh-client-test-runtime/src/assembly/index.ts'
import { CharacterLibraryTab, CharacterLibraryTitle } from '../src/client/tab.tsx'
import { LIBRARY_ID, LIBRARY_KIND } from '../src/client/definition.tsx'

const it = createClientTest({ roster: webApp })
afterEach(cleanup)

it('registers one localized guide, the body and title, and removes every seat on unload', async ({ start, mock }) => {
  const client = await start()
  const definition = client.ctx.sidebarRightTabs.get(LIBRARY_KIND)!
  expect(definition.id).toBe(LIBRARY_ID)
  expect(definition.patterns).toBeUndefined()
  expect(definition.title('')).toBe('Character library')
  const guide = client.ctx.sidebarRightTabs.guide().filter(entry => entry.providerId === LIBRARY_ID)
  expect(guide).toHaveLength(1)
  expect(guide[0]!.title()).toBe('Character library')
  expect(guide[0]!.description!()).toBe('Browse character cards, appearance, and review information')
  expect(guide[0]!.icon).toBeDefined()
  expect(client.ctx.slots.entries('sidebar.right.pane.tab').filter(entry => entry.options.key === LIBRARY_ID))
    .toHaveLength(1)
  expect(client.ctx.slots.entries('sidebar.right.pane.tab.title').filter(entry => entry.options.key === LIBRARY_ID))
    .toHaveLength(1)

  const callsBeforeBrowsing = mock.log.calls().length
  render(<CharacterLibraryTab t={client.ctx.locale.bind('characterLibrary')} />)
  expect(await screen.findByText('No character library source is configured')).toBeTruthy()
  expect(screen.queryByText(/Test data is displayed/)).toBeNull()
  expect(document.querySelector('img')).toBeNull()
  cleanup()
  expect(mock.log.calls()).toHaveLength(callsBeforeBrowsing)

  await client.reload(LIBRARY_ID)
  expect(client.ctx.sidebarRightTabs.guide().filter(entry => entry.providerId === LIBRARY_ID)).toHaveLength(1)
  expect(client.ctx.slots.entries('sidebar.right.pane.tab').filter(entry => entry.options.key === LIBRARY_ID))
    .toHaveLength(1)
  expect(client.ctx.slots.entries('sidebar.right.pane.tab.title').filter(entry => entry.options.key === LIBRARY_ID))
    .toHaveLength(1)
  await client.unload(LIBRARY_ID)
  expect(client.ctx.sidebarRightTabs.get(LIBRARY_KIND)).toBeUndefined()
  expect(client.ctx.sidebarRightTabs.guide().filter(entry => entry.providerId === LIBRARY_ID)).toHaveLength(0)
  expect(client.ctx.slots.entries('sidebar.right.pane.tab').filter(entry => entry.options.key === LIBRARY_ID)).toHaveLength(0)
  expect(client.ctx.slots.entries('sidebar.right.pane.tab.title').filter(entry => entry.options.key === LIBRARY_ID)).toHaveLength(0)
  expect(client.ctx.locale.bind('characterLibrary')('title')).toBe('title')
  expect(mock.log.calls()).toHaveLength(callsBeforeBrowsing)
}, 60_000)

it('renders the framework supplied tab title without a source or write control', async () => {
  const titleProps: PropsRuntime<'sidebar.right.pane.tab.title'> = {
    useTabInfo: () => ({ tab: { title: '人物库' } }),
  } as never
  render(<CharacterLibraryTitle {...titleProps} />)
  expect(screen.getByText('人物库')).toBeTruthy()
  expect(document.querySelector('svg')).not.toBeNull()
  expect(document.querySelector('button,input')).toBeNull()
})
