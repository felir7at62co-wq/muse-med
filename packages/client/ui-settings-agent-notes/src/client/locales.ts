/** Copy dictionaries for the Agent Notes Settings section. */

/**
 * Simplified Chinese dictionary and key source of truth.
 *
 * The notes themselves are user data: a title, a status value, and a note id
 * are never localized, and no key here describes one. The Markdown chrome the
 * section forwards to the renderer (`markdown.footnotes`) is owned by the
 * shared `common` namespace, which the lookup chain consults after this one.
 */
export const zh = {
  nav: 'Agent 笔记',
  loading: '正在读取笔记…',
  error: '暂时无法读取笔记。',
  retry: '重试',
  empty: '这个笔记目录里还没有 markdown 笔记。',
  emptySearch: '没有匹配的笔记。',
  rootLabel: '笔记目录',
  search: '搜索笔记',
  categoryOther: '未分类',
  countUnit: '篇',
  truncated: '这个目录里的笔记太多，只列出了前一部分。',
  openNamed: '打开 {title}',
  back: '返回列表',
  refresh: '重新读取',
  edit: '编辑',
  save: '保存',
  saving: '正在保存…',
  cancel: '取消',
  editorLabel: '笔记原文（markdown）',
  dirty: '有未保存的改动',
  saved: '已保存。',
  copy: '复制',
  copied: '已复制',
  savingFailed: '保存失败：{reason}',
  saveStale: '这篇笔记在别处被改过，已重新读取最新内容；请重新编辑后保存。',
  readFailed: '无法打开这篇笔记：{reason}',
  listFailed: '无法读取笔记目录：{reason}',
  missingRoot: '{root} 不存在；请创建它，或在配置里指向正确的笔记目录。',
} satisfies Record<string, string>

/** Agent Notes section locale key union. */
export type AgentNotesLocaleKey = keyof typeof zh

/** English dictionary checked against the Chinese key set. */
export const en = {
  nav: 'Agent notes',
  loading: 'Reading notes…',
  error: 'Notes are temporarily unavailable.',
  retry: 'Retry',
  empty: 'No markdown notes in this notes directory yet.',
  emptySearch: 'No matching notes.',
  rootLabel: 'Notes directory',
  search: 'Search notes',
  categoryOther: 'Uncategorized',
  countUnit: 'notes',
  truncated: 'This directory holds more notes than the listing cap; only the first part is shown.',
  openNamed: 'Open {title}',
  back: 'Back to list',
  refresh: 'Reload',
  edit: 'Edit',
  save: 'Save',
  saving: 'Saving…',
  cancel: 'Cancel',
  editorLabel: 'Note source (markdown)',
  dirty: 'Unsaved changes',
  saved: 'Saved.',
  copy: 'Copy',
  copied: 'Copied',
  savingFailed: 'Could not save: {reason}',
  saveStale: 'This note changed elsewhere, so the newest content was reloaded; edit it again and save.',
  readFailed: 'Could not open this note: {reason}',
  listFailed: 'Could not read the notes directory: {reason}',
  missingRoot: '{root} does not exist; create it, or point the configuration at the notes directory.',
} satisfies Record<AgentNotesLocaleKey, string>
