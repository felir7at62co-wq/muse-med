/** Copy dictionaries for the Jubian token Settings section. */

/**
 * Simplified Chinese dictionary and key source of truth.
 *
 * The credential reference itself (`JUBIANAI_ADMIN_TOKEN`) and a provider's
 * source id (`env`, `file`, `user-env`) are code tokens the Host reports
 * verbatim: they appear inside a sentence but are never translated, and no key
 * here carries a translated copy of one.
 */
export const zh = {
  nav: '剧变',
  loading: '正在读取令牌状态…',
  fieldLabel: '剧变 Admin Token',
  statusConfigured: '已配置',
  statusMissing: '未配置',
  statusLabel: '状态',
  sourceNamed: '来源：{source}',
  readOnly: '当前部署用只读来源提供这个令牌（例如进程环境变量），无法在这里写入。',
  hint: '在剧变工作台登录后取得 Admin Token，粘贴到这里保存。它写入宿主凭据服务，引用名 JUBIANAI_ADMIN_TOKEN，页面不会再读回它的值。',
  save: '保存',
  saving: '正在保存…',
  clear: '清除',
  saved: '已保存。',
  cleared: '已清除。',
  failed: '操作失败：{reason}',
} satisfies Record<string, string>

/** Jubian token section locale key union. */
export type JubianLocaleKey = keyof typeof zh

/** English dictionary checked against the Chinese key set. */
export const en = {
  nav: 'Jubian',
  loading: 'Reading the token status…',
  fieldLabel: 'Jubian admin token',
  statusConfigured: 'Configured',
  statusMissing: 'Not configured',
  statusLabel: 'Status',
  sourceNamed: 'Source: {source}',
  readOnly: 'This deployment supplies the token from a read-only source (a process environment variable, for example); it cannot be written here.',
  hint: 'Sign in to the Jubian workbench and take its admin token, then paste it here and save. It is written to the host credential service under JUBIANAI_ADMIN_TOKEN, and this page never reads its value back.',
  save: 'Save',
  saving: 'Saving…',
  clear: 'Clear',
  saved: 'Saved.',
  cleared: 'Cleared.',
  failed: 'Could not complete: {reason}',
} satisfies Record<JubianLocaleKey, string>
