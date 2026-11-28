/**
 * Let an unattended production run tell a person when it really needs one, through a saved DSH-IM delivery target.
 * The agent decides when to call `muse_notify`; the Host only adds a last-resort notice for tasks the coordinator
 * marked for attention that nobody was told about.
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

/** Cordis plugin identity. */
export const name = 'muse-unattended-notify'
/** Tool registration needs the Host tool registry. */
export const inject = ['tools']

/** Saved DSH-IM delivery target and fallback timing. */
export interface Config {
  /** Bot ID copied from Settings → IM bots → bot settings. Without it nothing is registered. */
  botId?: string
  /** Saved delivery target ID under that bot, e.g. a Feishu group for production alerts. */
  targetId?: string
  /** Minutes after an attention mark before the Host sends its own notice when the agent sent none. */
  fallbackMinutes?: number
}

/** Validated plugin configuration. */
export const Config: z<Config> = z.object({
  botId: z.string(),
  targetId: z.string(),
  fallbackMinutes: z.natural().min(1).default(15),
})

/** Same-Host DSH-IM delivery service, read structurally so Muse keeps no build dependency on the IM package. */
interface DshImDelivery {
  send(botId: string, targetId: string, text: string,
    options?: { signal?: AbortSignal; format?: 'plain' | 'markdown' }): Promise<{ sent?: unknown }>
}

/** The few coordinator task fields the fallback reads, kept structural to avoid a project reference. */
export interface CoordinationTask {
  readonly id: string
  readonly title: string
  readonly attempts: readonly {
    readonly sessionId: string
    readonly attention?: {
      readonly reason: string
      readonly at: number
    } | undefined
  }[]
}

/** Minimal coordinator surface used for the fallback notice. */
interface CoordinatorView {
  readonly mode: { readonly unattended: boolean }
  list(sessionId: never): readonly CoordinationTask[]
  watchMain(signal: AbortSignal): AsyncIterable<string | null>
  watch(sessionId: never, signal: AbortSignal): AsyncIterable<readonly CoordinationTask[]>
}

const DESCRIPTION = '无人值守制作中，确实需要人处理时，通过已配置的 IM 机器人（如飞书群）通知负责人。'
  + '先自己解决：等待后重试、先查原任务再接续（不重复扣费）、换一种做法、局部修复或在预算内只重做受影响的包、先继续其他集。'
  + '只有这些情况才通知：登录或账号失效、项目预算用完、缺少文件或权限、同一问题多次修复仍失败、需要人做取舍。'
  + '消息写清剧名、集号、卡在哪一步、已经尝试过什么、需要人做什么；每个问题只发一次，不用于普通进度汇报（用户要求时除外）。'
  + '通知后继续推进不受影响的工作。'

/**
 * Format one notice for a person reading it in a chat app.
 * @param title - One-line headline.
 * @param body - Markdown details.
 * @param session - Originating Session, when known.
 * @returns Markdown text.
 */
export function formatNotice(title: string, body: string, session?: string): string {
  return `**【Muse 无人值守】${title.trim()}**\n\n${body.trim()}${session === undefined ? '' : `\n\n会话：\`${session}\``}`
}

/** One coordinator attention mark that may need a notice. */
export interface AttentionNotice {
  readonly key: string
  readonly title: string
  readonly sessionId: string
  readonly reason: string
  readonly at: number
}

/**
 * Pick tasks whose latest revision the unattended policy marked for attention.
 * @param tasks - Current task snapshot of one Main Session.
 * @returns One entry per marked revision with a stable key.
 */
export function attentionTasks(tasks: readonly CoordinationTask[]): AttentionNotice[] {
  return tasks.flatMap((task) => {
    const latest = task.attempts.at(-1)
    if (latest?.attention === undefined) return []
    return [{ key: `${task.id}:${latest.attention.at}`, title: task.title, sessionId: latest.sessionId,
      reason: latest.attention.reason, at: latest.attention.at }]
  })
}

/**
 * Register `muse_notify` and the fallback notice when a delivery target is configured.
 * @param ctx - Host scope that also mounts the session coordinator.
 * @param config - Saved delivery target; absent target leaves the plugin inactive.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const botId = config.botId?.trim(), targetId = config.targetId?.trim()
  if (!botId || !targetId) return
  const fallbackMs = (config.fallbackMinutes ?? 15) * 60_000
  /** Last notice time per originating Session, so the fallback does not repeat what the agent already said. */
  const notified = new Map<string, number>()

  const deliver = async (text: string, signal?: AbortSignal): Promise<void> => {
    const service = (ctx.get as (name: string) => unknown)('dshIm') as DshImDelivery | undefined
    if (service === undefined || typeof service.send !== 'function') {
      throw new Error('MUSE_NOTIFY_UNAVAILABLE: 当前 Muse 未加载 IM 机器人，或机器人未在线。请在设置 → IM 机器人中确认后重试。')
    }
    const result = await service.send(botId, targetId, text, { format: 'markdown', ...(signal === undefined ? {} : { signal }) })
    if (result.sent !== true) throw new Error('MUSE_NOTIFY_FAILED: IM 机器人没有返回发送成功。')
  }

  ctx.tools.register(defineTool({
    name: 'muse_notify',
    description: DESCRIPTION,
    parameters: {
      title: { type: 'string', required: true, description: '一句话标题，例如「第12集卡在剧变登录失效」。' },
      message: { type: 'string', required: true,
        description: 'Markdown 正文：剧名、集号、卡住的步骤、原始报错要点、已尝试的处理、需要人做什么。' },
    },
    output: { schema: { type: 'string' }, render: (_args, text) => [{ type: 'text', text }] },
    async execute(args, exec) {
      const session = exec.agent?.session.id
      await deliver(formatNotice(args.title, args.message, session), exec.signal)
      if (session !== undefined) notified.set(session, Date.now())
      return '已通知负责人。继续推进不受影响的工作；对方处理后会在会话或 IM 中回复。'
    },
  }))

  ctx.inject(['sessionCoordinator'], (scope) => {
    const coordinator = (scope.get as (name: string) => unknown)('sessionCoordinator') as CoordinatorView
    if (!coordinator.mode.unattended) return
    scope.effect(() => {
      const owner = new AbortController()
      const handled = new Set<string>()
      const timers = new Set<ReturnType<typeof setTimeout>>()
      const watching = new Set<string>()
      const consider = (main: string, tasks: readonly CoordinationTask[]): void => {
        for (const task of attentionTasks(tasks)) {
          if (handled.has(task.key)) continue
          handled.add(task.key)
          const timer = setTimeout(() => {
            timers.delete(timer)
            // Recovery may have replaced this revision while the fallback was waiting.
            const current = attentionTasks(coordinator.list(main as never)).find(notice => notice.key === task.key)
            if (current === undefined) return
            // The agent's own notice shortly before or after the mark already reached a person.
            if ((notified.get(current.sessionId) ?? 0) >= current.at - fallbackMs) return
            const minutes = Math.round(fallbackMs / 60_000)
            void deliver(formatNotice(`任务需要人处理：${current.title}`,
              `无人值守协调器已停止自动重派这项任务，${minutes} 分钟内执行会话没有发出通知。\n\n原因：${current.reason}\n\n`
              + '请打开 Muse 查看该会话，处理后在会话中回复，或重新派发。', current.sessionId), owner.signal)
              .then(() => { notified.set(current.sessionId, Date.now()) })
              .catch((error: unknown) => { ctx.logger('muse-unattended-notify').warn('Fallback notice failed', error) })
          }, Math.max(0, task.at + fallbackMs - Date.now()))
          timers.add(timer)
        }
      }
      const follow = async (main: string): Promise<void> => {
        for await (const tasks of coordinator.watch(main as never, owner.signal)) consider(main, tasks)
      }
      void (async () => {
        for await (const main of coordinator.watchMain(owner.signal)) {
          if (main === null || watching.has(main)) continue
          watching.add(main)
          void follow(main).catch(() => { watching.delete(main) })
        }
      })().catch(() => {})
      return () => {
        owner.abort()
        for (const timer of timers) clearTimeout(timer)
      }
    })
  })
}
