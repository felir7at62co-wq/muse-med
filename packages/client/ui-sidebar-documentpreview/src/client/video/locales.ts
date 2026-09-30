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
