/** Bind Windows-recorded workspace path arguments to the replay host's real local tools. */
import { posix, win32 } from 'node:path'

/** @type {ReadonlyMap<string, readonly string[]>} */
const fields = new Map([['read', ['file_path']], ['write', ['file_path']], ['drama_shot', ['script', 'assets', 'project']]])

/**
 * Rebind only declared path fields beneath the complete hydrated workspace prefix.
 * @param {string} name - The real tool's registered name.
 * @param {unknown} args - Validated tool arguments; business fields remain unchanged.
 * @param {string} cwd - The isolated replay's native absolute working directory.
 * @returns {unknown} A path-adjusted argument object, without mutating the recorded call.
 */
export function rebindNarrativeVoicePaths(name, args, cwd) {
  const selected = fields.get(name)
  if (!selected || args === null || typeof args !== 'object' || Array.isArray(args)) return args
  const join = cwd.startsWith('/') ? posix.join : win32.join
  return Object.fromEntries(Object.entries(args).map(([key, value]) => {
    if (!selected.includes(key) || typeof value !== 'string' || value === cwd) return [key, value]
    if (!value.startsWith(`${cwd}/`) && !value.startsWith(`${cwd}\\`)) return [key, value]
    const segments = value.slice(cwd.length + 1).replaceAll('\\', '/').split('/')
    if (segments.some(segment => !segment || segment === '.' || segment === '..' || segment.includes('\0'))) {
      throw new Error('narrative-voice replay paths must stay beneath the bound workspace')
    }
    return [key, join(cwd, ...segments)]
  }))
}

/**
 * Delegate execution to the original tool with native workspace paths and actual filesystem effects.
 * @param {import('@deepseek-ai/dsh-tools').ToolDefinition} tool - Scenario-owned or process-isolated real tool definition.
 * @param {string} cwd - The isolated replay workspace.
 * @returns {() => void} Restores the original executor when the scenario context is disposed.
 */
export function bindNarrativeVoiceToolPaths(tool, cwd) {
  const original = tool.execute
  tool.execute = (args, exec) => original.call(tool, rebindNarrativeVoicePaths(tool.name, args, cwd), exec)
  return () => { tool.execute = original }
}
