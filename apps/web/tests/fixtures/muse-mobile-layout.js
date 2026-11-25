/** The current Bot column and styles over a small in-page conversation fixture. */
import { createElement as h, Fragment, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { useViewport } from '../../../../third_party/plugins/ds-bot/src/client/motion.js'
import { SIDEBAR_CSS, TeamSidebar } from '../../../../third_party/plugins/ds-bot/src/client/sidebar.js'
import { CONVERSATION_CSS, SHELL_CSS } from '../../../../third_party/plugins/ds-bot/src/client/styles.js'

const style = document.createElement('style')
style.textContent = SHELL_CSS + SIDEBAR_CSS + CONVERSATION_CSS
document.head.append(style)

const bot = { id: 'bridge', name: 'Paper Bridge', createdAt: 1 }
const roster = {
  bots: [bot], rooms: [], agents: [], byId: { [bot.id]: bot }, roomsById: {}, agentOf: {},
  mainBotId: bot.id, mainBotIds: [bot.id], ready: true, exchangeTurns: {},
}
const sessions = { ids: [], byId: {} }
const statuses = new Map()
const work = { approvals: [], rooms: {}, waiting: {} }

function PhoneSidebar() {
  useViewport()
  const [leftDrawer, setLeftDrawer] = useState(true)
  const [opened, setOpened] = useState('')
  const [drawerCloses, setDrawerCloses] = useState(0)
  const actions = {
    openSession: setOpened,
    setLeftDrawer: (visible) => {
      setLeftDrawer(visible)
      if (!visible) setDrawerCloses(count => count + 1)
    },
    landOn() {},
  }
  return h(Fragment, null,
    h(TeamSidebar, { actions,
      useRoster: select => select(roster), useUi: select => select({ leftDrawer, unread: {} }),
      useRegistry: select => select({}), useSessions: select => select(sessions), useSessionStatus: select => select(statuses),
      useSessionRetainInfo: (_id, select) => select(undefined), useActivity: select => select({}), useWork: select => select(work),
      useUpdate: select => select({}),
    }),
    h('output', { 'data-drawer-closes': drawerCloses }, opened))
}

const sidebar = document.getElementById('phone-sidebar-fixture')
if (sidebar) createRoot(sidebar).render(h(PhoneSidebar))
