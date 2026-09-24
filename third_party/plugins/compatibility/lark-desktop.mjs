/** Opt-in activation controls applied only to the private community build staging tree. */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Recorded in the generated package's SOURCE.json alongside its upstream pin. */
export const larkDesktopCompatibility = { activationControls: 1 }

/**
 * Apply reviewed source edits before compilation; upstream snapshots remain unchanged.
 * @param directory - Private staging package root, never the pinned source directory.
 * @returns The compatibility metadata for the generated package.
 * @throws When a source anchor is missing or duplicated, before writing any staged file.
 */
export function applyLarkDesktopCompatibility(directory) {
  const patches = {
    'config.ts': [
      ['export interface Config {', `export interface Config {
  /** Start the chat bridge after backend restart; false keeps its settings available offline. */
  enabled?: boolean
  /** Allow first-boot QR app registration when credentials are absent; restart required. */
  autoRegistration?: boolean
  /** Allow shared settings, device arbitration and the cross-instance control service; restart required. */
  crossInstanceSync?: boolean`],
      ['export interface ResolvedConfig {', `export interface ResolvedConfig {
  enabled: boolean
  autoRegistration: boolean
  crossInstanceSync: boolean`],
      ['export const Config: z<Config> = z.object({', `export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true).description('Enable Feishu chat / 启用飞书聊天。Restart backend after changing settings / 修改后重启后端。'),
  autoRegistration: z.boolean().default(true).description('Allow automatic QR app registration / 允许自动扫码注册应用。Restart required / 重启生效。'),
  crossInstanceSync: z.boolean().default(true).description('Enable cross-instance synchronization / 启用跨实例同步。Restart required / 重启生效。'),`],
      ['    ...config,\n    locale:', `    ...config,
    enabled: config.enabled ?? true,
    autoRegistration: config.autoRegistration ?? true,
    crossInstanceSync: config.crossInstanceSync ?? true,
    locale:`],
    ],
    'host.ts': [
      ['options?: { base?: unknown }): HostSettingsScope', "options?: { base?: unknown; applies?: 'live' | 'restart' }): HostSettingsScope"],
    ],
    'runtime.ts': [
      ['settings.register(SETTINGS_NAMESPACE, Config, { base: config })', "settings.register(SETTINGS_NAMESPACE, Config, { base: config, applies: 'restart' })"],
      ['    // Cross-profile overlay (dual-end sync):', `    if (!resolved.enabled) return

    if (resolved.crossInstanceSync) {
    // Cross-profile overlay (dual-end sync):`],
      ['    startSyncLayer(resolved)\n    if (hasCredentials(resolved))', '    startSyncLayer(resolved)\n    }\n    if (hasCredentials(resolved))'],
      ['    const base = resolved\n    beginOnboarding({', '    if (!resolved.autoRegistration) return\n    const base = resolved\n    beginOnboarding({'],
    ],
    'bridge.ts': [
      ["    if (msg.content.trim() !== '/bot activate') {", "    if (config.crossInstanceSync && msg.content.trim() !== '/bot activate') {"],
      ['          getSyncContext(),', '          config.crossInstanceSync ? getSyncContext() : undefined,'],
    ],
  }
  const writes = Object.entries(patches).map(([name, replacements]) => {
    const path = join(directory, 'src', name)
    let source = readFileSync(path, 'utf8').replace(/\r\n/gu, '\n')
    for (const [before, after] of replacements) {
      if (source.split(before).length !== 2) throw new Error(`community plugins: Lark ${name} overlay needs source review`)
      source = source.replace(before, after)
    }
    return [path, source]
  })
  for (const [path, source] of writes) writeFileSync(path, source)
  return larkDesktopCompatibility
}
