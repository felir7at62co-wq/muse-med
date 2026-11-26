/** Session-owned video browsing and source-local editing in the native right Sidebar. */
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import {
  Button, Checkbox, IconCheckOutlineRegular, IconChevronDownOutlineRegular, IconCloseOutlineRegular,
  IconFullscreenOutlineRegular, IconLoadingOutlineRegular, IconPanelLeftOutlineRegular,
  IconPlayTriangleOutlineRegular, IconPlusOutlineRegular, IconSparkleRegular, MenuSurface, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionVideoSource } from '@deepseek-ai/dsh-session-video/types'
import type { VideoWorkspaceProps } from './face.ts'
import {
  parseVideoWorkspaceAddress, serializeVideoTargets, targetKey, videoWorkspaceAddress,
  type VideoEpisodeFilter, type VideoTarget, type VideoWorkspaceNavigation,
} from './target-selection.ts'
import { assembleTimeline, authoredShots } from './timeline.ts'
import { VideoPlayer } from './VideoPlayer.tsx'
import { VideoShotGallery } from './VideoShotGallery.tsx'
import { parseVideoReference, VIDEO_REFERENCE_SOURCE, VIDEO_REVIEW_REFERENCE_SOURCE } from './references.ts'
import { videoSelectionLabel, videoShotScopeLabel } from './selection-labels.ts'
import { VideoEditionAdopt, VideoEditionControls } from './VideoEditionControls.tsx'
import { alignedEditionTime, getAdoptedVideoEdition, videoEditions, type VideoEdition, type VideoEditionSet } from './video-editions.ts'
import { bringVideoSuggestion } from './review-suggestion.ts'
import type { VideoSeek, VideoState } from './store.ts'
import type {} from './resource-provider.ts'
import css from './VideoWorkspace.module.css'

function comparisonTime(editions: VideoEditionSet, selectedShot: VideoState['selectedShot'], seek: VideoSeek | null): number {
  const { current, items } = editions
  if (seek !== null) {
    const previous = items.find(edition => edition.source.id === seek.sourceId && edition.shotId === selectedShot)
    if (previous !== undefined && seek.time > previous.startSeconds && seek.time < previous.endSeconds) {
      return alignedEditionTime(seek.time, previous, current)
    }
  }
  return (current.startSeconds + current.endSeconds) / 2
}

/** Browse this conversation's recorded sources without switching its composer or history.
 * @param props - Session, tab, inventory resource, selection store and localized controls.
 * @returns The dockable video island and compact episode picker.
 */
export function VideoWorkspace(props: VideoWorkspaceProps) {
  const { sessionId, useResource, useStore, useTabInfo, useInput, inputActions, actions,
    detectShots, refreshVideos, addTargetReference, removeTargetReference, setReviewMode, addVideoAttachment, pixelsPerSecond, t } = props
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
  const draftRev = useInput(state => state.draftRev)
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
  const [consumedNavigation, setConsumedNavigation] = useState<string | null>(null)
  const pickerAnchor = useRef<HTMLButtonElement>(null)
  const playbackPosition = useRef<{
    sourceId: string
    version: string | null
    revision: number | string | undefined
    time: number
  } | null>(null)
  const appliedNavigation = useRef<string | null>(null)
  const pickerId = useId()
  const navigationParams = tab.navigation.params as VideoWorkspaceNavigation | undefined
  const navigation = navigationParams?.target === undefined ? parseVideoWorkspaceAddress(tab.contentId) : navigationParams
  const navigationKey = navigation === null ? `${tab.id}/${tab.navigation.revision}`
    : navigationParams?.retainedNavigationKey ?? `${tab.id}/${tab.navigation.revision}`
  const activeNavigation = handledNavigation !== navigationKey && consumedNavigation !== navigationKey ? navigation : null
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
  const authored = useMemo(() => source === undefined ? [] : authoredShots(source), [source])
  const authoredNumbers = source?.production?.shotNumbers ?? authored.map(shot => shot.index)
  const selectableShots = [...timeline.shots, ...authored]
  const requestedShot = requestedSource !== undefined && requested?.kind === 'shot'
    ? selectableShots.find(shot => shot.id === requested.shotId
      && shot.localStart === requested.startSeconds && shot.localEnd === requested.endSeconds) : undefined
  const shot = requestedSource !== undefined ? requestedShot : selectableShots.find(shot => shot.id === selectedShot)
  const editions = source === undefined ? null : videoEditions(sources, source, shot?.authoredNumber)
  const issueTime = activeNavigation?.seekSeconds
  const seeksSource = requested?.kind === 'source' && issueTime !== undefined
  const sourceTime = seeksSource && currentAnalysis?.state === 'ready' && issueTime < (currentAnalysis.durationSeconds ?? 0)
    ? issueTime : undefined
  const staleNavigation = requested !== undefined && resource.status === 'live'
    && (requestedSource === undefined || requested.kind === 'shot' && currentAnalysis?.state === 'ready' && requestedShot === undefined
      || seeksSource && sourceTime === undefined && (currentAnalysis !== undefined || detection?.failed === true))
  const requestedTime = requestedShot === undefined ? sourceTime
    : issueTime ?? (navigationParams?.compareVersions === true && editions !== null
      ? comparisonTime(editions, selectedShot, seek) : requestedShot.localStart)
  const seekRequest = requestedTime !== undefined
    ? { time: requestedTime, revision: navigationKey }
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
  useEffect(() => {
    if (activeNavigation === null || appliedNavigation.current === navigationKey || !tab.visible
      || resource.status !== 'live' || resource.value === undefined) return
    if (seeksSource && requestedTime === undefined) return
    if (activeNavigation.editSuggestion === undefined && (requestedSource === undefined || requestedSource.playbackUrl === null
      || requested?.kind === 'shot' && requestedTime === undefined)) return
    if (requested?.kind === 'shot' && requestedSource?.playbackUrl !== null && requestedSource !== undefined
      && requestedShot === undefined && currentAnalysis === undefined && detection?.failed !== true) return
    appliedNavigation.current = navigationKey
    const result = activeNavigation.editSuggestion === undefined ? null
      : bringVideoSuggestion({ sessionId, navigation: activeNavigation, inventory: resource.value,
        analyses: Object.values(analyses) }, { input: { draftRev, phase }, actions: inputActions, addTargetReference, setReviewMode },
      (item, target) => videoSelectionLabel(item, target, t, sources))
    if (requestedSource !== undefined) {
      actions.selectEpisode(requestedSource.production?.episodeNumber ?? 'unassigned')
      if (requestedShot !== undefined && requestedTime !== undefined) actions.selectShot({ sourceId: requestedSource.id,
        shotId: requestedShot.id, time: requestedTime })
      else {
        actions.select(requestedSource.id)
        if (requestedTime !== undefined) actions.seekTo({ sourceId: requestedSource.id, time: requestedTime })
      }
    }
    actions.dismissNavigation(navigationKey)
    setConsumedNavigation(navigationKey)
    setNotice(result === null ? null : t(result === 'applied' ? 'draftReady' : result === 'invalid' ? 'suggestionInvalid'
      : result === 'stale' ? 'selectionStale' : 'draftRefused'))
  }, [activeNavigation, navigationKey, tab.visible, resource.status, resource.value, requested, requestedSource, requestedShot,
    requestedTime, seeksSource, currentAnalysis, detection?.failed, sessionId, analyses, draftRev, phase, inputActions, addTargetReference,
    setReviewMode, t, sources, actions])
  const dismissNavigation = () => {
    if (requestedSource !== undefined) actions.selectEpisode(effectiveEpisode)
    actions.dismissNavigation(navigationKey); setConsumedNavigation(navigationKey); setNotice(null)
  }
  const chooseSource = (item: SessionVideoSource) => { dismissNavigation(); actions.select(item.id); setPickerOpen(false) }
  const chooseEpisode = (value: VideoEpisodeFilter) => {
    dismissNavigation(); actions.selectEpisode(value)
    const first = sources.find(item => value === 'all' || (value === 'unassigned'
      ? item.production?.episodeNumber === undefined : item.production?.episodeNumber === value))
    if (first !== undefined) actions.select(first.id)
  }
  const addVideo = () => {
    if (!addVideoAttachment()) { setNotice(t('draftRefused')); return }
    setPickerOpen(false); setNotice(null)
  }
  const chooseEdition = (previous: VideoEdition, edition: VideoEdition) => {
    const playback = playbackPosition.current
    const position = playback?.sourceId === previous.source.id && playback.version === previous.source.version
      && playback.revision === seekRequest?.revision ? playback.time : seekRequest?.time ?? previous.startSeconds
    dismissNavigation(); actions.selectShot({ sourceId: edition.source.id, shotId: edition.shotId,
      time: alignedEditionTime(position, previous, edition) })
  }
  const toggleFloating = () => {
    tab.actions.openResource(navigation === null ? videoWorkspaceAddress(sessionId) : tab.contentId,
      { destination: panel.isFloating ? 'sidebar' : 'float', params: { sessionId, retainedNavigationKey: navigationKey } })
  }
  const prepare = (intent: 'review' | 'edit', current?: { target: VideoTarget; label: string }) => {
    const requestedTargets = current === undefined || targets.length > 0 ? targets : [current.target]
    const result = serializeVideoTargets(requestedTargets, sources, sessionId)
    if (!result.ok) { setNotice(t('selectionStale')); return }
    let remaining = draft
    const ownReferences = [...selections.map(value => value.occurrence),
      ...occurrences.filter(value => value.source === VIDEO_REVIEW_REFERENCE_SOURCE)]
    for (const occurrence of ownReferences.sort((a, b) => b.offset - a.offset)) {
      remaining = remaining.slice(0, occurrence.offset) + remaining.slice(occurrence.offset + occurrence.length)
    }
    if (current !== undefined && targets.length === 0
      && !addTargetReference(current.target, current.label, inputActions.captureInsertion())) {
      setNotice(t('draftRefused')); return
    }
    if (!setReviewMode(intent === 'review', inputActions.captureInsertion())) { setNotice(t('draftRefused')); return }
    const span = inputActions.captureInsertion()
    const request = t(intent === 'review' ? 'requestReview' : 'requestEdit')
    if (!remaining.trimEnd().endsWith(request.trimEnd()) && !inputActions.insertText(`\n\n${request}`,
      { start: span.end, end: span.end, draftRev: span.draftRev })) { setNotice(t('draftRefused')); return }
    inputActions.persistDraft()
    setPickerOpen(false)
    setNotice(t('draftReady'))
    if (intent === 'review' && remaining.trim() === '' && attachmentCount === 0) inputActions.submit()
  }
  const episodes = [...new Set(sources.flatMap(source => source.production?.episodeNumber === undefined
    ? [] : [source.production.episodeNumber]))].sort((a, b) => a - b)
  const sourceTitle = (item: SessionVideoSource): string => item.production?.packageIndex === undefined
    ? item.label : `${t('videoLabel', { index: item.production.packageIndex })} · ${item.label}`
  const pickerTitle = source === undefined ? t('picker') : source.production?.packageIndex === undefined
    ? source.label : t('videoLabel', { index: source.production.packageIndex })
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
  const currentLabel = source === undefined || currentTarget === null ? '' : videoSelectionLabel(source, currentTarget, t, sources)
  const currentAvailable = currentTarget !== null && source?.playbackUrl !== null && source !== undefined
  const currentIncluded = currentTarget !== null && selectedKeys.has(targetKey(currentTarget))
  const studio = authoredNumbers.length > 0 && source?.playbackUrl !== null
    ? { floating: panel.isFloating, toggleFloating } : undefined
  return <section className={css.workspace} data-muse-video-shelf data-muse-video-workspace aria-label={t('library')}
    onKeyDown={(event) => {
      if (!pickerOpen || event.key !== 'Escape') return
      event.stopPropagation(); setPickerOpen(false); pickerAnchor.current?.focus()
    }}>
    <header className={css.workspaceHead}>
      <div className={css.toolbar}>
        <h2>{t('library')}</h2>
        <select className={css.episodeSelect} aria-label={t('chooseEpisode')} value={effectiveEpisode} onChange={(event) => {
          const value = event.currentTarget.value
          chooseEpisode(value === 'all' || value === 'unassigned' ? value : Number(value))
        }}>
          <option value="all">{t('allEpisodes')}</option>
          {episodes.map(number => <option key={number} value={number}>{t('episodeLabel', { episode: number })}</option>)}
          <option value="unassigned">{t('unassigned')}</option>
        </select>
        <Button ref={pickerAnchor} size="sm" variant="outline" className={css.packagePicker} aria-label={t('picker')}
          aria-expanded={pickerOpen} aria-controls={pickerId} title={source?.label}
          onClick={() => { setPickerOpen(value => !value) }}>
          <span className={css.pickerLabel}>{pickerTitle}</span><IconChevronDownOutlineRegular />
        </Button>
        {studio === undefined && <Tooltip portal label={t(panel.isFloating ? 'dock' : 'float')}>
          <span><Button size="sm" variant="ghost" aria-label={t(panel.isFloating ? 'dock' : 'float')}
            onClick={toggleFloating}>{panel.isFloating ? <IconPanelLeftOutlineRegular /> : <IconFullscreenOutlineRegular />}</Button></span>
        </Tooltip>}
      </div>
      {shot !== undefined && shot.source.playbackUrl !== null && <div className={css.pinnedScope} data-muse-preview-scope>
        {videoShotScopeLabel(shot, t, editions?.current.number)}
      </div>}
    </header>
    {pickerOpen && <MenuSurface opaque className={css.pickerMenu} id={pickerId} role="group"
      aria-label={t('picker')} data-muse-video-picker>
      <div className={css.pickerContents}>
        <p className={css.pickerHint}>{t('pickerHint')}</p>
        <div className={css.pickerSummary}>
          <span>{t('draftSelectionCount', { count: targets.length })}</span>
          <Button size="sm" variant="ghost" disabled={phase !== 'plain'} onClick={addVideo}><IconPlusOutlineRegular />{t('addVideo')}</Button>
        </div>
        <div className={css.sourceList}>
          {visible.map((item) => {
            const target = wholeTarget(item)
            const selectTarget = () => {
              // oxlint-disable-next-line typescript/no-non-null-assertion -- Unversioned sources have a disabled checkbox.
              toggleTarget(target!, videoSelectionLabel(item, target!, t, sources))
            }
            return <div className={css.sourceRow} key={item.id}>
              <Checkbox label={t('selectVideo', { name: item.label })}
                checked={target !== null && selectedKeys.has(targetKey(target))}
                disabled={target === null || item.playbackUrl === null}
                onChange={selectTarget} />
              <Button size="sm" variant="ghost" aria-label={t('source', { name: item.label })}
                aria-pressed={source?.id === item.id} onClick={() => { chooseSource(item) }}>
                <IconPlayTriangleOutlineRegular /><span>{sourceTitle(item)}</span>
                {source?.id === item.id && <small>{t('previewing')}</small>}</Button>
            </div>
          })}
          {visible.length === 0 && <p className={css.empty}>{t('emptyEpisode')}</p>}
        </div>
      </div>
    </MenuSurface>}
    {resource.status === 'loading' && (resource.value === undefined || requested !== undefined && requestedSource === undefined)
      ? <div className={css.loading} role="status" aria-label={t('loading')}>
        <IconLoadingOutlineRegular />
      </div> : source === undefined ? <div className={css.emptyState}>
        <p className={css.empty} role="status">
          {t(foreignNavigation ? 'navigationForeign' : staleNavigation ? 'navigationStale'
            : sources.length === 0 ? 'empty' : 'emptyEpisode')}</p>
        {!foreignNavigation && !staleNavigation && resource.status === 'live' && <>
          <p className={css.actionHint}>{t('emptyHint')}</p>
          <Button size="sm" variant="outline" disabled={phase !== 'plain'} onClick={addVideo}><IconPlusOutlineRegular />{t('addVideo')}</Button>
        </>}
      </div>
        : <div className={studio === undefined ? css.island : `${css.island} ${css.studioIsland}`}>
          {editions !== null ? <VideoEditionControls editions={editions}
            onChoose={(edition) => { chooseEdition(editions.current, edition) }} t={t} />
            : studio === undefined && <header className={css.islandHeading}>
              <span className={css.spider} aria-hidden="true" /><span>{t('brand')}</span>
              <span className={css.sourceName}>{sourceTitle(source)}</span>
            </header>}
          {source.playbackUrl === null ? <p className={css.status} role="alert">{t('unavailable')}</p>
            : <VideoPlayer active={tab.visible} source={source} analysis={currentAnalysis} shots={timeline.shots}
              offset={0} duration={timeline.duration} pixelsPerSecond={pixelsPerSecond} zoom={zoom} onZoom={actions.setZoom}
              selectedShot={shot?.id ?? null} seekRequest={seekRequest} t={t}
              {...(studio === undefined ? {} : { studio })}
              onTimeChange={(time) => {
                playbackPosition.current = { sourceId: source.id, version: source.version, revision: seekRequest?.revision, time }
              }}
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
        </div>}
    {source !== undefined && authoredNumbers.length > 0 && <VideoShotGallery active={tab.visible} playbackUrl={source.playbackUrl}
      numbers={authoredNumbers} shots={authored} selectedId={shot?.id} t={t} onSelect={(located) => {
        const set = videoEditions(sources, source, located.authoredNumber)
        const preferred = set === null ? null : getAdoptedVideoEdition(sessionId, set)
        dismissNavigation(); actions.selectShot({ sourceId: preferred?.source.id ?? source.id,
          shotId: preferred?.shotId ?? located.id, time: preferred?.startSeconds ?? located.localStart })
      }} />}
    {(source !== undefined || targets.length > 0) && <div className={css.selectionAction}>
      {source !== undefined && <div className={css.currentScope}>
        {shot === undefined && <div className={css.previewScope}>
          <span className={css.scopeLabel}>{t('previewing')}</span><span>{t('currentVideo')}</span>
        </div>}
        <div className={css.scopeActions}>
          {shot !== undefined && <Button size="sm" variant="ghost" onClick={() => {
            dismissNavigation(); actions.select(source.id)
          }}>{t('wholeVideo')}</Button>}
          {editions !== null && <VideoEditionAdopt key={JSON.stringify([editions.key, editions.current.source.id])}
            sessionId={sessionId} editions={editions} t={t} />}
        </div>
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
      {studio === undefined && <p className={css.actionHint}>{t('chatHint')}</p>}
    </div>}
    {targets.length > 0 && <div className={css.selectedTargets} aria-label={t('selectedScope')}>
      <div className={css.selectedHeading}><span>{t('draftSelectionCount', { count: targets.length })}</span>
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
