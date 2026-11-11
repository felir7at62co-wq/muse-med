/** Normalize only saved visualization paths whose file and Session identity were verified. */
import assert from 'node:assert/strict'
import { readFile, realpath } from 'node:fs/promises'
import { basename, isAbsolute, join, resolve, sep } from 'node:path'
import { z } from 'zod'

const rowSchema = z.object({ type: z.string(), data: z.unknown().optional() }).loose()
const headerSchema = z.object({ type: z.literal('session'), cwd: z.string(), id: z.string().regex(/^[A-Za-z0-9_-]+$/u) })
const callSchema = z.object({ name: z.literal('visualize'), callId: z.string() })
const resultIdentity = z.union([
  z.object({ toolCallId: z.string() }).transform(message => message.toolCallId),
  z.object({ source: z.object({ kind: z.literal('tool'), callId: z.string() }),
    content: z.array(z.object({ type: z.literal('tool-result'), toolCallId: z.string() })).length(1) })
    .refine(message => message.source.callId === message.content[0]?.toolCallId)
    .transform(message => message.source.callId),
])
const resultSchema = z.object({
  message: resultIdentity,
  meta: z.object({ kind: z.literal('visualize'), path: z.string(), fragment: z.string() }),
})
const assistantSchema = z.object({ message: z.object({ content: z.array(z.unknown()) }) })
const blockSchema = z.object({ type: z.literal('tool-call'), name: z.literal('visualize'), id: z.string() })

/**
 * Expand this run's HOME-shortened card paths before ordinary cwd normalization.
 * Only matching visualize call/result records change; user text and other paths remain literal.
 * @param log - Raw Session JSONL from the completed visualization fixture.
 * @param home - The inherited operating-system home used by the real visualization plugin.
 * @param workspace - The temporary workspace allocated by this test invocation.
 * @returns JSONL with verified card identities expressed as absolute workspace paths.
 * @throws If a claimed workspace card resolves elsewhere or its final bytes differ from metadata.
 */
export async function normalizeVisualizeHomePaths(log: string, home: string, workspace: string): Promise<string> {
  const rows = log.trimEnd().split('\n').map(line => rowSchema.parse(JSON.parse(line)))
  const header = headerSchema.parse(rows[0])
  assert.ok(isAbsolute(header.cwd), 'Visualization normalization requires the actual workspace')
  const actualRoot = await realpath(workspace)
  assert.equal(await realpath(header.cwd), actualRoot, 'Visualization Session must belong to this test workspace')
  const calls = new Set(rows.flatMap(row => {
    const call = row.type === 'tool/call' ? callSchema.safeParse(row.data) : undefined
    return call?.success ? [call.data.callId] : []
  }))
  const latest = new Map<string, { fragment: string; spellings: Set<string> }>()
  for (const row of rows) {
    const result = row.type === 'tool/result' ? resultSchema.safeParse(row.data) : undefined
    if (!result?.success || !calls.has(result.data.message)) continue
    const displayPath = result.data.meta.path
    const expanded = displayPath.startsWith(`~${sep}`) || displayPath.startsWith('~/') ? join(home, displayPath.slice(2)) : displayPath
    if (!isAbsolute(expanded)) continue
    const absolute = resolve(expanded)
    const filename = basename(absolute)
    const suffix = sep + join('.dsh', 'visualize', 'sessions', header.id, filename)
    if (!/^visualization-[0-9a-f]{8}\.whale\.html$/u.test(filename) || !absolute.endsWith(suffix)) continue
    // Windows application redirection can give the same workspace two spellings.
    // A matching basename is insufficient; the directory must resolve to this run's root.
    const claimedWorkspace = absolute.slice(0, -suffix.length)
    if (basename(claimedWorkspace) !== basename(workspace)) continue
    let claimedRoot: string
    try {
      claimedRoot = await realpath(claimedWorkspace)
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') continue
      throw error
    }
    if (claimedRoot !== actualRoot) continue
    const path = await realpath(absolute)
    assert.equal(path, join(actualRoot, '.dsh', 'visualize', 'sessions', header.id, filename),
      'Visualization card must retain its workspace and Session identity')
    const spellings = latest.get(path)?.spellings ?? new Set<string>()
    spellings.add(absolute)
    spellings.add(path)
    latest.set(path, { fragment: result.data.meta.fragment, spellings })
  }
  const replacements: [string, string][] = []
  for (const [path, owned] of latest) {
    assert.equal(await readFile(path, 'utf8'), owned.fragment, 'Saved visualization must match its final metadata')
    const target = `${header.cwd}/.dsh/visualize/sessions/${header.id}/${basename(path)}`
    const spellings = new Set<string>()
    for (const spelling of owned.spellings) {
      spellings.add(spelling)
      spellings.add(spelling.replaceAll('\\', '/'))
      if (spelling.startsWith(home + sep)) {
        const display = `~${spelling.slice(home.length)}`
        spellings.add(display)
        spellings.add(display.replaceAll('\\', '/'))
      }
    }
    for (const spelling of spellings) {
      replacements.push([spelling, target], [JSON.stringify(spelling).slice(1, -1), JSON.stringify(target).slice(1, -1)])
    }
  }
  if (replacements.length === 0) return log
  const replace = (value: unknown): unknown => {
    if (typeof value === 'string') {
      let output = value
      for (const [from, to] of replacements) {
        const escaped = from.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
        output = output.replace(new RegExp(`(^|[\\s"'(<])${escaped}(?=$|[\\s"')>]|\\\\")`, 'gu'), (_match, prefix: string) => prefix + to)
      }
      return output
    }
    if (Array.isArray(value)) return value.map(replace)
    if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, replace(child)]))
    return value
  }
  return rows.map(row => {
    const call = row.type === 'tool/call' ? callSchema.safeParse(row.data) : undefined
    const result = row.type === 'tool/result' ? resultSchema.safeParse(row.data) : undefined
    const assistant = row.type === 'assistant/message' ? assistantSchema.safeParse(row.data) : undefined
    const related = call?.success || result?.success && calls.has(result.data.message)
      || assistant?.success && assistant.data.message.content.some(block => {
        const parsed = blockSchema.safeParse(block)
        return parsed.success && calls.has(parsed.data.id)
      })
    return JSON.stringify(related ? replace(row) : row)
  }).join('\n') + '\n'
}
