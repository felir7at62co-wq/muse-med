/** Workspace reference actions selected by the navigator's file-tree occurrence. */
import { useState } from 'react'
import type { FactoryLocalComponentPropsOf } from '@deepseek-ai/dsh-client-ui-slots'
import { IconEllipsisOutlineRegular, Menu, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './FilesBody.module.css'

/**
 * Render caller-owned row actions without changing the file tree's preview action.
 * @param props - row identity, localized actions, and the Factory's locale seat.
 * @returns an explicit menu button, or no accessory when the row has no actions.
 */
export function FileReferenceActions({ entry, entryActions, t }: FactoryLocalComponentPropsOf<'sidebar.files.tree', 'accessory'>) {
  const [open, setOpen] = useState(false)
  if (entryActions === undefined || entryActions.length === 0) return null
  return <Menu open={open} portal align="end" dense
    anchor={<Tooltip label={t('entry.actions', { name: entry.name })}>
      <button type="button" className={css.tool} aria-label={t('entry.actions', { name: entry.name })}
        aria-haspopup="menu" aria-expanded={open} onClick={() => { setOpen(value => !value) }}>
        <IconEllipsisOutlineRegular />
      </button>
    </Tooltip>}
    items={entryActions.map(({ id, label }) => ({ id, label }))}
    onClose={() => { setOpen(false) }}
    onSelect={(id) => {
      setOpen(false)
      entryActions.find(action => action.id === id)?.run()
    }} />
}
