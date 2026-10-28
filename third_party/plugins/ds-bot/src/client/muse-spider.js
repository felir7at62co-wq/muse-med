import bodyImage from './muse-spider-art.js'

const image = `<image href="${bodyImage}" x="-30.2083" y="-4.5833" width="160" height="106.6667"/>`
const imageDefinition = `<image id="%MASK%spider-image" href="${bodyImage}" x="-30.2083" y="-4.5833" width="160" height="106.6667"/>`

// The body image keeps the approved design; the eyes use the character animation system.
export const SPIDER_SHAPE = {
  label: 'Muse Spider',
  size: 100,
  solidEyes: true,
  pointerEventsNone: true,
  flatPath: 'M3 59Q3 46 16 42Q22 22 46 17Q71 12 86 35Q97 40 97 62Q98 79 85 81Q76 87 68 82Q56 87 45 83Q32 87 25 82Q10 82 3 70Z',
  eyes: [[54.6, 47.4, 16.8, 17.7, -8], [74.3, 45.9, 15, 18.3, -8]],
  body: paint => paint === 'var(--bt-ink-violet)' ? image : `<defs>${imageDefinition}<mask id="%MASK%spider" style="mask-type:alpha" x="-100" y="-100" width="300" height="300"><use href="#%MASK%spider-image"/></mask><filter id="%MASK%gray" color-interpolation-filters="sRGB"><feColorMatrix type="saturate" values="0"/></filter></defs><g style="isolation:isolate;pointer-events:none"><rect x="0" y="0" width="100" height="100" fill="${paint}" mask="url(#%MASK%spider)"/><use href="#%MASK%spider-image" filter="url(#%MASK%gray)" style="mix-blend-mode:multiply;opacity:.25"/><use href="#%MASK%spider-image" filter="url(#%MASK%gray)" style="mix-blend-mode:screen;opacity:.12"/></g>`,
}
