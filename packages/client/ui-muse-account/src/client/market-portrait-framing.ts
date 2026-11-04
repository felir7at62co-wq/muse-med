/** Shared framing for bundled market artwork. */
import type { CSSProperties } from 'react'
import type { MarketPresetPortraitId } from '@deepseek-ai/dsh-muse-market/types'

/** Scale and translation for a square display area. Apply scale before translate in the CSS transform list. */
export type MarketPortraitFraming = readonly [scale: number, xPercent: number, yPercent: number]

/** Framing for the standalone director portrait. */
export const directorPosterFraming: MarketPortraitFraming = [0.9864, 0.04, 0.23]

/** Shared framing for all director sprite cells. */
export const directorSpriteFraming: MarketPortraitFraming = [1.2084, -1.52, -0.16]

/** Framing for the wide Muse fallback portrait. */
export const museFallbackFraming: MarketPortraitFraming = [0.9613, -0.19, -0.06]

const screenplayEditorFraming: MarketPortraitFraming = [0.9444, 1.63, -0.52]

/** Framing for original Bot catalog portraits, keyed by catalog slug. */
export const catalogPortraitFraming: Readonly<Record<string, MarketPortraitFraming>> = {
  'storyboard-director-16-9': directorPosterFraming,
  'codex-coding': [0.9343, 1.79, -0.16],
  'claude-code-coding': [0.9236, 0.12, 0.08],
  'anime-3d-assets': [0.9243, 1.24, 0.28],
  'short-drama-director': [0.9350, 2.43, 0.20],
  'screenplay-editor': screenplayEditorFraming,
  'commercial-poster-designer': [0.9274, 0.56, -0.28],
}

/** Framing for the portraits offered in Bot creation and upload. */
export const presetPortraitFraming: Readonly<Record<MarketPresetPortraitId, MarketPortraitFraming>> = {
  'short-drama-writer': [0.9430, 1.63, -0.46],
  'screenplay-editor': screenplayEditorFraming,
  'dialogue-polish': [0.9430, 1.56, -0.46],
  'adaptation-planner': [0.9430, 1.63, -0.46],
  'outline-architect': [0.9443, 1.69, -0.52],
  'episode-planner': [0.9521, 1.63, -0.52],
  'plot-continuity': [0.9667, 3.06, -0.07],
  'character-biography': [0.9430, 2.54, 0.07],
  'novel-adaptation': [0.9495, 2.15, -0.13],
  'storyboard-reviewer': [0.9521, 1.63, -0.52],
  'horizontal-storyboard-director': [0.9430, 1.56, -0.46],
  'vertical-storyboard-director': [0.9430, 1.63, -0.46],
  'short-drama-director': [0.9430, 1.69, -0.46],
  'blocking-coach': [0.9430, 1.63, -0.46],
  'cinematographer': [0.9155, 2.02, -0.20],
  'lighting-designer': [0.9430, 2.21, -0.46],
  'shot-continuity': [0.9521, 1.69, -0.52],
  'shot-compiler': [0.9832, 1.69, -2.02],
  'animatic-planner': [0.9874, 1.76, -2.21],
  'virtual-camera-operator': [0.9521, 1.63, -0.52],
  '3d-asset-artist': [0.9456, 1.63, -0.46],
  'character-designer': [0.9443, 1.63, -0.52],
  'environment-designer': [0.9430, 1.63, -0.46],
  'prop-designer': [0.9443, 1.63, -0.52],
  'costume-designer': [0.9456, 1.63, -0.46],
  'makeup-stylist': [0.9521, 1.63, -0.52],
  'commercial-poster-designer': [0.9521, 1.63, -0.52],
  'visual-consistency-reviewer': [0.9694, 1.63, -1.37],
  'image-prompt-designer': [0.9495, 1.63, 0.00],
  'asset-librarian': [0.9481, 1.76, 0.07],
  'video-editor': [0.9456, 1.56, -0.46],
  'sound-designer': [0.9443, 1.69, -0.52],
  'subtitle-specialist': [0.9430, 1.69, -0.46],
  'voice-casting': [0.9521, 1.63, -0.52],
  'colorist': [0.9521, 1.63, -0.52],
  'compositor': [0.9521, 1.63, -0.52],
  'delivery-coordinator': [0.9521, 1.69, -0.52],
  'video-qa': [0.9521, 2.02, 0.26],
  'music-supervisor': [0.9735, 1.69, -1.56],
  'media-archivist': [0.9521, 1.69, -0.52],
  'production-manager': [0.9521, 1.69, -0.52],
  'budget-coordinator': [0.9430, 2.02, -0.33],
  'project-bible': [0.9521, 1.69, -0.52],
  'research-assistant': [0.9521, 1.63, -0.52],
  'knowledge-librarian': [1.0165, 1.69, -3.52],
  'document-specialist': [0.9694, 1.69, -1.37],
  'spreadsheet-analyst': [1.0105, 1.69, -3.26],
  'presentation-designer': [0.9846, 1.63, -2.08],
  'coding-assistant': [0.9521, 1.43, 0.00],
  'workflow-automation': [0.9560, 2.41, 0.20],
}

/** Apply the measured framing in a square portrait stage.
 * @param framing Measured framing, or undefined for artwork that uses the full stage.
 * @returns Styles for the artwork inside the stage.
 */
export function marketPortraitStyle(framing: MarketPortraitFraming | undefined): CSSProperties | undefined {
  if (!framing) return undefined
  const [scale, x, y] = framing
  return { transform: `scale(${scale}) translate(${x}%, ${y}%)` }
}
