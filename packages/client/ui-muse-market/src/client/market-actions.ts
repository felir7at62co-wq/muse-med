/** Skill market callbacks supplied by the actual local, activation and cloud Remotes. */
import type MuseMarket from '@deepseek-ai/dsh-muse-market'
import type MuseMarketActivation from '@deepseek-ai/dsh-muse-market/activation'
import type MuseMarketCloud from '@deepseek-ai/dsh-muse-market/cloud'
import type { MarketAccess } from './market-controller.ts'
import type { HostObservable, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'

/** Operations backed by separately mounted local, activation and cloud namespaces. */
export type MarketActions = Pick<MuseMarket, 'sources' | 'prepare' | 'installed' | 'importPackage' | 'exportPackage' | 'removePackage'>
  & Pick<MuseMarketActivation, 'defaults' | 'setDefault' | 'binding'>
  & Pick<MuseMarketCloud, 'catalog' | 'identity' | 'getPublication' | 'publishDraft' | 'installPublication' | 'review'>
/** Complete publication metadata returned by the configured cloud. */
export type MarketPublication = Awaited<ReturnType<MarketActions['catalog']>>[number]
/** Verified public account id, publishing teams and moderation capability. */
export type MarketIdentity = Awaited<ReturnType<MarketActions['identity']>>
/** Original local release metadata with its disabled storage marker. */
export type MarketInstallation = Awaited<ReturnType<MarketActions['installed']>>[number]
/** Authoritative current defaults and their committed revision. */
export type MarketDefaultSnapshot = Awaited<ReturnType<MarketActions['defaults']>>
/** Typed translation callback for this market namespace. */
export type MarketTranslate = PropsLocale<'settings.museMarket'>['t']
/** Locale keys for settled operation outcomes and recovery guidance. */
export type MarketOutcomeKey = 'done' | 'installedDone' | 'defaultDone' | 'draftDone' | 'reviewDone' | 'reviewUnconfirmed' | 'failed' | 'invalidPackage' | 'defaultConflict' | 'releaseInUse' | 'signInRequired' | 'permissionDenied' | 'cloudUnavailable'
/** Registration-owned callbacks and observable access facts consumed through framework hooks. */
export interface MarketInjected {
  readonly hooks: { readonly access: HostObservable<MarketAccess> }
  readonly isCurrentAccess: (revision: number) => boolean
  readonly operations: MarketActions
  readonly reportOutcome: (key: MarketOutcomeKey, failed: boolean) => void
}

/** Return the actual default for a release's invoked Skill.
 * @param item - Verified local installation whose invocation is being compared.
 * @param snapshot - Complete current defaults returned by activation.
 * @returns That invocation's current default, or undefined when it has none.
 */
export function defaultFor(item: MarketInstallation, snapshot: MarketDefaultSnapshot): MarketDefaultSnapshot['defaults'][number] | undefined {
  return snapshot.defaults.find(row => row.skillName === item.release.manifest.skills[0]?.name)
}

/** Save a Host-exported archive without changing its bytes.
 * @param file - Filename and complete canonical base64 returned by local export.
 */
export function downloadMarketFile(file: Awaited<ReturnType<MarketActions['exportPackage']>>): void {
  const bytes = Uint8Array.from(atob(file.base64), character => character.charCodeAt(0))
  const href = URL.createObjectURL(new Blob([bytes], { type: 'application/zip' }))
  const link = document.createElement('a')
  link.href = href; link.download = file.name; link.click()
  setTimeout(() => { URL.revokeObjectURL(href) }, 0)
}

/** Encode a selected ZIP unchanged for authoritative Host validation.
 * @param file - User-selected complete archive.
 * @returns Canonical base64 of the original file bytes.
 */
export async function archiveBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  let body = ''
  for (let offset = 0; offset < bytes.length; offset += 16384) body += String.fromCharCode(...bytes.subarray(offset, offset + 16384))
  return btoa(body)
}

/** Select locale-owned recovery copy without displaying upstream messages.
 * @param error - Structured Host or carrier refusal.
 * @returns A bounded operation feedback key.
 */
export function marketFailureOutcome(error: unknown): MarketOutcomeKey {
  if (typeof error !== 'object' || error === null) return 'failed'
  if ('code' in error && error.code === 'muse-market/access-changed') return 'signInRequired'
  if (!('details' in error) || typeof error.details !== 'object' || error.details === null) return 'cloudUnavailable'
  const details = error.details
  if ('status' in details && details.status === 401) return 'signInRequired'
  if ('status' in details && details.status === 403) return 'permissionDenied'
  if (!('code' in details)) return 'failed'
  if (details.code === 'default-conflict') return 'defaultConflict'
  if (details.code === 'release-in-use' || details.code === 'default-in-use') return 'releaseInUse'
  if (details.code === 'account-changed') return 'signInRequired'
  if (['invalid-archive', 'invalid-manifest', 'archive-mismatch', 'catalog-changed', 'digest-mismatch'].includes(String(details.code))) return 'invalidPackage'
  if ('status' in details && typeof details.status === 'number' && details.status >= 500) return 'cloudUnavailable'
  return 'failed'
}
