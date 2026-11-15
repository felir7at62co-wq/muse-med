/** Desktop-owned computer tools backed by the bundled Cua Driver executable. */
import type { Context, Fiber } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { ComputerUseProviderName } from '@deepseek-ai/dsh-computer-use/brand'
import * as McpClient from '@deepseek-ai/dsh-mcp-client'
import { createPhysicalInputMonitor } from './computer-input-monitor.ts'
import { createComputerStatePublisher, installComputerControl } from './computer-control.ts'
import type {} from '@deepseek-ai/dsh-computer-use'
import type {} from '@deepseek-ai/dsh-system-prompt'

/** Cordis plugin identity for Muse's bundled desktop controls. */
export const name = 'muse-computer-use'
/** Host registries required before publishing desktop tools and guidance. */
export const inject = ['computerUse', 'tools', 'systemPrompt']

/** Bundled executable location and bounded tool-call options. */
export interface Config {
  /** Executable supplied by the Desktop Host; no PATH lookup is required. */
  command: string
  /** Arguments passed without a shell; defaults to the driver's MCP entry. */
  args: string[]
  /** Per-call timeout in milliseconds; omission uses the shared client default. */
  toolCallTimeoutMs?: number
}

/** Validate executable configuration before reserving desktop ownership. */
export const Config: z<Partial<Config>, Config> = z.object({
  command: z.string().required().pattern(/[^\s]/u),
  args: z.array(String).default(['mcp']),
  toolCallTimeoutMs: z.number().min(1),
})

const GUIDANCE = [
  'For a task that operates this computer, load the basic tools in one tool_context call: {"operation":"load","tools":["mcp__muse-computer__list_windows","mcp__muse-computer__launch_app","mcp__muse-computer__get_window_state","mcp__muse-computer__click","mcp__muse-computer__type_text","mcp__muse-computer__press_key","mcp__muse-computer__verify_state","mcp__muse-computer__end_session"]}. Muse supplies these tools; do not ask the user to configure an external server. Reuse loaded definitions. Use tool_search only for an additional operation. Loading tools does not execute an action.',
  'Find an existing target with list_windows, whose records include the owning app; list_apps is not a prerequisite. If launch_app is needed, reuse its returned windows instead of rediscovering the app. Keep the chosen pid/window_id while that window remains valid. A failed input or UIA timeout is not a reason to launch another instance. For a large window, bound the accessibility walk with max_elements and max_depth; query narrows the returned rows but does not skip the walk.',
  'Read get_window_state for that exact pid/window_id. Read the structured snapshot_id and elements[].element_token, not only the numbered text tree. Prefer type_text with the fresh element_token and exact window; it focuses and types without a separate click. For pixel input, type_text with the exact window and screenshot-local x/y likewise focuses and types in one action. Use either target or legacy pid/window_id, not both. Never use targetless scope:"desktop" input for an app task: it writes to whichever app is foreground, possibly Muse. An action-scoped foreground click restores the previous foreground after it finishes; it does not establish focus for the next call. Bare element_index is insufficient without its matching snapshot_id and window. A newer snapshot invalidates old tokens.',
  'Start each input action with delivery_mode:"background". If the driver explicitly returns background_unavailable or fresh state proves a no-op, retry only that refused or verified-ineffective action once with delivery_mode:"foreground" and the same exact window. That action activates, acts and restores the previous foreground. This does not authorize bypassing permission denials or other refusals, and it does not authorize targetless desktop input. bring_to_front is not the normal recovery path.',
  'After a UIA timeout or busy provider, inspect the same window with include_accessibility_tree:false and include_screenshot:true rather than repeating the failing tree walk. Ground a pixel action in that fresh screenshot. Do not guess screenshot coordinates if the image is unavailable to the current model; use trustworthy accessibility data when sufficient, otherwise report the limitation. Disabling the screenshot does not skip UIA.',
  'Muse shows a computer-use indicator while operating. A physical mouse or keyboard action pauses computer control; physical Escape exits it and dismisses the indicator. COMPUTER_USE_ENDED means stop computer work until a fresh user instruction. When a tool reports COMPUTER_USE_PAUSED_USER_INPUT, stop computer work and tell the user that their input took priority; wait for a fresh user instruction. Never loop, relaunch, or use shell/another input tool to bypass the pause. After resuming, inspect fresh state before continuing, because already-delivered input is not undone. COMPUTER_USE_BUSY means another Agent owns this desktop; do not compete for it.',
  'Verify the requested outcome with fresh state or verify_state; delivered input alone is not completion. After cancellation or an unknown outcome, inspect before any retry because input is not rolled back. Other sessions can change the desktop. If the driver is unavailable, report that limitation instead of repeatedly sending input. The bundled tools support Windows x64. Release only your own computer-use sessions with end_session when done or when the user asks to stop or exit, including while paused.',
].join('\n\n')

/**
 * Reserve desktop ownership and load the bundled driver's tool catalog.
 * Connection failures remain local to this capability and do not reject Host startup.
 * Reconnection is disabled; unloading closes owned work before releasing ownership.
 * @param ctx - Host context providing computer use, tools, and prompt registries.
 * @param config - Bundled executable location and optional call deadline.
 * @returns initial connection and tool discovery settlement.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const monitor = createPhysicalInputMonitor()
  const status = createComputerStatePublisher()
  ctx.effect(() => () => monitor.close(), 'muse-computer-use.input-observer')
  ctx.effect(() => () => { status.close() }, 'muse-computer-use.status')
  ctx.effect(() => installComputerControl(ctx, monitor, state => status.publish(state)), 'muse-computer-use.control')
  const connection = McpClient.Config({
    transport: 'stdio',
    serverName: 'muse-computer',
    command: config.command,
    args: config.args,
    env: { CUA_DRIVER_PERMISSION_MODE: 'standard', CUA_DRIVER_RS_TELEMETRY_ENABLED: 'false' },
    ...config.toolCallTimeoutMs === undefined ? {} : { toolCallTimeoutMs: config.toolCallTimeoutMs },
    failOnStartupError: false,
    reconnect: { enabled: false },
  })
  let child!: Fiber
  ctx.effect(function* () {
    yield ctx.computerUse.register(ComputerUseProviderName('muse-computer'))
    child = ctx.plugin(McpClient, connection)
    yield child.dispose
  }, 'muse-computer-use.connection')
  ctx.systemPrompt.section({
    name: 'computer-use:muse',
    order: ctx.systemPrompt.getSectionOrder('TOOL_COMPUTER_USE'),
    text: GUIDANCE,
    interpolate: false,
  })
  await child.await()
}
