/** Market records shared by cloud routes, the Host and browser consumers. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/** Immutable release identity. */
export type MarketReleaseId = Branded<'MarketReleaseId'>
/** Stable creator or team identity. */
export type MarketPublisherId = Branded<'MarketPublisherId'>
/** Declarative plugin row admitted by a market installation policy. */
export interface MarketPlugin {
  readonly name: string
  readonly config?: Readonly<Record<string, JsonValue>> | readonly MarketPlugin[]
  readonly disabled?: boolean
  readonly group?: boolean
}
/** One instruction file and its stable invocation name. */
export interface MarketSkill {
  readonly name: string
  readonly path: string
}
/** Identifiers in the selectable Bot portrait library. */
export const marketPresetPortraitIds = [
  'short-drama-writer', 'screenplay-editor', 'dialogue-polish', 'adaptation-planner',
  'outline-architect', 'episode-planner', 'plot-continuity', 'character-biography',
  'novel-adaptation', 'storyboard-reviewer', 'horizontal-storyboard-director', 'vertical-storyboard-director',
  'short-drama-director', 'blocking-coach', 'cinematographer', 'lighting-designer',
  'shot-continuity', 'shot-compiler', 'animatic-planner', 'virtual-camera-operator',
  '3d-asset-artist', 'character-designer', 'environment-designer', 'prop-designer',
  'costume-designer', 'makeup-stylist', 'commercial-poster-designer', 'visual-consistency-reviewer',
  'image-prompt-designer', 'asset-librarian', 'video-editor', 'sound-designer',
  'subtitle-specialist', 'voice-casting', 'colorist', 'compositor',
  'delivery-coordinator', 'video-qa', 'music-supervisor', 'media-archivist',
  'production-manager', 'budget-coordinator', 'project-bible', 'research-assistant',
  'knowledge-librarian', 'document-specialist', 'spreadsheet-analyst', 'presentation-designer',
  'coding-assistant', 'workflow-automation',
] as const

/** One portrait in the selectable Bot library. */
export type MarketPresetPortraitId = typeof marketPresetPortraitIds[number]

/** Bot portraits supported by the original archive field. */
export type MarketPortrait = 'storyboard-director' | 'screenplay-editor'

/** Author-entered execution content; cloud ownership is stored separately. */
export interface MarketManifest {
  readonly formatVersion: 1
  readonly kind: 'bot' | 'skill'
  readonly name: string
  readonly title: string
  readonly description: string
  readonly version: string
  readonly license: string
  readonly category: string
  readonly examples: readonly string[]
  readonly requirements: readonly string[]
  readonly skills: readonly MarketSkill[]
  readonly plugins?: readonly MarketPlugin[]
  readonly portrait?: MarketPortrait
  readonly presetPortrait?: MarketPresetPortraitId
}
/** Compressed and expanded package limits controlled by deployment. */
export interface MarketLimits {
  readonly archiveBytes: number
  readonly expandedBytes: number
  readonly fileCount: number
}
/** A release with review status and server-authenticated ownership. */
export interface MarketRelease {
  readonly id: MarketReleaseId
  readonly publisherId: MarketPublisherId
  readonly publisher: string
  readonly manifest: MarketManifest
  readonly sha256: string
  readonly bytes: number
  readonly status: 'draft' | 'pending' | 'published' | 'rejected' | 'withdrawn'
  readonly reviewNote: string
  readonly revision: number
  readonly createdAt: string
}
/** Original distribution metadata used for discovery and manual download. */
export interface MarketLegacyResource {
  readonly id: string
  readonly kind: 'bot' | 'skill'
  readonly title: string
  readonly description: string
  readonly category: string
  readonly version: string
  readonly requirements: readonly string[]
  readonly requiredSkills: readonly string[]
  readonly validation: string
  readonly sha256: string
  readonly href: string
}
/** A cloud-authenticated account; never constructed from request JSON. */
export interface MarketActor {
  readonly id: string
  readonly username: string
  readonly admin: boolean
}
/** A persistent local installation; activation is independent of download. */
export interface MarketInstallation {
  readonly release: MarketRelease
  readonly enabled: boolean
  /** Original distribution identity before conversion to a local publication. */
  readonly legacySource?: Pick<MarketLegacyResource, 'id' | 'sha256'>
}
