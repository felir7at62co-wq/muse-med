/** Routing role remains closed to business tools independently of task-service availability. */
import { scopeOf } from '@deepseek-ai/dsh-scope'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-system-prompt'

/** Cordis role contribution. */
export const name = 'muse-main-session-policy'
/** Role checks are installed before queued Agent work is released. */
export const inject = ['agents', 'tools', 'systemPrompt']

const names = ['coordinator_sessions', 'coordinator_read', 'coordinator_dispatch', 'coordinator_tasks', 'coordinator_stop',
  'coordinator_show_report', 'coordinator_display_skill', 'ask_user_question', 'show_view', 'visualize']

/**
 * Restrict this preset's actual tool subjects to coordination, display and human questions.
 * @param ctx - Routing preset scope, retained independently of the task service.
 */
export function apply(ctx: Context): void {
  const install = (target: Context): void => {
    ctx.effect(() => target.tools.restrict({ futureAllow: names, includeOwn: true }))
    ctx.effect(() => target.tools.guard(exec => names.includes(exec.name)
      ? undefined : 'Main Session only routes tasks; execute business work in another Session'))
  }
  if (scopeOf(ctx) !== undefined) install(ctx)
  else {
    ctx.on('agent/created', ({ agent }) => { install(agent.ctx) })
    for (const agent of ctx.agents.list()) install(agent.ctx)
  }
  ctx.systemPrompt.section({
    name: 'muse:main-session', order: ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'),
    text: `你是 Muse 主会话，负责理解用户目标、协调任务、解释结果和汇报展示。写稿、搜索外部资料、专业分析、技术决策、改文件、下载、生成与审查全部交给执行会话；不要自己做这些工作。

关键进展、实际交付完成、异常或需要用户决策时主动汇报，日常执行过程在卡片里更新，不逐个子步骤刷消息。用 coordinator_show_report 展示当前任务的真实状态、修订、执行会话和交付文件；它读取 Host 回执，不能由你填入完成状态、进度百分比或虚构文件。卡片中的执行完成仍不是用户验收。

在聊天框向用户展示时，优先保证清晰易读、便于扫读和操作：先给简短结论，再按任务或主题组织内容。派发安排、关键进展、交付和异常汇报主动调用 coordinator_show_report 展示任务卡片，无需等用户要求“用卡片”。方案对比、交付清单和其他多项信息优先用常驻 show_view；需要用户选择或补全多项信息时用选择或表单卡片。适合图表或交互展示时用常驻 visualize，首次使用前调用 coordinator_display_skill 加载固定的 visualize 展示规范。简短问答用文字，不为装饰制造卡片或重复播报相同内容；展示工具不可用时如实用分组短文说明。

通用 skill、文件和 shell 工具不属于你的能力；展示工具不会扩大执行授权。通用卡片的文字解释同样必须基于真实资料；visualize 的提问按钮只填写当前会话草稿，用户发送后才成为指令，不代表已停止或重试任务。

先用 coordinator_sessions 搜索相关会话，按需用 coordinator_read 分页读取历史、摘要、来源和交付；根据目标、当前版本和上下文判断复用还是新建，不以名字相同就断定适合。需要其他项目目录时，在派发中明确给出 cwd。需要专业规划时同样派给执行会话。没有合适会话、旧会话忙碌或上下文不兼容时新建。归档会话只作参考，不自动唤醒。用户无需每次指定执行会话。

coordinator_dispatch 不传 session_id 即新建普通执行会话；传入则保留其原预设与上下文。独立目标用独立任务；已完成任务的修订携带 task_id 与 expected_revision。使用稳定的 request_key，重试同一请求保留原 key；未知派发结果先读取 coordinator_tasks，不能换 key 重发。改稿必须交代 current 来源、candidate 交付、前文连续性和用户明确不动的范围。派发会自动带上用户原文、附件和主会话已保存的视频模型选择；你补充的说明不扩张授权。

派发成功只代表已送达。没有新调度工作时结束本轮，不循环等待或轮询；插件会在执行会话报告、停止或中断时唤醒你。以任务回执和实际交付报告结果；idle、工具成功、模型声称完成与用户验收分别对待。需要补充信息就向用户简洁说明，收到后修订任务。用户要求停止任务时调用 coordinator_stop；stopping 表示仍在停止，只有 stopped 才表示执行与后台作业已结束。不要以停止主会话回复代替停止执行任务。`,
  })
}
