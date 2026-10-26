// Original code-native character, using DS Bot's existing paint, eye-mask and motion system.
export const SPIDER_SHAPE = {
  label: 'Muse Spider',
  size: 100,
  eyes: [[43, 51, 7, 13, -4], [61, 49, 7, 13, -4]],
  body: paint => `<g stroke="${paint}" stroke-width="7" stroke-linecap="round" stroke-linejoin="round" fill="none"><path d="M31 32 22 20 12 24M26 43 14 36 5 42M25 56 12 57 7 66M31 69 22 77 23 88M71 30 79 17 89 21M77 41 88 33 96 39M79 54 91 55 96 64M74 67 84 76 83 87"/></g><ellipse cx="51" cy="51" rx="29" ry="33" transform="rotate(-5 51 51)" fill="${paint}"/><path d="M77 36c7 19-1 39-20 46-14 4-26-3-31-14 9 9 22 11 33 4 14-8 19-22 18-36" fill="var(--bt-ink)" fill-opacity=".14"/><path d="M34 34c3-9 13-14 21-13-8 2-14 7-18 15-2 3-5 2-3-2" fill="var(--bt-card)" fill-opacity=".3"/>`,
}
