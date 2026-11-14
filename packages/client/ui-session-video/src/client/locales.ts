/** Copy owned by the conversation video shelf. */
/** Namespace for all Session video product copy. */
export const NS = 'sessionVideo'
/** Simplified Chinese source dictionary. */
export const zh = {
  settingTitle: '视频气泡与轨道',
  settingDescription: '启用 Muse 气泡、镜头轨道和视频收纳动效；关闭后立即恢复原有界面',
  settingError: '设置未能生效，请重试',
  brand: 'Muse', library: '会话视频', empty: '这个会话还没有视频', loading: '正在读取视频…',
  unavailable: '视频暂时无法播放', retry: '重试', play: '播放', pause: '暂停',
  zoomControls: '视频轨道缩放', zoomIn: '放大视频轨道', zoomOut: '缩小视频轨道', zoomValue: '轨道缩放 {percent}%',
  timeline: '视频镜头轨道', playhead: '播放位置', detecting: '正在识别镜头…',
  detectionFailed: '无法识别镜头，可重试', redo: '重做这个镜头',
  shot: '镜头 {index} · {start}–{end}', source: '切换视频：{name}',
  redoPrompt: '请重做这个镜头：{name}。源视频：{source}；镜头 ID：{id}；原视频范围：{start}–{end} 秒。保留前后镜头的剧情与人物连续性。具体调整：',
  selectShotToRedo: '先在下方轨道选择一个镜头',
  collected: '已收纳到 Muse，点击查看', incomplete: '部分视频暂未读取完整',
} as const
/** Typed keys for every dictionary registered by this plugin. */
export type VideoKey = keyof typeof zh
/** English fallback dictionary. */
export const en: Record<VideoKey, string> = {
  settingTitle: 'Video bubble and timeline',
  settingDescription: 'Enable the Muse bubble, shot timeline and video collection animation. Turn off to restore the original interface immediately.',
  settingError: 'The setting could not be applied. Please retry.',
  brand: 'Muse', library: 'Conversation videos', empty: 'No videos in this conversation yet', loading: 'Loading video…',
  unavailable: 'Video is unavailable', retry: 'Retry', play: 'Play', pause: 'Pause',
  zoomControls: 'Timeline zoom', zoomIn: 'Zoom in timeline', zoomOut: 'Zoom out timeline', zoomValue: 'Timeline zoom {percent}%',
  timeline: 'Video shots', playhead: 'Playback position', detecting: 'Detecting shots…',
  detectionFailed: 'Shot detection failed. You can retry.', redo: 'Regenerate this shot',
  shot: 'Shot {index} · {start}–{end}', source: 'Switch video: {name}',
  redoPrompt: 'Regenerate this shot: {name}. Source: {source}; shot ID: {id}; original range: {start}–{end} seconds. Preserve story and character continuity with adjacent shots. Changes: ',
  selectShotToRedo: 'Select a shot in the timeline first',
  collected: 'Stored in Muse. Click to view.', incomplete: 'Some videos could not be read completely',
}
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { /** Conversation video shelf copy. */ sessionVideo: VideoKey }
}

/** English fallbacks for Japanese, Spanish, French, German, Russian and Portuguese. */
export const ja = en, es = en, fr = en, de = en, ru = en, pt = en
