// Muse: the panel's Terminal tab — the conversation's terminals as cards under the Bot's
// name, as the Browser tab shows its pages. A card opens its terminal in a strip tab of
// its own; the last row starts another terminal.
import { createElement as h, useEffect, useState } from 'react'
import { PlusIcon, TerminalIcon } from './icons.js'
import { terminalCards } from './side-model.js'
import { t } from './i18n.js'

const NO_TERMINALS = []

// The terminals the Host lists for one conversation part, kept current while mounted.
export function useTerminals(session, actions) {
  const [listed, setListed] = useState(NO_TERMINALS)
  useEffect(() => {
    setListed(NO_TERMINALS)
    if (!session || !actions.watchTerminals) return undefined
    return actions.watchTerminals(session, setListed)
  }, [session])
  return listed
}

// A terminal's folder, by its last two segments.
const shortFolder = cwd => String(cwd ?? '').split(/[\\/]/).filter(Boolean).slice(-2).join('/')
const stateText = state => (state === 'exited' ? t('Exited') : state === 'failed' ? t('Unavailable') : state === 'starting' ? t('Starting…') : '')

export function TerminalCards({ sessionId, part, tabs, actions }) {
  const listed = useTerminals(part, actions)
  const cards = terminalCards(listed, tabs, actions.terminalOf)
  const open = card => (card.tab !== null ? actions.showDetails(sessionId, `terminal:${card.tab}`) : actions.openTerminal(sessionId, part, card.id))
  if (cards.length === 0) {
    return h('div', { className: 'bt-browser-empty-mark' },
      h('span', { className: 'bt-tcard-mark', 'aria-hidden': true }, h(TerminalIcon)),
      h('button', { type: 'button', className: 'bt-browser-retry', onClick: () => actions.openTerminal(sessionId, part) }, t('Open terminal')))
  }
  return h('div', { className: 'bt-bcards' },
    cards.map((card, index) => {
      const label = card.title || t('Terminal')
      const note = stateText(card.state) || (card.agent ? t('Agent') : '')
      return h('div', { key: card.tab ?? card.id, className: 'bt-bcard bt-tcard', 'data-open': card.tab !== null || undefined, style: { animationDelay: `${index * 30}ms` } },
        h('button', { type: 'button', className: 'bt-tcard-open', 'aria-label': t('Open {title}', { title: label }), title: card.cwd, onClick: () => open(card) },
          h(TerminalIcon),
          h('span', { className: 'bt-bcard-title' }, label),
          note ? h('span', { className: 'bt-tcard-note' }, note) : null,
          card.cwd ? h('span', { className: 'bt-bcard-host' }, shortFolder(card.cwd)) : null),
        h('button', {
          type: 'button', className: 'bt-bcard-x', 'aria-label': t('Close terminal'), title: t('Close terminal'),
          onClick: () => actions.endTerminal(sessionId, part, { tab: card.tab, terminalId: card.id ?? undefined }),
        }, '×'))
    }),
    h('button', { type: 'button', className: 'bt-bcard-new', style: { animationDelay: `${cards.length * 30}ms` }, onClick: () => actions.openTerminal(sessionId, part) }, h(PlusIcon), t('New terminal')))
}

export const TERMINAL_CSS = `
.bt-tcard-open{display:flex;align-items:center;gap:8px;width:100%;min-width:0;height:44px;padding:0 36px 0 12px;border:0;background:none;color:var(--bt-ink);font:inherit;text-align:left;cursor:pointer}
.bt-tcard-open:hover{background:var(--bt-hover)}
.bt-tcard-open:focus-visible{outline:2px solid var(--bt-accent);outline-offset:-2px}
.bt-tcard-open svg{flex:none;width:16px;height:16px;color:var(--bt-ink-2)}
.bt-tcard[data-open] .bt-tcard-open svg{color:var(--bt-accent)}
.bt-tcard-note{flex:none;font-size:11px;line-height:15px;color:var(--bt-ink-3)}
.bt-tcard .bt-bcard-x{top:11px}
.bt-tcard-mark{display:inline-grid;place-items:center;width:40px;height:40px;border-radius:12px;background:var(--bt-hover);color:var(--bt-ink-2)}
.bt-tcard-mark svg{width:20px;height:20px}
.bt-drawer-body[data-fill]{padding:0;gap:0;overflow:hidden}
`
