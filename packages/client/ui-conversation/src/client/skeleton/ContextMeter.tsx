/** Composer occupancy uses a calibrated prepared-request snapshot when available
 * and keeps the model window separate from composition estimates. It stays
 * hidden until an estimate and route capacity are available. */

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { UseProjection } from '@deepseek-ai/dsh-api-session-controller/client'
// Type-only: the `contextPressure` / `contextBreakdown` projection key merges.
import type {} from '@deepseek-ai/dsh-token-meter/client'
import { Tooltip, useAnchoredPosition, useDismissOnOutsidePointer } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ComposerBarProps } from '../contract/slots.ts'
import { contextOccupancy } from '../context-occupancy.ts'
import css from './ContextMeter.module.css'

/** Ring geometry: 14px viewBox, 2px stroke. */
const RADIUS = 5.5
const CIRCUMFERENCE = 2 * Math.PI * RADIUS

/**
 * Marker the localized occupancy sentence is split on, so the panel headline
 * keeps the reading in its own tone while each locale still owns the word
 * order (`45% of context used` / `上下文已用 45%`).
 */
const READING_SLOT = '\u0000'

/** Panel legend rows, in bar-segment order; each color class carries the shared swatch/segment tint. */
const ROWS = [
  { key: 'systemTokens', label: 'context.system', color: css.colorSystem },
  { key: 'toolsTokens', label: 'context.tools', color: css.colorTools },
  { key: 'messageTokens', label: 'context.messages', color: css.colorMessages },
] as const

/**
 * Format a token count for the compact context panel.
 * @param value - token count.
 * @param t - Conversation locale seat with shared compact-number templates.
 * @returns Compact localized count using K or M when needed.
 */
function formatTokens(value: number, t: ComposerBarProps['t']): string {
  const scaled = (candidate: number): string => candidate >= 100
    ? String(Math.round(candidate))
    : String(Math.round(candidate * 10) / 10)
  if (value < 1_000) return String(value)
  if (value < 1_000_000) return t('number.thousand', { value: scaled(value / 1_000) })
  return t('number.million', { value: scaled(value / 1_000_000) })
}

export interface ContextMeterProps {
  useProjection: UseProjection
  /** The owning bar's locale seat, passed down as a plain prop. */
  t: ComposerBarProps['t']
}

export function ContextMeter({ useProjection, t }: ContextMeterProps) {
  const pressure = useProjection('contextPressure')
  const breakdown = useProjection('contextBreakdown')
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLSpanElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const context = contextOccupancy(pressure)
  const available = context !== null
  const position = useAnchoredPosition({
    open: open && available,
    anchorRef: rootRef,
    panelRef,
    side: 'top',
    gap: 8,
    margin: 12,
  })
  useDismissOnOutsidePointer(rootRef, open && available, setOpen, panelRef)

  // A model switch can temporarily remove capacity while this component stays
  // mounted. Close the now-unavailable panel instead of preserving stale UI.
  useEffect(() => {
    if (!available && open) setOpen(false)
  }, [available, open])

  useEffect(() => {
    if (!open || !available) return
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown) }
  }, [available, open])

  if (context === null) return null
  const percent = context.percent
  const fillPercent = Math.min(100, percent)
  const working = context.workingTokenLimit !== undefined
  const ariaKey = working ? 'context.workingAria' : 'context.aria'
  const usedKey = working ? 'context.workingUsed' : 'context.used'
  const reading = `${percent}%`
  const [headBefore = '', headAfter = ''] = t(ariaKey, { percent: READING_SLOT })
    .split(READING_SLOT)
    .map(part => part.trim())

  // The reading may exceed the working target; drawing remains within its track.
  const breakdownTotal = breakdown === undefined
    ? 0
    : breakdown.systemTokens + breakdown.toolsTokens + breakdown.messageTokens
  const parts = breakdown === undefined || breakdownTotal === 0
    ? [{ key: 'total', color: undefined, width: fillPercent }]
    : ROWS.map(row => ({ key: row.key, color: row.color, width: fillPercent * breakdown[row.key] / breakdownTotal }))
  const segments = parts.filter(part => part.width > 0)

  return (
    <span ref={rootRef} className={css.root}>
      <Tooltip label={t(ariaKey, { percent: reading })} side="top" delayMs={200} disabled={open}>
        <button
          type="button"
          className={css.trigger}
          aria-label={t(ariaKey, { percent: reading })}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => { setOpen(!open) }}
        >
          <svg viewBox="0 0 14 14" width="14" height="14" aria-hidden>
            <circle className={css.track} cx="7" cy="7" r={RADIUS} />
            <circle
              className={css.fill}
              cx="7"
              cy="7"
              r={RADIUS}
              strokeDasharray={`${CIRCUMFERENCE * fillPercent / 100} ${CIRCUMFERENCE}`}
              transform="rotate(-90 7 7)"
            />
          </svg>
          <span>{reading}</span>
        </button>
      </Tooltip>
      {open && createPortal(
        <div
          ref={panelRef}
          className={css.panel}
          style={position ?? { visibility: 'hidden', left: 0, top: 0 }}
          role="dialog"
          aria-label={t(usedKey)}
        >
          <div className={css.header}>
            {/* Empty sides collapse through `.headline:empty` so the locale that
                needs no leading (or trailing) text spends no header gap. */}
            <span className={css.headline}>{headBefore}</span>
            <span className={css.percent}>{reading}</span>
            <span className={css.headline}>{headAfter}</span>
            {/* `~`: usedTokens prefers projectedTokens, whose surface delta is
                heuristically repriced on top of the provider-anchored sample. */}
            <span className={css.figures}>
              {`~${formatTokens(context.usedTokens, t)} / ${formatTokens(context.workingTokenLimit ?? context.contextWindow, t)}`}
            </span>
          </div>
          {working && (
            <>
              <dl className={css.rows}>
                <div className={css.row}>
                  <dt>{t('context.modelWindow')}</dt>
                  <dd>{formatTokens(context.contextWindow, t)}</dd>
                </div>
              </dl>
              <p className={css.note}>{t('context.workingTarget')}</p>
            </>
          )}
          <div className={css.bar}>
            {segments.map(segment => (
              <div
                key={segment.key}
                className={segment.color === undefined ? css.segment : `${css.segment} ${segment.color}`}
                style={{ width: `${segment.width}%` }}
              />
            ))}
          </div>
          {breakdown !== undefined && (
            <>
              <p className={css.note}>{t('context.compositionEstimate')}</p>
              <dl className={css.rows}>
                {ROWS.map(row => (
                  <div key={row.key} className={css.row}>
                    <dt>
                      <span className={`${css.swatch} ${row.color}`} aria-hidden />
                      {t(row.label)}
                    </dt>
                    <dd>{`~${formatTokens(breakdown[row.key], t)}`}</dd>
                  </div>
                ))}
              </dl>
            </>
          )}
        </div>,
        document.body,
      )}
    </span>
  )
}
