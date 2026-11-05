/** Video preview copy owned by the renderer. */
export const en = {
  title: 'Video', loading: 'Loading video', player: 'Video player',
  failed: 'This video cannot be played. Its encoding may be unsupported, or the computer connection may be unavailable.',
  unavailable: 'Video preview is unavailable on this connection.',
} as const

/** Chinese video preview dictionary. */
export const zh = {
  title: '视频', loading: '正在载入视频', player: '视频播放器',
  failed: '无法播放视频，可能不支持该编码，或电脑连接已断开',
  unavailable: '当前连接无法预览视频',
} as const

/** Keys accepted by this renderer's typed dictionary. */
export type VideoPreviewKey = keyof typeof en

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Video preview labels and recoverable failures. */
    sidebarVideo: VideoPreviewKey
  }
}

/** English fallback for Japanese interface copy. */
export const ja = {
  'title': en['title'],
  'loading': en['loading'],
  'player': en['player'],
  'failed': en['failed'],
  'unavailable': en['unavailable'],
} satisfies Record<keyof typeof en, string>

/** English fallback for Spanish interface copy. */
export const es = {
  'title': en['title'],
  'loading': en['loading'],
  'player': en['player'],
  'failed': en['failed'],
  'unavailable': en['unavailable'],
} satisfies Record<keyof typeof en, string>

/** English fallback for French interface copy. */
export const fr = {
  'title': en['title'],
  'loading': en['loading'],
  'player': en['player'],
  'failed': en['failed'],
  'unavailable': en['unavailable'],
} satisfies Record<keyof typeof en, string>

/** English fallback for German interface copy. */
export const de = {
  'title': en['title'],
  'loading': en['loading'],
  'player': en['player'],
  'failed': en['failed'],
  'unavailable': en['unavailable'],
} satisfies Record<keyof typeof en, string>

/** English fallback for Russian interface copy. */
export const ru = {
  'title': en['title'],
  'loading': en['loading'],
  'player': en['player'],
  'failed': en['failed'],
  'unavailable': en['unavailable'],
} satisfies Record<keyof typeof en, string>

/** English fallback for Portuguese interface copy. */
export const pt = {
  'title': en['title'],
  'loading': en['loading'],
  'player': en['player'],
  'failed': en['failed'],
  'unavailable': en['unavailable'],
} satisfies Record<keyof typeof en, string>
