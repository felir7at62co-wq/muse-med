/** Real Bot sidebar and CSS, with only its roster and row operations replaced by local data. */
import { createElement as h, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { TeamSidebar, SIDEBAR_CSS } from '../../../../../../third_party/plugins/ds-bot/src/client/sidebar.js'
import { SHELL_CSS } from '../../../../../../third_party/plugins/ds-bot/src/client/styles.js'

export const inject = ['slots', 'layout', 'locale']

/** Mount the real navigation components inside the shipped SidebarRoot. */
export function apply(ctx) {
  const labels = { leave: 'Leave fixture Bot mode', restore: 'Restore fixture Bot mode' }
  ctx.effect(() => ctx.locale.register('fixtureBotRail', { en: labels, zh: labels }))
  const bots = Array.from({ length: 24 }, (_, index) => ({ id: index === 0 ? 'chief' : `writer-${index}`,
    name: index === 0 ? 'Muse coordinator' : `Writer ${index}`, createdAt: index + 1 }))
  const roster = { bots, rooms: [], agents: [], byId: Object.fromEntries(bots.map(bot => [bot.id, bot])),
    roomsById: {}, agentOf: {}, mainBotId: 'chief', mainBotIds: ['chief'], ready: true, exchangeTurns: {} }
  const sessions = { ids: [], byId: {} }
  const noStatus = new Map()
  const note = (id) => { document.documentElement.dataset.fixtureBotSelected = id }
  const actions = { toggleSidebar: () => ctx.layout.toggleSidebar(), openSession: note,
    openPalette: () => note('search'), openSettings: () => note('settings'), openNewChat: () => note('new'),
    clearUnread() {}, landOn() {}, openMenu() {} }
  function Sidebar(props) {
    return h(TeamSidebar, { ...props, actions,
      useRoster: select => select(roster), useUi: select => select({ unread: {} }),
      useRegistry: select => select({}), useSessions: select => select(sessions),
      useSessionStatus: select => select(noStatus), useSessionRetainInfo: (_id, select) => select(undefined),
      useActivity: select => select({}), useWork: select => select({ approvals: [], rooms: {}, waiting: {} }),
      useUpdate: select => select({}),
    })
  }
  let releaseShell
  const activate = () => {
    const releaseRail = ctx.layout.retainSidebarRail()
    const style = document.createElement('style')
    style.dataset.plugin = '@fixture/bot-sidebar-rail'
    style.textContent = SHELL_CSS + SIDEBAR_CSS
    document.head.append(style)
    const releaseSlot = ctx.slots.inject('sidebar.workspaces', () => ctx.slots.register({
      name: 'sidebar.workspaces', priority: -100,
    }, Sidebar))
    releaseShell = () => { releaseSlot(); style.remove(); releaseRail() }
  }
  function Controls({ t }) {
    const [active, setActive] = useState(true)
    return h(Button, { 'data-fixture-bot-mode': active ? 'bot' : 'classic',
      style: { position: 'fixed', right: 12, bottom: 12, pointerEvents: 'auto' },
      onClick: () => {
        if (active) { releaseShell?.(); releaseShell = undefined }
        else activate()
        setActive(!active)
      },
    }, t(active ? 'leave' : 'restore'))
  }
  ctx.effect(() => { activate(); return () => { releaseShell?.(); releaseShell = undefined } })
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay', id: 'fixture-bot-rail-control', locale: 'fixtureBotRail',
  }, Controls))
}
