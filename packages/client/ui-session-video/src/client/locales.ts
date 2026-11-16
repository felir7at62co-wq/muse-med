/** Copy owned by the conversation video workspace. */
/** Namespace for all Session video product copy. */
export const NS = 'sessionVideo'
/** Simplified Chinese source dictionary. */
export const zh = {
  settingTitle: 'Muse 视频工作区',
  settingDescription: '在当前会话选择集数、视频和画面片段，停靠或浮动预览，并通过聊天审片和修改',
  settingError: '设置未能生效，请重试',
  brand: 'Muse', library: '会话视频', empty: '这个会话还没有视频', loading: '正在读取视频…',
  unavailable: '视频暂时无法播放', retry: '重试', play: '播放', pause: '暂停',
  zoomControls: '视频轨道缩放', zoomIn: '放大视频轨道', zoomOut: '缩小视频轨道', zoomValue: '轨道缩放 {percent}%',
  timeline: '画面片段轨道', playhead: '播放位置', detecting: '正在识别画面片段…',
  detectionFailed: '无法识别画面片段，可重试', redo: '修改这个片段',
  shot: '画面片段 {index} · {start}–{end}', source: '切换视频：{name}',
  redoPrompt: '请修改这个画面片段：{name}。源视频：{source}；片段 ID：{id}；原视频范围：{start}–{end} 秒。保留原版，以及未涉及的剧情、台词和人物连续性。具体调整：',
  selectShotToRedo: '先在下方轨道选择一个画面片段',
  collected: '已收纳到 Muse，点击查看', incomplete: '部分视频信息暂未读取完整',
  picker: '选择视频', chooseEpisode: '选择集数', allEpisodes: '全部集数', unassigned: '未分集',
  episodeLabel: '第 {episode} 集', videoLabel: '视频包 {index}', selectVideo: '选择视频：{name}',
  emptyEpisode: '当前范围还没有视频', float: '浮动视频预览', dock: '停靠视频预览',
  addSelectedShot: '加入所选片段', selectedScope: '所选视频与片段', selectedCount: '已选 {count} 项',
  clearSelection: '清空选择', targetRemove: '移除选择：{name}', reviewSelected: '请 Agent 看看',
  prepareEdit: '准备修改要求', prepareRegenerate: '准备重新生成要求',
  noSelection: '先选择需要查看的视频或画面片段',
  selectionStale: '部分所选视频已变化或不可用，请重新选择',
  navigationStale: '这个视频或片段已变化，请重新选择',
  navigationForeign: '这个视频属于另一个会话，请回到原会话查看',
  inventoryFailed: '视频列表暂时无法读取，请重试',
  draftRefused: '输入内容已变化，请重试', draftReady: '要求已加入当前对话',
  referenceInvalid: '这个视频引用无效，请重新选择',
  referenceStale: '所选视频已变化或无法播放，请刷新后重新选择',
  selectedSegmentReference: '{name} · {start}–{end} 秒',
  selectionHeading: '所选视频：',
  requestReview: '请让 Agent 只读审阅这些视频，指出问题和修改建议，并附上画面定位。先别修改或生成，等我的要求。',
  requestEdit: '请按我的要求修改本条消息中选定的视频或画面片段，只调整涉及的部分，保留原版和未涉及的内容。具体要求：',
  requestRegenerate: '请按我的要求重新生成本条消息中选定的视频或画面片段，核对来源、对应视频卡和费用，保留原版，不扩大范围。具体要求：',
} as const
/** Typed keys for every dictionary registered by this plugin. */
export type VideoKey = keyof typeof zh
/** English fallback dictionary. */
export const en: Record<VideoKey, string> = {
  settingTitle: 'Muse video workspace',
  settingDescription: 'Choose episodes, videos and visual segments in this conversation, dock or float the preview, and review or edit through chat.',
  settingError: 'The setting could not be applied. Please retry.',
  brand: 'Muse', library: 'Conversation videos', empty: 'No videos in this conversation yet', loading: 'Loading video…',
  unavailable: 'Video is unavailable', retry: 'Retry', play: 'Play', pause: 'Pause',
  zoomControls: 'Timeline zoom', zoomIn: 'Zoom in timeline', zoomOut: 'Zoom out timeline', zoomValue: 'Timeline zoom {percent}%',
  timeline: 'Visual segment timeline', playhead: 'Playback position', detecting: 'Detecting visual segments…',
  detectionFailed: 'Visual segment detection failed. You can retry.', redo: 'Edit this segment',
  shot: 'Video segment {index} · {start}–{end}', source: 'Switch video: {name}',
  redoPrompt: 'Edit this visual segment: {name}. Source: {source}; segment ID: {id}; original range: {start}–{end} seconds. Keep the original version and preserve unaffected story, dialogue and character continuity. Changes: ',
  selectShotToRedo: 'Select a visual segment in the timeline first',
  collected: 'Stored in Muse. Click to view.', incomplete: 'Some video information could not be read completely',
  picker: 'Video selection', chooseEpisode: 'Choose episode', allEpisodes: 'All episodes', unassigned: 'Unassigned',
  episodeLabel: 'Episode {episode}', videoLabel: 'Video package {index}', selectVideo: 'Select video: {name}',
  emptyEpisode: 'No videos in this selection yet', float: 'Float video preview', dock: 'Dock video preview',
  addSelectedShot: 'Add selected segment', selectedScope: 'Selected videos and segments', selectedCount: '{count} selected',
  clearSelection: 'Clear selection', targetRemove: 'Target remove: {name}', reviewSelected: 'Review selected videos',
  prepareEdit: 'Prepare edit', prepareRegenerate: 'Prepare regeneration',
  noSelection: 'Select videos or visual segments first.',
  selectionStale: 'Some selected videos changed or became unavailable. Please select them again.',
  navigationStale: 'This video or segment changed. Please select it again.',
  navigationForeign: 'This video belongs to another conversation. Open it there to review.',
  inventoryFailed: 'The video list could not be loaded. Please retry.',
  draftRefused: 'The input changed. Please retry.', draftReady: 'The request was added to this conversation',
  referenceInvalid: 'This video reference is invalid. Please select it again.',
  referenceStale: 'The selected video changed or cannot be played. Refresh and select it again.',
  selectedSegmentReference: '{name} · {start}–{end} s',
  selectionHeading: 'Selected videos:',
  requestReview: 'Ask an Agent for a read-only review of these videos, with issues, suggested fixes and source links. Wait for my changes before editing or generating.',
  requestEdit: 'Apply my requested changes to the videos or visual segments selected in this message. Change only the requested parts, retaining the original version and unaffected content. Requested changes: ',
  requestRegenerate: 'Regenerate the videos or visual segments selected in this message according to my request. Check the sources, corresponding video cards and cost; retain the original version and do not expand the scope. Generation requirements: ',
}
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { /** Conversation video workspace copy. */ sessionVideo: VideoKey }
}

/** English fallbacks for Japanese, Spanish, French, German, Russian and Portuguese. */
export const ja = en, es = en, fr = en, de = en, ru = en, pt = en
