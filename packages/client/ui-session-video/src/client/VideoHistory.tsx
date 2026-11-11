/** Session video navigation and its in-flow history player. */
import { useState } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { Button, IconCloseOutlineRegular, IconPlayOutlineRegular, Menu, MenuItemButton, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { VideoShared } from './face.ts'
import { InlineVideoCard } from './InlineVideoCard.tsx'
import { VideoController } from './VideoController.tsx'
import css from './VideoShelf.module.css'

/** Offer recorded videos in the Session header while the controller maintains inventory.
 * @param props - Session context and shared video state.
 * @returns The controller and a keyboard-accessible video menu.
 */
export function VideoHeader(props: PropsRuntime<'conversation.session.header.utilities'> & VideoShared) {
  const { useStore, actions, t } = props
  const sources = useStore(state => state.sources)
  const issue = useStore(state => state.issue)
  const [open, setOpen] = useState(false)
  const [loadError, setLoadError] = useState<boolean | null>(null)
  const ordered = [...sources].sort((a, b) => b.eventSeq - a.eventSeq || (b.presentedIndex ?? -1) - (a.presentedIndex ?? -1))
  return <>
    <VideoController {...props} onLoadError={setLoadError} />
    <span data-muse-session-video-menu>
      <Menu open={open} onClose={() => { setOpen(false) }} portal autoFocus align="end"
        anchor={<Tooltip label={t('library')} portal><Button size="sm" aria-label={t('library')} aria-haspopup="menu"
          aria-expanded={open} onClick={() => { setOpen(value => !value) }}><IconPlayOutlineRegular /></Button></Tooltip>}>
        {ordered.map(source => <MenuItemButton key={source.id} disabled={source.playbackUrl === null}
          onSelect={() => { actions.openSource(source.id); props.selectView('chat'); setOpen(false) }}>{source.label}</MenuItemButton>)}
        {sources.length === 0 && loadError !== true && <MenuItemButton disabled onSelect={() => {}}>
          {t(loadError === null ? 'loading' : 'empty')}
        </MenuItemButton>}
        {(loadError === true || issue !== null) && <MenuItemButton onSelect={() => { actions.refreshInventory() }}>
          {t(loadError ? 'unavailable' : 'incomplete')} · {t('retry')}
        </MenuItemButton>}
      </Menu>
    </span>
  </>
}

/** Render a selected historical video in the Chat document flow.
 * @param props - Session context and shared video state.
 * @returns An independently selectable video card with a close action.
 */
export function VideoHistory(props: PropsRuntime<'conversation.chat.pinned'> & VideoShared) {
  const { useStore, actions, t } = props
  const selected = useStore(state => state.selected)
  const open = useStore(state => state.open)
  const source = useStore(state => state.sources.find(item => item.id === selected))
  if (!open || source === undefined || source.playbackUrl === null) return null
  return <section className={css.history} data-muse-session-video-history>
    <div className={css.historyActions}><Tooltip label={t('closeVideo')} portal><Button size="sm" aria-label={t('closeVideo')}
      onClick={() => { actions.toggle() }}><IconCloseOutlineRegular /></Button></Tooltip></div>
    <InlineVideoCard {...props} key={source.id} source={source} sourceUrl={source.playbackUrl} label={source.label} />
  </section>
}
