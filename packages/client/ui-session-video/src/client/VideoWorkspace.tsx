/** Session-owned video browsing and source-local editing in the native right Sidebar. */
import { useEffect, useId, useRef, useState } from 'react'
import {
  Button, Checkbox, IconCheckOutlineRegular, IconChevronDownOutlineRegular, IconCloseOutlineRegular,
  IconFullscreenOutlineRegular, IconLoadingOutlineRegular, IconPanelLeftOutlineRegular,
  IconPlayTriangleOutlineRegular, IconPlusOutlineRegular, IconSparkleRegular, MenuSurface, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionVideoSource } from '@deepseek-ai/dsh-session-video/types'
import type { VideoWorkspaceProps } from './face.ts'
import {
  parseVideoWorkspaceAddress, serializeVideoTargets, targetKey, videoWorkspaceAddress, VIDEO_REVIEW_REQUEST,
  type VideoEpisodeFilter, type VideoTarget, type VideoWorkspaceNavigation,
} from './target-selection.ts'
import { assembleTimeline, authoredShots } from './timeline.ts'
import { VideoPlayer } from './VideoPlayer.tsx'
import { parseVideoReference, VIDEO_REFERENCE_SOURCE } from './references.ts'
import type {} from './resource-provider.ts'
import css from './VideoWorkspace.module.css'

/** Browse this conversation's recorded sources without switching its composer or history.
 * @param props - Session, tab, inventory resource, selection store and localized controls.
 * @returns The dockable video island and compact episode picker.
 */
export function VideoWorkspace(props: VideoWorkspaceProps) {
  const { sessionId, useResource, useStore, useTabInfo, useInput, inputActions, actions,
    detectShots, refreshVideos, addTargetReference, removeTargetReference, pixelsPerSecond, t } = props
  const resource = useResource<'session-video'>(videoWorkspaceAddress(sessionId))
  const sources = resource.value?.sources ?? []
  const { tab, panel } = useTabInfo()
  const selected = useStore(state => state.selected)
  const episode = useStore(state => state.selectedEpisode)
  const selectedShot = useStore(state => state.selectedShot)
  const analyses = useStore(state => state.analyses)
  const zoom = useStore(state => state.zoom)
  const seek = useStore(state => state.seek)
  const handledNavigation = useStore(state => state.handledNavigation)
  const draft = useInput(state => state.draft)
  const occurrences = useInput(state => state.occurrences)
  const selections = occurrences.flatMap((occurrence) => {
    const parsed = occurrence.source === VIDEO_REFERENCE_SOURCE ? parseVideoReference(occurrence.ref) : null
    return parsed?.sessionId === sessionId ? [{ occurrence, target: parsed.target }] : []
  })
  const targets = selections.map(value => value.target)
  const attachmentCount = useInput(state => state.attachmentIds.length)
  const phase = useInput(state => state.phase)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [detection, setDetection] = useState<{ source: string; failed: boolean } | null>(null)
  const [retry, setRetry] = useState(0)
  const pickerAnchor = useRef<HTMLButtonElement>(null)
  const pickerId = useId()
  const navigation = parseVideoWorkspaceAddress(tab.contentId)
  const navigationParams = tab.navigation.params as VideoWorkspaceNavigation | undefined
  const navigationKey = navigation === null ? `${tab.id}/${tab.navigation.revision}`
    : navigationParams?.retainedNavigationKey ?? `${tab.id}/${tab.navigation.revision}`
  const activeNavigation = handledNavigation !== navigationKey ? navigation : null
  const foreignNavigation = activeNavigation !== null && activeNavigation.sessionId !== sessionId
  const requested = activeNavigation?.sessionId === sessionId ? activeNavigation.target : undefined
  const requestedSource = requested === undefined ? undefined
    : sources.find(source => source.id === requested.sourceId && source.version === requested.sourceVersion)
  const effectiveEpisode = requestedSource === undefined ? episode : requestedSource.production?.episodeNumber ?? 'unassigned'
  const inEpisode = (source: SessionVideoSource): boolean => effectiveEpisode === 'all'
    || (effectiveEpisode === 'unassigned' ? source.production?.episodeNumber === undefined
      : source.production?.episodeNumber === effectiveEpisode)
  const visible = sources.filter(inEpisode)
  const source = foreignNavigation ? undefined
    : requested === undefined ? visible.find(source => source.id === selected) ?? visible.at(0) : requestedSource
  const analysis = source === undefined ? undefined : analyses[source.id]
  const currentAnalysis = analysis?.sourceVersion === source?.version ? analysis : undefined
  const timeline = assembleTimeline(source === undefined ? [] : [source], currentAnalysis === undefined ? [] : [currentAnalysis])
  const authored = source === undefined ? [] : authoredShots(source)
  const authoredNumbers = source?.production?.shotNumbers ?? []
  const selectableShots = [...timeline.shots, ...authored]
  const requestedShot = requestedSource !== undefined && requested?.kind === 'shot'
    ? selectableShots.find(shot => shot.id === requested.shotId
      && shot.localStart === requested.startSeconds && shot.localEnd === requested.endSeconds) : undefined
  const shot = requestedSource !== undefined ? requestedShot : selectableShots.find(shot => shot.id === selectedShot)
  const staleNavigation = requested !== undefined && resource.status === 'live'
    && (requestedSource === undefined || requested.kind === 'shot' && currentAnalysis?.state === 'ready' && requestedShot === undefined)
  const seekRequest = requestedShot !== undefined
    ? { time: requestedShot.localStart, revision: navigationKey }
    : seek?.sourceId === source?.id ? seek : null
  const needsDetection = source?.version !== null && source?.playbackUrl !== null
    && source !== undefined && currentAnalysis === undefined
  useEffect(() => {
    if (!tab.visible || !needsDetection) return
    const controller = new AbortController()
    setDetection({ source: source.id, failed: false })
    void detectShots(sessionId, source.id, source.version, controller.signal).then((value) => {
      if (!controller.signal.aborted) {
        actions.analysis(value); setDetection(null)
        if (value.state === 'ready' && source.status === 'remote-only') refreshVideos()
      }
    }).catch((_error: unknown) => {
      if (!controller.signal.aborted) setDetection({ source: source.id, failed: true })
    })
    return () => { controller.abort() }
  }, [sessionId, source?.id, source?.version, source?.status, needsDetection, tab.visible, retry, detectShots, refreshVideos, actions])
  const dismissNavigation = () => {
    if (requestedSource !== undefined) actions.selectEpisode(effectiveEpisode)
    actions.dismissNavigation(navigationKey); setNotice(null)
  }
  const chooseSource = (item: SessionVideoSource) => { dismissNavigation(); actions.select(item.id); setPickerOpen(false) }
  const chooseEpisode = (value: VideoEpisodeFilter) => {
    dismissNavigation(); actions.selectEpisode(value)
    const first = sources.find(item => value === 'all' || (value === 'unassigned'
      ? item.production?.episodeNumber === undefined : item.production?.episodeNumber === value))
    if (first !== undefined) actions.select(first.id)
  }
  const prepare = (intent: 'review' | 'edit', current?: { target: VideoTarget; label: string }) => {
    const requestedTargets = current === undefined || targets.length > 0 ? targets : [current.target]
    const result = serializeVideoTargets(requestedTargets, sources, sessionId)
    if (!result.ok) { setNotice(t('selectionStale')); return }
    if (current !== undefined && targets.length === 0
      && !addTargetReference(current.target, current.label, inputActions.captureInsertion())) {
      setNotice(t('draftRefused')); return
    }
    const span = inputActions.captureInsertion()
    const request = t(intent === 'review' ? 'requestReview' : 'requestEdit')
    const mode = intent === 'review' ? `${VIDEO_REVIEW_REQUEST}\n` : ''
    if (!inputActions.insertText(`\n\n${mode}${request}`,
      { start: span.end, end: span.end, draftRev: span.draftRev })) { setNotice(t('draftRefused')); return }
    inputActions.persistDraft()
    setPickerOpen(false)
    setNotice(t('draftReady'))
    let remaining = draft
    for (const { occurrence } of [...selections].sort((a, b) => b.occurrence.offset - a.occurrence.offset)) {
      remaining = remaining.slice(0, occurrence.offset) + remaining.slice(occurrence.offset + occurrence.length)
    }
    if (intent === 'review' && remaining.trim() === '' && attachmentCount === 0) inputActions.submit()
  }
  const episodes = [...new Set(sources.flatMap(source => source.production?.episodeNumber === undefined
    ? [] : [source.production.episodeNumber]))].sort((a, b) => a - b)
  const sourceTitle = (item: SessionVideoSource): string => item.production?.packageIndex === undefined
    ? item.label : `${t('videoLabel', { index: item.production.packageIndex })} · ${item.label}`
  const pickerTitle = source === undefined ? t('library') : `${source.production?.episodeNumber === undefined
    ? t('unassigned') : t('episodeLabel', { episode: source.production.episodeNumber })} · ${sourceTitle(source)}`
  const selectedKeys = new Set(targets.map(targetKey))
  const toggleTarget = (target: VideoTarget, label: string) => {
    const existing = selections.filter(value => targetKey(value.target) === targetKey(target))
    const accepted = existing.length > 0
      ? existing.every(value => removeTargetReference(value.occurrence))
      : addTargetReference(target, label, inputActions.captureInsertion())
    if (accepted) { inputActions.persistDraft(); setNotice(null) } else setNotice(t('draftRefused'))
  }
  const wholeTarget = (item: SessionVideoSource): VideoTarget | null => item.version === null ? null
    : { kind: 'source', sourceId: item.id, sourceVersion: item.version }
  const shotTarget: VideoTarget | null = source?.version !== null && source !== undefined && shot !== undefined
    ? { kind: 'shot', sourceId: source.id, sourceVersion: source.version, shotId: shot.id,
      startSeconds: shot.localStart, endSeconds: shot.localEnd } : null
  const currentTarget = shotTarget ?? (source === undefined ? null : wholeTarget(source))
  const currentLabel = source === undefined ? '' : shot === undefined ? source.label
    : t('selectedSegmentReference', { name: source.label, start: shot.localStart.toFixed(2), end: shot.localEnd.toFixed(2) })
  const currentAvailable = currentTarget !== null && source?.playbackUrl !== null && source !== undefined
  const currentIncluded = currentTarget !== null && selectedKeys.has(targetKey(currentTarget))
  return <section className={css.workspace} data-muse-video-shelf data-muse-video-workspace aria-label={t('library')}>
    <div className={css.toolbar}>
      <Button ref={pickerAnchor} size="sm" variant="ghost" aria-label={t('picker')}
        aria-expanded={pickerOpen} aria-controls={pickerId} onClick={() => { setPickerOpen(value => !value) }}>
        <span className={css.pickerLabel}>{pickerTitle}</span><IconChevronDownOutlineRegular />
      </Button>
      <Tooltip portal label={t(panel.isFloating ? 'dock' : 'float')}>
        <span><Button size="sm" variant="ghost" aria-label={t(panel.isFloating ? 'dock' : 'float')}
          onClick={() => {
            tab.actions.openResource(navigation === null ? videoWorkspaceAddress(sessionId) : tab.contentId,
              { destination: panel.isFloating ? 'sidebar' : 'float', params: { sessionId, retainedNavigationKey: navigationKey } })
          }}>{panel.isFloating ? <IconPanelLeftOutlineRegular /> : <IconFullscreenOutlineRegular />}</Button></span>
      </Tooltip>
    </div>
    {pickerOpen && <MenuSurface opaque className={css.pickerMenu} id={pickerId} role="group"
      aria-label={t('picker')} data-muse-video-picker onKeyDown={(event) => {
        if (event.key === 'Escape') { event.stopPropagation(); setPickerOpen(false); pickerAnchor.current?.focus() }
      }}>
      <div className={css.pickerContents}>
        <label className={css.episodeLabel}>{t('chooseEpisode')}
          <select value={effectiveEpisode} onChange={(event) => {
            const value = event.currentTarget.value
            chooseEpisode(value === 'all' || value === 'unassigned' ? value : Number(value))
          }}>
            <option value="all">{t('allEpisodes')}</option>
            {episodes.map(number => <option key={number} value={number}>{t('episodeLabel', { episode: number })}</option>)}
            <option value="unassigned">{t('unassigned')}</option>
          </select>
        </label>
        <div className={css.sourceList}>
          {visible.map((item) => {
            const target = wholeTarget(item)
            const selectTarget = () => {
              // oxlint-disable-next-line typescript/no-non-null-assertion -- Unversioned sources have a disabled checkbox.
              toggleTarget(target!, item.label)
            }
            return <div className={css.sourceRow} key={item.id}>
              <Checkbox label={t('selectVideo', { name: item.label })}
                checked={target !== null && selectedKeys.has(targetKey(target))}
                disabled={target === null || item.playbackUrl === null}
                onChange={selectTarget} />
              <Button size="sm" variant="ghost" aria-label={t('source', { name: item.label })}
                onClick={() => { chooseSource(item) }}><IconPlayTriangleOutlineRegular /><span>{sourceTitle(item)}</span></Button>
            </div>
          })}
          {visible.length === 0 && <p className={css.empty}>{t('emptyEpisode')}</p>}
        </div>
      </div>
    </MenuSurface>}
    {resource.status === 'loading' && (resource.value === undefined || requested !== undefined && requestedSource === undefined)
      ? <div className={css.loading} role="status" aria-label={t('loading')}>
        <IconLoadingOutlineRegular />
      </div> : source === undefined ? <p className={css.empty} role="status">
        {t(foreignNavigation ? 'navigationForeign' : staleNavigation ? 'navigationStale'
          : sources.length === 0 ? 'empty' : 'emptyEpisode')}</p>
        : <div className={css.island}>
          <header className={css.islandHeading}><span className={css.spider} aria-hidden="true" /><span>{t('brand')}</span>
            <span className={css.sourceName}>{sourceTitle(source)}</span></header>
          {source.playbackUrl === null ? <p className={css.status} role="alert">{t('unavailable')}</p>
            : <VideoPlayer active={tab.visible} source={source} analysis={currentAnalysis} shots={timeline.shots}
              offset={0} duration={timeline.duration} pixelsPerSecond={pixelsPerSecond} zoom={zoom} onZoom={actions.setZoom}
              selectedShot={shot?.id ?? null} seekRequest={seekRequest} t={t}
              onRetrySource={() => { actions.retryFailed(); refreshVideos() }}
              onSelectShot={(id) => {
                // oxlint-disable-next-line typescript/no-non-null-assertion -- The player emits IDs from this rendered timeline.
                const picked = timeline.shots.find(shot => shot.id === id)!
                dismissNavigation(); actions.selectShot({ sourceId: source.id, shotId: picked.id, time: picked.localStart })
              }} onSeek={(time) => { dismissNavigation(); actions.seekTo({ sourceId: source.id, time }) }} />}
          {(detection?.source === source.id && currentAnalysis === undefined || currentAnalysis?.state === 'failed')
          && <div className={css.status} role="status">
            {t(detection?.failed || currentAnalysis?.state === 'failed' ? 'detectionFailed' : 'detecting')}
            {(detection?.failed || currentAnalysis?.state === 'failed') && <Button size="sm" onClick={() => {
              refreshVideos(); actions.retryFailed(); setRetry(value => value + 1)
            }}>{t('retry')}</Button>}
          </div>}
          {authoredNumbers.length > 0 && <div className={css.authoredShots} aria-label={t('authoredShots')}>
            <span>{t('authoredShots')}</span>
            {authoredNumbers.map((number) => {
              const located = authored.find(item => item.authoredNumber === number)
              return <Tooltip key={number} portal label={located === undefined ? t('shotUnlocated')
                : t('authoredRange', { index: number, start: located.localStart.toFixed(2), end: located.localEnd.toFixed(2) })}>
                <span><Button size="sm" variant={shot?.id === located?.id && located !== undefined ? 'primary' : 'ghost'}
                  disabled={located === undefined} aria-label={t('authoredShot', { index: number })}
                  onClick={located === undefined ? undefined : () => {
                    dismissNavigation(); actions.selectShot({ sourceId: source.id, shotId: located.id, time: located.localStart })
                  }}>{t('authoredShot', { index: number })}</Button></span>
              </Tooltip>
            })}
            {authored.length < authoredNumbers.length && <small>{t('shotUnlocated')}</small>}
          </div>}
        </div>}
    {(source !== undefined || targets.length > 0) && <div className={css.selectionAction}>
      {source !== undefined && <div className={css.currentScope}>
        <span>{shot === undefined ? t('currentVideo') : t(shot.authoredNumber === undefined ? 'shot' : 'authoredRange', { index: shot.index,
          start: shot.localStart.toFixed(2), end: shot.localEnd.toFixed(2) })}</span>
        {shot !== undefined && <Button size="sm" variant="ghost" onClick={() => {
          dismissNavigation(); actions.select(source.id)
        }}>{t('wholeVideo')}</Button>}
      </div>}
      <div className={css.quickActions}>
        {source !== undefined && <Button size="sm" variant="outline"
          aria-label={t(shot === undefined ? 'addCurrentVideo' : 'addSelectedShot')}
          disabled={phase !== 'plain' || !currentAvailable || currentIncluded}
          onClick={currentTarget === null ? undefined : () => { toggleTarget(currentTarget, currentLabel) }}>
          {currentIncluded ? <IconCheckOutlineRegular /> : <IconPlusOutlineRegular />}
          {t(currentIncluded ? 'addedToChat' : 'addToChat')}</Button>}
        <Button size="sm" variant="primary" disabled={phase !== 'plain' || targets.length === 0 && !currentAvailable}
          onClick={() => { prepare('review', currentAvailable
            ? { target: currentTarget, label: currentLabel } : undefined) }}>
          <IconSparkleRegular />{t('reviewSelected')}</Button>
      </div>
      <p className={css.actionHint}>{t('chatHint')}</p>
    </div>}
    {targets.length > 0 && <div className={css.selectedTargets} aria-label={t('selectedScope')}>
      <div className={css.selectedHeading}><span>{t('selectedCount', { count: targets.length })}</span>
        <Button size="sm" variant="ghost" onClick={() => {
          const accepted = selections.map(value => removeTargetReference(value.occurrence)).every(Boolean)
          inputActions.persistDraft(); setNotice(accepted ? null : t('draftRefused'))
        }}>{t('clearSelection')}</Button></div>
      {selections.map(({ occurrence }) => {
        const name = occurrence.label
        return <div className={css.target} key={occurrence.occurrenceId}>
          <span>{name}</span>
          <Tooltip portal label={t('targetRemove', { name })}><span><Button size="sm" variant="ghost"
            aria-label={t('targetRemove', { name })} onClick={() => {
              if (removeTargetReference(occurrence)) { inputActions.persistDraft(); setNotice(null) } else setNotice(t('draftRefused'))
            }}><IconCloseOutlineRegular /></Button></span></Tooltip>
        </div>
      })}
      <div className={css.promptActions}>
        <Button size="sm" variant="ghost" disabled={phase !== 'plain'} onClick={() => { prepare('edit') }}>{t('prepareEdit')}</Button></div>
    </div>}
    {(notice !== null || staleNavigation || resource.status === 'failed' || resource.value?.complete === false)
      && (!staleNavigation || source !== undefined)
      && !foreignNavigation
      && <p className={css.notice} role="status">
        {staleNavigation ? t('navigationStale') : resource.status === 'failed' ? t('inventoryFailed') : notice ?? t('incomplete')}
        {resource.status === 'failed' && <Button size="sm" onClick={refreshVideos}>{t('retry')}</Button>}
      </p>}
  </section>
}
