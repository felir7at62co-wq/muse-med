// Modified for Muse Bot; upstream DS Bot 0.2.2 is retained under Apache-2.0.
// Muse product details and application update actions.
import { createElement as h, useEffect, useState } from 'react'
import { t } from './i18n.js'
import { BotMark } from './mark.js'
import { MAIN_LOOK } from './characters.js'

const CHEER_MS = 1800

export function ownAppRow(ownApp) {
  if (ownApp === null || typeof ownApp !== 'object') return null
  const version = typeof ownApp.version === 'string' ? ownApp.version : ''
  switch (ownApp.phase) {
    case 'checking': return { hint: t('Checking for updates…'), button: null }
    case 'current': return { hint: t('Up to date'), button: 'check' }
    case 'downloading': return { hint: t('Downloading {version}…', { version }), button: null }
    case 'downloaded': return { hint: t('{version} is ready; it installs when you restart', { version }), button: 'restart' }
    case 'available': return { hint: t('{version} is available', { version }), button: 'open' }
    case 'failed': return { hint: t('Could not check for updates.'), button: 'check' }
    default: return null
  }
}


export function AboutPage({ useUpdate, actions, run, Section, Row }) {
  const update = useUpdate(value => value) ?? {}
  const [cheer, setCheer] = useState(true)
  useEffect(() => {
    if (!cheer) return undefined
    const timer = setTimeout(() => setCheer(false), CHEER_MS)
    return () => clearTimeout(timer)
  }, [cheer])
  const ownRow = update.source === 'app' ? ownAppRow(update.ownApp) : null
  const button = ownRow?.button
  const control = button === 'restart'
    ? h('button', { type: 'button', className: 'bt-fb-primary', onClick: () => run(actions.installOwnApp()) }, t('Restart to update'))
    : button === 'check'
      ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => run(actions.checkOwnApp()) }, t('Check for updates'))
      : button === 'open'
        ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => run(actions.openOwnApp()) }, t('Download'))
        : null
  const version = update.productVersion ?? update.ownApp?.version
  return [
    h('div', { key: 'hero', className: 'bt-about-hero' },
      h('span', { className: 'bt-about-mark' }, h(BotMark, { look: MAIN_LOOK, bot: { id: 'about' }, size: 52, state: cheer ? 'done' : 'idle', live: true, gaze: true, pokeable: true })),
      h('div', { className: 'bt-about-copy' },
        h('span', { className: 'bt-about-name' }, t('Muse Bot')),
        version ? h('span', { className: 'bt-about-version' }, t('Version {version}', { version })) : null)),
    h(Section, { key: 'updates', title: t('Updates') },
      h(Row, { label: t('Muse Bot'), hint: ownRow?.hint ?? t('Updates come with Muse.') }, control)),
    h(Section, { key: 'links', title: t('Links') },
      h(Row, { label: t('Report a problem') }, h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => actions.openSettings('feedback') }, t('Open')))),
  ]
}

export const ABOUT_CSS = `
.bt-about-hero{display:flex;align-items:center;gap:14px;padding:16px;border:1px solid var(--bt-line);border-radius:12px;background:var(--bt-card)}
.bt-about-mark{flex:none;display:inline-flex;position:relative}
.bt-about-mark::before{content:'';position:absolute;inset:-20%;border-radius:50%}
body:not([data-bt-motion=quiet]) .bt-about-mark:hover .bt-mark[data-live][data-state=idle]:not(.bt-mark-poke) .bt-b{rotate:8deg;translate:5% -1%;animation:bt-nuzzle .78s ease-in-out .32s infinite}
body:not([data-bt-motion=quiet]) .bt-about-mark:hover .bt-mark[data-live][data-state=idle] .bt-eye{scale:1 0;animation:none}
body:not([data-bt-motion=quiet]) .bt-about-mark:hover .bt-mark[data-live][data-state=idle] .bt-eye-happy{opacity:1;transition-delay:.1s}
.bt-about-copy{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.bt-about-name{font-size:16px;line-height:22px;font-weight:500}
.bt-about-version{font-size:12px;line-height:16px;color:var(--bt-ink-2);font-variant-numeric:tabular-nums}
.bt-fb-primary:disabled{opacity:.6;cursor:default;filter:none}
`
