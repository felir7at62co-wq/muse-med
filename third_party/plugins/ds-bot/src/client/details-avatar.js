import { createElement as h, useEffect, useState } from 'react'
import { BotAvatar, BotMark, botState, lookOf } from './mark.js'
import { POLL_MAX_MS } from './polling.js'

const COMPLETION_MS = 1100

/** Render the current activity of the purple spider in the Bot details pane. */
export function DetailsAvatar({ bot, main, running, activity, awaitingInput, completedAt }) {
  const look = lookOf(bot)
  if (look.shape !== 'muse-spider' || look.image) {
    return h(BotAvatar, { bot, size: 64, main, state: botState(running, activity, awaitingInput),
      badge: false, gaze: true, pokeable: true })
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
    h(BotMark, { bot, look, size: 64, state, live: true, gaze: state === 'idle', pokeable: state === 'idle' }))
}

export const SPIDER_DETAIL_CSS = `
.bt-spider-detail{display:inline-flex;justify-content:center;margin-bottom:16px}
.bt-spider-detail .bt-mark[data-state=thinking] .bt-b{animation:bt-spider-think-body 2.8s ease-in-out infinite}
.bt-spider-detail .bt-mark[data-state=thinking] .bt-eyes{animation:bt-spider-think-eyes 2.8s ease-in-out infinite}
.bt-spider-detail .bt-mark[data-state=working] .bt-b{animation:bt-spider-work 1.4s ease-in-out infinite}
.bt-spider-detail .bt-mark[data-state=working] .bt-eye{animation-duration:3.8s}
body .bt-spider-detail .bt-mark[data-state=alert] .bt-b{animation:bt-spider-attend-body .4s ease-out both}
.bt-spider-detail .bt-mark[data-state=alert] .bt-eyes{animation:bt-spider-attend-eyes .44s ease-out both}
.bt-spider-detail .bt-mark[data-state=alert] .bt-eye{animation:none}
.bt-spider-detail .bt-mark[data-state=done] .bt-b{animation:bt-spider-finish .84s ease-out 1}
.bt-spider-detail .bt-mark[data-state=done] .bt-eye{animation:bt-spider-finish-open .84s linear 1}
.bt-spider-detail .bt-mark[data-state=done] .bt-eye-happy{animation:bt-spider-finish-smile .84s linear 1}
@keyframes bt-spider-think-body{
  0%,100%{transform:none}
  36%,65%{transform:translate(1%,-1.5%) rotate(-7deg) scale(.98,1.04)}
}
@keyframes bt-spider-think-eyes{
  0%,100%{transform:none}
  24%,69%{transform:translate(12%,-6%) scaleY(.93)}
}
@keyframes bt-spider-work{
  0%,100%{transform:none}
  26%{transform:translateY(-5%) rotate(-3deg) scale(.98,1.03)}
  52%{transform:translateY(1%) scale(1.025,.97)}
  75%{transform:translateY(-3%) rotate(2deg)}
}
@keyframes bt-spider-attend-body{
  0%{transform:translateY(-3%) rotate(-3deg)}
  100%{transform:none}
}
@keyframes bt-spider-attend-eyes{
  0%{transform:translate(10%,-5%) scaleY(.93)}
  70%,100%{transform:scale(1.04)}
}
@keyframes bt-spider-finish{
  0%,100%{transform:none}
  16%{transform:scale(1.05,.94)}
  40%{transform:translateY(-9%) scale(.98,1.04)}
  70%{transform:scale(1.035,.96)}
  90%{transform:scale(.99,1.012)}
}
@keyframes bt-spider-finish-open{
  0%,18%,74%,100%{opacity:1}
  28%,63%{opacity:0}
}
@keyframes bt-spider-finish-smile{
  0%,18%,74%,100%{opacity:0}
  28%,63%{opacity:1}
}
body:is([data-bt-effects=reduced],[data-bt-effects=off]) .bt-spider-detail .bt-mark *{
  animation:none!important;transition:none!important
}
`
