/** Local sample artwork; no presentation fields are added to cloud release records. */
import type { MarketManifest, MarketPresetPortraitId, MarketRelease } from '@deepseek-ai/dsh-muse-market/types'
import type { MarketPresentation } from './MarketCharacter.tsx'
import { marketPresetPortraitUrls } from './market-preset-portrait-urls.ts'
import type { CharacterAnimation } from './market-character-generation.ts'

/** Prepared sprite with independent idle and introduction sequences. */
export const stockDirectorAnimation: CharacterAnimation = {
  sheetUrl: new URL('./assets/storyboard-director-sprite-v2.png', import.meta.url).href,
  columns: 2, rows: 2, cellWidth: 627, cellHeight: 627,
  idle: [{ cell: 0, durationMs: 3500 }, { cell: 1, durationMs: 160 }],
  introduce: [{ cell: 2, durationMs: 280 }, { cell: 3, durationMs: 220 }],
}

/** Resolve a publication portrait using the shared built-in assets.
 * @param manifest Publication metadata with an optional portrait.
 * @param portrait Preview selection, or the persisted portrait when omitted.
 * @returns Presentation for the selected portrait.
 */
export function boundMarketPresentation(manifest: MarketManifest, portrait: MarketPresetPortraitId | MarketManifest['portrait'] | undefined = manifest.presetPortrait ?? manifest.portrait): MarketPresentation | undefined {
  const copy = { role: manifest.title, introduction: manifest.description }
  switch (portrait) {
    case 'storyboard-director': return { ...copy, posterUrl: new URL('./assets/storyboard-director-chibi.png', import.meta.url).href, animation: stockDirectorAnimation }
    case undefined: return undefined
    default: return { ...copy, posterUrl: marketPresetPortraitUrls[portrait] }
  }
}

/** Resolve local artwork for the two exact handoff archives, retaining actual release copy.
 * @param release Server-confirmed release metadata and digest.
 * @returns Local sample presentation, or undefined for other publication bytes.
 */
export function stockMarketPresentation(release: MarketRelease): MarketPresentation | undefined {
  if (release.manifest.kind === 'bot' && release.sha256 === 'f10f9df6c7b45d6950ee52aa5375416cec6eb020af8df84d646ab5f00af054fc') {
    return { role: release.manifest.title, introduction: release.manifest.description,
      posterUrl: new URL('./assets/storyboard-director-chibi.png', import.meta.url).href,
      animation: stockDirectorAnimation }
  }
  if (release.manifest.kind === 'skill' && release.sha256 === '6a046668b9c690d85f4802cef398d8148ed9231e37acf29d82ce0d79e93b51c8') {
    return { role: release.manifest.title, introduction: release.manifest.description,
      posterUrl: new URL('./assets/storyboard-skill-kit.png', import.meta.url).href }
  }
  return undefined
}
