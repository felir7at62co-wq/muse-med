/** One automatic Skill character assignment for authoring, discovery, and downloaded packages. */
import type { MarketManifest, MarketPresetPortraitId } from '@deepseek-ai/dsh-muse-market/types'
import { matchMarketPresetPortrait } from './market-preset-portraits.ts'

/** Purpose and immutable portrait binding shared by original and published Skills. */
export interface MarketSkillArtworkMetadata {
  name: string
  title: string
  description: string
  category: string
  skills?: readonly { name: string }[]
  presetPortrait?: MarketPresetPortraitId
}

const portraitsByName = new Map<string, MarketPresetPortraitId>([
  ['anime-3d-assets', '3d-asset-artist'],
  ['audio-transcribe', 'sound-designer'],
  ['commercial-drama-poster', 'commercial-poster-designer'],
  ['douyin-download', 'media-archivist'],
  ['guzhuang-sweet-romance-3d', 'character-designer'],
  ['jubian-asset-library', 'asset-librarian'],
  ['jubian-snatch', 'media-archivist'],
  ['media-link-import', 'media-archivist'],
  ['muse-dialogue-polish', 'dialogue-polish'],
  ['muse-episode-design', 'episode-planner'],
  ['muse-llm-wiki', 'knowledge-librarian'],
  ['muse-project-participation', 'production-manager'],
  ['muse-script-doctor', 'screenplay-editor'],
  ['muse-script-editing', 'screenplay-editor'],
  ['muse-storyboard-checklist', 'storyboard-reviewer'],
  ['novel-to-script', 'novel-adaptation'],
  ['office-docx', 'document-specialist'],
  ['office-pptx', 'presentation-designer'],
  ['office-xlsx', 'spreadsheet-analyst'],
  ['screenplay-format', 'screenplay-editor'],
  ['screenplay-project', 'project-bible'],
  ['shot-script-creator-16-9', 'horizontal-storyboard-director'],
  ['shot-script-creator-9-16', 'vertical-storyboard-director'],
  ['storyboard-starter', 'storyboard-reviewer'],
  ['transcript-to-novel', 'adaptation-planner'],
  ['transcript-to-script', 'adaptation-planner'],
  ['trope-adaptation', 'adaptation-planner'],
  ['tweet-drama-asset-extract', 'asset-librarian'],
  ['tweet-drama-asset-vision-check', 'visual-consistency-reviewer'],
  ['tweet-drama-background-render', 'environment-designer'],
  ['tweet-drama-core', 'production-manager'],
  ['tweet-drama-delivery', 'delivery-coordinator'],
  ['tweet-drama-draft-build', 'video-editor'],
  ['tweet-drama-early-shot-script', 'horizontal-storyboard-director'],
  ['tweet-drama-key-manager', 'workflow-automation'],
  ['tweet-drama-pipeline', 'workflow-automation'],
  ['tweet-drama-project-bible', 'project-bible'],
  ['tweet-drama-project-inspect', 'video-qa'],
  ['tweet-drama-script-convert', 'screenplay-editor'],
  ['tweet-drama-script-split', 'episode-planner'],
  ['tweet-drama-shot-asset-match', 'asset-librarian'],
  ['tweet-drama-voice-continuity', 'voice-casting'],
  ['urban-sweet-romance-3d', 'character-designer'],
  ['video-review', 'video-qa'],
  ['wechat-shortdrama-harvest', 'media-archivist'],
])

function namedPortrait(name: string): MarketPresetPortraitId | undefined {
  return portraitsByName.get(name.normalize('NFKC').trim().toLowerCase().replace(/^muse\/skills\//u, ''))
}

/** Assign a character by the published binding, primary Skill identity, and stated purpose.
 * @param metadata Metadata available before and after preparing the same Skill archive.
 * @returns A built-in profession character with consistent framing in every market view.
 */
export function resolveMarketSkillArtwork(metadata: MarketSkillArtworkMetadata): MarketPresetPortraitId {
  if (metadata.presetPortrait) return metadata.presetPortrait
  const primarySkill = metadata.skills?.[0]
  const named = (primarySkill && namedPortrait(primarySkill.name)) ?? namedPortrait(metadata.name)
  return named ?? matchMarketPresetPortrait(metadata).id
}

/** Bind an automatic character before an unbound Skill archive is uploaded.
 * @param manifest Validated archive metadata.
 * @returns The matching character, or undefined when a binding already exists.
 */
export function matchUnboundMarketPresetPortrait(manifest: MarketManifest): MarketPresetPortraitId | undefined {
  return manifest.kind === 'skill' && !manifest.presetPortrait ? resolveMarketSkillArtwork(manifest) : undefined
}
