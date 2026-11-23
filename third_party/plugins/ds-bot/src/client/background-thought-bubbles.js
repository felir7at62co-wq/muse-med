import { createElement as h, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { t } from './i18n.js'
import { ChevronUpIcon } from './icons.js'
import { SPRING_SHAPE, reducedEffects, spring, useLinger } from './motion.js'
import { useEscape } from './overlay-hooks.js'

const SIDES = ['left', 'right']
const EXIT_MS = 900

function placeThoughts(previous, rows, animate) {
  const wanted = rows.slice(0, rows.length > 2 ? 1 : 2).map(row => ({ row, key: row.key }))
  if (rows.length > 2) wanted.push({ key: null, overflow: rows.length - 1 })
  const slots = previous.map(old => {
    if (!old) return null
    const current = wanted.find(item => item.key === old.key)
    if (current) {
      return !old.leaving && old.row === current.row && old.overflow === current.overflow ? old : current
    }
    if (!animate || old.key === null || rows.some(row => row.key === old.key)) return null
    return old.leaving ? old : { ...old, leaving: true }
  })
  // A fading slot stays reserved so the other task and the avatar do not jump.
  for (const item of wanted) {
    const i = slots.indexOf(null)
    if (i !== -1 && !slots.some(slot => slot?.key === item.key)) slots[i] = item
  }
  return slots.every((slot, i) => slot === previous[i]) ? previous : slots
}

function ThoughtBubble({ item, side, expanded, panelId, panel, open, close, expire, children }) {
  const { row, overflow, leaving } = item
  const label = row?.label ?? t('and {count} more tasks', { count: overflow })
  const state = row?.state
  const status = state === 'paused' ? t('Paused')
    : state === 'running' ? t('Run in progress')
    : state === 'stopping' ? t('Stopping…') : undefined
  const [body] = useLinger(children, reducedEffects() ? 0 : SPRING_SHAPE.duration)

  useEffect(() => {
    if (!leaving) return undefined
    const timer = setTimeout(() => expire(item), EXIT_MS)
    return () => clearTimeout(timer)
  }, [expire, item, leaving])

  return h('div', {
    className: 'bt-thoughts-slot', 'data-side': side,
    'data-open': expanded || undefined, 'data-overlay': Boolean(body) || undefined, 'data-leaving': leaving || undefined,
  },
    h('div', { className: 'bt-thoughts-surface' },
      h('button', {
        type: 'button', className: 'bt-thoughts-chip', 'data-side': side, 'data-state': state,
        'data-leaving': leaving || undefined, disabled: leaving || undefined, 'aria-hidden': leaving || undefined,
        'aria-expanded': leaving ? undefined : expanded, 'aria-controls': expanded ? panelId : undefined,
        'aria-label': leaving || status === undefined ? undefined : `${label} · ${status}`,
        title: leaving ? undefined : label, onClick: event => open(item.key, event.currentTarget),
      },
      state === undefined ? null : h('span', { className: 'bt-thoughts-dot', 'aria-hidden': true }),
      h('span', { className: 'bt-thoughts-label' }, label),
      expanded ? h(ChevronUpIcon) : null),
      h('div', { className: 'bt-thoughts-reveal' }, body ? h('section', {
        id: expanded ? panelId : undefined, ref: expanded ? panel : undefined, tabIndex: expanded ? -1 : undefined,
        className: 'bt-thoughts-panel', 'aria-label': row?.label ?? t('Background jobs'),
        'aria-hidden': expanded ? undefined : true, inert: expanded ? undefined : '',
        'data-overflow': row === undefined || undefined,
      }, body) : null)),
    expanded ? h(ThoughtEscape, { close }) : null)
}

function ThoughtEscape({ close }) {
  useEscape(close)
  return null
}

/** Place the current background work around the details avatar and expand one task or the full list. */
export function BackgroundThoughtBubbles({ avatar, children, group = false, rows, renderPanel }) {
  const panelId = useId()
  const root = useRef(null)
  const panel = useRef(null)
  const trigger = useRef(null)
  const [selected, select] = useState(undefined)
  const [slots, setSlots] = useState(() => placeThoughts([null, null], rows, false))
  const expanded = selected !== undefined && slots.some(slot => slot?.key === selected && !slot.leaving)
    && (selected === null ? rows.length > SIDES.length : rows.some(row => row.key === selected))

  useLayoutEffect(() => {
    const next = placeThoughts(slots, rows, !reducedEffects())
    if (next !== slots) setSlots(next)
  }, [rows, slots])

  const expire = useCallback(item => setSlots(current => current.map(slot => slot === item ? null : slot)), [])

  const close = useCallback(() => {
    select(undefined)
    const previous = trigger.current
    const target = previous?.isConnected && !previous.disabled ? previous : root.current
    target?.focus({ preventScroll: true })
  }, [])

  useEffect(() => {
    if (!expanded) return undefined
    const away = event => {
      if (!trigger.current?.closest('.bt-thoughts-slot')?.contains(event.target)) select(undefined)
    }
    document.addEventListener('pointerdown', away, true)
    return () => document.removeEventListener('pointerdown', away, true)
  }, [expanded])

  useEffect(() => {
    if (expanded) panel.current?.focus({ preventScroll: true })
    else if (selected !== undefined) {
      select(undefined)
      const active = document.activeElement
      if (active === document.body || trigger.current?.parentElement?.contains(active)) root.current?.focus({ preventScroll: true })
    }
  }, [expanded, selected])

  const open = (key, button) => {
    if (key !== null && !rows.some(row => row.key === key)) return
    if (expanded && key === selected) {
      close()
      return
    }
    trigger.current = button
    select(key)
  }

  return h('div', { className: 'bt-thoughts', 'data-group': group || undefined, ref: root, tabIndex: -1 },
    h('div', { className: 'bt-thoughts-stage' },
      h('div', { className: 'bt-thoughts-avatar' }, avatar),
      slots.map((item, i) => {
        if (!item) return null
        const isOpen = expanded && selected === item.key
        return h(ThoughtBubble, {
          key: item.key ?? 'overflow', item, side: SIDES[i], panelId, panel, open, close, expire, expanded: isOpen,
        }, isOpen ? renderPanel(selected) : null)
      })),
    children)
}

export const BACKGROUND_THOUGHT_CSS = `
.bt-thoughts{display:flex;flex-direction:column;align-items:center;align-self:stretch;min-width:0;container:bt-thoughts / inline-size}
.bt-drawer-id:has(.bt-thoughts-slot[data-overlay]){position:relative;z-index:2}
.bt-thoughts-stage{align-self:stretch;display:grid;grid-template-columns:minmax(0,1fr) auto minmax(0,1fr);column-gap:14px;align-items:start;margin-bottom:16px}
.bt-thoughts-avatar{grid-column:2;grid-row:1;display:flex;align-items:center;justify-content:center;line-height:0}
.bt-thoughts-avatar>.bt-spider-detail{margin-bottom:0}
.bt-thoughts-slot{
  --bt-thought-inset:9px;
  --bt-thought-max:min(100%,132px);
  --bt-thought-fill:color-mix(in srgb,var(--bt-accent) 5%,var(--bt-hover));
  --bt-thought-edge:color-mix(in srgb,var(--bt-accent) 12%,var(--bt-line));
  display:grid;grid-template:30px / minmax(0,1fr);grid-row:1;position:relative;
  min-width:0;max-width:var(--bt-thought-max);
  animation:bt-thought-appear .2s ease-out both;transition:${spring(SPRING_SHAPE, 'min-width')}
}
.bt-thoughts-surface{
  display:grid;grid-template-columns:minmax(0,1fr);grid-template-rows:auto 0fr;align-self:start;
  min-width:0;box-sizing:border-box;border:1px solid var(--bt-thought-edge);border-radius:15px;
  background:var(--bt-thought-fill);color:var(--bt-ink-2);
  transition:${spring(SPRING_SHAPE, 'grid-template-rows', 'border-radius')},background-color .14s ease,border-color .14s ease,color .14s ease
}
.bt-thoughts-slot[data-side=left]{--bt-thought-in:5px;grid-column:1;justify-self:end;margin-top:4px}
.bt-thoughts-slot[data-side=right]{--bt-thought-in:-5px;grid-column:3;justify-self:start;margin-top:30px}
.bt-thoughts-surface:has(>.bt-thoughts-chip:is(:hover,:focus-visible)){background:color-mix(in srgb,var(--bt-accent) 10%,var(--bt-active));border-color:var(--bt-line-2);color:var(--bt-ink)}
.bt-thoughts-slot[data-overlay]{z-index:1}
.bt-thoughts-slot[data-open]{z-index:2;min-width:var(--bt-thought-max)}
.bt-thoughts-slot[data-overlay]>.bt-thoughts-surface{background:color-mix(in srgb,var(--bt-accent) 12%,var(--bt-card));border-color:var(--bt-line-2);color:var(--bt-ink);box-shadow:var(--bt-card-shadow)}
.bt-thoughts-slot[data-open]>.bt-thoughts-surface{grid-template-rows:auto 1fr;border-radius:14px}
.bt-thoughts-slot[data-overlay]:not([data-open])>.bt-thoughts-surface{pointer-events:none}
.bt-thoughts-slot[data-overlay]:not([data-open],[data-leaving]) .bt-thoughts-chip{pointer-events:auto}
.bt-thoughts-slot[data-leaving]{pointer-events:none;animation:bt-thought-fade ${EXIT_MS}ms ease-in-out both}
.bt-thoughts-chip{
  display:flex;align-items:center;gap:5px;min-width:0;min-height:28px;padding:4px var(--bt-thought-inset);
  border:0;border-radius:inherit;background:transparent;color:inherit;cursor:pointer;font:inherit;font-size:12px;line-height:18px;text-align:start
}
.bt-thoughts-chip:focus-visible{outline:2px solid var(--bt-accent);outline-offset:2px}
.bt-thoughts-chip>svg{flex:none;width:12px;height:12px;margin-inline-start:auto}
.bt-thoughts-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-thoughts-dot{flex:none;width:5px;height:5px;box-sizing:border-box;border-radius:50%;background:var(--bt-ink-3)}
.bt-thoughts-chip[data-state=running] .bt-thoughts-dot{background:color-mix(in srgb,var(--bt-green) 66%,var(--bt-ink-3))}
.bt-thoughts-chip[data-state=paused] .bt-thoughts-dot{background:transparent;border:1px solid var(--bt-ink-2)}
.bt-thoughts[data-group] .bt-thoughts-stage{grid-template-columns:repeat(2,minmax(0,1fr));row-gap:6px}
.bt-thoughts[data-group] .bt-thoughts-avatar{grid-column:1/-1}
.bt-thoughts[data-group] .bt-thoughts-slot{grid-row:2;margin:0}
.bt-thoughts[data-group] .bt-thoughts-slot[data-side=right]{grid-column:2}
.bt-thoughts-reveal{min-height:0;overflow:hidden;contain:inline-size;opacity:0;transition:opacity .16s ease}
.bt-thoughts-slot[data-open] .bt-thoughts-reveal{opacity:1}
.bt-thoughts-panel{
  align-self:stretch;max-height:min(36dvh,240px);overflow-y:auto;overscroll-behavior:contain;
  padding:0 var(--bt-thought-inset) 8px;box-sizing:border-box;color:var(--bt-ink);font-size:12px;line-height:18px;text-align:start
}
.bt-thoughts-panel[data-overflow] .bt-bg-row{align-items:flex-start;flex-direction:column;gap:4px}
.bt-thoughts-panel[data-overflow] .bt-bg-row>.bt-soft-sm{max-width:100%;white-space:normal;overflow-wrap:anywhere}
.bt-thoughts-panel:focus{outline:none}
.bt-thoughts-panel:focus-visible{outline:1px solid var(--bt-accent);outline-offset:-2px;border-radius:8px}
@keyframes bt-thought-appear{from{opacity:0;transform:translate(var(--bt-thought-in,0),2px) scale(.95)}}
@keyframes bt-thought-fade{to{opacity:0}}
@container bt-thoughts (max-width:310px){
  .bt-thoughts-chip>svg{display:none}
}
@container bt-thoughts (max-width:265px){
  .bt-thoughts-stage{column-gap:11px}
  .bt-thoughts-slot{--bt-thought-inset:7px}
  .bt-thoughts-chip{gap:4px}
}
@container bt-thoughts (max-width:220px){
  .bt-thoughts-stage{grid-template-columns:repeat(2,minmax(0,1fr));row-gap:6px}
  .bt-thoughts-avatar{grid-column:1/-1}
  .bt-thoughts-slot[data-side]{grid-row:2;margin:0}
  .bt-thoughts-slot[data-side=right]{grid-column:2}
}
@media(prefers-reduced-motion:reduce){
  .bt-thoughts-slot,.bt-thoughts-surface,.bt-thoughts-reveal{animation:none;transition:none}
  .bt-thoughts-slot[data-leaving]{display:none}
}
body:is([data-bt-effects=reduced],[data-bt-effects=off]) :is(.bt-thoughts-slot,.bt-thoughts-surface,.bt-thoughts-reveal){animation:none;transition:none}
body:is([data-bt-effects=reduced],[data-bt-effects=off]) .bt-thoughts-slot[data-leaving]{display:none}
`
