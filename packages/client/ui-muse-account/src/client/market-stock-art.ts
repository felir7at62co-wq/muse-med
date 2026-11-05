/** Shared silhouettes and prepared motion for the bundled Skill characters. */
import { marketPresetPortraitUrls } from './market-preset-portrait-urls.ts'
import { marketPresetPortraits } from './market-preset-portraits.ts'
import { directorPosterFraming, presetPortraitFraming, type MarketPortraitFraming } from './market-portrait-framing.ts'
import type { CharacterAnimation } from './market-character-generation.ts'

const directorPosterUrl = new URL('./assets/storyboard-director-chibi.png', import.meta.url).href

/** Visual framing for bundled posters, keyed by their resolved artwork URLs. */
export const marketPosterFraming: ReadonlyMap<string, MarketPortraitFraming> = new Map([
  ...marketPresetPortraits.map(({ id }) => [marketPresetPortraitUrls[id], presetPortraitFraming[id]] as const),
  [directorPosterUrl, directorPosterFraming],
])

/** Prepared sprite with independent idle and introduction sequences. */
export const stockDirectorAnimation: CharacterAnimation = {
  sheetUrl: new URL('./assets/storyboard-director-sprite-v2.png', import.meta.url).href,
  columns: 2, rows: 2, cellWidth: 627, cellHeight: 627,
  idle: [{ cell: 0, durationMs: 3500 }, { cell: 1, durationMs: 160 }],
  introduce: [{ cell: 2, durationMs: 280 }, { cell: 3, durationMs: 220 }],
}
