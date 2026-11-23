import { createElement as h, Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { CoinIcon } from './icons.js'
import { useLinger, useViewport, viewBottom } from './motion.js'
import { t } from './i18n.js'

// Muse: the user's Jingliu credit (积分, 1 积分 = 1 元) behind the quota button in the sidebar
// foot. ui-jingliu mounts the `jingliuConnection` Remote namespace; DS Bot only reads it.
// 'remote' is listed because the callback reads `scope.remote.$on`: the real app never runs a
// callback whose list leaves out a service it reads.
export const QUOTA_INJECT = ['remote', 'remote.jingliuConnection']
export const QUOTA_REFRESH_MS = 60_000
export const QUOTA_HIDDEN_REFRESH_MS = 5 * 60_000
// Showing the window again reads at once, unless the last read started this recently; the next
// read then comes a minute after that one.
const WAKE_MS = 15_000
// Failures that mean the Host does not serve the namespace: the button stays out.
const ABSENT = new Set(['gateway/invocation-unavailable', 'gateway/definition-unavailable', 'gateway/service-unavailable', 'gateway/method-unavailable'])

/** Whether this Host lacks the requested Jingliu service or method. */
export const quotaUnavailable = result => ABSENT.has(result?.error?.code)

const readable = value => value !== null && typeof value === 'object' && typeof value.unlimited === 'boolean'
  && Number.isFinite(value.usedFen) && Number.isFinite(value.heldFen)
  && (value.unlimited || (typeof value.available === 'string' && value.available.trim() !== '' && Number.isFinite(Number(value.available))))

// The `quota` UI state one `balance` result leads to: `known` with the balance, `absent` where the
// Host has no Jingliu service, `unknown` for any other failure, and null for a cancelled read.
export function quotaFrom(result) {
  if (result?.ok === true) return readable(result.value) ? { state: 'known', value: result.value } : { state: 'unknown' }
  const code = result?.error?.code
  if (code === 'gateway/cancelled') return null
  return quotaUnavailable(result) ? { state: 'absent' } : { state: 'unknown' }
}

const sameQuota = (a, b) => a?.state === b?.state && JSON.stringify(a?.value) === JSON.stringify(b?.value)

// Keeps `ui.quota` while the Jingliu namespace is mounted: unset until the first read answers, then
// what each read found. It reads on mount, every minute (five while the window is hidden), when the
// window shows again, after a Muse sign-in change or a reconnect, and on `actions.refreshQuota()`.
// A failed read drops the figure. A sign-in change or a reconnect shows `loading` only while the
// button is in, so a Host without the service never shows it. When the namespace goes away
// `ui.quota` is cleared, and the button with it.
export function installQuota(ctx, { ui, actions }) {
  ctx.inject(QUOTA_INJECT, (scope) => {
    let live = true
    let reading = null
    let started = 0
    let timer
    const put = quota => ui.set(state => (sameQuota(state.quota, quota) ? state : { ...state, quota }))
    // Each source belongs to one connection and login. The settings page drops results
    // from a previous source before starting the next read.
    const billingSource = () => signal => scope.remote.jingliuConnection.billingDetails(signal)
    ui.set(state => ({ ...state, readBillingDetails: billingSource() }))
    const read = () => {
      if (!live) return
      clearTimeout(timer)
      timer = setTimeout(read, document.hidden ? QUOTA_HIDDEN_REFRESH_MS : QUOTA_REFRESH_MS)
      started = Date.now()
      reading?.abort()
      const mine = new AbortController()
      reading = mine
      const settle = (next) => {
        if (!live || reading !== mine) return
        reading = null
        if (next !== null) put(next)
      }
      void Promise.resolve()
        .then(() => scope.remote.jingliuConnection.balance(mine.signal))
        .then(result => settle(quotaFrom(result)), () => settle({ state: 'unknown' }))
    }
    // After a sign-in change or a reconnect the figure shown may be another account's.
    const reread = () => {
      ui.set(state => ({
        ...state,
        quota: state.quota === undefined || state.quota.state === 'absent' ? state.quota : { state: 'loading' },
        readBillingDetails: billingSource(),
      }))
      read()
    }
    // A read made while hidden scheduled the next one five minutes out; a skipped wake read
    // brings it back to a minute after that read.
    const onShow = () => {
      if (document.hidden) return
      const since = Date.now() - started
      if (since > WAKE_MS) { read(); return }
      clearTimeout(timer)
      timer = setTimeout(read, QUOTA_REFRESH_MS - since)
    }
    read()
    actions.refreshQuota = read
    const off = scope.remote.$on('muse-account/session-changed', reread)
    scope.on('connection/reset', reread)
    document.addEventListener('visibilitychange', onShow)
    scope.effect(() => () => {
      live = false
      clearTimeout(timer)
      reading?.abort()
      off()
      document.removeEventListener('visibilitychange', onShow)
      if (actions.refreshQuota === read) delete actions.refreshQuota
      ui.set(state => ({ ...state, quota: undefined, readBillingDetails: undefined }))
    }, 'ds-bot: jingliu quota')
  })
}

/** Format Jingliu credit in yuan. */
export const quotaMoney = yuan => `${yuan < 0 ? '-' : ''}¥${Math.abs(yuan).toFixed(2)}`

// What the button and its popover show for `ui.quota`, or null where the button stays out.
// `state` is `loading`, `unknown`, `known`, `unlimited` or `exhausted` (nothing left, not unlimited).
export function quotaView(quota) {
  if (!quota || quota.state === 'absent') return null
  if (quota.state !== 'known') return { state: quota.state }
  const { unlimited, available, usedFen, heldFen, enforced } = quota.value
  const left = Number(available)
  return {
    state: unlimited ? 'unlimited' : left <= 0 && enforced === true ? 'exhausted' : 'known',
    figure: unlimited ? t('Unlimited') : quotaMoney(left),
    used: quotaMoney(usedFen / 100),
    held: quotaMoney(heldFen / 100),
  }
}

const MENU_WIDTH = 224

// The round quota button beside the user's capsule, and its popover above it: what is left as
// the main figure, what was used and what is on hold, and the way to Settings → Balance and costs.
export function QuotaButton({ actions, useUi }) {
  const quota = useUi(state => state.quota)
  const view = quotaView(quota)
  const hidden = view === null
  const [open, setOpen] = useState(false)
  const [shown, leaving] = useLinger(open, 120)
  const [box, setBox] = useState(null)
  const button = useRef(null)
  const menu = useRef(null)
  useEffect(() => { if (hidden) setOpen(false) }, [hidden])
  useEffect(() => {
    if (!open) return undefined
    const onDown = (event) => {
      if (event.target instanceof Element && (event.target.closest('.bt-quota-menu') || button.current?.contains(event.target))) return
      setOpen(false)
    }
    const onKey = (event) => { if (event.key === 'Escape') { event.stopPropagation(); setOpen(false); button.current?.focus() } }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey, true)
    return () => { window.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey, true) }
  }, [open])
  const tick = useViewport()
  const anchor = () => {
    const rect = button.current?.getBoundingClientRect()
    if (rect) setBox({ left: Math.max(8, Math.min(rect.left, window.innerWidth - MENU_WIDTH - 8)), bottom: viewBottom() - rect.top + 5 })
  }
  useLayoutEffect(() => { if (open) anchor() }, [open, tick])
  // Opening moves focus into the popover, which the page lists last; Escape brings it back.
  useLayoutEffect(() => { if (open && box) menu.current?.focus() }, [open, box === null])
  // Hooks first: the Jingliu namespace can mount after the sidebar did.
  if (hidden) return null
  const toggle = () => {
    if (!open) { anchor(); actions.refreshQuota?.() }
    setOpen(value => !value)
  }
  const exhausted = view.state === 'exhausted'
  const label = exhausted ? t('Quota used up') : t('Quota')
  // Screen readers hear the figure with the name; the tooltip stays the name alone.
  const spoken = view.figure === undefined || exhausted ? label : t('Quota: {figure}', { figure: view.figure })
  return h(Fragment, null,
    h('button', {
      ref: button, type: 'button', className: 'bt-account bt-quota', 'data-state': view.state, 'aria-label': spoken, title: label,
      'aria-haspopup': 'dialog', 'aria-expanded': open, onClick: toggle,
    },
      h('span', { className: 'bt-you', 'aria-hidden': true }, h(CoinIcon)),
      exhausted ? h('span', { className: 'bt-quota-dot', 'aria-hidden': true }) : null),
    shown && box ? createPortal(h('div', { ref: menu, tabIndex: -1, className: 'bt-menu bt-menu-up bt-quota-menu', role: 'dialog', 'aria-label': t('Quota'), 'data-state': view.state, style: box, 'data-leaving': leaving || undefined },
      h('div', { className: 'bt-quota-head' },
        h('div', { className: 'bt-quota-figure' }, view.figure ?? '—'),
        view.state === 'unknown' ? h('div', { className: 'bt-quota-note' }, t('Quota not available right now')) : null),
      view.used === undefined ? null : h('dl', { className: 'bt-quota-rows' },
        h('div', null, h('dt', null, t('Used')), h('dd', null, view.used)),
        h('div', null, h('dt', null, t('On hold')), h('dd', null, view.held))),
      exhausted ? h('p', { className: 'bt-quota-stop', role: 'status' }, t('Quota used up. Generation has stopped; ask your team lead to grant more.')) : null,
      h('div', { className: 'bt-menu-sep', role: 'separator' }),
      h('button', { type: 'button', className: 'bt-quota-balance', onClick: () => { setOpen(false); actions.openSettings('balance') } },
        h(CoinIcon), h('span', { className: 'bt-menu-label' }, t('Balance and costs')))), document.body) : null)
}

export const QUOTA_CSS = `
.bt-account.bt-quota{position:relative}
.bt-quota:is([data-state=loading],[data-state=unknown]) .bt-you{color:var(--bt-ink-3)}
.bt-quota-dot{position:absolute;top:2px;right:2px;width:7px;height:7px;border-radius:50%;background:var(--bt-danger);box-shadow:0 0 0 1.5px var(--bt-sidebar);pointer-events:none}
.bt-quota-menu{width:${MENU_WIDTH}px}
.bt-quota-menu:focus{outline:none}
.bt-quota-head{display:flex;flex-direction:column;gap:2px;padding:8px 8px 6px}
.bt-quota-figure{font-size:20px;line-height:26px;font-weight:600;color:var(--bt-ink);font-variant-numeric:tabular-nums}
.bt-quota-menu[data-state=exhausted] .bt-quota-figure{color:var(--bt-danger)}
.bt-quota-note{font-size:12px;line-height:17px;color:var(--bt-ink-3)}
.bt-quota-rows{margin:0;padding:0 8px 6px;display:flex;flex-direction:column;gap:2px}
.bt-quota-rows>div{display:flex;align-items:baseline;justify-content:space-between;gap:12px;font-size:12px;line-height:18px}
.bt-quota-rows dt{color:var(--bt-ink-2)}
.bt-quota-rows dd{margin:0;color:var(--bt-ink);font-variant-numeric:tabular-nums}
.bt-quota-stop{margin:0 8px 6px;font-size:12px;line-height:17px;color:var(--bt-danger);text-wrap:pretty}
`
