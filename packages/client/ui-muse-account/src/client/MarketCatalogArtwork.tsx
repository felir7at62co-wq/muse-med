/** Illustrated roles for the original Muse catalog. */
import { useState, type ReactNode } from 'react'
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

function propArtwork(prop: string): ReactNode {
  switch (prop) {
    case 'terminal': return <path d="m7 12 8 7-8 7m13 0h13" />
    case 'code': return <path d="m13 11-8 8 8 8m14-16 8 8-8 8M22 8l-5 22" />
    case 'cube': return <path d="m20 6 14 8v14l-14 8-14-8V14Zm0 14v16M6 14l14 8 14-8" />
    case 'frames': return <path d="M6 8h28v23H6zm14 0v23M6 19h28" />
    case 'clapper': return <path d="m6 18 28-8v20H6zm0 0 2-10 26-4v6m-21-3 4 7m6-9 4 7" />
    case 'pen': return <path d="m9 30 4-11L28 5l7 7-15 14Zm4-11 7 7m-11 4 6-2" />
    case 'poster': return <><circle cx="24" cy="13" r="5" /><path d="m6 30 10-14 9 12 4-5 6 7Z" /></>
    default: return <path d="M8 9h24M8 19h24M8 29h16" />
  }
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
  return <img className={css.catalogBotPortrait} src={src} alt={label} onError={() => { setFailed(src) }} />
}

const categoryProps: Readonly<Record<string, string>> = {
  '角色与资产': 'cube', '媒体与交付': 'clapper', '海报宣发': 'poster', '制作工具': 'terminal',
  '剧本创作': 'pen', '办公文档': 'frames', '镜头分镜': 'frames', '编程开发': 'code', '短剧制作': 'clapper',
}

/** Illustrate a Skill by its catalog category.
 * @param props Catalog category and accessible title.
 * @returns A resource illustration.
 */
export function MarketCatalogSkill({ category, label }: { category: string; label: string }): ReactNode {
  return <svg className={css.catalogPortrait} viewBox="0 0 240 230" role="img" aria-label={label}>
    <circle cx="120" cy="110" r="85" fill="#dfd2fa" />
    <g transform="rotate(-11 120 110)">
      <rect x="58" y="48" width="120" height="132" rx="16" fill="#ac8adb" />
      <rect x="68" y="42" width="120" height="132" rx="16" fill="#f8eeff" stroke="#7751ac" strokeWidth="3" />
      <g transform="translate(86 65) scale(2)" fill="none" stroke="#7751ac" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        {propArtwork(categoryProps[category] ?? 'document')}
      </g>
    </g>
  </svg>
}
