// Muse: the file tree of the panel's Files tab — the conversation's working folder, one
// level at a time. A folder row opens in place; a file row puts the file's path into the
// conversation's message box.
import { createElement as h, useEffect, useState } from 'react'
import { FolderIcon, TextIcon } from './icons.js'
import { t } from './i18n.js'

const INDENT = 22

export function FilesTree({ sessionId, actions }) {
  // Listings by folder path ('' is the working folder itself): { entries, truncated } or { error }.
  const [levels, setLevels] = useState({})
  const [open, setOpen] = useState(() => new Set(['']))
  const [name, setName] = useState('')
  const load = path => Promise.resolve(actions.workFiles(sessionId, path)).then(
    (listing) => {
      if (path === '') setName(listing.name)
      setLevels(map => ({ ...map, [path]: { entries: listing.entries, truncated: listing.truncated === true } }))
    },
    error => setLevels(map => ({ ...map, [path]: { error: error?.message ?? String(error) } })),
  )
  useEffect(() => { setLevels({}); setOpen(new Set([''])); void load('') }, [sessionId])
  const toggle = (path) => {
    const next = new Set(open)
    if (next.has(path)) next.delete(path)
    else { next.add(path); if (levels[path] === undefined) void load(path) }
    setOpen(next)
  }
  const rows = []
  const walk = (path, depth) => {
    const level = levels[path]
    if (level === undefined) { rows.push(h('div', { key: `${path}:wait`, className: 'bt-ft-note', style: { paddingLeft: 8 + depth * INDENT } }, t('Loading…'))); return }
    if (level.error) { rows.push(h('div', { key: `${path}:error`, className: 'bt-ft-note', role: 'alert', style: { paddingLeft: 8 + depth * INDENT } }, level.error)); return }
    if (level.entries.length === 0) rows.push(h('div', { key: `${path}:empty`, className: 'bt-ft-note', style: { paddingLeft: 8 + depth * INDENT } }, t('Empty folder')))
    for (const entry of level.entries) {
      const child = path === '' ? entry.name : `${path}/${entry.name}`
      rows.push(entry.dir
        ? h('button', { key: child, type: 'button', className: 'bt-ft-row', 'aria-expanded': open.has(child), style: { paddingLeft: 8 + depth * INDENT }, onClick: () => toggle(child) },
          h(FolderIcon), h('span', { className: 'bt-ft-name' }, entry.name))
        : h('button', { key: child, type: 'button', className: 'bt-ft-row', title: t('Put this file into the message box'), style: { paddingLeft: 8 + depth * INDENT }, onClick: () => actions.quote(sessionId, child, { plain: true }) },
          h(TextIcon), h('span', { className: 'bt-ft-name' }, entry.name)))
      if (entry.dir && open.has(child)) walk(child, depth + 1)
    }
    if (level.truncated) rows.push(h('div', { key: `${path}:more`, className: 'bt-ft-note', style: { paddingLeft: 8 + depth * INDENT } }, t('Some items are not shown')))
  }
  walk('', 1)
  return h('div', { className: 'bt-ft', role: 'tree', 'aria-label': t('Files') },
    h('div', { className: 'bt-ft-row bt-ft-root' }, h(FolderIcon), h('span', { className: 'bt-ft-name' }, name || t('Working folder'))),
    rows)
}

export const FILES_TREE_CSS = `
.bt-ft{display:flex;flex-direction:column;gap:1px;padding:4px 0 16px}
.bt-ft-row{display:flex;align-items:center;gap:8px;width:100%;min-height:32px;padding:0 8px;border:0;border-radius:8px;background:none;color:var(--bt-ink);font:inherit;font-size:13px;text-align:left;cursor:pointer}
button.bt-ft-row:hover{background:var(--bt-hover)}
.bt-ft-row svg{flex:none;width:15px;height:15px;color:var(--bt-ink-2)}
.bt-ft-root{font-weight:600;cursor:default}
.bt-ft-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-ft-note{min-height:28px;display:flex;align-items:center;font-size:12px;color:var(--bt-ink-3)}
`
