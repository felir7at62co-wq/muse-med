/**
 * The page's editable draft, the write set it compiles to, and the verdict a
 * write settles with.
 *
 * A draft holds the delivery spec and yuan budget as typed text, because a form
 * field that is briefly not a number is a normal state and typing it must not
 * write anything. {@link draftSection} is the one place that decides what a
 * draft means: a blank path field means "the schema default" — the same value
 * {@link sectionOps} leaves behind by clearing the field rather than storing a
 * copy of it. A blank image-route select means "no row pinned", which is a
 * different value from a row whose id happens to read as blank.
 */

import type { SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client'
import {
  DELIVERY_SPEC_FIELD, DRAMA_SETTINGS_DEFAULTS, DRAMA_SETTINGS_FIELDS,
  type DramaDeliverySpec, type DramaSettings, type DramaSettingsField,
} from '../settings.ts'

/** What one page write did. */
export type DramaWriteOutcome =
  /** The resolved section now carries everything the draft asked for. */
  | 'saved'
  /** A numeric field or yuan budget was invalid, so nothing was sent. */
  | 'invalid'
  /** The host kept a different section, which is what a refusal looks like here. */
  | 'rejected'

/** One editable section as the page holds it: the spec's four numbers as typed text. */
export interface DramaSettingsDraft {
  /** Delivery directory as typed; blank means the schema default. */
  deliveryDir: string
  /** Draft root as typed; blank means the schema default. */
  jianyingDraftDir: string
  /** Frame width as typed. */
  width: string
  /** Frame height as typed. */
  height: string
  /** Frame rate as typed. */
  fps: string
  /** Bitrate floor as typed. */
  minBitrateMbps: string
  /** BGM library as typed; blank means the schema default. */
  bgmDir: string
  /** Chosen image-route row as the select holds it; blank means no row is pinned. */
  imageStandardId: string
  /** Automatic per-drama spending ceiling in yuan as typed; blank is invalid. */
  seriesBudgetYuan: string
}

/**
 * The draft showing one resolved section.
 * @param settings - the section the page is editing.
 * @returns the same values as editable text.
 */
export function draftOf(settings: DramaSettings): DramaSettingsDraft {
  return {
    deliveryDir: settings.deliveryDir,
    jianyingDraftDir: settings.jianyingDraftDir,
    width: String(settings.deliverySpec.width),
    height: String(settings.deliverySpec.height),
    fps: String(settings.deliverySpec.fps),
    minBitrateMbps: String(settings.deliverySpec.minBitrateMbps),
    bgmDir: settings.bgmDir,
    imageStandardId: settings.imageStandardId === undefined ? '' : String(settings.imageStandardId),
    seriesBudgetYuan: `${Math.trunc(settings.seriesBudgetCents / 100)}${settings.seriesBudgetCents % 100 === 0
      ? '' : `.${String(settings.seriesBudgetCents % 100).padStart(2, '0').replace(/0$/, '')}`}`,
  }
}

/** Parse one number box; undefined while it holds no finite number. */
function parseNumber(text: string): number | undefined {
  const value = Number(text.trim())
  return text.trim().length > 0 && Number.isFinite(value) ? value : undefined
}

/** Convert yuan text to safe integer cents without a floating-point decimal conversion. */
function parseBudget(text: string): number | undefined {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(text.trim())
  if (match === null) return undefined
  const cents = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'))
  return Number.isSafeInteger(cents) ? cents : undefined
}

/** One path box, or its default while the box is blank. */
function parsePath(text: string, fallback: string): string {
  const trimmed = text.trim()
  return trimmed.length === 0 ? fallback : trimmed
}

/**
 * The section one draft asks for.
 * @param draft - the current form values.
 * @returns the section to persist, or undefined while a spec box, image-route
 *   select or yuan budget holds an invalid value.
 */
export function draftSection(draft: DramaSettingsDraft): DramaSettings | undefined {
  const width = parseNumber(draft.width)
  const height = parseNumber(draft.height)
  const fps = parseNumber(draft.fps)
  const minBitrateMbps = parseNumber(draft.minBitrateMbps)
  const seriesBudgetCents = parseBudget(draft.seriesBudgetYuan)
  if (width === undefined || height === undefined || fps === undefined || minBitrateMbps === undefined
    || seriesBudgetCents === undefined) {
    return undefined
  }
  // An empty select means "pin no row", which is a value rather than a failure:
  // the route then decides for itself while the catalogue lists exactly one row.
  const unpinned = draft.imageStandardId.trim().length === 0
  const imageStandardId = parseNumber(draft.imageStandardId)
  if (!unpinned && imageStandardId === undefined) return undefined
  const section: DramaSettings = {
    deliveryDir: parsePath(draft.deliveryDir, DRAMA_SETTINGS_DEFAULTS.deliveryDir),
    jianyingDraftDir: parsePath(draft.jianyingDraftDir, DRAMA_SETTINGS_DEFAULTS.jianyingDraftDir),
    deliverySpec: { width, height, fps, minBitrateMbps },
    bgmDir: parsePath(draft.bgmDir, DRAMA_SETTINGS_DEFAULTS.bgmDir),
    seriesBudgetCents,
  }
  // Past the guard, an absent id can only mean the select was blank.
  return imageStandardId === undefined ? section : { ...section, imageStandardId }
}

/** Whether two specs state the same four numbers. */
function sameSpec(left: DramaDeliverySpec, right: DramaDeliverySpec): boolean {
  return left.width === right.width && left.height === right.height
    && left.fps === right.fps && left.minBitrateMbps === right.minBitrateMbps
}

/**
 * Whether a resolved section is exactly the intended one — the evidence that a
 * write landed, read from the same snapshot the page renders.
 * @param current - the section the settings namespace resolves to now.
 * @param intended - the section the page asked for.
 * @returns true when every field already states the intended value.
 */
export function sameSettings(current: DramaSettings, intended: DramaSettings): boolean {
  return current.deliveryDir === intended.deliveryDir
    && current.jianyingDraftDir === intended.jianyingDraftDir
    && current.bgmDir === intended.bgmDir
    && current.seriesBudgetCents === intended.seriesBudgetCents
    && current.imageStandardId === intended.imageStandardId
    && sameSpec(current.deliverySpec, intended.deliverySpec)
}

/**
 * Whether a namespace holds the intended section.
 * @param current - the section the namespace resolves to, absent before its first read.
 * @param intended - the section a write asked for.
 * @returns true only when a resolved section states the intended value.
 */
export function landed(current: DramaSettings | undefined, intended: DramaSettings): boolean {
  return current !== undefined && sameSettings(current, intended)
}

/** The scalar fields whose default is a plain value. */
type ScalarField = Exclude<DramaSettingsField, typeof DELIVERY_SPEC_FIELD>

/**
 * The write set taking one resolved section to the intended one.
 *
 * A field already stating the intended value is untouched, and a field whose
 * intended value IS the schema default — or is absent, which states the same
 * thing — is cleared: the user layer then holds no override that says nothing,
 * which is also what "restore defaults" leaves behind. The spec is compared
 * field by field because it is the one object-valued setting. A namespace that
 * has not resolved yet holds no user layer, so it compares as the defaults.
 * @param current - the resolved section, or undefined before the first read.
 * @param intended - the section the page asks for.
 * @returns ordered path operations for one atomic namespace write.
 */
export function sectionOps(current: DramaSettings | undefined, intended: DramaSettings): SettingsPathOpView[] {
  const from = current ?? DRAMA_SETTINGS_DEFAULTS
  const ops: SettingsPathOpView[] = []
  const scalar = (field: ScalarField): void => {
    const value = intended[field]
    if (value === from[field]) return
    // An absent value is the same statement as the schema default: this field
    // carries no override, so the operation that leaves none behind is an unset.
    ops.push(value === undefined || value === DRAMA_SETTINGS_DEFAULTS[field]
      ? { op: 'unset', path: [field] }
      : { op: 'set', path: [field], value })
  }
  scalar('deliveryDir')
  scalar('jianyingDraftDir')
  scalar('bgmDir')
  scalar('imageStandardId')
  scalar('seriesBudgetCents')
  if (!sameSpec(intended.deliverySpec, from.deliverySpec)) {
    ops.push(sameSpec(intended.deliverySpec, DRAMA_SETTINGS_DEFAULTS.deliverySpec)
      ? { op: 'unset', path: [DELIVERY_SPEC_FIELD] }
      : { op: 'set', path: [DELIVERY_SPEC_FIELD], value: intended.deliverySpec })
  }
  return ops
}

/**
 * Clear every field, which is what returns the section to its schema defaults.
 * @returns one unset operation per field, for a single atomic namespace write.
 */
export function defaultOps(): SettingsPathOpView[] {
  return DRAMA_SETTINGS_FIELDS.map(field => ({ op: 'unset', path: [field] }))
}
