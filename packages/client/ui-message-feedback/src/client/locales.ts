/** `feedback` namespace dictionaries. */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'action.like': '好的回答',
  'action.likeActive': '取消标记',
  'action.dislike': '有问题的回答',
  'action.dislikeActive': '取消标记',
  'dialog.title': '提交反馈',
  'dialog.categories': '反馈分类',
  'dialog.detail': '反馈详情',
  'dialog.hint': '填写详情以帮助我们改进体验，提交内容会包括当前对话的日志',
  'dialog.museHint': '反馈将提交到 Muse 意见箱，附账号、分类及消息或任务标识',
  'dialog.museDiagnostics': '附带最近请求、相关回答的有限摘录；不含完整日志、工具参数与结果、思考内容或附件',
  'category.task-result': '任务结果',
  'category.instruction-following': '指令理解与遵循',
  'category.product-interaction': '产品功能与交互',
  'category.service-stability': '稳定性和速度',
  'category.resource-cost': '资源使用与费用',
  'category.security-privacy-permission': '安全隐私与权限',
  'category.other': '其他',
  'toast.recorded': '感谢你的反馈',
  'toast.museSubmitted': '已提交到 Muse 意见箱',
  'error.conflict': '这条反馈已在别处改动，已显示最新状态',
  'error.load': '反馈状态加载失败',
  'error.generic': '反馈保存失败',
  'error.noteTooLarge': '描述太长，请缩短后再提交',
  'error.museSignIn': '请先登录 Muse，再提交反馈；填写内容已保留',
  'error.museAccountChanged': 'Muse 账号已切换，请先在原账号意见箱查看提交结果，再决定是否重试',
  'error.museUnconfirmed': '尚未确认反馈是否入箱，请先查看 Muse 意见箱再决定是否重试',
  'error.museRejected': 'Muse 意见箱未接受这条反馈，填写内容已保留',
  'error.museRateLimited': '提交过于频繁，请稍后重试；填写内容已保留',
  'error.museUnavailable': 'Muse 意见箱暂时不可用，填写内容已保留',
  'error.museInvalidInput': '请检查反馈内容后重新提交，填写内容已保留',
} satisfies Record<string, string>

/** The feedback namespace key union. */
export type MessageFeedbackKey = keyof typeof zh

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The feedback surface's copy: the message controls, the dialog, and the acknowledgement. */
    feedback: MessageFeedbackKey
  }
}

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'action.like': 'Good response',
  'action.likeActive': 'Remove rating',
  'action.dislike': 'Bad response',
  'action.dislikeActive': 'Remove rating',
  'dialog.title': 'Submit feedback',
  'dialog.categories': 'Feedback category',
  'dialog.detail': 'Feedback details',
  'dialog.hint': 'Add details to help us improve. Your submission will include the current conversation log.',
  'dialog.museHint': 'Feedback goes to the Muse inbox with your account, category, and message or task identifier.',
  'dialog.museDiagnostics': 'Include bounded excerpts of the recent request and related answer; excludes full logs, tool arguments and results, thinking, and attachments.',
  'category.task-result': 'Task result',
  'category.instruction-following': 'Instruction understanding and following',
  'category.product-interaction': 'Product features and interaction',
  'category.service-stability': 'Stability and speed',
  'category.resource-cost': 'Resource usage and cost',
  'category.security-privacy-permission': 'Security, privacy, and permissions',
  'category.other': 'Other',
  'toast.recorded': 'Thanks for your feedback',
  'toast.museSubmitted': 'Submitted to the Muse inbox',
  'error.conflict': 'This feedback changed elsewhere; the latest state is shown',
  'error.load': 'Could not load feedback',
  'error.generic': 'Could not save feedback',
  'error.noteTooLarge': 'The description is too long; shorten it and submit again',
  'error.museSignIn': 'Sign in to Muse to submit feedback; your draft is retained',
  'error.museAccountChanged': 'The Muse account changed; check the original account’s inbox before deciding to retry',
  'error.museUnconfirmed': 'Delivery is unconfirmed; check the Muse inbox before deciding to retry',
  'error.museRejected': 'The Muse inbox did not accept this feedback; your draft is retained',
  'error.museRateLimited': 'Too many submissions; try later. Your draft is retained',
  'error.museUnavailable': 'The Muse inbox is unavailable; your draft is retained',
  'error.museInvalidInput': 'Check the feedback and submit again; your draft is retained',
} satisfies Record<MessageFeedbackKey, string>
