/** Copy owned by the Main Session task-card plugin. */
import type {} from '@deepseek-ai/dsh-client-ui-slots'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Main Session navigation, task cards and action feedback. */
    'muse-coordination': CoordinationKey
  }
}
/** Translation namespace shared by navigation, cards and root feedback. */
export const NS = 'muse-coordination'
/** English task labels. */
export const en = {
  reportTitle: 'Task report', reportRevision: 'Revision {revision}', reportLive: 'Current status', reportHistorical: 'Recorded receipt',
  reportUnavailable: 'Live status is unavailable; showing the recorded receipt', reportEmpty: 'No tasks in this report',
  reportPartial: 'Showing {count} of {total} tasks', reportInspect: 'Inspect tool call',
  mainEntry: 'Muse Main Session', failedMain: 'Could not open Main Session',
  stopRequested: 'Task stop requested', tasks: 'Execution tasks', open: 'Open execution chat', stop: 'Stop task', stopping: 'Stopping',
  failedRead: 'Could not read task status', failedStop: 'Could not stop this task', failedOpen: 'Could not open this file',
  attention: 'Inspect the execution chat before continuing this task', details: 'Diagnostics', files: 'Files', dispatching: 'Waiting to start', reconciling: 'Preparing reconciliation', accepted: 'Delivered', running: 'Running', finishing: 'Finishing',
  'needs-report': 'Awaiting report', interrupted: 'Needs attention', stopped: 'Stopped', completed: 'Worker completed',
  blocked: 'Blocked', 'needs-input': 'Needs your input', failed: 'Failed', receipt: 'Worker report; awaiting your acceptance',
} as const
/** Chinese task labels. */
export const zh: Record<keyof typeof en, string> = {
  reportTitle: '任务汇报', reportRevision: '第 {revision} 次执行', reportLive: '当前状态', reportHistorical: '历史回执',
  reportUnavailable: '暂时无法更新状态，显示汇报时保存的回执', reportEmpty: '本次汇报没有任务',
  reportPartial: '显示 {count} 项，共 {total} 项任务', reportInspect: '查看工具调用',
  mainEntry: 'Muse 主会话', failedMain: '未能打开主会话',
  stopRequested: '已请求停止任务', tasks: '执行任务', open: '打开执行会话', stop: '停止任务', stopping: '正在停止',
  failedRead: '暂时无法读取任务状态', failedStop: '未能停止此任务', failedOpen: '未能打开此文件',
  attention: '请先检查执行会话，再决定如何续做', details: '诊断信息', files: '交付文件', dispatching: '等待开始', reconciling: '准备核对', accepted: '已送达', running: '执行中', finishing: '等待执行结束',
  'needs-report': '待执行会话汇报', interrupted: '需要跟进', stopped: '已停止', completed: '执行会话已完成',
  blocked: '遇到阻碍', 'needs-input': '需要补充信息', failed: '执行失败', receipt: '执行会话回执，等待你验收',
}
/** Owned translation keys. */
export type CoordinationKey = keyof typeof en
