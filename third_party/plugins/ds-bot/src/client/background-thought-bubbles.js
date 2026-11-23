import { createElement as h, useEffect, useId, useRef, useState } from 'react'
import { t } from './i18n.js'
import { CloseIcon } from './icons.js'
import { useEscape } from './overlay-hooks.js'

function ThoughtButton({ row, overflow, side, expanded, panelId, open }) {
  const label = row?.label ?? t('and {count} more tasks', { count: overflow })
  const state = row?.state
  const status = state === 'paused' ? t('Paused')
    : state === 'running' ? t('Run in progress')
    : state === 'stopping' ? t('Stopping…') : undefined

  return h('button', {
    type: 'button', className: 'bt-thoughts-chip', 'data-side': side, 'data-state': state,
    'aria-expanded': expanded, 'aria-controls': expanded ? panelId : undefined,
    'aria-label': status === undefined ? undefined : `${label} · ${status}`,
    title: label, onClick: event => open(row?.key ?? null, event.currentTarget),
  },
  state === undefined ? null : h('span', { className: 'bt-thoughts-dot', 'aria-hidden': true }),
  h('span', { className: 'bt-thoughts-label' }, label))
}

function ThoughtPanel({ id, panel, close, children }) {
  useEscape(close)
  return h('section', { id, ref: panel, tabIndex: -1, className: 'bt-thoughts-panel', 'aria-label': t('Background jobs') },
    h('div', { className: 'bt-thoughts-head' },
      h('span', null, t('Background jobs')),
      h('button', { type: 'button', className: 'bt-icon-btn', 'aria-label': t('Close'), onClick: close }, h(CloseIcon))),
    children)
}

/** Place the current background work around the details avatar and expand one task or the full list. */
export function BackgroundThoughtBubbles({ avatar, children, group = false, rows, renderPanel }) {
  const panelId = useId()
  const root = useRef(null)
  const panel = useRef(null)
  const trigger = useRef(null)
  const [selected, select] = useState(undefined)
  const expanded = selected !== undefined && rows.length > 0
    && (selected === null || rows.some(row => row.key === selected))

  const close = () => {
    select(undefined)
    const previous = trigger.current
    const target = previous?.isConnected ? previous : root.current
    target?.focus({ preventScroll: true })
  }

  useEffect(() => {
    if (!expanded) return undefined
    const away = event => {
      if (!root.current?.contains(event.target)) select(undefined)
    }
    document.addEventListener('pointerdown', away, true)
    return () => document.removeEventListener('pointerdown', away, true)
  }, [expanded])

  useEffect(() => {
    if (expanded) panel.current?.focus({ preventScroll: true })
    else if (selected !== undefined) {
      select(undefined)
      if (document.activeElement === document.body) root.current?.focus({ preventScroll: true })
    }
  }, [expanded, selected])

  const open = (key, button) => {
    if (expanded && key === selected) {
      close()
      return
    }
    trigger.current = button
    select(key)
  }

  const button = (row, side, overflow) => h(ThoughtButton, {
    key: row?.key ?? 'overflow', row, side, overflow, panelId, open,
    expanded: expanded && selected === (row?.key ?? null),
  })

  return h('div', { className: 'bt-thoughts', 'data-group': group || undefined, ref: root, tabIndex: -1 },
    h('div', { className: 'bt-thoughts-stage' },
      rows.length === 0 ? null : button(rows[0], 'left'),
      h('div', { className: 'bt-thoughts-avatar' }, avatar),
      rows.length > 2 ? button(undefined, 'right', rows.length - 1)
        : rows.length === 2 ? button(rows[1], 'right') : null),
    children,
    expanded ? h(ThoughtPanel, { id: panelId, panel, close }, renderPanel(selected)) : null)
}

export const BACKGROUND_THOUGHT_CSS = `
.bt-thoughts{display:flex;flex-direction:column;align-items:center;align-self:stretch;min-width:0;container:bt-thoughts / inline-size}
.bt-thoughts-stage{align-self:stretch;display:grid;grid-template-columns:minmax(0,1fr) auto minmax(0,1fr);column-gap:14px;align-items:center;margin-bottom:16px}
.bt-thoughts-avatar{grid-column:2;grid-row:1;display:flex;align-items:center;justify-content:center;line-height:0}
.bt-thoughts-avatar>.bt-spider-detail{margin-bottom:0}
.bt-thoughts-chip{
  --bt-thought-fill:color-mix(in srgb,var(--bt-accent) 5%,var(--bt-hover));
  --bt-thought-edge:color-mix(in srgb,var(--bt-accent) 12%,var(--bt-line));
  position:relative;display:flex;align-items:center;gap:5px;grid-row:1;min-width:0;max-width:min(100%,132px);
  min-height:30px;padding:4px 9px;box-sizing:border-box;border:1px solid var(--bt-thought-edge);border-radius:999px;
  background:var(--bt-thought-fill);color:var(--bt-ink-2);cursor:pointer;font:inherit;font-size:12px;line-height:18px;text-align:start;
  animation:bt-thought-appear .2s ease-out both;transition:background-color .14s ease,border-color .14s ease,color .14s ease
}
.bt-thoughts-chip[data-side=left]{--bt-thought-in:5px;grid-column:1;justify-self:end;align-self:start;margin-top:4px}
.bt-thoughts-chip[data-side=right]{--bt-thought-in:-5px;grid-column:3;justify-self:start;align-self:end;margin-bottom:4px}
.bt-thoughts-chip:is(:hover,:focus-visible,[aria-expanded=true]){background:color-mix(in srgb,var(--bt-accent) 10%,var(--bt-active));border-color:var(--bt-line-2);color:var(--bt-ink)}
.bt-thoughts-chip:focus-visible{outline:2px solid var(--bt-accent);outline-offset:2px}
.bt-thoughts-chip::before,.bt-thoughts-chip::after{
  position:absolute;content:"";box-sizing:border-box;border:1px solid var(--bt-thought-edge);
  background:var(--bt-thought-fill);border-radius:50%;pointer-events:none
}
.bt-thoughts-chip::before{width:6px;height:6px}
.bt-thoughts-chip::after{width:4px;height:4px}
.bt-thoughts-chip[data-side=left]::before{right:-8px;bottom:3px}
.bt-thoughts-chip[data-side=left]::after{right:-13px;bottom:-2px}
.bt-thoughts-chip[data-side=right]::before{left:-8px;top:3px}
.bt-thoughts-chip[data-side=right]::after{left:-13px;top:-2px}
.bt-thoughts-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-thoughts-dot{flex:none;width:5px;height:5px;box-sizing:border-box;border-radius:50%;background:var(--bt-ink-3)}
.bt-thoughts-chip[data-state=running] .bt-thoughts-dot{background:color-mix(in srgb,var(--bt-green) 66%,var(--bt-ink-3))}
.bt-thoughts-chip[data-state=paused] .bt-thoughts-dot{background:transparent;border:1px solid var(--bt-ink-2)}
.bt-thoughts[data-group] .bt-thoughts-stage{grid-template-columns:repeat(2,minmax(0,1fr));row-gap:6px}
.bt-thoughts[data-group] .bt-thoughts-avatar{grid-column:1/-1}
.bt-thoughts[data-group] .bt-thoughts-chip{grid-row:2;align-self:center;margin:0}
.bt-thoughts[data-group] .bt-thoughts-chip[data-side=right]{grid-column:2}
.bt-thoughts[data-group] .bt-thoughts-chip[data-side=left]::before{right:6px;bottom:auto;top:-8px}
.bt-thoughts[data-group] .bt-thoughts-chip[data-side=left]::after{right:0;bottom:auto;top:-13px}
.bt-thoughts[data-group] .bt-thoughts-chip[data-side=right]::before{left:6px;top:-8px}
.bt-thoughts[data-group] .bt-thoughts-chip[data-side=right]::after{left:0;top:-13px}
.bt-thoughts-panel{
  align-self:stretch;max-height:min(36dvh,240px);overflow-y:auto;overscroll-behavior:contain;
  margin-top:10px;padding:4px 10px 8px;border:1px solid var(--bt-line);border-radius:12px;background:var(--bt-card);
  color:var(--bt-ink);font-size:13px;line-height:18px;text-align:start;animation:bt-thought-appear .16s ease-out both
}
.bt-thoughts-head{display:flex;align-items:center;justify-content:space-between;gap:6px;color:var(--bt-ink-2);font-size:12px}
.bt-thoughts-head>.bt-icon-btn{flex:none}
.bt-thoughts-panel:focus{outline:none}
.bt-thoughts-panel:focus-visible{outline:2px solid var(--bt-accent);outline-offset:2px}
@keyframes bt-thought-appear{from{opacity:0;transform:translate(var(--bt-thought-in,0),2px) scale(.95)}}
@container bt-thoughts (max-width:265px){
  .bt-thoughts-stage{column-gap:11px}
  .bt-thoughts-chip{gap:4px;padding-inline:7px}
  .bt-thoughts-chip[data-side=left]::after{right:-10px}
  .bt-thoughts-chip[data-side=right]::after{left:-10px}
}
@media(prefers-reduced-motion:reduce){.bt-thoughts-chip,.bt-thoughts-panel{animation:none;transition:none}}
body:is([data-bt-effects=reduced],[data-bt-effects=off]) :is(.bt-thoughts-chip,.bt-thoughts-panel){animation:none;transition:none}
`
