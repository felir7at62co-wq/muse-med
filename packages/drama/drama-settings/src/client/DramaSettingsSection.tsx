/**
 * The short-drama Settings page, browser half.
 *
 * One form over the `drama` settings section — the two directories, the delivery
 * spec's four numbers, the BGM library and the paid image route's catalogue row —
 * plus the read-only component list that says which packages a short-drama
 * production is built from and what the plugin inventory reports about each.
 *
 * The form follows the resolved section rather than its own echo: after each
 * commit it adopts the values the Host reports, and a write that did not land is
 * reported as a failure instead of being shown as saved. The component list is
 * read once per mount and never claims a package is loaded that no inventory
 * named. Whether a paid step asks first is the agent's call, not a field here.
 */

import { useEffect, useState, type ReactNode } from 'react'
import { Button, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SettingsScope, SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import { DRAMA_SETTINGS_DEFAULTS, type DramaSettings } from '../settings.ts'
import type { DramaComponentState, DramaComponentStatus } from './components.ts'
import { STATUS_COPY } from './locales.ts'
import type { DramaImageRoute, DramaImageRoutes } from './routes.ts'
import {
  draftOf, draftSection, sameSettings, type DramaSettingsDraft, type DramaWriteOutcome,
} from './section.ts'
import css from './DramaSettingsSection.module.css'

/** Registration-side face the page calls; the write reports failures as values. */
export interface DramaSettingsSectionInjected {
  hooks: {
    /** The bound `drama` namespace scope, rendered as useDrama. */
    drama: SettingsScope<DramaSettings>
  }
  /** Persist the draft, or report that it could not be persisted. */
  write: (draft: DramaSettingsDraft) => Promise<DramaWriteOutcome>
  /** Clear every field, returning the section to its schema defaults. */
  restoreDefaults: () => Promise<DramaWriteOutcome>
  /**
   * Read the composed packages' current state. A deployment with no plugin
   * inventory answers with every component unqueryable.
   */
  components: () => Promise<DramaComponentState[]>
  /**
   * Read the rows the paid asset-image route can buy from. A deployment with no
   * Jubian image-route namespace answers `unavailable`, never an empty catalogue.
   */
  imageRoutes: () => Promise<DramaImageRoutes>
}

/** Full component props assembled by the Settings slot renderer. */
export type DramaSettingsSectionProps =
  PropsRuntime<'settings.section'>
  & PropsLocale<'settings.drama'>
  & InjectFace<DramaSettingsSectionInjected>

/** Which status dot a component status shows; only `loaded` reads as green. */
const STATUS_DOT: Record<DramaComponentStatus, StateDotState> = {
  loaded: 'done',
  starting: 'ongoing',
  failed: 'error',
  conditional: 'warning',
  inactive: 'idle',
  absent: 'idle',
  unknown: 'idle',
}

/** The read-only component list: one row per composed package. */
function ComponentList({ components, t }: {
  components: DramaComponentState[] | undefined
  t: DramaSettingsSectionProps['t']
}): ReactNode {
  return (
    <section className={css.group}>
      <h3 className={css.groupTitle}>{t('componentsTitle')}</h3>
      <p className={css.groupDescription}>{t('componentsDescription')}</p>
      {components === undefined
        ? <p className={css.notice} aria-busy="true">{t('componentsLoading')}</p>
        : (
          <ul className={css.components}>
            {components.map(({ component, status, condition }) => (
              <li key={component.pkg} className={css.component}>
                <span className={css.componentState}>
                  <StateDot state={STATUS_DOT[status]} />
                  <span className={css.componentStatus}>{t(STATUS_COPY[status])}</span>
                </span>
                <span className={css.componentText}>
                  <span className={css.componentRole}>{t(component.role)}</span>
                  <code className={css.componentPkg}>{component.pkg}</code>
                  {condition === undefined ? null : (
                    <span className={css.componentCondition}>{t('componentsCondition', { condition })}</span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      {components !== undefined && components.every(entry => entry.status === 'unknown')
        ? <p className={css.notice}>{t('componentsUnqueried')}</p>
        : null}
    </section>
  )
}

/**
 * The one-line label of a payable row: the platform, the row's own price, and
 * the id that pins it.
 * @param route - one row of the account catalogue.
 * @param t - the page's bound copy.
 * @returns the option text.
 */
function routeLabel(route: DramaImageRoute, t: DramaSettingsSectionProps['t']): string {
  const price = route.unitPrice === null || route.unit === null
    ? t('imageRoutePriceUnknown')
    : `${String(route.unitPrice)} ${route.unit}`
  return t('imageRouteOption', { platform: route.platformId, price, id: String(route.standardId) })
}

/**
 * The paid image route's row picker.
 *
 * The section's own value is what the select shows even when the catalogue read
 * failed or no longer lists that row: a list this page could not read is not
 * permission to drop a choice somebody already made.
 * @param props - the current draft, the last catalogue answer, the copy and the change sink.
 * @returns the group element tree.
 */
function ImageRouteGroup({ draft, routes, t, onChange }: {
  draft: DramaSettingsDraft
  routes: DramaImageRoutes | undefined
  t: DramaSettingsSectionProps['t']
  onChange: (imageStandardId: string) => void
}): ReactNode {
  const listed = routes?.status === 'ok' ? routes.routes : []
  const pinned = draft.imageStandardId
  const delisted = pinned !== '' && !listed.some(route => String(route.standardId) === pinned)
  return (
    <section className={css.group}>
      <h3 className={css.groupTitle}>{t('imageRouteTitle')}</h3>
      <p className={css.groupDescription}>{t('imageRouteDescription')}</p>
      <select
        className={css.input}
        value={pinned}
        aria-label={t('imageRouteTitle')}
        onChange={(event) => { onChange(event.currentTarget.value) }}
      >
        <option value="">{t('imageRouteUnset')}</option>
        {delisted ? <option value={pinned}>{t('imageRouteMissing', { id: pinned })}</option> : null}
        {listed.map(route => (
          <option key={route.standardId} value={String(route.standardId)}>{routeLabel(route, t)}</option>
        ))}
      </select>
      {routes === undefined ? <p className={css.notice} aria-busy="true">{t('imageRouteLoading')}</p> : null}
      {routes?.status === 'unavailable' ? <p className={css.notice}>{t('imageRouteUnavailable')}</p> : null}
      {routes?.status === 'failed'
        ? <p className={css.notice} role="status">{t('imageRouteFailed', { reason: routes.message })}</p>
        : null}
      {routes?.status === 'ok' && routes.routes.length === 0
        ? <p className={css.notice}>{t('imageRouteEmpty')}</p>
        : null}
    </section>
  )
}

/**
 * Render the short-drama settings page.
 * @param props - composed slot props (see {@link DramaSettingsSectionProps}).
 * @returns the settings page element tree.
 */
export function DramaSettingsSection(props: DramaSettingsSectionProps): ReactNode {
  const { t, useDrama, write, restoreDefaults, components, imageRoutes } = props
  const snapshot: SettingsScopeSnapshot<DramaSettings> = useDrama(value => value)
  const settings = snapshot.value
  const [draft, setDraft] = useState<DramaSettingsDraft | undefined>(undefined)
  const [states, setStates] = useState<DramaComponentState[] | undefined>(undefined)
  const [routes, setRoutes] = useState<DramaImageRoutes | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | undefined>(undefined)

  // Adopt every committed section: the first read, this page's own save, and a
  // tier switched from the composer control all arrive here.
  useEffect(() => {
    setDraft(settings === undefined ? undefined : draftOf(settings))
  }, [settings])

  // The inventory is a snapshot of process state, so this page reads it once per
  // mount rather than subscribing to it.
  useEffect(() => {
    let current = true
    void components().then((next) => {
      if (current) setStates(next)
    })
    return () => { current = false }
  }, [components])

  // The account catalogue is account state rather than a setting, so it is read
  // once per mount too: reopening the page is what re-reads it.
  useEffect(() => {
    let current = true
    void imageRoutes().then((next) => {
      if (current) setRoutes(next)
    })
    return () => { current = false }
  }, [imageRoutes])

  // The composition is not a setting, so this list shows in every state of the
  // form below it — including a deployment whose settings document is missing.
  const componentList = <ComponentList components={states} t={t} />

  if (snapshot.status === 'unavailable') {
    return (
      <div className={css.section}>
        <p className={css.notice}>{t('unavailable')}</p>
        {componentList}
      </div>
    )
  }
  if (draft === undefined || settings === undefined) {
    return (
      <div className={css.section}>
        <p className={css.notice} aria-busy="true">{t('loading')}</p>
        {componentList}
      </div>
    )
  }

  const intended = draftSection(draft)
  const dirty = intended === undefined || !sameSettings(settings, intended)

  /**
   * Run one write, then report what it did. A refusal shows the failure line and
   * leaves the draft alone, so the same page can be corrected and retried.
   * @param call - the write to run.
   * @param done - the notice a landed write shows.
   */
  const run = (call: () => Promise<DramaWriteOutcome>, done: string): void => {
    setBusy(true)
    setNotice(undefined)
    void call().then((outcome) => {
      setBusy(false)
      setNotice(outcome === 'saved'
        ? done
        : outcome === 'invalid' ? t('invalidNumber') : t('rejected'))
    })
  }

  return (
    <div className={css.section}>
      <section className={css.group}>
        <h3 className={css.groupTitle}>{t('deliveryDirTitle')}</h3>
        <p className={css.groupDescription}>{t('deliveryDirDescription')}</p>
        <input
          className={css.input}
          value={draft.deliveryDir}
          spellCheck={false}
          placeholder={t('deliveryDirPlaceholder')}
          aria-label={t('deliveryDirTitle')}
          onChange={(event) => { setDraft({ ...draft, deliveryDir: event.currentTarget.value }) }}
        />
      </section>

      <section className={css.group}>
        <h3 className={css.groupTitle}>{t('jianyingDraftDirTitle')}</h3>
        <p className={css.groupDescription}>{t('jianyingDraftDirDescription')}</p>
        <input
          className={css.input}
          value={draft.jianyingDraftDir}
          spellCheck={false}
          placeholder={DRAMA_SETTINGS_DEFAULTS.jianyingDraftDir}
          aria-label={t('jianyingDraftDirTitle')}
          onChange={(event) => { setDraft({ ...draft, jianyingDraftDir: event.currentTarget.value }) }}
        />
      </section>

      <section className={css.group}>
        <h3 className={css.groupTitle}>{t('specTitle')}</h3>
        <p className={css.groupDescription}>{t('specDescription')}</p>
        <div className={css.spec}>
          {([
            ['width', t('specWidth')],
            ['height', t('specHeight')],
            ['fps', t('specFps')],
            ['minBitrateMbps', t('specBitrate')],
          ] as const).map(([field, label]) => (
            <label key={field} className={css.specField}>
              <span className={css.specLabel}>{label}</span>
              <input
                className={css.input}
                type="number"
                inputMode="decimal"
                value={draft[field]}
                aria-label={label}
                onChange={(event) => { setDraft({ ...draft, [field]: event.currentTarget.value }) }}
              />
            </label>
          ))}
        </div>
      </section>

      <section className={css.group}>
        <h3 className={css.groupTitle}>{t('bgmDirTitle')}</h3>
        <p className={css.groupDescription}>{t('bgmDirDescription')}</p>
        <input
          className={css.input}
          value={draft.bgmDir}
          spellCheck={false}
          placeholder={DRAMA_SETTINGS_DEFAULTS.bgmDir}
          aria-label={t('bgmDirTitle')}
          onChange={(event) => { setDraft({ ...draft, bgmDir: event.currentTarget.value }) }}
        />
      </section>

      <ImageRouteGroup
        draft={draft}
        routes={routes}
        t={t}
        onChange={(imageStandardId) => { setDraft({ ...draft, imageStandardId }) }}
      />

      <div className={css.actions}>
        <Button
          variant="primary"
          size="sm"
          disabled={busy || !snapshot.writable || !dirty}
          onClick={() => { run(() => write(draft), t('saved')) }}
        >
          {busy ? t('saving') : t('save')}
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={busy || !snapshot.writable}
          onClick={() => { run(restoreDefaults, t('resetDone')) }}
        >
          {busy ? t('resetting') : t('reset')}
        </Button>
      </div>
      {notice === undefined ? null : <p className={css.notice} role="status">{notice}</p>}
      {snapshot.writable ? null : <p className={css.notice}>{t('readOnly')}</p>}
      {componentList}
    </div>
  )
}
