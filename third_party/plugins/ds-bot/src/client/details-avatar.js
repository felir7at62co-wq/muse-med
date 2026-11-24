import { createElement as h, useEffect, useState } from 'react'
import { BotAvatar, BotMark, botState, lookOf } from './mark.js'
import { POLL_MAX_MS } from './polling.js'

const COMPLETION_MS = 1100

/**
 * Render the current activity of the Bot in its details pane: the Muse spider drawn in parts
 * with its own motion, and every other look as the sidebar draws it. `animated` hands the default characters
 * to animated-avatar.js; the spider never goes there.
 */
export function DetailsAvatar({ bot, main, running, activity, awaitingInput, completedAt, animated = false }) {
  const look = lookOf(bot)
  if (look.shape !== 'muse-spider' || look.image) {
    return h(BotAvatar, { bot, size: 64, main, state: botState(running, activity, awaitingInput),
      badge: false, gaze: true, pokeable: true, animated: animated ? 'live' : undefined, surface: animated ? 'main' : undefined })
  }
  return h(SpiderDetail, { bot, look, running, activity, awaitingInput, completedAt })
}

function SpiderDetail({ bot, look, running, activity, awaitingInput, completedAt }) {
  const [finished, setFinished] = useState(undefined)
  const settling = !running && !awaitingInput && activity !== 'alert' && activity !== 'waiting'
    && completedAt !== undefined && finished !== completedAt
    && completedAt > Date.now() - POLL_MAX_MS - COMPLETION_MS
  useEffect(() => {
    if (!settling) return undefined
    const timer = setTimeout(() => setFinished(completedAt), COMPLETION_MS)
    return () => clearTimeout(timer)
  }, [settling, completedAt])

  const state = awaitingInput || activity === 'alert' ? 'alert'
    : running ? (activity === undefined || activity === 'thinking' ? 'thinking' : 'working')
    : activity === 'waiting' ? 'waiting'
    : settling ? 'done' : 'idle'
  return h('span', { className: 'bt-spider-detail' },
    h(BotMark, { bot, look, size: 64, state, live: true, gaze: state === 'idle', pokeable: state === 'idle', rig: true }))
}

// The spider's motion on this page is spider-motion.js, as on a Main Bot's tile.
export const SPIDER_DETAIL_CSS = `
.bt-spider-detail{display:inline-flex;justify-content:center;margin-bottom:16px}
`
