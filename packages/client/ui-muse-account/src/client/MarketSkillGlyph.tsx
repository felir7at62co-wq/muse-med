/** Purpose illustrations for the shared Skill artwork tile. */
import type { ReactNode } from 'react'

// Each glyph occupies a 40 × 40 canvas. The artwork tile supplies the outline style.
const skillGlyphs = {
  terminal: <>
    <rect x="4" y="8" width="32" height="24" rx="4" />
    <path d="m10 15 6 5-6 5m12 0h8" />
  </>,
  code: <path d="m12 11-8 9 8 9m16-18 8 9-8 9M23 8l-6 24" />,
  cube: <path d="m20 6 14 8v14l-14 8-14-8V14Zm0 16v14M6 14l14 8 14-8" />,
  frames: <path d="M5 8h30v24H5zm15 0v24M5 20h30" />,
  'frames-wide': <path d="M3 9h34v22H3zm17 0v22M7 24l5-7 4 5m8 2 5-7 4 5" />,
  'frames-vertical': <path d="M9 4h22v32H9zm0 16h22M13 16l5-7 8 7m-13 16 5-7 8 7" />,
  clapper: <path d="m5 16 29-7 2 7-30 7zm1 7h30v11H6zm7-9 5 6m5-8 5 6M12 28h18" />,
  pen: <path d="m8 31 3-10L27 5l8 8-16 16Zm3-10 8 8m4-20 8 8M8 35h24" />,
  poster: <>
    <rect x="7" y="4" width="26" height="32" rx="3" />
    <path d="M12 10h16m-16 5h9m-9 14 5-7 4 4 3-3 4 6" />
  </>,
  document: <path d="M9 5h15l7 7v23H9zm15 0v8h7M14 18h12m-12 6h12m-12 6h8" />,
  portrait: <>
    <rect x="6" y="5" width="28" height="30" rx="4" />
    <circle cx="20" cy="15" r="5" />
    <path d="M11 29a9 9 0 0 1 18 0" />
  </>,
  sound: <path d="M5 17v6m6-12v18m6-23v28m6-21v14m6-18v22m6-14v6" />,
  voice: <>
    <rect x="15" y="5" width="10" height="19" rx="5" />
    <path d="M10 19a10 10 0 0 0 20 0M20 29v6m-6 0h12" />
  </>,
  captions: <>
    <rect x="4" y="8" width="32" height="24" rx="4" />
    <path d="M10 22h8m4 0h8m-20 5h20" />
  </>,
  edit: <>
    <path d="m14 14 20 20m-20-8L34 6M10 18a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm0 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z" />
    <circle cx="20" cy="20" r="1" />
  </>,
  download: <path d="M20 5v21m-8-8 8 8 8-8M5 25v8h30v-8" />,
  qa: <path d="M14 6h12v6H14zm0 3H7v26h26V9h-7M12 23l5 5 11-11" />,
  'video-qa': <>
    <rect x="4" y="7" width="32" height="25" rx="4" />
    <path d="m10 14 9 6-9 6Zm12 10 4 4 7-9" />
  </>,
  workflow: <>
    <rect x="14" y="4" width="12" height="10" rx="2" />
    <rect x="4" y="26" width="12" height="10" rx="2" />
    <rect x="24" y="26" width="12" height="10" rx="2" />
    <path d="M20 14v6H10v6m10-6h10v6" />
  </>,
  folder: <path d="M5 14V8h12l4 5h14v20H5V14Zm0 5h30M12 25h12" />,
  table: <>
    <rect x="5" y="7" width="30" height="26" rx="3" />
    <path d="M5 15h30M5 24h30M15 15v18m10-18v18" />
  </>,
  prompt: <path d="M7 6h26v22H18l-7 6v-6H7zm13 5 2 5 5 2-5 2-2 5-2-5-5-2 5-2Z" />,
  dialogue: <path d="M5 7h24v16H15l-6 5v-5H5zm11 21h10l6 6v-6h4V15h-3M11 14h12m-12 4h8" />,
  book: <path d="M20 10c-4-4-10-5-16-4v25c6-1 12 0 16 4 4-4 10-5 16-4V6c-6-1-12 0-16 4Zm0 0v25M9 13l6 2m-6 4 6 2m16-8-6 2m6 4-6 2" />,
  translate: <path d="M5 11h18m-9-5v5m5 0c0 8-7 14-13 17m4-13c2 5 6 8 10 10m2 9 6-14 7 14m-11-5h9" />,
  research: <>
    <circle cx="17" cy="16" r="10" />
    <path d="m24 24 10 10M13 13h8m-8 5h6" />
  </>,
  camera: <>
    <path d="M5 13h7l3-5h10l3 5h7v19H5z" />
    <circle cx="20" cy="22" r="6" />
  </>,
  link: <path d="m16 24 8-8m-12 4-4 4a6 6 0 0 0 8 8l6-6m-4-12 6-6a6 6 0 0 1 8 8l-4 4" />,
  key: <>
    <path d="M14 5a9 9 0 0 1 8 13l13 13-4 4-4-4-3 3-4-4 3-3-6-6A9 9 0 1 1 14 5Z" />
    <circle cx="12" cy="13" r="2" />
  </>,
  package: <path d="M5 13h30v21H5zm0 0 4-7h22l4 7m-15-7v13m-6 7h12m-12 4h7" />,
  presentation: <path d="M5 6h30v21H5zm15 21v8m-7 0h14M11 21l5-6 4 3 7-7m-4 0h4v4" />,
  calendar: <>
    <rect x="5" y="8" width="30" height="27" rx="4" />
    <path d="M12 5v7m16-7v7M5 16h30m-23 7h4m4 0h4m4 0h2m-18 6h4m4 0h4" />
  </>,
  image: <>
    <rect x="5" y="7" width="30" height="26" rx="3" />
    <circle cx="27" cy="15" r="3" />
    <path d="m6 29 9-10 7 7 4-4 8 7" />
  </>,
} satisfies Record<string, ReactNode>

/** A purpose glyph recognized by the shared Skill artwork. */
export type MarketSkillGlyphId = keyof typeof skillGlyphs

/** Render the outline paths inside a Skill cover.
 * @param props Purpose glyph to draw.
 * @returns SVG paths positioned within the tile's internal canvas.
 */
export function MarketSkillGlyph({ glyph }: { glyph: MarketSkillGlyphId }): ReactNode {
  return skillGlyphs[glyph]
}
