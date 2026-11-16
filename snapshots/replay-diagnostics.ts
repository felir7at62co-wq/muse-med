/** Read-only replay evidence for diagnosing platform-specific Session and header mismatches. */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  formatSystemPromptSnapshot, formatToolSchemasSnapshot, normalizeSessionLog,
  normalizedSystemPrompts, normalizedToolSchemas, redactSessionSnapshotIds, scrubSessionSnapshot, writerSnapshotName, type NormalizeContext,
} from '@deepseek-ai/dsh-session-snapshot'

/**
 * Save parseable current-writer replay output beside its independently readable request headers.
 * The caller supplies an ignored, scenario-owned directory; committed inputs and expectations are never written.
 * @param directory - Private output directory for this scenario and execution mode.
 * @param logs - Persisted logs in primary-first role order.
 * @param context - Live identities and working-directory aliases used by the replay comparison.
 * @returns Completion after every role's writer, prompt and tool-schema evidence is saved.
 */
export async function writeReplayDiagnostics(directory: string, logs: readonly string[], context: NormalizeContext): Promise<void> {
  const writers = redactSessionSnapshotIds(logs.map(log => scrubSessionSnapshot(
    normalizeSessionLog(log, { ...context, sessionIds: [] }, { identityMode: 'preserve' }),
  )))
  await mkdir(directory, { recursive: true })
  await Promise.all(logs.map(async (log, index) => {
    const writer = writers[index] ?? ''
    const prompts = normalizedSystemPrompts(log, context)
    const schemas = normalizedToolSchemas(log, context)
    const suffix = index === 0 ? '' : `.${index}`
    await Promise.all([
      writeFile(join(directory, writerSnapshotName(index)), writer),
      writeFile(join(directory, `system-prompt${suffix}.expected.md`), formatSystemPromptSnapshot(prompts[0] ?? '', prompts.slice(1))),
      writeFile(join(directory, `tool-schemas${suffix}.expected.json`), formatToolSchemasSnapshot(schemas[0] ?? [], schemas.slice(1))),
    ])
  }))
}
