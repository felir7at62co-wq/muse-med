/** Native path rebinding used only by the isolated narrative voice replay. */
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
/**
 * Rebind the tool's declared workspace path fields without changing other arguments.
 * @param name - Registered real tool name.
 * @param args - Validated arguments from the recorded call.
 * @param cwd - Current isolated native workspace.
 * @returns Path-adjusted arguments with business fields unchanged.
 */
export function rebindNarrativeVoicePaths(name: string, args: unknown, cwd: string): unknown
/**
 * Delegate to the real executor with native paths.
 * @param tool - Process-isolated real definition.
 * @param cwd - Current isolated native workspace.
 * @returns Restoration callback owned by the scenario context.
 */
export function bindNarrativeVoiceToolPaths(tool: ToolDefinition, cwd: string): () => void
