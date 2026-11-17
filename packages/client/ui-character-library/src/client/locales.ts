/** Character library navigation, browse and preview copy. */
export const zh = {
  title: '人物库', description: '浏览古装与都市人物参考，Muse 可在生成人物素材时查阅',
  readOnly: '只读参考库', all: '全部', ancient: '古装', urban: '都市', collection: '人物分类',
  search: '搜索人物特征、风格或标签', searchAction: '搜索', refresh: '刷新',
  unavailable: '人物库暂未连接，请联系管理员开通访问',
  failed: '暂时无法读取人物库，请重试', empty: '没有找到符合条件的人物参考',
  retry: '重试', previous: '上一页', next: '下一页', close: '关闭',
  preview: '查看人物参考', previewFailed: '暂时无法查看此图片，请重试',
  imageFailed: '图片暂不可用',
  referenceOnly: '仅供创作参考，生成素材仍需按项目要求审核',
  count: '本页 {count} 项', loading: '正在读取人物库',
} as const
/** Typed keys shared by the character library dictionaries. */
export type CharacterLibraryKey = keyof typeof zh
/** English character library copy. */
export const en: Record<CharacterLibraryKey, string> = {
  title: 'Character library', description: 'Browse ancient and urban character references for Muse character generation',
  readOnly: 'Read-only references', all: 'All', ancient: 'Ancient', urban: 'Urban', collection: 'Character collection',
  search: 'Search appearance, style or tags', searchAction: 'Search', refresh: 'Refresh',
  unavailable: 'The character library is not connected. Ask your administrator to enable access.',
  failed: 'The character library could not be read. Try again.', empty: 'No matching character references',
  retry: 'Retry', previous: 'Previous', next: 'Next', close: 'Close',
  preview: 'View character reference', previewFailed: 'This image could not be opened. Try again.',
  imageFailed: 'Image unavailable',
  referenceOnly: 'For creative reference. Generated assets still require project review.',
  count: '{count} items on this page', loading: 'Reading character library',
}
