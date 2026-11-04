/** Original Bot portraits and shared Skill illustrations. */
import { useState, type ReactNode } from 'react'
import { catalogPortraitFraming, marketPortraitStyle } from './market-portrait-framing.ts'
import { MarketSkillGlyph } from './MarketSkillGlyph.tsx'
import { resolveMarketSkillArtwork, type MarketSkillArtworkMetadata } from './market-skill-artwork.ts'
import css from './MarketCharacter.module.css'

const botPortraits: Readonly<Record<string, string>> = {
  'storyboard-director-16-9': new URL('./assets/storyboard-director-chibi.png', import.meta.url).href,
  'codex-coding': new URL('./assets/catalog-codex-coding.png', import.meta.url).href,
  'claude-code-coding': new URL('./assets/catalog-claude-code-coding.png', import.meta.url).href,
  'anime-3d-assets': new URL('./assets/catalog-anime-3d-assets.png', import.meta.url).href,
  'short-drama-director': new URL('./assets/catalog-short-drama-director.png', import.meta.url).href,
  'screenplay-editor': new URL('./assets/catalog-screenplay-editor.png', import.meta.url).href,
  'commercial-poster-designer': new URL('./assets/catalog-commercial-poster-designer.png', import.meta.url).href,
}

/** Render the illustrated Muse role with viewport-contained motion.
 * @param props Catalog identity, accessible name and fallback artwork.
 * @returns A character portrait, or fallback for an unavailable portrait.
 */
export function MarketCatalogBot({ id, label, fallback }: { id: string; label: string; fallback: ReactNode }): ReactNode {
  const slug = id.replace(/^muse\/bots\//, '')
  const src = Object.hasOwn(botPortraits, slug) ? botPortraits[slug] : undefined
  const [failed, setFailed] = useState<string>()
  if (!src || src === failed) return fallback
  return <span className={css.catalogMotion}>
    <img className={css.portrait} src={src} alt={label} style={marketPortraitStyle(catalogPortraitFraming[slug])}
      onError={() => { setFailed(src) }} />
  </span>
}

/** Show the same purpose illustration for previews and published Skill cards.
 * @param props Skill metadata and accessible title.
 * @returns Skill artwork with a vector fallback for unavailable storyboard artwork.
 */
export function MarketSkillArtwork({ metadata, label }: {
  metadata: MarketSkillArtworkMetadata
  label: string
}): ReactNode {
  const [failed, setFailed] = useState(false)
  const artwork = resolveMarketSkillArtwork(metadata)
  if (artwork === 'storyboard' && !failed) {
    return <img className={css.portrait} src={new URL('./assets/storyboard-skill-kit.png', import.meta.url).href}
      alt={label} onError={() => { setFailed(true) }} />
  }
  return <svg className={css.catalogPortrait} viewBox="0 0 240 230" role="img" aria-label={label}>
    <circle cx="120" cy="110" r="85" fill="#dfd2fa" />
    <g transform="rotate(-11 120 110)">
      <rect x="58" y="48" width="120" height="132" rx="16" fill="#ac8adb" />
      <rect x="68" y="42" width="120" height="132" rx="16" fill="#f8eeff" stroke="#7751ac" strokeWidth="3" />
      <g transform="translate(86 65) scale(2)" fill="none" stroke="#7751ac" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <MarketSkillGlyph glyph={artwork === 'storyboard' ? 'frames' : artwork} />
      </g>
    </g>
  </svg>
}
