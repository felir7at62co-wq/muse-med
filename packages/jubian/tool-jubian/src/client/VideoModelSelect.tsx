/** Compact session video-model and resolution menu beside the dialogue-model selector. */
import { useLayoutEffect, useRef, useState } from 'react'
import { DisclosureRow, Menu, StateDot, IconWarningOutlineRegular, IconChevronDownOutlineRegular, IconChevronRightOutlineRegular, type MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { VideoDirectoryState } from './video-directory.ts'
import css from './VideoModelSelect.module.css'

/** Registration-side callbacks and framework-bound live snapshot. */
export interface VideoModelSelectInjected {
  hooks: { videoState: SnapshotStore<VideoDirectoryState> }
  load: () => Promise<void>
  select: (key: string) => Promise<void>
}
/** Complete slot component props. */
export type VideoModelSelectProps = PropsRuntime<'conversation.input.right'> & PropsLocale<'settings.jubian'> & InjectFace<VideoModelSelectInjected> & { variant?: 'details' }
/**
 * Render only supported live combinations; model and resolution stay separate rows.
 * @param props - Session-scoped selector facts and actions.
 * @returns Video choice trigger and viewport-fitting menu.
 */
export function VideoModelSelect({ useVideoState, load, select, t, variant }: VideoModelSelectProps) {
  const state = useVideoState(value => value)
  const [open, setOpen] = useState(false)
  const [pane, setPane] = useState<'root' | 'model' | 'resolution'>('root')
  const [details, setDetails] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const families = [...new Map(state.options.map(option => [option.standardId, option])).values()]
  const displayed = state.current ?? state.defaultModel
  const current = state.current ?? state.options.find(option => option.modelId === displayed?.modelId
    && option.platformId === displayed.platformId && option.resolution === displayed.resolution) ?? null
  const modelName = (model: { modelId: string; modelName?: string }): string => model.modelId === 'doubao-seedance-2-5-260628'
    ? 'Seedance 2.5' : model.modelId === 'doubao-seedance-2-0-260128' ? 'Seedance 2.0' : model.modelName ?? model.modelId
  const groups = [...new Set(families.map(option => option.platformId))]
  const items: MenuEntry[] = pane === 'model' ? groups.flatMap(platform => [
    { id: `channel:${platform}`, type: 'label' as const, text: platform },
    ...families.filter(option => option.platformId === platform).map(option => ({
      id: `family:${option.standardId}`, label: modelName(option),
    })),
  ]) : pane === 'resolution' ? state.options.filter(option => option.standardId === current?.standardId)
    .map(option => ({ id: option.key, label: option.resolution })) : []
  const close = (): void => { setOpen(false); setPane('root'); setDetails(false) }
  useLayoutEffect(() => { if (open) trigger.current?.focus() }, [open, pane])
  return <div data-jubian-video-selector={variant === 'details' ? 'details' : 'composer'} className={`${css.root} ${variant === 'details' ? css.details : ''}`} onKeyDownCapture={(event) => {
    if (open && pane !== 'root' && event.key === 'ArrowLeft') {
      event.preventDefault(); event.stopPropagation(); setPane('root')
    }
  }}>
    <Menu open={open} onClose={close} items={items} opaque className={variant === 'details' ? css.detailMenu : undefined}
      selectedIds={current ? [current.key, `family:${current.standardId}`] : undefined}
      align="end" side="top" portal listClassName={css.menu} onSelect={(key) => {
        const family = families.find(option => `family:${option.standardId}` === key)
        // Keep the displayed resolution when supported; otherwise use this catalogue row's first specification.
        const chosen = family
          ? state.options.find(option => option.standardId === family.standardId && option.resolution === current?.resolution)
            ?? state.options.find(option => option.standardId === family.standardId)
          : state.options.find(option => option.key === key)
        if (chosen) { close(); void select(chosen.key) }
      }}
      anchor={<button ref={trigger} type="button" className={css.trigger} aria-label={t('videoSelector')}
        aria-haspopup="menu" aria-expanded={open} disabled={state.selecting}
        onClick={() => { if (open) close(); else { setOpen(true); setPane('root'); void load() } }}>
        <span>{displayed ? modelName(displayed) : t('videoSelector')}</span>
        {displayed ? <span className={css.resolution}>{displayed.resolution}</span> : null}
        {state.error ? <span className={css.warning} role="img" aria-label={t('videoUnavailable')}><IconWarningOutlineRegular className={css.chevron} /></span> : null}
        <IconChevronDownOutlineRegular className={css.chevron} />
      </button>}>
      {pane === 'root' ? <>
        <button type="button" role="menuitem" aria-haspopup="menu" className={css.cell}
          disabled={families.length === 0} onClick={() => { setPane('model') }}>
          <span>{t('videoModel')}</span><span className={css.value}>{displayed ? modelName(displayed) : t('videoUnset')}</span>
          <IconChevronRightOutlineRegular className={css.chevron} />
        </button>
        <button type="button" role="menuitem" aria-haspopup="menu" className={css.cell}
          disabled={current === null} onClick={() => { setPane('resolution') }}>
          <span>{t('videoResolution')}</span><span className={css.value}>{displayed?.resolution ?? t('videoUnset')}</span>
          <IconChevronRightOutlineRegular className={css.chevron} />
        </button>
      </> : null}
      {state.loading && state.options.length === 0
        ? <div className={css.status} role="status" aria-label={t('videoLoading')}><StateDot state="ongoing" /></div>
        : null}
      {state.error ? <div className={css.error}>
        <p role="alert">{t('videoUnavailable')}</p>
        <button type="button" className={css.cell} disabled={state.loading} onClick={() => { void load() }}>{t('videoRetry')}</button>
        <DisclosureRow title={t('videoErrorDetails')} icon={null} open={details} expandable expandOnRowClick
          onToggle={() => { setDetails(value => !value) }}>
          <pre className={css.diagnostics}>{state.error}</pre>
        </DisclosureRow>
      </div> : null}
    </Menu>
  </div>
}
