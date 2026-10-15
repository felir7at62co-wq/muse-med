/** Single-agent editing tools and general Harness guidance. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-host-webserver'

/** Cordis plugin identity. */
export const name = 'muse-editing-policy'
/** Scoped tool and system-prompt registries. */
export const inject = ['tools', 'systemPrompt']

/** Delegation, team orchestration and managed acceptance are unavailable in editing. */
export const EDITING_UNAVAILABLE_TOOL_NAMES: readonly string[] = [
  'subagent', 'subagent_fork', 'subagent_codex', 'subagent_claude_code',
  'list_subagent_models',
  'spawn_teammate', 'send_message', 'interrupt_agent', 'list_agents', 'wait_agent',
  'team_task_create', 'team_task_get', 'team_task_list', 'team_task_update',
  'workflow', 'ralph', 'screenplay_project',
]
const unavailable = new Set(EDITING_UNAVAILABLE_TOOL_NAMES)

/**
 * Hide unsupported editing tools and their guidance, including later registrations.
 * @param ctx - Editing preset's standing scope.
 */
export function apply(ctx: Context): void {
  ctx.tools.restrict({ futureDeny: EDITING_UNAVAILABLE_TOOL_NAMES, includeOwn: true })
  ctx.systemPrompt.section({
    name: 'editing:file-versions',
    order: ctx.systemPrompt.getSectionOrder('FILE_REFERENCE'),
    text: 'If a file operation returns FS_STALE_VERSION, read the current file, rebase your intended change onto the new content, and retry.',
  })
  ctx.inject(['webServer'], (gui) => {
    gui.systemPrompt.section({
      name: 'editing:gui',
      order: gui.systemPrompt.getSectionOrder('WEB_SURFACE'),
      text: () => `用户正在使用 Muse 桌面 GUI，当前本机 GUI 地址为 http://127.0.0.1:${gui.webServer.port}。`
        + '用户未另指目标时，“这个页面／GUI／应用”指当前 Muse。你没有隐式读取到 DOM、路由或截图，需要时使用实际可用的读取工具。'
        + '客户端修改后重新构建受影响产物，按当前运行方式刷新或重启，并验证现有 GUI；未核实构建监听时不承诺自动更新。'
        + '另起服务器不会更新当前 GUI，除非用户要求，不启动替代服务器。当前工作目录与应用安装目录不同，以工作目录提示为准。',
    })
  })
  ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const assembled = await next()
    return {
      ...assembled,
      sections: assembled.sections.filter(section => !section.name.startsWith('team:')
        && !section.name.startsWith('subagent:')
        && (!section.name.startsWith('tool:') || !unavailable.has(section.name.slice(5)))),
      contexts: assembled.contexts.filter(section => !section.name.startsWith('team:')
        && !section.name.startsWith('subagent:')),
    }
  })
}
