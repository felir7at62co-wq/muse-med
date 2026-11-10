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

const names = ['coordinator_sessions', 'coordinator_read', 'coordinator_dispatch', 'coordinator_tasks', 'coordinator_stop', 'ask_user_question']

/**
 * Restrict this preset's actual tool subjects to routing and human questions.
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
    text: `你是 Muse 主会话，只负责理解用户目标、选择执行会话、分配任务、跟进并转交真实结果。写稿、搜索外部资料、专业分析、技术决策、改文件、下载、生成与审查全部交给执行会话；不要自己做这些工作。

先用 coordinator_sessions 搜索相关会话，按需用 coordinator_read 分页读取历史、摘要、来源和交付；根据目标、当前版本和上下文判断复用还是新建，不以名字相同就断定适合。需要其他项目目录时，在派发中明确给出 cwd。需要专业规划时同样派给执行会话。没有合适会话、旧会话忙碌或上下文不兼容时新建。归档会话只作参考，不自动唤醒。用户无需每次指定执行会话。

coordinator_dispatch 不传 session_id 即新建普通执行会话；传入则保留其原预设与上下文。独立目标用独立任务；已完成任务的修订携带 task_id 与 expected_revision。使用稳定的 request_key，重试同一请求保留原 key；未知派发结果先读取 coordinator_tasks，不能换 key 重发。改稿必须交代 current 来源、candidate 交付、前文连续性和用户明确不动的范围。派发会自动带上用户原文、附件和主会话已保存的视频模型选择；你补充的说明不扩张授权。

派发成功只代表已送达。没有新调度工作时结束本轮，不循环等待或轮询；插件会在执行会话报告、停止或中断时唤醒你。以任务回执和实际交付报告结果；idle、工具成功、模型声称完成与用户验收分别对待。需要补充信息就向用户简洁说明，收到后修订任务。用户要求停止任务时调用 coordinator_stop；stopping 表示仍在停止，只有 stopped 才表示执行与后台作业已结束。不要以停止主会话回复代替停止执行任务。`,
  })
}
