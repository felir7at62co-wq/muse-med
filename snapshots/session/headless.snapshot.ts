/** Recorded-session replay through the shipped headless `dsh` profile. */

import { startHttpMcpFixture } from '../../packages/mcp/mcp-client/tests/http-fixture.ts'
import { cp, copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { basename, delimiter, dirname, isAbsolute, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import ts from 'typescript'
import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { releasedV0SessionFormatCodec } from '@deepseek-ai/dsh-session-format-v0-to-v1'
import type { SessionFormatEvent, SessionFormatMigrationContext } from '@deepseek-ai/dsh-session-format'
import { assertWorkspaceOutsideTemp, outsideTempWorkspaceParent } from '../../scripts/snapshot-workspace-parent.ts'
import {
  assertPersistedSessionVersion,
  assertSessionFixtureVersion,
  captureExpectedWorkspaceSnapshot,
  captureWorkspaceSnapshot,
  fixtureContext,
  formatSystemPromptSnapshot,
  formatToolSchemasSnapshot,
  latestPersistedSessionPaths,
  materializeProfilePatch,
  normalizeSessionSnapshots,
  normalizedHeaders,
  normalizedSystemPrompts,
  normalizedToolSchemas,
  parseSnapshotManifest,
  parseToolSchemasSnapshot,
  redactSessionSnapshotIds,
  refreshFixtureReplacements,
  restorePinnedToolSchemas,
  scrubSessionSnapshot,
  scrubSystemPrompts,
  scrubToolSchemas,
  sessionFixtureName,
  systemPromptPrecedesRequests,
  sessionFixtureNames,
  sessionHeaderVersion,
  writerSnapshotName,
  snapshotSpillRoot,
  stabilizeFixtureMessageIds,
  stabilizeRefreshLog,
  tokenizeSessionFixtureCwd,
  writesCurrentSessionFixtures,
  type HarvestedLog,
  type NormalizeContext,
  type SnapshotManifest,
  type WorkspaceSnapshotEntry,
} from '@deepseek-ai/dsh-session-snapshot'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import { resolvePwshPath } from '@deepseek-ai/dsh-pwsh-local'
import { parseSessionLog, prepareSessionSnapshotFixtureForComparison } from '@deepseek-ai/dsh-llm-replay'

const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
const snapshotsRoot = fileURLToPath(new URL('./', import.meta.url))
const dshBin = join(repoRoot, 'apps/cli/src/bin.ts')
const tsconfigPath = join(repoRoot, 'tsconfig.json')
const editingCordisSkill = join(
  repoRoot,
  'packages/preset/agent-preset/skills/editing-cordis-compositions/SKILL.md',
)
// Retired guides belong only to these recorded workspaces; current production discovery stays disabled.
const museLegacySkills = join(snapshotsRoot, 'muse-video-screenplay-skills/legacy-skills')
const museEditingSkill = join(museLegacySkills, 'editing.skill.txt')
const museSharedSkills = [
  ['screenplay-project', join(museLegacySkills, 'screenplay-project.skill.txt')],
  ['tweet-drama-project-bible', join(repoRoot, 'packages/drama/skills/skills/tweet-drama-project-bible/SKILL.md')],
  ['tweet-drama-voice-continuity', join(repoRoot, 'packages/drama/skills/skills/tweet-drama-voice-continuity/SKILL.md')],
  ['muse-project-participation', join(museLegacySkills, 'muse-project-participation.skill.txt')],
  ['muse-llm-wiki', join(museLegacySkills, 'muse-llm-wiki.skill.txt')],
  ['douyin-download', join(museLegacySkills, 'douyin-download.skill.txt')],
  ['screenplay-format', join(repoRoot, 'apps/desktop-host/tests/fixtures/retired-writing-skills/screenplay-format/SKILL.md')],
  ['wechat-shortdrama-harvest', join(museLegacySkills, 'wechat-shortdrama-harvest.skill.txt')],
  ['audio-transcribe', join(repoRoot, 'apps/desktop-host/skills/audio-transcribe/SKILL.md')],
  ['transcript-to-novel', join(museLegacySkills, 'transcript-to-novel.skill.txt')],
  ['transcript-to-script', join(museLegacySkills, 'transcript-to-script.skill.txt')],
  ['novel-to-script', join(museLegacySkills, 'novel-to-script.skill.txt')],
  ['trope-adaptation', join(museLegacySkills, 'trope-adaptation.skill.txt')],
] as const

type SnapshotMode = 'replay' | 'record' | 'refresh'

function snapshotMode(value: string | undefined): SnapshotMode {
  switch (value) {
    case undefined:
    case '':
    case 'replay': return 'replay'
    case 'record': return 'record'
    case 'refresh': return 'refresh'
    default: throw new Error(`unknown DSH_SNAPSHOT mode: ${value}`)
  }
}

const mode = snapshotMode(process.env.DSH_SNAPSHOT)
const RUNTIME_WORKSPACE_ENTRIES = ['.agents', '.dsh', '.snapshot-patches'] as const

interface JsonObject {
  [key: string]: unknown
}

interface HeadlessScenario {
  readonly name: string
  readonly dir: string
  readonly manifest: SnapshotManifest & {
    composition: string
    recording: 'live' | 'authored'
    header: NonNullable<SnapshotManifest['header']>
  }
}

interface SessionLog {
  readonly content: string
  readonly header: JsonObject
}

function propertyName(node: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node)) return node.text
  return undefined
}

function bindsOsAssignedPort(argument: ts.Expression | undefined): boolean {
  if (argument === undefined) return false
  if (ts.isNumericLiteral(argument)) return Number(argument.text) === 0
  if (!ts.isObjectLiteralExpression(argument)) return false
  let portIsZero: boolean | undefined
  for (const property of argument.properties) {
    if (ts.isSpreadAssignment(property)) {
      portIsZero = undefined
      continue
    }
    if (propertyName(property.name) !== 'port') continue
    portIsZero = ts.isPropertyAssignment(property)
      && ts.isNumericLiteral(property.initializer)
      && Number(property.initializer.text) === 0
  }
  return portIsZero === true
}

function listenerPortViolations(path: string, sourceText: string): string[] {
  const source = ts.createSourceFile(path, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const violations: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === 'listen'
      && !bindsOsAssignedPort(node.arguments[0])) {
      const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
      const received = node.arguments[0]?.getText(source) ?? '<missing>'
      violations.push(
        `${path}:${line}: listener port ${received} must use listen(0, ...) or listen({ port: 0, ... })`,
      )
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return violations
}

function harvested(log: SessionLog): HarvestedLog {
  return {
    id: String(log.header.id),
    createdAt: Number(log.header.createdAt),
    ...(typeof log.header.parentSession === 'string' ? { parentSession: log.header.parentSession } : {}),
    content: log.content,
  }
}

function records(log: string): JsonObject[] {
  return log.split(/\r?\n/)
    .filter(line => line.trim() !== '')
    .map(line => JSON.parse(line) as JsonObject)
}

/** Compare deterministic recorded tool output with raw writer fields; only message ids are volatile. */
function verifyToolResultWriterParity(fixture: string, actual: string): void {
  expect(sessionHeaderVersion(fixture, 'retained tool-result input')).toBe(3)
  expect(sessionHeaderVersion(actual, 'raw tool-result writer')).toBe(SESSION_FORMAT_VERSION)
  const withoutMessageId = (message: object): JsonObject => Object.fromEntries(
    Object.entries(message).filter(([key]) => key !== 'id'),
  )
  const expected = parseSessionLog(fixture).flatMap(event => event.type === 'tool/result'
    ? [withoutMessageId(event.data.message)] : [])
  const written = records(actual).flatMap(event => event.type === 'tool/result'
    ? [withoutMessageId((event.data as JsonObject).message as JsonObject)] : [])
  expect(expected.length, 'recorded stock tool results').toBeGreaterThan(0)
  expect(written, 'native tool-result messages match migration output').toEqual(expected)
}

function headerOf(log: string): JsonObject {
  return records(log)[0] ?? {}
}

function contextOf(logs: readonly string[]): NormalizeContext {
  const headers = logs.map(headerOf)
  const cwd = typeof headers[0]?.cwd === 'string' ? headers[0].cwd : '\0missing-cwd\0'
  return {
    sessionIds: headers.flatMap(header => typeof header.id === 'string' ? [header.id] : []),
    cwd,
    cwdAliases: [cwd.replaceAll('\\', '/'), JSON.stringify(cwd).slice(1, -1)],
  }
}

async function persistedSessions(cwd: string): Promise<SessionLog[]> {
  const root = join(cwd, '.dsh', 'sessions')
  const files = latestPersistedSessionPaths(await readdir(root, { recursive: true }))
  const logs = await Promise.all(files.map(async (file): Promise<SessionLog> => {
    const content = await readFile(join(root, file), 'utf8')
    expect(assertPersistedSessionVersion(basename(file), content), `${file}: current writer`).toBe(SESSION_FORMAT_VERSION)
    return { content, header: headerOf(content) }
  }))
  // Siblings bind to fixture roles by catalog publication order; concurrent
  // provider startup can publish an older Session after a newer one.
  const catalogOrders = new Map(logs.map(log => [log.header.id, new Map(
    records(log.content)
      .filter(event => event.type === 'subagent/catalog')
      .map((event, index) => [(event.data as JsonObject).childId, index]),
  )]))
  return logs.sort((left, right) => {
    const leftChild = typeof left.header.parentSession === 'string'
    const rightChild = typeof right.header.parentSession === 'string'
    if (leftChild !== rightChild) return leftChild ? 1 : -1
    if (left.header.parentSession === right.header.parentSession) {
      const catalogOrder = catalogOrders.get(left.header.parentSession)
      const childOrder = (catalogOrder?.get(left.header.id) ?? Infinity) - (catalogOrder?.get(right.header.id) ?? Infinity)
      if (childOrder) return childOrder
    }
    return Number(left.header.createdAt) - Number(right.header.createdAt)
  })
}

async function fixtureSessions(scenario: HeadlessScenario, selectedFiles?: readonly string[]): Promise<string[]> {
  const files = selectedFiles ?? sessionFixtureNames(await readdir(scenario.dir))
  return Promise.all(files.map(async (file) => {
    const content = await readFile(join(scenario.dir, file), 'utf8')
    assertSessionFixtureVersion(file, content)
    return content
  }))
}

async function primaryFixtureFile(dir: string): Promise<string> {
  const [primary] = sessionFixtureNames(await readdir(dir))
  if (primary === undefined) throw new Error(`${dir}: missing parent Session fixture`)
  const content = await readFile(join(dir, primary), 'utf8')
  assertSessionFixtureVersion(primary, content)
  return primary
}

async function writeSessionFixtures(
  scenario: HeadlessScenario,
  actualLogs: readonly SessionLog[],
  existing: readonly string[],
  ctx: NormalizeContext,
): Promise<string[]> {
  const names = actualLogs.map((log, index) => scenario.manifest.sessionFormat === undefined && scenario.manifest.writerOutput !== true
    ? sessionFixtureName(index, sessionHeaderVersion(log.content, `harvested Session ${index}`))
    : writerSnapshotName(index))
  const prior = names.map((_, index) => existing[index] ?? '')
  const replacements = mode === 'refresh'
    ? refreshFixtureReplacements(actualLogs.map(harvested), prior)
    : []
  const fresh = actualLogs.map((log, index) => {
    const stable = tokenizeRefreshedFixtureCwd(mode === 'refresh'
      ? stabilizeRefreshLog(log.content, prior[index] as string, replacements, ctx)
      : log.content, ctx.cwd)
    return scrubSessionSnapshot(prepareSessionSnapshotFixtureForComparison(stable))
  })
  const output = redactSessionSnapshotIds(stabilizeFixtureMessageIds(fresh, prior))
  await Promise.all(output.map((content, index) => writeFile(join(scenario.dir, names[index] as string), content)))
  return output
}

/** Refresh can retain a tokenized header while a new tool result contains the run's real cwd. */
function tokenizeRefreshedFixtureCwd(log: string, cwd: string): string {
  const lines = log.split('\n')
  const header = JSON.parse(lines[0] as string) as JsonObject
  if (header.cwd === '{{cwd}}') lines[0] = JSON.stringify({ ...header, cwd })
  return tokenizeSessionFixtureCwd(lines.join('\n'))
}

/**
 * Write prompt and tool-schema sidecars independently of Session-generation retention.
 * @param scenario - scenario and sidecar ownership metadata.
 * @param actualLogs - current run's primary-first Session logs.
 * @param ctx - volatile run values used by header normalization.
 */
async function writeHeaderSidecars(
  scenario: HeadlessScenario,
  actualLogs: readonly SessionLog[],
  ctx: NormalizeContext,
): Promise<void> {
  if (scenario.manifest.header.pin === true
    || [...headerPins.values()].some(pin => pin.manifest.header.systemPromptSource === scenario.name
      || pin.manifest.header.toolSchemasSource === scenario.name)) {
    const primary = actualLogs[0]
    if (primary === undefined) throw new Error(`${scenario.name}: write-back has no primary session`)
    const prompts = normalizedSystemPrompts(primary.content, ctx)
    const schemas = normalizedToolSchemas(primary.content, ctx)
    const promptOwner = scenario.manifest.header.systemPromptSource ?? scenario.name
    const schemaOwner = scenario.manifest.header.toolSchemasSource ?? scenario.name
    if (promptOwner === scenario.name) {
      await writeFile(
        join(scenario.dir, 'system-prompt.expected.md'),
        formatSystemPromptSnapshot(prompts[0] as string, prompts.slice(1)),
      )
    }
    if (schemaOwner === scenario.name) {
      await writeFile(
        join(scenario.dir, 'tool-schemas.expected.json'),
        formatToolSchemasSnapshot(schemas[0] as unknown[], schemas.slice(1)),
      )
    }
  }
  for (const index of scenario.manifest.header.childSystemPrompts ?? []) {
    const child = actualLogs[index]
    if (child === undefined) throw new Error(`${scenario.name}: write-back has no child ${index} prompt`)
    const prompts = normalizedSystemPrompts(child.content, ctx)
    await writeFile(
      join(scenario.dir, `system-prompt.${index}.expected.md`),
      formatSystemPromptSnapshot(prompts[0] as string, prompts.slice(1)),
    )
  }
  for (const index of scenario.manifest.header.childToolSchemas ?? []) {
    const child = actualLogs[index]
    if (child === undefined) throw new Error(`${scenario.name}: write-back has no child ${index} schemas`)
    const schemas = normalizedToolSchemas(child.content, ctx)
    await writeFile(
      join(scenario.dir, `tool-schemas.${index}.expected.json`),
      formatToolSchemasSnapshot(schemas[0] as unknown[], schemas.slice(1)),
    )
  }
}

function taskFromSession(log: string): string | undefined {
  const text = (value: unknown): string | undefined => {
    if (value === null || typeof value !== 'object') return undefined
    const message = value as JsonObject
    const source = message.source as JsonObject | undefined
    if (source?.kind !== 'user' || !Array.isArray(message.content)) return undefined
    const blocks = message.content as JsonObject[]
    return blocks.length === 1 && blocks[0]?.type === 'text' && typeof blocks[0].text === 'string'
      ? blocks[0].text
      : undefined
  }
  // Inbox text retains canonical mentions that pre-step renders as readable labels.
  for (const record of records(log)) {
    if (record.type !== 'agent/inbox/spliced') continue
    const data = record.data as JsonObject | undefined
    if (!Array.isArray(data?.inserted)) continue
    for (const message of data.inserted) {
      const task = text(message)
      if (task !== undefined) return task
    }
  }
  for (const record of records(log)) {
    if (record.type !== 'user/message') continue
    const task = text(record.data)
    if (task !== undefined) return task
  }
  return undefined
}

function finalTextFromSession(log: string): string {
  const messages = records(log).flatMap((record) => {
    if (record.type !== 'assistant/message') return []
    const data = record.data as JsonObject | undefined
    const message = data?.message as JsonObject | undefined
    return message === undefined ? [] : [message]
  })
  const content = messages.at(-1)?.content
  if (!Array.isArray(content)) return ''
  return (content as JsonObject[])
    .flatMap(block => block.type === 'text' && typeof block.text === 'string' ? [block.text] : [])
    .join('')
}

function turnReasonFromSession(log: string): JsonObject | undefined {
  const endings = records(log).flatMap((record) => {
    if (record.type !== 'turn/end') return []
    const data = record.data as JsonObject | undefined
    return data?.reason !== null && typeof data?.reason === 'object'
      ? [data.reason as JsonObject]
      : []
  })
  return endings.at(-1)
}

function stderrFromSession(log: string): string {
  let output = ''
  let started = false
  let open = false
  let endsWithNewline = true
  const appendReasoning = (text: string): void => {
    if (text === '') return
    if (!open) {
      output += 'dsh: reasoning:\n'
      open = true
    }
    output += text
    endsWithNewline = text.endsWith('\n')
  }
  const close = (): void => {
    if (!open) return
    if (!endsWithNewline) output += '\n'
    open = false
    endsWithNewline = true
  }
  const consume = (type: unknown, data: JsonObject | undefined): void => {
    if (type === 'reasoning-chunks') {
      if (!Array.isArray(data?.texts) || data.texts.some(text => typeof text !== 'string')) {
        throw new Error('headless snapshot reasoning chunks have invalid text')
      }
      for (const text of data.texts as string[]) appendReasoning(text)
      return
    }
    if (type === 'text-chunks' || type === 'tool-call-chunks') {
      close()
      return
    }
    if (type !== 'assistant/chunk' && type !== 'chunk') return
    const chunk = data?.chunk as JsonObject | undefined
    switch (chunk?.type) {
      case 'reasoning-delta':
        if (typeof chunk.text !== 'string') throw new Error('headless snapshot reasoning delta has invalid text')
        appendReasoning(chunk.text)
        break
      case 'block-start':
        if (chunk.blockType !== 'reasoning') close()
        break
      case 'block-end': {
        const block = chunk.block as JsonObject | undefined
        if (block?.type !== 'reasoning') close()
        break
      }
      case 'usage':
        break
      case 'text-delta':
      case 'tool-call-delta':
      case 'finish':
        close()
        break
    }
  }
  for (const record of records(log)) {
    if (record.type === 'turn/start') {
      close()
      started = true
      continue
    }
    if (!started) continue
    const data = record.data as JsonObject | undefined
    if ((record.type === 'assistant/message' || record.type === 'assistant/attempt')
      && Array.isArray(data?.stream)) {
      for (const entry of data.stream) {
        if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
          throw new Error('headless snapshot embedded stream has an invalid entry')
        }
        const streamRecord = entry as JsonObject
        consume(streamRecord.type, streamRecord)
      }
      close()
      continue
    }
    consume(record.type, data)
  }
  close()
  const reason = turnReasonFromSession(log)
  if (reason?.kind !== 'error') return output
  const error = reason.error as JsonObject | undefined
  if (typeof error?.code !== 'string' || typeof error.message !== 'string') {
    throw new Error('headless snapshot error reason has no code and message')
  }
  return `${output}dsh: ${error.code}: ${error.message}\n`
}

function modelFromSession(log: string): { provider: string; model: string } {
  for (const record of records(log)) {
    if (record.type !== 'request/header') continue
    const data = record.data as JsonObject | undefined
    const header = data?.header as JsonObject | undefined
    const config = header?.config as JsonObject | undefined
    if (typeof config?.provider === 'string' && typeof config.model === 'string') {
      return { provider: config.provider, model: config.model }
    }
  }
  throw new Error('headless snapshot session has no request model')
}

interface PreparedWorkspace {
  readonly expectedRoot?: string
}

function expandSubtitleOverlayExpectedReport(text: string, cwd: string): string {
  const report = JSON.parse(text) as JsonObject
  const expand = (value: unknown): string => {
    if (typeof value !== 'string' || !value.startsWith('{{cwd}}/')) {
      throw new Error('subtitle-overlay expected paths must start with {{cwd}}/')
    }
    return join(cwd, ...value.slice('{{cwd}}/'.length).split('/'))
  }
  for (const field of ['plan_path', 'original_srt', 'resolved_srt', 'decision_report']) {
    report[field] = expand(report[field])
  }
  if (!Array.isArray(report.sources)) throw new Error('subtitle-overlay expected sources must be an array')
  report.sources = report.sources.map((source: JsonObject) => ({ ...source, path: expand(source.path) }))
  return `${JSON.stringify(report, null, 2)}\n`
}

async function prepareSubtitleOverlayExpectedWorkspace(cwd: string, scenarioDir: string): Promise<string> {
  const expectedRoot = join(cwd, '.snapshot-patches', 'expected-workspace')
  await cp(join(scenarioDir, 'workspace.expected'), expectedRoot, { recursive: true, verbatimSymlinks: true })
  const report = join(expectedRoot, 'editing', 'review-overlay.srt.decision-report.json')
  await writeFile(report, expandSubtitleOverlayExpectedReport(await readFile(report, 'utf8'), await realpath(cwd)))
  return expectedRoot
}

async function seedWorkspace(scenario: HeadlessScenario, cwd: string): Promise<PreparedWorkspace> {
  const source = join(scenario.dir, 'workspace')
  if (existsSync(source)) {
    for (const entry of await readdir(source)) {
      await cp(join(source, entry), join(cwd, entry), { recursive: true, verbatimSymlinks: true })
    }
  }
  const setup = scenario.manifest.workspace?.setup
  if (setup === undefined) return {}
  const prepare = workspaceSetups[setup]
  if (prepare === undefined) throw new Error(`${scenario.name}: unknown workspace setup ${setup}`)
  return await prepare(cwd, scenario.dir) ?? {}
}

const workspaceSetups: Record<string, (cwd: string, scenarioDir?: string) => Promise<PreparedWorkspace | void>> = {
  async 'drama-subtitle-overlay'(cwd, scenarioDir) {
    if (scenarioDir === undefined) throw new Error('subtitle-overlay expected workspace requires its owner directory')
    const skillRoot = join(cwd, '.dsh', 'skills', 'tweet-drama-draft-build')
    const sourceRoot = join(repoRoot, 'packages/drama/skills/skills/tweet-drama-draft-build')
    await mkdir(skillRoot, { recursive: true })
    await copyFile(join(sourceRoot, 'SKILL.md'), join(skillRoot, 'SKILL.md'))
    await cp(join(sourceRoot, 'references'), join(skillRoot, 'references'), { recursive: true })
    return { expectedRoot: await prepareSubtitleOverlayExpectedWorkspace(cwd, scenarioDir) }
  },
  async 'muse-video-observation'(cwd, scenarioDir) {
    if (scenarioDir === undefined) throw new Error('video observation requires its owner directory')
    await writeFile(join(cwd, 'fixture.mp4'), 'Deterministic media source for the external-process fixture.\n')
    await writeFile(join(cwd, 'episode.md'), '# 第1集\n▲合成画面从黑色切换为白色。\n')
    const expectedRoot = join(cwd, '.snapshot-patches', 'expected-video-observation')
    await cp(join(scenarioDir, 'workspace.expected'), expectedRoot, { recursive: true })
    return { expectedRoot }
  },
  async 'muse-video-inspect'(cwd) {
    await writeFile(join(cwd, 'fixture.mp4'), 'Deterministic media source for the external-process fixture.\n')
  },
  async 'windows-acl-skill'(cwd) {
    const target = join(cwd, '.dsh', 'skills', 'diagnose-windows-sandbox-acl', 'SKILL.md')
    await mkdir(dirname(target), { recursive: true })
    await copyFile(join(repoRoot, 'packages/sandbox/sandbox-windows-acl/assets/diagnose-windows-sandbox-acl/SKILL.md'), target)
  },
  async 'office-skills'(cwd) {
    await cp(join(repoRoot, 'packages/skill/skill-office/assets'), join(cwd, 'office-skills'), { recursive: true })
    await symlink(process.execPath, join(cwd, 'office-node'))
    await symlink(join(repoRoot, 'packages/skill/skill-office/node_modules/@deepseek-ai/libreoffice-kit/lib/cli.js'), join(cwd, 'office-cli.js'))
  },
  async 'editing-cordis-skill'(cwd) {
    const target = join(cwd, '.dsh', 'skills', 'editing-cordis-compositions', 'SKILL.md')
    await mkdir(dirname(target), { recursive: true })
    await copyFile(editingCordisSkill, target)
  },
  async 'muse-minimal-writing'(cwd) {
    await cp(join(repoRoot, 'apps/desktop-host/skills'), join(cwd, '.dsh/skills'), { recursive: true })
    await cp(join(repoRoot, 'packages/drama/skills/skills'), join(cwd, '.dsh/skills'), { recursive: true })
  },
  async 'muse-editing-skill'(cwd) {
    for (const [name, source] of [['muse-script-editing', museEditingSkill], ...museSharedSkills]) {
      const target = join(cwd, '.dsh', 'skills', name, 'SKILL.md')
      await mkdir(dirname(target), { recursive: true })
      await copyFile(source, target)
    }
    const episodeGuide = join(cwd, '.dsh/skills/trope-adaptation/references/episode-design.md')
    await mkdir(dirname(episodeGuide), { recursive: true })
    await copyFile(join(repoRoot, 'apps/desktop-host/tests/fixtures/retired-writing-skills/trope-adaptation/references/episode-design.md'), episodeGuide)
    for (const name of ['screenplay-format', 'screenplay-project']) {
      await cp(join(repoRoot, 'apps/desktop-host/tests/fixtures/retired-writing-skills', name, 'references'),
        join(cwd, '.dsh/skills', name, 'references'), { recursive: true })
    }
    await cp(join(repoRoot, 'packages/drama/skills/skills/tweet-drama-project-bible/references'),
      join(cwd, '.dsh/skills/tweet-drama-project-bible/references'), { recursive: true })
  },
  async 'muse-character-reference-skill'(cwd) {
    await workspaceSetups['muse-editing-skill']!(cwd)
    const target = join(cwd, '.dsh/skills/character-reference-library')
    await mkdir(target, { recursive: true })
    await copyFile(join(repoRoot, 'packages/drama/skills/skills/character-reference-library/SKILL.md'),
      join(target, 'SKILL.md'))
  },
  async 'muse-script-safety-skill'(cwd) {
    await cp(join(repoRoot, 'apps/desktop-host/tests/fixtures/retired-writing-skills/reviewing-micro-drama-scripts'),
      join(cwd, '.dsh/skills/reviewing-micro-drama-scripts'), { recursive: true })
  },
  async 'muse-editing-trial-skills'(cwd) {
    await workspaceSetups['muse-editing-skill']!(cwd)
    for (const name of ['muse-episode-design', 'muse-script-doctor', 'muse-dialogue-polish']) {
      await cp(join(repoRoot, 'apps/desktop-host/tests/fixtures/retired-writing-skills', name), join(cwd, '.dsh', 'skills', name), { recursive: true })
      if (name !== 'muse-script-doctor') {
        await copyFile(join(museLegacySkills, `${name}.skill.txt`), join(cwd, '.dsh', 'skills', name, 'SKILL.md'))
      }
    }
  },
  async 'muse-time-context'(cwd) {
    await workspaceSetups['muse-editing-trial-skills']!(cwd)
    await workspaceSetups['windows-acl-skill']!(cwd)
  },
  async 'muse-current-professional-skills'(cwd) {
    for (const name of ['muse-dialogue-polish', 'muse-episode-design', 'muse-script-doctor', 'screenplay-format']) {
      await cp(join(repoRoot, 'apps/desktop-host/tests/fixtures/retired-writing-skills', name), join(cwd, '.dsh', 'skills', name), { recursive: true })
    }
  },
  async 'muse-creation-skills'(cwd) {
    await workspaceSetups['muse-editing-trial-skills']!(cwd)
    await cp(join(repoRoot, 'packages/drama/skills/skills'), join(cwd, '.dsh/skills'), { recursive: true })
    await cp(join(repoRoot, 'apps/desktop-host/skills'), join(cwd, '.dsh/skills'), { recursive: true })
    await copyFile(join(museLegacySkills, 'video-review.skill.txt'), join(cwd, '.dsh/skills/video-review/SKILL.md'))
  },
  async 'muse-audio-transcribe-skill-legacy'(cwd) {
    await workspaceSetups['muse-editing-skill']!(cwd)
    await copyFile(join(repoRoot, 'snapshots/session/muse-audio-transcribe-skill/audio-transcribe.skill.txt'), join(cwd, '.dsh/skills/audio-transcribe/SKILL.md'))
  },
  async 'muse-transcript-to-script-skill-legacy'(cwd) {
    await workspaceSetups['muse-editing-skill']!(cwd)
    await copyFile(join(repoRoot, 'snapshots/session/muse-transcript-to-script-skill/transcript-to-script.skill.txt'), join(cwd, '.dsh/skills/transcript-to-script/SKILL.md'))
  },
  async 'muse-asr-purpose'(cwd) {
    const workspace = await realpath(cwd)
    await workspaceSetups['muse-editing-skill']!(cwd)
    await mkdir(join(cwd, 'source'), { recursive: true })
    await mkdir(join(cwd, 'transcript/jobs'), { recursive: true })
    const id = '71000000-0000-4000-8000-000000000001'
    await writeFile(join(cwd, 'source/fixture.mp4'), 'The source of an already submitted screenplay transcription.\n')
    await writeFile(join(cwd, 'transcript/jobs/fixture-v1.json'), JSON.stringify({
      id, source: join(workspace, 'source/fixture.mp4'), accountUsername: 'fixture', stem: 'fixture', version: 1,
      language: 'zh', purpose: 'screenplay', sha256: 'a'.repeat(64), mp3: join(workspace, `transcript/jobs/.${id}.wav`), status: 'processing',
    }) + '\n')
  },
  async 'muse-asr-recovery-guard'(cwd) {
    const workspace = await realpath(cwd)
    await workspaceSetups['muse-editing-skill']!(cwd)
    await mkdir(join(cwd, 'transcript/jobs'), { recursive: true })
    for (const [index, stem] of ['flash', 'standard'].entries()) {
      const id = `71000000-0000-4000-8000-00000000000${index + 1}`
      const flash = stem === 'flash'
      await writeFile(join(cwd, `transcript/jobs/${stem}-v1.json`), JSON.stringify({
        id, source: join(workspace, `source/${stem}.mp4`), accountUsername: 'fixture', stem, version: 1,
        language: 'zh', purpose: 'screenplay', sha256: 'a'.repeat(64), mp3: join(workspace, `transcript/jobs/.${id}.wav`),
        status: flash ? 'uncertain' : 'failed', service_version: flash ? 'flash' : 'standard-v2', error_code: flash ? 'provider_unavailable' : 'provider_rejected',
        provider_diagnostic: flash ? { reason: 'timeout', operation: 'flash' }
          : { reason: 'response', operation: 'query', http_status: 200, provider_code: '45000006' },
        recovery: { capability: flash ? 'no_query' : 'none', next_action: 'inspect_receipt', automatic_resubmit: false },
      }, null, 2) + '\n')
    }
  },
  async 'muse-bgm-project-feedback'(cwd) {
    for (const name of ['tweet-drama-project-bible', 'tweet-drama-background-render']) {
      const source = join(repoRoot, 'packages/drama/skills/skills', name)
      const target = join(cwd, '.dsh/skills', name)
      await mkdir(target, { recursive: true })
      await copyFile(join(source, 'SKILL.md'), join(target, 'SKILL.md'))
      if (existsSync(join(source, 'references'))) await cp(join(source, 'references'), join(target, 'references'), { recursive: true })
    }
  },
  async 'muse-drama-pipeline-skill'(cwd) {
    const renderTarget = join(cwd, '.dsh/skills/tweet-drama-background-render/SKILL.md')
    await mkdir(dirname(renderTarget), { recursive: true })
    await copyFile(join(repoRoot, 'packages/drama/skills/skills/tweet-drama-background-render/SKILL.md'), renderTarget)
  },
  async 'muse-jianying-project-style-skill'(cwd) {
    await cp(join(repoRoot, 'packages/drama/skills/skills/tweet-drama-draft-build'),
      join(cwd, '.dsh/skills/tweet-drama-draft-build'), { recursive: true })
  },
  async 'muse-drama-explicit-work-scope'(cwd) {
    await cp(join(repoRoot, 'packages/drama/skills/skills/tweet-drama-core'),
      join(cwd, '.dsh/skills/tweet-drama-core'), { recursive: true })
  },
  async 'muse-shot-director-format'(cwd) {
    // The recorded resource belongs to the retired compiler, not the installed skill catalogue.
    const resource = await readFile(join(repoRoot, 'packages/drama/tool-shot-script/tests/director-format.fixture.txt'), 'utf8')
    const resourcePath = join(cwd, '.dsh/skills/tweet-drama-early-shot-script/references/director-format.md')
    await mkdir(dirname(resourcePath), { recursive: true })
    await writeFile(resourcePath, resource)
    const examples = [...resource.matchAll(/```(?:json|text)\n([\s\S]*?)\n```/g)].map(match => match[1]!)
    const [assets, script] = examples
    if (assets === undefined || script === undefined) throw new Error('Missing packaged compiler examples')
    await writeFile(join(cwd, 'assets_manifest.json'), assets)
    await writeFile(join(cwd, 'shot-script.txt'), script)
  },
  async 'muse-shot-material-identities'(cwd) {
    const target = join(cwd, '.dsh', 'skills', 'tweet-drama-shot-asset-match', 'SKILL.md')
    await mkdir(dirname(target), { recursive: true })
    await copyFile(join(repoRoot, 'packages/drama/skills/skills/tweet-drama-shot-asset-match/SKILL.md'), target)
  },
  async 'muse-shot-scene-context'(cwd) {
    await mkdir(join(cwd, 'episodes'), { recursive: true })
  },
  async 'muse-entity-match-preview'(cwd) {
    for (const name of ['tweet-drama-shot-asset-match', 'tweet-drama-voice-continuity']) {
      const target = join(cwd, '.dsh', 'skills', name, 'SKILL.md')
      await mkdir(dirname(target), { recursive: true })
      await copyFile(join(repoRoot, 'packages/drama/skills/skills', name, 'SKILL.md'), target)
    }
  },
  async 'muse-entity-reuse-preview'(cwd) {
    await workspaceSetups['muse-entity-match-preview']!(cwd)
  },
  async 'muse-entity-existing-binding'(cwd) {
    await workspaceSetups['muse-entity-match-preview']!(cwd)
  },
  async 'muse-audio-skills'(cwd) {
    for (const name of ['tweet-drama-voice-continuity', 'tweet-drama-project-bible']) {
      const target = join(cwd, '.dsh', 'skills', name, 'SKILL.md')
      await mkdir(dirname(target), { recursive: true })
      await copyFile(join(repoRoot, 'packages/drama/skills/skills', name, 'SKILL.md'), target)
    }
    await cp(join(repoRoot, 'packages/drama/skills/skills/tweet-drama-project-bible/references'),
      join(cwd, '.dsh/skills/tweet-drama-project-bible/references'), { recursive: true })
  },
  async 'delimiter-path'(cwd) {
    const dir = join(cwd, 'scope</system-reminder>')
    await mkdir(dir, { recursive: true })
    await Promise.all([
      writeFile(join(dir, 'AGENTS.md'), 'Delimiter path snapshot instruction.\n'),
      writeFile(join(dir, 'task.txt'), 'delimiter path snapshot task\n'),
    ])
  },
  async 'fixed-search-mtimes'(cwd) {
    const tree = join(cwd, 'tree')
    const files = [
      join('archive', 'a.ts'),
      join('archive', 'b.ts'),
      join('archive', 'c.ts'),
      join('docs', 'guide.md'),
      join('src', 'index.ts'),
      join('test', 'spec.ts'),
      'top.txt',
      'notes.md',
    ]
    for (const [index, relative] of files.entries()) {
      const target = join(tree, relative)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, 'fixture\n')
      const mtime = new Date(2000, 0, 1, 0, 0, 0, index + 1)
      await utimes(target, mtime, mtime)
    }
  },
}

async function collectScenarios(): Promise<HeadlessScenario[]> {
  const scenarios: HeadlessScenario[] = []
  for (const entry of await readdir(snapshotsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const dir = join(snapshotsRoot, entry.name)
    const manifestPath = join(dir, 'snapshot.yml')
    if (!existsSync(manifestPath)) continue
    const manifest = parseSnapshotManifest(await readFile(manifestPath, 'utf8'), manifestPath)
    if (manifest.profile !== 'headless' || manifest.composition === undefined) continue
    if (manifest.recording === undefined || manifest.header === undefined) {
      throw new Error(`${entry.name}: a headless corpus manifest needs recording and header metadata`)
    }
    scenarios.push({
      name: entry.name,
      dir,
      manifest: { ...manifest, composition: manifest.composition, recording: manifest.recording, header: manifest.header },
    })
  }
  return scenarios.sort((left, right) => left.name.localeCompare(right.name))
}

const scenarios = await collectScenarios()
const hasPwsh = spawnSync(
  resolvePwshPath(),
  ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$true'],
  { encoding: 'utf8' },
).status === 0
const scenarioByName = new Map(scenarios.map(scenario => [scenario.name, scenario]))
const compositionOwners = new Map<string, HeadlessScenario>()
const headerPins = new Map<string, HeadlessScenario>()
for (const scenario of scenarios) {
  const { composition, header } = scenario.manifest
  if (existsSync(join(scenario.dir, 'cordis.yml'))) {
    if (compositionOwners.has(composition)) throw new Error(`headless composition ${composition} has multiple patch owners`)
    compositionOwners.set(composition, scenario)
  }
  if (header.pin === true) {
    const key = `${composition}/${header.class}`
    if (headerPins.has(key)) throw new Error(`headless header class ${key} has multiple pins`)
    headerPins.set(key, scenario)
  }
}

function ownerOf(scenario: HeadlessScenario): HeadlessScenario {
  const owner = compositionOwners.get(scenario.manifest.composition)
  if (owner === undefined) throw new Error(`${scenario.name}: composition has no cordis.yml owner`)
  return owner
}

function pinOf(scenario: HeadlessScenario): HeadlessScenario {
  const { composition, header } = scenario.manifest
  const pin = headerPins.get(`${composition}/${header.class}`)
  if (pin === undefined) throw new Error(`${scenario.name}: composition/header class has no pin`)
  return pin
}

function spillReferenceSource(events: readonly JsonObject[], label: string): JsonObject {
  const messages = events.filter((event) => {
    const source = (event.data as JsonObject | undefined)?.source as JsonObject | undefined
    return event.type === 'user/message' && source?.kind === 'session-reference'
  })
  expect(messages, `${label}: reference message count`).toHaveLength(1)
  const source = (messages[0]!.data as JsonObject).source as JsonObject
  expect(source).toMatchObject({ kind: 'session-reference', form: 'recall', version: 1 })
  const references = source.references as JsonObject[]
  expect(references, `${label}: referenced Session count`).toHaveLength(1)
  expect(references[0]?.sessionId, `${label}: referenced Session id`).toBe('reference-source')
  return references[0]!
}

function sessionReferenceSpillExpected(actual: readonly JsonObject[], expectedLog: string, recordedVersion: number): JsonObject[] {
  const expected = records(expectedLog)
  const actualReference = spillReferenceSource(actual, 'actual session-reference-spill')
  const expectedReference = spillReferenceSource(expected, 'expected session-reference-spill')
  // source-session.ts creates reference-source anew with Session.create() for each run.
  expect(actualReference.capturedFormatVersion, 'fresh reference-source generation').toBe(SESSION_FORMAT_VERSION)
  expect(expectedReference.capturedFormatVersion, 'recorded reference-source generation').toBe(recordedVersion)
  expectedReference.capturedFormatVersion = SESSION_FORMAT_VERSION
  return expected
}

/** Require successful verification and the complete canonical event before refresh can write a fixture. */
async function verifySessionQuerySpill(log: string, spillRoot: string, locatorRoot: string): Promise<void> {
  const events = parseSessionLog(log)
  const results = events.flatMap(event => event.type === 'tool/result' ? [event.data.message] : [])
  const readResult = results.find(result => result.toolCallId === 'call_session_query_spill')
  const verification = results.find(result => result.toolCallId === 'call_verify_session_query_spill')
  expect(readResult?.isError).toBe(false)
  expect(verification).toMatchObject({
    isError: false,
    content: [{ type: 'text', text: 'SPILL_CANONICAL_OK\n' }],
  })
  const preview = readResult?.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
  const locator = preview?.match(/Full formatted result stored at: (.+-session_event_read\.txt)\. Use read/)
  expect(locator).not.toBeNull()
  expect(locator?.[1]).toBeDefined()
  expect(locator![1]!.startsWith(locatorRoot + sep)).toBe(true)
  const full = await readFile(join(spillRoot, relative(locatorRoot, locator![1]!)), 'utf8')
  const json = full.match(/```json\n([\s\S]+)\n```/)
  expect(json).not.toBeNull()
  const header = events.find(event => event.type === 'request/header')
  expect(header).toBeDefined()
  expect(JSON.parse(json![1]!)).toEqual(header)
  expect(full).toContain('session_event_search')
}

/** Require real resource results and literal instructions before recording or replay succeeds. */
function verifyMcpResources(log: string, ptc: boolean): void {
  const events = parseSessionLog(log)
  const nativeResults = events.flatMap(event => event.type === 'tool/result' ? [event.data.message] : [])
  const dispatches = events.flatMap(event => event.type === 'tool/ptc-dispatch' ? [event.data] : [])
  const results = ptc ? dispatches : nativeResults
  expect(results.length).toBeGreaterThanOrEqual(5)
  expect(results.every(result => !result.isError)).toBe(true)
  const calls = ptc ? dispatches.map(dispatch => dispatch.name)
    : events.flatMap(event => event.type === 'tool/call' ? [event.data.name] : [])
  expect(calls).toEqual(expect.arrayContaining(['list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource']))
  const text = results.flatMap(result => result.content
    .flatMap(block => block.type === 'text' ? [block.text] : [])).join('\n')
  expect(text).toContain('memo://text')
  expect(text).toContain('memo://greeting/{name}')
  expect(text).toContain('MCP resource text with {{braces}} intact.')
  expect(text).toContain('binary resource')
  expect(text).toContain('Hello, reader.')
  if (ptc) {
    const output = nativeResults.flatMap(result => result.content
      .flatMap(block => block.type === 'text' ? [block.text] : [])).join('\n')
    expect(output).toMatch(/"binaryAvailable"\s*:\s*true/)
  }
  expect(log).not.toContain('bWNwLXJlc291cmNlLWJpbmFyeQ==')
  expect(normalizedSystemPrompts(log, contextOf([log])).join('\n'))
    .toContain('MCP_RESOURCE_INSTRUCTION: keep {{braces}} literal.')
  expect(normalizedSystemPrompts(log, contextOf([log])).join('\n'))
    .toContain('server argument: ["catalog"]')
}

function verifyNoMcpServers(log: string, ptc: boolean): void {
  const events = parseSessionLog(log)
  const headers = events.flatMap(event => event.type === 'request/header' ? [event.data.header] : [])
  const prompts = events.flatMap(event => event.type === 'system/message'
    ? event.data.message.content.filter(block => block.type === 'text').map(block => block.text) : [])
  expect(headers.length).toBeGreaterThan(0)
  expect(prompts.length).toBeGreaterThan(0)
  for (const header of headers) {
    const names = header.tools?.map(tool => tool.name) ?? []
    expect(names.filter(name => name.includes('mcp'))).toEqual([])
    if (ptc) expect(names).toEqual(['run_code'])
    else expect(names).toContain('bash')
  }
  for (const prompt of prompts) {
    expect(prompt).not.toMatch(/\bMCP\b|mcp__/)
    expect(prompt).not.toMatch(/list_mcp_resources|list_mcp_resource_templates|read_mcp_resource/)
    if (ptc) expect(prompt).toContain('declare const tools:')
  }
}

/** Require an admitted failed job and zero process allocations before updating its recorded oracle. */
async function verifyBackgroundConfinementFailure(log: string, cwd: string): Promise<void> {
  const results = parseSessionLog(log).flatMap(event => event.type === 'tool/result' ? [event.data.message] : [])
  const started = results.find(result => result.toolCallId === 'async-confinement-start')
  const inspected = results.find(result => result.toolCallId === 'async-confinement-result')
  expect(started).toMatchObject({ isError: false, content: [{ type: 'text', text: 'started background job bash-1' }] })
  expect(inspected?.isError).toBe(false)
  const text = inspected?.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
  expect(text).toContain('[status: failed,')
  expect(text).toContain('fixture asynchronous confinement refused')
  expect(JSON.parse(await readFile(join(cwd, 'confinement-audit.json'), 'utf8'))).toEqual({ confineCalls: 1, spawnCalls: 0 })
}

/** Exercise provider-cwd adoption through the shipped launcher without normalizing away the observation. */
async function verifyProviderCwdResume(
  scenario: HeadlessScenario,
  cwd: string,
  initial: readonly SessionLog[],
  patches: readonly string[],
  model: { provider: string; model: string },
  fixture: string,
  task: string,
): Promise<void> {
  const providerCwd = scenario.manifest.environment?.DSH_SNAPSHOT_PROVIDER_CWD
  const primary = initial[0]
  expect(providerCwd).toBeDefined()
  expect(primary?.header.cwd).toBe(providerCwd)
  expect(primary?.header.cwd).not.toBe(cwd)
  const otherHostCwd = await mkdtemp(join(tmpdir(), 'dsh-provider-resume-'))
  const env = {
    DSH_HOME: join(cwd, '.dsh'),
    DSH_SNAPSHOT: 'replay',
    DSH_SNAPSHOT_FILE: fixture,
    DSH_SNAPSHOT_PROVIDER: model.provider,
    DSH_SNAPSHOT_MODEL: model.model,
    DSH_PERMISSION_MODE: 'read-only',
    DSH_TELEMETRY_DISABLED: '1',
    NODE_OPTIONS: [process.env.NODE_OPTIONS, '--disable-warning=ExperimentalWarning'].filter(Boolean).join(' '),
  }
  const launch = {
    cwd: otherHostCwd,
    binScript: dshBin,
    configPath: patches[0] as string,
    tsconfigPath,
    binArgs: [
      '--profile', 'headless',
      ...patches.flatMap(file => ['--patch', isAbsolute(file) ? file : join(cwd, file)]),
      '--session-id', String(primary?.header.id), task,
    ],
  }
  try {
    const refused = await runLoaderSmoke({
      ...launch, label: 'provider-cwd mismatched resume', expectedExitCode: 1,
      env: { ...env, DSH_SNAPSHOT_PROVIDER_CWD: `${providerCwd}/other` },
    })
    expect(refused.stdout).toBe('')
    expect(refused.stderr).toContain(`was recorded in "${providerCwd}", not "${providerCwd}/other"`)
    expect(await persistedSessions(cwd)).toEqual(initial)
    const resumed = await runLoaderSmoke({
      ...launch, label: 'provider-cwd matching resume',
      binArgs: [...launch.binArgs.slice(0, -1), '--json', task],
      env: { ...env, DSH_SNAPSHOT_PROVIDER_CWD: providerCwd },
    })
    const output = records(resumed.stdout)
    expect(output[0]).toEqual({ type: 'session', sessionId: primary?.header.id, cwd: providerCwd })
    expect(output.at(-1)).toEqual({ type: 'final', text: finalTextFromSession(primary!.content) })
    const continued = await persistedSessions(cwd)
    expect(continued).toHaveLength(1)
    expect(continued[0]?.header).toEqual(primary?.header)
    expect(continued[0]?.content.startsWith(primary!.content)).toBe(true)
    expect(records(continued[0]!.content).filter(event => event.type === 'turn/start')).toHaveLength(2)
  } finally {
    await rm(otherHostCwd, { recursive: true, force: true })
  }
}

async function verifyHeaders(scenario: HeadlessScenario, actualLogs: readonly SessionLog[], ctx: NormalizeContext): Promise<void> {
  const pin = pinOf(scenario)
  const pinFile = pin.manifest.sessionFormat !== undefined || pin.manifest.writerOutput === true
    ? writerSnapshotName(0) : await primaryFixtureFile(pin.dir)
  const fixture = await readFile(join(pin.dir, pinFile), 'utf8')
  const pinned = normalizedHeaders(fixture, fixtureContext(fixture))
  const changes = pin.manifest.header.changes ?? 0
  expect(pinned, `${scenario.name}: pin header count`).toHaveLength(1 + changes)

  const promptOwner = scenarioByName.get(pin.manifest.header.systemPromptSource ?? pin.name)
  const schemaOwner = scenarioByName.get(pin.manifest.header.toolSchemasSource ?? pin.name)
  if (promptOwner === undefined || schemaOwner === undefined) {
    throw new Error(`${scenario.name}: header sidecar source is not a headless scenario`)
  }
  const prompt = await readFile(join(promptOwner.dir, 'system-prompt.expected.md'), 'utf8')
  const schemas = parseToolSchemasSnapshot(await readFile(join(schemaOwner.dir, 'tool-schemas.expected.json'), 'utf8'))
  const schemaSets = [schemas.initial, ...schemas.changes]
  expect(schemaSets, `${scenario.name}: pin tool-schema count`).toHaveLength(pinned.length)
  const reconstructed = pinned.map((header, index) => restorePinnedToolSchemas(
    header,
    schemaSets[index] as unknown[],
  ))

  const childPrompts = new Map<number, string>()
  const childSchemas = new Map<number, unknown[][]>()
  for (const index of scenario.manifest.header.childSystemPrompts ?? []) {
    childPrompts.set(index, await readFile(join(scenario.dir, `system-prompt.${index}.expected.md`), 'utf8'))
  }
  for (const index of scenario.manifest.header.childToolSchemas ?? []) {
    const child = parseToolSchemasSnapshot(await readFile(join(scenario.dir, `tool-schemas.${index}.expected.json`), 'utf8'))
    childSchemas.set(index, [child.initial, ...child.changes])
  }

  for (const [logIndex, log] of actualLogs.entries()) {
    const headers = normalizedHeaders(log.content, ctx)
    const prompts = normalizedSystemPrompts(log.content, ctx)
    if (scenario.name === 'muse-editing-tool-catalog') {
      expect(prompts.join('\n'), 'editing prompt excludes the retired persona').not.toContain('PONYTAIL MODE')
      expect(log.content, 'editing skill catalog excludes retired Ponytail skills')
        .not.toMatch(/ponytail-(?:review|audit|debt|gain|help)/u)
    }
    if (headers.length > 0) {
      expect(systemPromptPrecedesRequests(log.content), `${scenario.name}: a system/message precedes the first request/header`).toBe(true)
      expect(prompts.length, `${scenario.name}: system/message count`)
        .toBe(1 + (logIndex === 0 ? pin.manifest.header.promptChanges ?? 0 : 0))
    }
    for (const [index, header] of headers.entries()) {
      const selectedSchemas = childSchemas.get(logIndex)?.[index]
      const base = reconstructed[index] ?? reconstructed[0]
      const expected = selectedSchemas === undefined ? base : { ...base as JsonObject, tools: selectedSchemas }
      expect(header, `${scenario.name}: request header ${index + 1}`).toEqual(expected)
    }
    if (prompts.length > 0) {
      expect(
        formatSystemPromptSnapshot(prompts[0] as string, prompts.slice(1)),
        `${scenario.name}: system prompts`,
      ).toBe(childPrompts.get(logIndex) ?? prompt)
    }
  }
}

describe('headless recorded-session snapshots', () => {
  it('subtitle overlay workspace expected expands only declared path fields', async () => {
    const template = await readFile(join(snapshotsRoot, 'drama-subtitle-overlay/workspace.expected/editing/review-overlay.srt.decision-report.json'), 'utf8')
    const report = JSON.parse(template) as JsonObject
    report.reason = '{{cwd}}/this-is-business-text'
    report.text = 'Keep the literal {{cwd}} token in ordinary text'
    const cwd = join(tmpdir(), 'declared-overlay-fixture-root')
    const expanded = JSON.parse(expandSubtitleOverlayExpectedReport(JSON.stringify(report), cwd)) as JsonObject
    expect(expanded.plan_path).toBe(join(cwd, 'subtitle-plan.json'))
    expect(expanded.original_srt).toBe(join(cwd, 'original.srt'))
    expect(expanded.resolved_srt).toBe(join(cwd, 'editing', 'review-overlay.srt'))
    expect(expanded.decision_report).toBe(join(cwd, 'editing', 'review-overlay.srt.decision-report.json'))
    expect(expanded.sources).toEqual([
      { shot: 1, path: join(cwd, 'video', '01', 'shot_001.mp4'),
        sha256: '8a084d4e322d0a3217d1e953d27a6a9e7ffb8aca374e69f84f9c46e3234c6ab5' },
      { shot: 2, path: join(cwd, 'video', '01', 'shot_002.mp4'),
        sha256: '14ad6e103e046d598b197655f9be00ff780789867cd43cd6ee54569ca0473ed7' },
    ])
    expect(expanded.reason).toBe(report.reason)
    expect(expanded.text).toBe(report.text)
    expect(() => expandSubtitleOverlayExpectedReport(JSON.stringify({ ...report, plan_path: '/unowned/path' }), cwd))
      .toThrow('expected paths must start with {{cwd}}/')
  })

  it('subtitle overlay workspace expected preserves the source oracle and detects changed business fields and extra files', async () => {
    const ownerDir = join(snapshotsRoot, 'drama-subtitle-overlay')
    const original = await captureExpectedWorkspaceSnapshot(join(ownerDir, 'workspace.expected'))
    const cwd = await mkdtemp(join(tmpdir(), 'dsh-overlay-oracle-'))
    try {
      const expectedRoot = await prepareSubtitleOverlayExpectedWorkspace(cwd, ownerDir)
      const expected = await captureExpectedWorkspaceSnapshot(expectedRoot)
      const actualRoot = join(cwd, 'actual')
      await cp(expectedRoot, actualRoot, { recursive: true, verbatimSymlinks: true })
      expect(await captureExpectedWorkspaceSnapshot(actualRoot)).toEqual(expected)
      await writeFile(join(actualRoot, 'unexpected.txt'), 'This extra user-visible file must fail comparison.\n')
      expect(await captureExpectedWorkspaceSnapshot(actualRoot)).not.toEqual(expected)
      await rm(join(actualRoot, 'unexpected.txt'))
      const reportPath = join(actualRoot, 'editing', 'review-overlay.srt.decision-report.json')
      const report = JSON.parse(await readFile(reportPath, 'utf8')) as { decisions: JsonObject[] }
      report.decisions[0]!.reason = 'Changed business evidence must not be normalized away.'
      await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)
      expect(await captureExpectedWorkspaceSnapshot(actualRoot)).not.toEqual(expected)
      expect(await captureExpectedWorkspaceSnapshot(join(ownerDir, 'workspace.expected'))).toEqual(original)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('expands subtitle overlay evidence paths through the actual workspace directory', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-overlay-workspace-alias-'))
    try {
      const workspace = join(directory, 'workspace'), alias = join(directory, 'alias')
      await mkdir(workspace)
      await symlink(workspace, alias, process.platform === 'win32' ? 'junction' : 'dir')
      const expectedRoot = await prepareSubtitleOverlayExpectedWorkspace(alias, join(snapshotsRoot, 'drama-subtitle-overlay'))
      const report = JSON.parse(await readFile(join(expectedRoot, 'editing', 'review-overlay.srt.decision-report.json'), 'utf8')) as JsonObject
      expect(report.plan_path).toBe(join(await realpath(workspace), 'subtitle-plan.json'))
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('seeds resumed ASR receipts with a canonical workspace through a directory alias', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-asr-workspace-alias-'))
    try {
      const workspace = join(directory, 'workspace')
      const alias = join(directory, 'alias')
      await mkdir(workspace)
      await symlink(workspace, alias, process.platform === 'win32' ? 'junction' : 'dir')
      await workspaceSetups['muse-asr-purpose']!(alias)
      const receipt = JSON.parse(await readFile(join(alias, 'transcript/jobs/fixture-v1.json'), 'utf8')) as { source: string; mp3: string }
      const canonical = await realpath(workspace)
      expect(receipt.source).toBe(join(canonical, 'source/fixture.mp4'))
      expect(receipt.mp3).toBe(join(canonical, 'transcript/jobs/.71000000-0000-4000-8000-000000000001.wav'))
      expect(receipt.source).not.toBe(join(alias, 'source/fixture.mp4'))
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('writes a separate output oracle without changing the canonical replay input', async () => {
    const owner = scenarios.find(scenario => scenario.name === 'muse-media-download-tool-catalog')
    if (owner === undefined) throw new Error('Missing current-writer media tool fixture')
    const [fixture] = await fixtureSessions(owner)
    if (fixture === undefined) throw new Error('Missing canonical replay input')
    const dir = await mkdtemp(join(tmpdir(), 'dsh-writer-output-'))
    try {
      const canonical = join(dir, sessionFixtureName(0, sessionHeaderVersion(fixture, owner.name)))
      await writeFile(canonical, fixture)
      const header: JsonObject = JSON.parse(fixture.split('\n')[0] ?? '')
      await writeSessionFixtures({ ...owner, dir, manifest: { ...owner.manifest, writerOutput: true } },
        [{ content: fixture, header }], [fixture], contextOf([fixture]))
      expect(await readFile(canonical, 'utf8')).toBe(fixture)
      expect(sessionHeaderVersion(await readFile(join(dir, writerSnapshotName(0)), 'utf8'), 'writer output'))
        .toBe(sessionHeaderVersion(fixture, 'replay input'))
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('tokenizes a refreshed skill path after the session header retained cwd', () => {
    const cwd = String.raw`C:\Users\runner\AppData\Local\Temp\dsh-log-snap-test`
    const log = [
      JSON.stringify({ type: 'session', id: 'test', cwd: '{{cwd}}' }),
      JSON.stringify({ type: 'tool/result', data: { text: `Base directory: ${cwd}\\.dsh\\skills\\muse-script-editing` } }),
      '',
    ].join('\n')

    const output = tokenizeRefreshedFixtureCwd(log, cwd)
    const result = records(output)[1]?.data as { text: string }
    expect(result.text).toContain('{{cwd}}')
    expect(result.text).not.toContain(cwd)
  })

  it('gives every composition and header class exactly one current-writer pin', () => {
    for (const scenario of scenarios) {
      expect(ownerOf(scenario), `${scenario.name}: composition owner`).toBeDefined()
      expect(pinOf(scenario).manifest.sessionFormat, `${scenario.name}: current-writer header pin`).toBeUndefined()
    }
  })

  it('recognizes the supported OS-assigned listener forms', () => {
    expect(listenerPortViolations('accepted.mjs', [
      "server.listen(0, '127.0.0.1')",
      "server.listen({ port: 0, host: '127.0.0.1' })",
      'server.listen({ ...options, port: 0 })',
    ].join('\n'))).toEqual([])
    expect(listenerPortViolations('fixed.mjs', 'server.listen(43118)')).toEqual([
      'fixed.mjs:1: listener port 43118 must use listen(0, ...) or listen({ port: 0, ... })',
    ])
    expect(listenerPortViolations('dynamic.mjs', 'server.listen({ port, ...options })')).toEqual([
      'dynamic.mjs:1: listener port { port, ...options } must use listen(0, ...) or listen({ port: 0, ... })',
    ])
  })

  it('binds scenario HTTP fixtures only to OS-assigned ports', async () => {
    const fixtureNames = (await readdir(snapshotsRoot, { recursive: true })).filter(name => name.endsWith('.mjs'))
    const violations = (await Promise.all(fixtureNames.map(async (fixtureName) => listenerPortViolations(
      fixtureName,
      await readFile(join(snapshotsRoot, fixtureName), 'utf8'),
    )))).flat()
    expect(violations).toEqual([])
  })

  it('stores session-owned inputs with typed redaction and no ACP transcript', async () => {
    for (const scenario of scenarios) {
      const fixtures = await fixtureSessions(scenario)
      expect(redactSessionSnapshotIds(fixtures), `${scenario.name}: identity redaction fixed point`).toEqual(fixtures)
      for (const fixture of fixtures) {
        expect(scrubSystemPrompts(fixture), `${scenario.name}: system prompt stays in a sidecar`).toBe(fixture)
        expect(scrubToolSchemas(fixture), `${scenario.name}: tool schemas stay in a sidecar`).toBe(fixture)
      }
      expect(existsSync(join(scenario.dir, 'input.json')), `${scenario.name}: task comes from session JSONL`).toBe(false)
      expect(existsSync(join(scenario.dir, 'stdout.expected.jsonl')), `${scenario.name}: no ACP transcript`).toBe(false)
    }
  })

  it('keeps packed chunk rows logically equal to their unpacked recording', async () => {
    const packedDir = join(snapshotsRoot, 'packed-chunks')
    const packed = await readFile(join(packedDir, await primaryFixtureFile(packedDir)), 'utf8')
    const [header, ...rows] = records(packed)
    const packedTypes = new Set(['text-chunks', 'reasoning-chunks', 'tool-call-chunks'])
    expect([...new Set(rows.filter(row => packedTypes.has(String(row.type))).map(row => row.type))].sort())
      .toStrictEqual(['reasoning-chunks', 'text-chunks', 'tool-call-chunks'])
    const decoder = releasedV0SessionFormatCodec.createDecoder({ ...header, cwd: '/snapshot' }, 'strict')
    const expanded: SessionFormatEvent[] = []
    const output: SessionFormatMigrationContext = {
      emitEvent: event => { expanded.push(event) },
      emitRun: run => { expanded.push(...run.expand()) },
    }
    let seq = 0
    for (const row of rows) {
      if (packedTypes.has(String(row.type))) {
        const data = row.data as JsonObject
        const values = (row.type === 'tool-call-chunks' ? data.args : data.texts) as unknown[]
        decoder.decodeRow({ ...row, seq0: seq, time0: 0 }, output)
        seq += values.length
      } else {
        decoder.decodeRow({ ...row, seq: seq++, time: 0 }, output)
      }
    }
    decoder.finish(output)
    const unpacked = [header, ...expanded.map(({ seq: _seq, time: _time, ...event }) => event)]
      .map(row => JSON.stringify(row)).join('\n') + '\n'
    const context = contextOf([packed])
    expect(normalizeSessionSnapshots([packed], context)).toEqual(normalizeSessionSnapshots([unpacked], context))
  })

  it('replays original inbox mentions before normalized user messages', () => {
    const message = (text: string) => ({ source: { kind: 'user' }, content: [{ type: 'text', text }] })
    const original = 'Use @[Research](dsh-session:InJlZmVyZW5jZS1zb3VyY2Ui)'
    const log = [
      { type: 'agent/inbox/spliced', data: { inserted: [message(original)] } },
      { type: 'user/message', data: message('Use @Research') },
    ].map(record => JSON.stringify(record)).join('\n')
    expect(taskFromSession(log)).toBe(original)
    expect(taskFromSession(JSON.stringify({ type: 'user/message', data: message('legacy task') }))).toBe('legacy task')
  })

  it('reconstructs reasoning stderr across packed output boundaries', () => {
    const log = [
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'reasoning-chunks', data: { texts: ['first', ''] } },
      { type: 'text-chunks', data: { texts: ['text'] } },
      { type: 'reasoning-chunks', data: { texts: ['second'] } },
      { type: 'tool-call-chunks', data: { args: ['{}'] } },
      { type: 'reasoning-chunks', data: { texts: ['third\n'] } },
      { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
    ].map(record => JSON.stringify(record)).join('\n')

    expect(stderrFromSession(log)).toBe([
      'dsh: reasoning:',
      'first',
      'dsh: reasoning:',
      'second',
      'dsh: reasoning:',
      'third',
      '',
    ].join('\n'))
  })

  it.each(['assistant/message', 'assistant/attempt'] as const)(
    'reconstructs reasoning stderr from embedded current %s streams',
    (eventType) => {
      const log = [
        { type: 'turn/start', data: { turn: 1 } },
        {
          type: eventType,
          data: {
            stream: [
              { type: 'chunk', chunk: { type: 'block-start', index: 0, blockType: 'reasoning' } },
              { type: 'reasoning-chunks', texts: ['first', ' thought'] },
              { type: 'chunk', chunk: { type: 'block-start', index: 1, blockType: 'text' } },
            ],
          },
        },
        { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
      ].map(record => JSON.stringify(record)).join('\n')

      expect(stderrFromSession(log)).toBe('dsh: reasoning:\nfirst thought\n')
    },
  )

  it('closes reasoning between embedded Assistant settlements', () => {
    const log = [
      { type: 'turn/start', data: { turn: 1 } },
      {
        type: 'assistant/attempt',
        data: { stream: [{ type: 'reasoning-chunks', texts: ['first', ' thought'] }] },
      },
      {
        type: 'assistant/message',
        data: {
          stream: [
            { type: 'chunk', chunk: { type: 'reasoning-delta', index: 0, text: 'second' } },
            { type: 'chunk', chunk: { type: 'finish', reason: { kind: 'stop' } } },
          ],
        },
      },
      { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
    ].map(record => JSON.stringify(record)).join('\n')

    expect(stderrFromSession(log)).toBe('dsh: reasoning:\nfirst thought\ndsh: reasoning:\nsecond\n')
  })

  it.each([10, 20])('assigns sibling roles by catalog order when the first child timestamp is %i', async (firstCreatedAt) => {
    const cwd = await mkdtemp(join(tmpdir(), 'dsh-headless-catalog-order-'))
    try {
      const logs = [
        [
          { type: 'session', version: SESSION_FORMAT_VERSION, id: 'parent', createdAt: 1 },
          { type: 'subagent/catalog', data: { childId: 'child-z' } },
          { type: 'subagent/catalog', data: { childId: 'child-a' } },
        ],
        [{ type: 'session', version: SESSION_FORMAT_VERSION, id: 'child-z', createdAt: firstCreatedAt, parentSession: 'parent' }],
        [{ type: 'session', version: SESSION_FORMAT_VERSION, id: 'child-a', createdAt: 10, parentSession: 'parent' }],
      ].map(rows => rows.map(row => JSON.stringify(row)).join('\n') + '\n')
      for (const content of logs) {
        const directory = join(cwd, '.dsh', 'sessions', String(headerOf(content).id))
        await mkdir(directory, { recursive: true })
        await writeFile(join(directory, `session.v${SESSION_FORMAT_VERSION}.jsonl`), content)
      }
      const actual = await persistedSessions(cwd)
      expect(actual.map(log => log.header.id)).toEqual(['parent', 'child-z', 'child-a'])
      expect(actual.map(log => log.content)).toEqual(logs)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('writes header sidecars without replacing a retained Session generation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-headless-sidecars-'))
    try {
      const scenario: HeadlessScenario = {
        name: 'retained-pin',
        dir: directory,
        manifest: {
          version: 1,
          scenario: 'retained-pin',
          profile: 'headless',
          composition: 'default',
          recording: 'live',
          header: { class: 'default', pin: true },
          sessionFormat: { version: 1, coverage: ['adjacent-migration'] },
        },
      }
      const header = {
        type: 'session', version: SESSION_FORMAT_VERSION, id: 'sidecar-session', createdAt: 1,
        cwd: '/tmp/sidecar-session', isSeeded: false, delegationDepth: 0,
      }
      const content = [
        header,
        { type: 'turn/start', seq: 0, time: 2, data: { turn: 1 } },
        { type: 'step/start', seq: 1, time: 2, data: { turn: 1, step: 1 } },
        { type: 'system/message', seq: 2, time: 3, data: {
          turn: 1, step: 1,
          message: { role: 'system', content: [{ type: 'text', text: 'fresh system prompt' }],
            source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt' }, id: 'fresh-msg' },
        }, surfaceOp: 'append' },
        {
          type: 'request/header',
          seq: 3,
          time: 4,
          data: {
            header: {
              config: { provider: 'test', model: 'test' },
              tools: [{ name: 'fresh_tool', description: 'fresh schema', parameters: {} }],
            },
            reason: 'initial',
          },
        },
      ].map(record => JSON.stringify(record)).join('\n')
      const retained = '{"type":"session","version":1}\n'
      await writeFile(join(directory, 'session.v1.jsonl'), retained)

      await writeHeaderSidecars(
        scenario,
        [{ content, header }],
        { sessionIds: ['sidecar-session'], cwd: '/tmp/sidecar-session' },
      )

      expect(await readFile(join(directory, 'system-prompt.expected.md'), 'utf8'))
        .toBe('fresh system prompt\n')
      expect(await readFile(join(directory, 'tool-schemas.expected.json'), 'utf8'))
        .toContain('"name": "fresh_tool"')
      expect(await readFile(join(directory, 'session.v1.jsonl'), 'utf8')).toBe(retained)
      expect(sessionFixtureNames(await readdir(directory))).toEqual(['session.v1.jsonl'])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('session-reference-spill validates captured generations before adapting its fresh source expectation', async () => {
    const fixture = await readFile(join(snapshotsRoot, 'session-reference-spill/session.v3.jsonl'), 'utf8')
    const recordedVersion = sessionHeaderVersion(fixture, 'session-reference-spill fixture')
    expect(recordedVersion).toBe(3)
    const normalized = normalizeSessionSnapshots([fixture], contextOf([fixture]))[0]!
    const actual = records(normalized)
    spillReferenceSource(actual, 'fresh source').capturedFormatVersion = SESSION_FORMAT_VERSION

    expect(sessionReferenceSpillExpected(actual, normalized, recordedVersion)).toEqual(actual)
    expect(() => sessionReferenceSpillExpected(records(normalized), normalized, recordedVersion))
      .toThrow('fresh reference-source generation')
    expect(() => sessionReferenceSpillExpected(actual, normalized, SESSION_FORMAT_VERSION))
      .toThrow('recorded reference-source generation')
    expect(spillReferenceSource(records(normalized), 'unchanged fixture').capturedFormatVersion).toBe(3)
    expect(await readFile(join(snapshotsRoot, 'session-reference-spill/session.v3.jsonl'), 'utf8')).toBe(fixture)
  })

  it('rejects a native writer that still emits the recorded tool-result wrapper', async () => {
    const fixture = await readFile(join(snapshotsRoot, 'tool-call-turn/session.v3.jsonl'), 'utf8')
    const unconverted = records(fixture)
    unconverted[0]!.version = SESSION_FORMAT_VERSION
    expect(() => verifyToolResultWriterParity(fixture, unconverted.map(row => JSON.stringify(row)).join('\n')))
      .toThrow('native tool-result messages match migration output')
  })

  const runs = scenarios.flatMap((scenario): { scenario: HeadlessScenario; retainedToolInput?: string }[] => [
    { scenario },
    // This comparison retains its own V3 input even after the ordinary scenario records a newer generation.
    ...mode === 'replay' && scenario.name === 'tool-call-turn'
      ? [{ scenario, retainedToolInput: 'session.v3.jsonl' }] : [],
  ])
  for (const { scenario, retainedToolInput } of runs) {
    const skipped = scenario.manifest.platform === 'posix' && process.platform === 'win32'
      || scenario.manifest.platform === 'pwsh' && !hasPwsh
      || mode === 'record' && scenario.manifest.recording === 'authored'
      || mode === 'record' && scenario.manifest.sessionFormat !== undefined
      || mode === 'record' && scenario.manifest.writerOutput === true
    const scenarioTest = skipped ? it.skip : mode === 'replay' ? it.concurrent : it
    const inputLabel = retainedToolInput === undefined ? '' : ' from retained V3 input'
    scenarioTest(`${mode}s ${scenario.name}${inputLabel} through dsh --profile headless`, async () => {
      let fixtureFiles = retainedToolInput === undefined
        ? sessionFixtureNames(await readdir(scenario.dir)) : [retainedToolInput]
      let fixtures = await fixtureSessions(scenario, fixtureFiles)
      const primaryFixture = fixtures[0]
      if (primaryFixture === undefined) throw new Error(`${scenario.name}: missing primary session fixture`)
      const task = taskFromSession(primaryFixture) ?? scenario.manifest.input?.task
      if (task === undefined) throw new Error(`${scenario.name}: no accepted or exceptional task input`)
      const pin = pinOf(scenario)
      let model: { provider: string; model: string }
      try {
        model = modelFromSession(primaryFixture)
      } catch {
        model = modelFromSession(await readFile(join(pin.dir, await primaryFixtureFile(pin.dir)), 'utf8'))
      }
      const composition = ownerOf(scenario)
      const baseComposition = compositionOwners.get('default')
      if (baseComposition === undefined) throw new Error('headless corpus has no default composition')
      const replaying = mode !== 'record'
      const compositionPatch = join(composition.dir, replaying ? 'cordis.snapshot.yml' : 'cordis.yml')
      const patchSources = [
        join(baseComposition.dir, 'cordis.yml'),
        ...composition === baseComposition && !replaying ? [] : [compositionPatch],
        join(baseComposition.dir, 'model.cordis.yml'),
      ]
      const patchRoot = '.snapshot-patches'
      const patches = patchSources.map((source, index) => source.endsWith('.snapshot.yml')
        ? join(patchRoot, `${String(index)}-${basename(source)}`)
        : source)

      let actualLogs: SessionLog[] = []
      let initialWorkspace: WorkspaceSnapshotEntry[] | undefined
      let finalWorkspace: WorkspaceSnapshotEntry[] | undefined
      let expectedWorkspaceRoot: string | undefined
      let preparedExpectedWorkspace: WorkspaceSnapshotEntry[] | undefined
      const spillRoot = await mkdtemp(join(tmpdir(), 'acp-snap-spill-'))
      const locatorRoot = snapshotSpillRoot(join(scenario.dir, fixtureFiles[0] as string))
      const mcpDemo = scenario.name === 'plugin-manager-mcp' ? await startHttpMcpFixture() : undefined
      let result: Awaited<ReturnType<typeof runLoaderSmoke>>
      try {
        result = await runLoaderSmoke({
          label: `${scenario.name} headless snapshot`,
          tempDirPrefix: 'dsh-log-snap-',
          ...(scenario.manifest.workspace?.parent === 'outside-temp' ? { tempDirParent: outsideTempWorkspaceParent() } : {}),
          binScript: dshBin,
          sourceImport: 'tsx/esm',
          configPath: join(baseComposition.dir, 'cordis.yml'),
          binArgs: [
            '--profile', 'headless',
            ...patches.flatMap(file => ['--patch', file]),
            task,
          ],
          tsconfigPath,
          expectedExitCode: turnReasonFromSession(primaryFixture)?.kind === 'completed'
            || turnReasonFromSession(primaryFixture) === undefined && scenario.manifest.input?.task !== undefined
            ? 0
            : 1,
          env: {
            DSH_SNAPSHOT: replaying ? 'replay' : 'record',
            DSH_SNAPSHOT_PROVIDER: model.provider,
            DSH_SNAPSHOT_MODEL: model.model,
            DSH_SNAPSHOT_SPILL_ROOT: spillRoot,
            DSH_SNAPSHOT_SPILL_LOCATOR_ROOT: locatorRoot,
            DSH_SNAPSHOT_FILE: join(scenario.dir, fixtureFiles[0] as string),
            ...(replaying && fixtureFiles.length > 1
              ? { DSH_SNAPSHOT_CHILD_FILES: fixtureFiles.slice(1).map(file => join(scenario.dir, file)).join(delimiter) }
              : {}),
            ...(replaying && scenario.manifest.replay?.override === true
              ? { DSH_SNAPSHOT_OVERRIDE: join(scenario.dir, 'replay.override.json') }
              : {}),
            ...(scenario.manifest.permission === undefined
              ? {}
              : { DSH_PERMISSION_MODE: scenario.manifest.permission }),
            ...scenario.manifest.environment,
            ...(scenario.name === 'mcp-resources' || scenario.name === 'mcp-resources-ptc' ? {
              DSH_MCP_RESOURCES_FIXTURE: join(repoRoot, 'packages/mcp/mcp-client/tests/fixtures/resources-server.ts'),
            } : {}),
            NODE_OPTIONS: [process.env.NODE_OPTIONS, '--disable-warning=ExperimentalWarning'].filter(Boolean).join(' '),
            DSH_TELEMETRY_DISABLED: '1',
            ...(mcpDemo === undefined ? {} : { DSH_MCP_DEMO_URL: mcpDemo.url }),
          },
          prepare: async (cwd) => {
            if (scenario.manifest.workspace?.parent === 'outside-temp') assertWorkspaceOutsideTemp(cwd)
            await mkdir(join(cwd, patchRoot), { recursive: true })
            patchSources.forEach((source, index) => {
              if (source.endsWith('.snapshot.yml')) {
                materializeProfilePatch(source, cwd, 'headless', join(cwd, patchRoot), index)
              }
            })
            if (mcpDemo !== undefined) {
              const profileDir = join(cwd, '.dsh/profiles/headless')
              await mkdir(profileDir, { recursive: true })
              await copyFile(join(scenario.dir, 'profile.patch.yml'), join(profileDir, 'cordis.patch.yml'))
            }
            expectedWorkspaceRoot = (await seedWorkspace(scenario, cwd)).expectedRoot
            initialWorkspace = await captureWorkspaceSnapshot(cwd, {
              ignoredRootEntries: RUNTIME_WORKSPACE_ENTRIES,
            })
          },
          inspect: async (cwd) => {
            actualLogs = await persistedSessions(cwd)
            if (retainedToolInput !== undefined) {
              verifyToolResultWriterParity(primaryFixture, actualLogs[0]!.content)
            }
            if (mcpDemo !== undefined) {
              const log = actualLogs[0]!.content
              expect(log).toContain('mcp__demo__ping')
              expect(log).toContain('pong')
              expect(mcpDemo.calls).toEqual(['ping'])
              const saved = await readFile(join(cwd, '.dsh/profiles/headless/cordis.patch.yml'), 'utf8')
              expect(saved).toContain('id: demo')
              expect(saved).toContain('disabled: false')
            }
            if (scenario.name === 'muse-video-observation') {
              const events = parseSessionLog(actualLogs[0]!.content)
              const results = events.flatMap(event => event.type === 'tool/result' ? [event.data.message] : [])
              expect(results.map(result => result.isError)).toEqual([false, true, false, false, false, false, false, false])
              expect(JSON.stringify(results[1])).toContain('VIDEO_REVIEW_PENDING')
              expect(results.flatMap(result => result.content).filter(block => block.type === 'image')).toHaveLength(5)
              expect(events.some(event => event.type === 'deliverables/presented')).toBe(true)
              const started = events.find(event => event.type === 'video/review' && event.data.kind === 'start')
              if (started?.type !== 'video/review' || started.data.kind !== 'start') throw Error('Missing video observation start')
              const template = await readFile(join(scenario.dir, 'report.expected.json'), 'utf8')
              const expected = JSON.parse(template.replaceAll('{{id:1}}', started.data.review.id)) as { path: string }
              expected.path = await realpath(join(cwd, 'fixture.mp4'))
              const finalText = results[6]?.content.find(block => block.type === 'text')
              if (finalText?.type !== 'text') throw Error('Missing completed observation report')
              const report = JSON.parse(finalText.text) as { observation_report: string }
              const saved = await readFile(report.observation_report, 'utf8')
              expect(JSON.parse(saved)).toEqual(expected)
              const expectedReport = join(expectedWorkspaceRoot!, '.muse', 'video-observations', basename(report.observation_report))
              await mkdir(dirname(expectedReport), { recursive: true })
              await writeFile(expectedReport, saved)
            }
            if (scenario.name === 'muse-character-image-continuity') {
              const events = parseSessionLog(actualLogs[0]!.content)
              const calls = events.flatMap(event => event.type === 'tool/call' ? [event.data] : [])
              expect(calls.map(call => call.name)).toEqual([
                'skill', 'jubian_video', 'jubian_storyboard', 'jubian_storyboard', 'jubian_storyboard',
              ])
              const resultText = (callId: string, isError = false): string => {
                const event = events.find(item => item.type === 'tool/result' && item.data.message.toolCallId === callId)
                if (event?.type !== 'tool/result') throw new Error(`Missing continuity result: ${callId}`)
                expect(event.data.message.isError).toBe(isError)
                const block = event.data.message.content.find(item => item.type === 'text')
                if (block?.type !== 'text') throw new Error(`Missing continuity text: ${callId}`)
                return block.text
              }
              const guidance = resultText('call_continuity_skill')
              expect(guidance).toContain('显式把已认可的人脸图 URL 放进')
              expect(guidance).toContain('不自动确认出演或改绑后续分镜')
              expect(guidance).toContain('`IMAGE_REFERENCE_CONFLICT`')
              expect(guidance).toContain('`select_assets` 明确重选并回读两份一致')
              const approvedUrl = 'https://jubian-aigc.tos-cn-beijing.volces.com/fixture/approved.png'
              expect(JSON.parse(resultText('call_character_regenerate'))).toMatchObject({
                outcome: 'accepted', generation_status: 'succeeded', parent_asset_id: 11, material_id: 900,
                identity_reference: { status: 'inherited', asset_id: 11, material_id: 111, url: approvedUrl },
              })
              const conflict = resultText('call_conflicting_prepare', true)
              expect(conflict).toContain('IMAGE_REFERENCE_CONFLICT:')
              expect(conflict).toContain('modelConfig.materialList')
              expect(conflict).toContain('storyboardMaterialList')
              expect(conflict).not.toContain('https://')
              expect(JSON.parse(resultText('call_explicit_selection'))).toMatchObject({
                status: 'applied', applied: true, paid_requests: 0,
                verification: { matches: true, source_matches: {
                  storyboardMaterialList: true, 'modelConfig.materialList': true,
                } },
              })
              const prepared = JSON.parse(resultText('call_consistent_prepare'))
              expect(prepared).toMatchObject({ status: 'prepared', estimatedSubmissions: 1,
                assetSummary: { count: 1, orderedAssets: [{ materialAssetId: 11, materialKey: 'lead', imageUrl: approvedUrl }] } })
              const receipt = JSON.parse(await readFile(join(cwd, 'provider-receipt.json'), 'utf8'))
              expect(receipt).toEqual(JSON.parse(await readFile(join(scenario.dir, 'workspace.expected/provider-receipt.json'), 'utf8')))
              expect(receipt).toMatchObject({ confirmation_requests: 0, storyboard_writes: 1 })
              expect(receipt.selected_model_references).toEqual(receipt.selected_storyboard_references)
              const preview = JSON.parse(await readFile(prepared.preview_path, 'utf8'))
              expect(JSON.parse(preview.payload.modelConfig).materialList).toEqual(preview.payload.storyboardMaterialList)
              expect(preview.payload.storyboardMaterialList).toEqual([{ ...receipt.selected_storyboard_references[0],
                official: true, asset_status: 'confirmed' }])
            }
            if (scenario.name === 'muse-shot-director-format') {
              const events = parseSessionLog(actualLogs[0]!.content)
              const calls = events.flatMap(event => event.type === 'tool/call' ? [event.data] : [])
              expect(calls.map(call => call.name)).toEqual(['skill', 'skill', 'skill', 'read', 'drama_shot'])
              const results = events.flatMap(event => event.type === 'tool/result' ? [event.data.message] : [])
              // Keep the historical calls as rejection coverage for the removed creative skills.
              expect(results.map(message => message.isError)).toEqual([true, true, true, false, false])
              for (const index of [0, 1, 2]) {
                const block = results[index]!.content[0]
                if (block?.type !== 'text') throw new Error('Expected unavailable skill diagnostic')
                expect(block.text).toContain('unknown or no longer available')
              }
              const resourceBlock = results[3]!.content[0]
              if (resourceBlock?.type !== 'text') throw new Error('Expected packaged format resource text')
              expect(resourceBlock.text).toContain('调用没有 `duration` 参数')
              expect(resourceBlock.text).toContain('不跨镜继承')
              expect(resourceBlock.text).toContain('场景按本镜实际内外与动作选择')
              expect(resourceBlock.text).toContain('一个动作跨过室内与室外时拆成各自的镜头')
              expect(resourceBlock.text).toContain('机器的 `vo` 只归类发声，不替代原文的 OS、心声、记忆音或当前画外对白语义')
              expect(resourceBlock.text).toContain('画面人物不对这句发声、不按该句对口型，表情动作仍按原文，不强制闭嘴')
              expect(resourceBlock.text).toContain('不强迫声源入画')
              const previewBlock = results[4]!.content[0]
              if (previewBlock?.type !== 'text') throw new Error('Expected format preview text')
              const preview = JSON.parse(previewBlock.text)
              expect(preview).toMatchObject({ ok: true, failures: [], written: [] })
              expect(preview.shots.map((shot: JsonObject) => shot.voice_type)).toEqual(['dialogue', 'action', 'vo'])
              expect(preview.shots[2]).toMatchObject({ speaker: '周明', offscreen: true })
              expect(preview.shots.map((shot: JsonObject) => shot.bindings)).toMatchObject([
                [{ name: '温雨身份母版', asset_id: '71001' }, { name: '后厨', asset_id: '71004' }],
                [{ name: '温雨雨衣版', asset_id: '71002' }, { name: '后厨', asset_id: '71004' }],
                [{ name: '温雪身份母版', asset_id: '71003' }, { name: '后厨', asset_id: '71004' }],
              ])
              expect(preview.packages.every((pack: JsonObject) => typeof pack.prompt === 'string' && !pack.prompt.includes('时长：'))).toBe(true)
            }
            if (scenario.name === 'goal-wait-yields') {
              const events = parseSessionLog(actualLogs[0]!.content)
              const waits = events.filter(event => event.type === 'goal/wait')
              expect(waits).toHaveLength(1)
              expect(waits[0]?.data).toMatchObject({ roundsStarted: 0, wait: { reason: 'input', message: 'Waiting for new work' } })
              const results = events.flatMap(event => event.type === 'tool/result' ? [event.data.message] : [])
              expect(results.map(result => result.isError)).toEqual([false, true, false])
              expect(events.filter(event => event.type === 'goal/change').map(event => event.data.operation)).toEqual(['create'])
            }
            if (scenario.name === 'muse-shot-scene-context') {
              const events = parseSessionLog(actualLogs[0]!.content)
              const calls = events.flatMap(event => event.type === 'tool/call' ? [event.data] : [])
              expect(calls.map(call => call.name)).toEqual(['drama_shot', 'drama_shot'])
              const results = events.flatMap(event => event.type === 'tool/result' ? [event.data.message] : [])
              expect(results.every(message => message.isError === false), JSON.stringify(results)).toBe(true)
              const positive = results[0]!.content[0]
              const metadataOnly = results[1]!.content[0]
              if (positive?.type !== 'text' || metadataOnly?.type !== 'text') throw new Error('Expected source-scene previews')
              const preview = JSON.parse(positive.text)
              expect(preview).toMatchObject({ ok: true, failures: [], written: [] })
              expect(preview.shots.map((shot: JsonObject) => shot.text)).toEqual(['别走', '等等', '外面有人', '他回来了', '回家吧'])
              expect(preview.packages.map((pack: JsonObject) => pack.shots)).toEqual([[1], [2], [3], [4], [5]])
              expect(preview.packages[0].prompt).toContain('来源场次（原文段落）：场次1-1：后厨 夜 内；')
              expect(preview.packages[1].prompt).toContain('场次1-1：后厨 夜 内；')
              expect(preview.packages[1].prompt).not.toContain('场次1-2')
              expect(preview.packages[2].prompt).toContain('场次1-2：办公室 次日清晨 内；本镜可为内外插镜')
              expect(preview.shots[2].scene).toBe('办公室窗下外墙')
              expect(preview.packages[3].prompt).not.toContain('场次1-3')
              expect(preview.packages[4].prompt).toContain('场次1-3：门口 次日清晨 外；')
              expect(preview.packages.every((pack: JsonObject) => !pack.prompt.includes('场次对照') && !pack.prompt.includes('原文出场人物') && !pack.prompt.includes('时长：'))).toBe(true)
              expect(preview.shots.every((shot: JsonObject) => !shot.bindings.some((asset: JsonObject) => asset.name === '陆沉'))).toBe(true)
              const refusedInference = JSON.parse(metadataOnly.text)
              expect(refusedInference).toMatchObject({ ok: true, failures: [], written: [], shots: [{ bindings: [] }] })
              expect(refusedInference.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'no_scene_bound' })]))
              expect(refusedInference.packages[0].material_bindings).toEqual([])
              expect(refusedInference.packages[0].prompt).toContain('来源场次（原文段落）：场次1-1：陆沉家 夜 内 奶瓶；')
            }
            if (scenario.name === 'muse-shot-derived-visual') {
              const events = parseSessionLog(actualLogs[0]!.content)
              const calls = events.flatMap(event => event.type === 'tool/call' ? [event.data] : [])
              expect(calls.map(call => call.name)).toEqual(['drama_shot', 'drama_shot'])
              const results = events.flatMap(event => event.type === 'tool/result' ? [event.data.message] : [])
              expect(results.every(message => message.isError === false)).toBe(true)
              const positive = results[0]!.content[0]
              const negative = results[1]!.content[0]
              if (positive?.type !== 'text' || negative?.type !== 'text') throw new Error('Expected derived visual previews')
              const preview = JSON.parse(positive.text)
              expect(preview).toMatchObject({ method: 'preview', ok: true, failures: [], written: [] })
              expect(preview.shots.map((shot: JsonObject) => shot.text)).toEqual(['', '慢一点。', '别让孩子摔倒。', ''])
              expect(preview.shots.map((shot: JsonObject) => shot.bindings.filter((asset: JsonObject) => asset.type === '角色')
                .map((asset: JsonObject) => asset.asset_id))).toEqual([[], ['72001', '72002'], ['72001'], ['72003']])
              expect(preview.shots[2]).toMatchObject({ speaker: '谭伯', voice_type: 'vo', offscreen: true })
              expect(preview.packages).toHaveLength(1)
              const pack = preview.packages[0]
              expect(pack.material_bindings.map((binding: JsonObject) => binding.asset_id)).toEqual([
                '72004', '72005', '72001', '72002', '72003', '72006',
              ])
              expect(pack.material_bindings.find((binding: JsonObject) => binding.material_key === 'he')).toMatchObject({
                name: '小禾身份母版', asset_id: '72001', material_id: '82001', reference_scope: 'identity',
              })
              expect(pack.prompt).not.toContain('he-repeat')
              expect(pack.prompt).toContain('身体状态：【非孕期；7岁；黄色雨衣】')
              expect(pack.prompt).toContain('动作状态：【蹲下扶住板凳】')
              expect(pack.prompt).toContain('身体状态：【非孕期；68岁；灰色夹袄；草帽】')
              expect(pack.prompt).toContain('谭伯OS，内心独白，不对口型；声源画外')
              expect(pack.prompt).toContain('木枪保持已有木制外形，不改成机械枪')
              expect(pack.prompt).not.toContain('时长：')
              const visualScopes = pack.prompt.match(/本镜人物范围：[^\n]+/g)
              expect(visualScopes).toEqual([
                '本镜人物范围：0人，无人物入画；画外发声与来源场次的人物表不增加出镜人物。',
                '本镜人物范围：最多2人，仅限小禾身份母版、小竹身份母版；可按本镜景别局部入画或遮挡，不强求全员同框；画外发声、来源场次人物表和其他镜头的人物不增加本镜人数。',
                '本镜人物范围：最多1人，仅限小禾身份母版；可按本镜景别局部入画或遮挡，不强求全员同框；画外发声、来源场次人物表和其他镜头的人物不增加本镜人数。',
                '本镜人物范围：最多1人，仅限谭伯身份母版；可按本镜景别局部入画或遮挡，不强求全员同框；画外发声、来源场次人物表和其他镜头的人物不增加本镜人数。',
              ])
              expect(pack.prompt.match(/同一素材中的脸部、服装和多视角属于同一人，同一key在本镜仅一个人物实例，跨镜复用不新增人物/g)).toHaveLength(4)
              expect(pack.prompt.match(/保留区分本人的脸型、年龄感与面部特征/g)).toHaveLength(4)
              expect(pack.prompt.match(/正文明确的年龄或妆造变化按本镜正文及对应正式版本/g)).toHaveLength(4)
              expect(pack.prompt.match(/外形、结构、材质和颜色沿用本镜正式参考图/g)).toHaveLength(2)
              expect(pack.prompt).toContain('不凭道具泛名替换外观，不发明图中未确认的材质或结构')
              const refused = JSON.parse(negative.text)
              expect(refused).toMatchObject({ method: 'preview', ok: false, packages: [], written: [] })
              expect(refused.failures).toEqual(expect.arrayContaining([
                expect.objectContaining({ code: 'material_reference_mismatch', shot: 1 }),
              ]))
              expect(refused.failures[0].message).toContain('@[小竹](asset_72001)')
            }
            if (scenario.name === 'muse-shot-material-identities') {
              const events = parseSessionLog(actualLogs[0]!.content)
              const calls = events.flatMap(event => event.type === 'tool/call' ? [event.data] : [])
              expect(calls.map(call => call.name)).toEqual(['skill', 'drama_shot', 'drama_shot'])
              expect(JSON.parse(calls[0]!.arguments)).toEqual({ name: 'tweet-drama-shot-asset-match' })
              const results = events.flatMap(event => event.type === 'tool/result' ? [event.data.message] : [])
              expect(results.map(message => message.toolCallId)).toEqual(calls.map(call => call.callId))
              expect(results.every(message => message.isError === false)).toBe(true)
              expect(results[0]!.content).toEqual(expect.arrayContaining([expect.objectContaining({
                type: 'text', text: expect.stringContaining('select_assets'),
              })]))
              const skillBlock = results[0]!.content[0]
              if (skillBlock?.type !== 'text') throw new Error('Expected asset matching skill text')
              expect(skillBlock.text).toContain('专用妆造图核对对应服装')
              expect(skillBlock.text).toContain('身份母版仅参考本人身份，妆造与动作仍按本镜正文')
              expect(skillBlock.text).toContain('不得为通过检查删改原文')
              expect(skillBlock.text).toContain('场景按本镜实际内外、动作与正式图片布局匹配，不靠同名资产认定')
              expect(skillBlock.text).toContain('`vo` 不替代原文 OS/心声与记忆音语义')
              expect(skillBlock.text).toContain('最终提示词写清内心独白、不对口型或回忆中的声音，不强迫声源入画')
              const previewBlock = results[1]!.content[0]
              const refusedBlock = results[2]!.content[0]
              if (previewBlock?.type !== 'text' || refusedBlock?.type !== 'text') {
                throw new Error('Expected shot preview result text')
              }
              const preview = JSON.parse(previewBlock.text)
              expect(preview).toMatchObject({ method: 'preview', ok: true, failures: [], written: [] })
              expect(preview.shots.map((shot: JsonObject) => shot.bindings)).toMatchObject([
                [{ name: '温雨身份母版', asset_id: '71001' }, { name: '温雪身份母版', asset_id: '71003' }, { name: '后厨', asset_id: '71004' }],
                [{ name: '温雨雨衣版', asset_id: '71002' }, { name: '后厨', asset_id: '71004' }],
                [{ name: '李军家', asset_id: '71007' }, { name: '李军的碗', asset_id: '71008' }],
                [{ name: '李军', asset_id: '71006' }, { name: '李军家', asset_id: '71007' }, { name: '李军的碗', asset_id: '71008' }],
              ])
              expect(preview.shots[2]).toMatchObject({ characters_field: '', voice_type: 'action' })
              expect(preview.shots[2].bindings.some((asset: JsonObject) => asset.type === '角色')).toBe(false)
              expect(preview.shots[3].bindings.filter((asset: JsonObject) => asset.type === '角色')).toEqual([
                { name: '李军', type: '角色', official: true, asset_id: '71006', material_id: '81006', url: 'https://example.invalid/71006.png' },
              ])
              expect(preview.packages).toHaveLength(3)
              const identityPackage = preview.packages[0]
              expect(identityPackage.material_keys).toEqual(['background', 'rain', 'snow'])
              expect(identityPackage.material_bindings).toEqual([
                { material_key: 'background', name: '后厨', type: '场景', official: true, asset_id: '71004', material_id: '81004', url: 'https://example.invalid/kitchen.png', reference_scope: 'appearance' },
                { material_key: 'rain', name: '温雨身份母版', type: '角色', official: true, asset_id: '71001', material_id: '81001', url: 'https://example.invalid/rain.png', reference_scope: 'identity' },
                { material_key: 'snow', name: '温雪身份母版', type: '角色', official: true, asset_id: '71003', material_id: '81003', url: 'https://example.invalid/snow.png', reference_scope: 'identity' },
              ])
              expect(identityPackage.prompt).not.toContain('rain-repeat')
              expect(identityPackage.prompt.match(/仅参考本人面孔与身份/g)).toHaveLength(2)
              expect(identityPackage.prompt).toContain('身体状态：【非孕期；青年；砖红卫衣】')
              expect(identityPackage.prompt).toContain('身体状态：【非孕期；青年；墨绿夹克】')
              expect(preview.packages[1].material_bindings).toEqual([
                { material_key: 'background', name: '后厨', type: '场景', official: true, asset_id: '71004', material_id: '81004', url: 'https://example.invalid/kitchen.png', reference_scope: 'appearance' },
                { material_key: 'asset_71002', name: '温雨雨衣版', type: '角色', official: true, asset_id: '71002', material_id: '81002', url: 'https://example.invalid/rain-yellow.png', reference_scope: 'appearance' },
              ])
              expect(preview.packages[1].prompt).toContain('身体状态：【非孕期；青年；黄色雨衣】')
              expect(preview.packages[1].prompt).toContain('保留本镜正式参考人物的脸型、年龄感和可见妆造差异')
              expect(preview.packages[1].prompt).toContain('动作和表情以本镜正文为准，不复制参考图的姿态')
              expect(preview.packages[1].prompt).toContain('同一素材中的脸部、服装和多视角属于同一人，同一key在本镜仅一个人物实例，跨镜复用不新增人物')
              const refused = JSON.parse(refusedBlock.text)
              expect(refused).toMatchObject({ method: 'preview', ok: false, packages: [], written: [],
                failures: [{ code: 'material_reference_mismatch', shot: 1 }] })
              expect(refused.failures[0].message).toContain('@[温雪](asset_71001)')
            }
            if (scenario.name === 'muse-audio-asset-usage') {
              const events = parseSessionLog(actualLogs[0]!.content)
              const result = events.find(event => event.type === 'tool/result' && event.data.message.toolCallId === 'call_usage_preview')
              if (result?.type !== 'tool/result') throw new Error('Missing persisted asset usage result')
              const block = result.data.message.content.find(item => item.type === 'text')
              if (block?.type !== 'text') throw new Error('Missing usage output')
              expect(JSON.parse(block.text)).toMatchObject({ method: 'usage_preview', total: 2, read_only: true, paid_requests: 0,
                usage_rows: [{ asset_id: 13, status: 'project_voice_reference' }, { asset_id: 11, episode: 54, status: 'local_package_reference' }],
                voice_states: [{ character_id: 'lu', status: 'current_reference_needs_verification' }] })
            }
            if (scenario.name === 'muse-shared-asset-usage') {
              const events = parseSessionLog(actualLogs[0]!.content)
              const result = events.find(event => event.type === 'tool/result' && event.data.message.toolCallId === 'call_shared_usage_preview')
              if (result?.type !== 'tool/result') throw new Error('Missing shared usage query result')
              expect(result.data.message.isError, JSON.stringify(result.data.message.content)).toBe(false)
              const block = result.data.message.content.find(item => item.type === 'text')
              if (block?.type !== 'text') throw new Error('Missing shared usage output')
              expect(JSON.parse(block.text)).toMatchObject({ method: 'shared_usage_preview', complete: true, query_complete: true, stable_inventory: true,
                paid_requests: 0, remote_writes: 0, local_writes: 0,
                assets: [{ asset_id: 13, package_count: 2, voice_period_id: 'child' },
                  { asset_id: 14, package_count: 1, voice_period_id: 'child' }, { asset_id: 15, package_count: 0, voice_period_id: 'adult' }],
                uses: [{ storyboard_id: 901, episode_number: 54 }, { storyboard_id: 902, episode_number: 83 },
                  { storyboard_id: 903, episode_number: 83 }],
                duplicate_audio_groups: [{ asset_ids: [13, 14], preferred_asset_id: 13, delete_allowed: false }],
                coverage: { historical_generation_tasks: false, other_computers_local_plans: false, atomic_remote_snapshot: false } })
            }
            if (scenario.name === 'muse-shared-voice-pending') {
              const events = parseSessionLog(actualLogs[0]!.content)
              const calls = events.flatMap(event => event.type === 'tool/call' ? [event.data] : [])
              expect(calls.map(call => call.name)).toEqual(['jubian_asset'])
              const result = events.find(event => event.type === 'tool/result' && event.data.message.toolCallId === 'call_shared_voice_pending')
              if (result?.type !== 'tool/result') throw new Error('Missing shared voice pending result')
              expect(result.data.message.isError).toBe(false)
              const block = result.data.message.content.find(item => item.type === 'text')
              if (block?.type !== 'text') throw new Error('Missing shared voice pending output')
              const pending = JSON.parse(block.text)
              expect(Array.isArray(pending)).toBe(false)
              expect(pending).toMatchObject({ status: 'coordination_busy', reason_code: 'busy', blocking_state: 'submitted',
                work_can_continue: true, failure_scope: 'voice_registration', submission_attempted: false,
                retry_registration: false, original_idempotency_key: 'offline-original-voice-key', paid_requests: 0 })
              expect(pending.next).toContain('继续无此参考音频的已授权初始视频或其他独立工作')
              expect(pending).not.toHaveProperty('lease_id')
              expect(events.at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
            }
            if (scenario.name === 'muse-bgm-project-feedback') {
              const events = parseSessionLog(actualLogs[0]!.content)
              const calls = events.flatMap(event => event.type === 'tool/call' ? [event.data] : [])
              expect(calls.map(call => call.name)).toEqual(['skill', 'skill', 'bgm_match', 'drama_bgm'])
              expect(JSON.parse(calls[0]!.arguments)).toEqual({ name: 'tweet-drama-project-bible' })
              expect(JSON.parse(calls[1]!.arguments)).toEqual({ name: 'tweet-drama-background-render' })
              expect(JSON.parse(calls[2]!.arguments)).toEqual({ method: 'match', project: '.',
                context_tags: ['family-conflict', 'dense-dialogue'], valence: 5, arousal: 5, limit: 5, intended_use: 'non_commercial' })
              expect(JSON.parse(calls[3]!.arguments)).toEqual({ method: 'compose', project: '.', episode: 24,
                timeline: 'editing/24-timeline.json', plan: 'episodes/segments/24.json' })
              const results = events.flatMap(event => event.type === 'tool/result' ? [event.data.message] : [])
              expect(results.map(message => message.toolCallId)).toEqual(calls.map(call => call.callId))
              expect(results.every(message => message.isError === false)).toBe(true)
              const bibleBlock = results[0]?.content.find(block => block.type === 'text')
              const renderBlock = results[1]?.content.find(block => block.type === 'text')
              if (bibleBlock?.type !== 'text' || renderBlock?.type !== 'text') throw new Error('Missing real project/render Skill content')
              for (const text of ['project_bible.bgm_feedback', '先 `drama_project action=read`', '时间来自该次明确用户反馈']) {
                expect(bibleBlock.text).toContain(text)
              }
              for (const text of ['可以只用一首，也可以不额外添加 BGM', '实际可播放 A/B 试听', '集中一次请求反馈', 'audio_preview']) {
                expect(renderBlock.text).toContain(text)
              }
              const matchBlock = results[2]?.content.find(block => block.type === 'text')
              const composeBlock = results[3]?.content.find(block => block.type === 'text')
              if (matchBlock?.type !== 'text' || composeBlock?.type !== 'text') throw new Error('Missing real BGM feedback tool results')
              const matched: unknown = JSON.parse(matchBlock.text)
              expect(matched).toMatchObject({ evaluated_tracks: 1, candidates: [], withheld_count: 1, music_optional: true,
                project_preferences: { status: 'ready', feedback_count: 1, context_tags: ['family-conflict', 'dense-dialogue'] },
                withheld_candidates: [{ source_sha256: `sha256:${'a'.repeat(64)}`, valence: 5, arousal: 5, distance: 0,
                  project_preference: { decision: 'reject', feedback_id: 'explicit-user-24-1',
                    reason: 'The user rejected the instrumentation under this dense family dialogue.',
                    recorded_at: '2026-10-22T06:00:00Z', history_count: 1, history_truncated: false,
                    history: [{ feedback_id: 'explicit-user-24-1', applicable: true }] } }],
                recommendation: 'No unrejected candidate in this scene; deliver without added BGM or ask once for an explicit user change.' })
              const composed: unknown = JSON.parse(composeBlock.text)
              expect(composed).toMatchObject({ method: 'compose', episode: '24', music_decision: 'none', status: 'no_added_music',
                decision_reason: 'Respect explicit user feedback in this dialogue scene; preserve the original audio.',
                segments: [], output: '', report: '', license_records: [], policy_findings: [], media: { size_bytes: 0, sha256: '' } })
              expect(existsSync(join(cwd, 'audio'))).toBe(false)
              expect(existsSync(join(cwd, 'music'))).toBe(false)
              expect(events.at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
            }
            if (scenario.name === 'muse-voice-periods') {
              const events = parseSessionLog(actualLogs[0]!.content)
              const result = events.find(event => event.type === 'tool/result' && event.data.message.toolCallId === 'call_usage_preview')
              if (result?.type !== 'tool/result') throw new Error('Missing persisted period voice usage result')
              const block = result.data.message.content.find(item => item.type === 'text')
              if (block?.type !== 'text') throw new Error('Missing period voice output')
              expect(JSON.parse(block.text)).toMatchObject({ method: 'usage_preview', total: 2, read_only: true, paid_requests: 0,
                usage_rows: [{ asset_id: 13, voice_period_id: 'child', status: 'project_voice_reference' },
                  { asset_id: 11, episode: 54, status: 'local_package_reference' }],
                voice_states: [{ character_id: 'lu', voice_period_id: 'child', status: 'current_reference_needs_verification' },
                  { character_id: 'lu', voice_period_id: 'adult', status: 'missing', candidate_count: 0 }] })
            }
            if (['muse-entity-match-preview', 'muse-entity-reuse-preview', 'muse-entity-existing-binding'].includes(scenario.name)) {
              const events = parseSessionLog(actualLogs[0]!.content)
              const calls = events.flatMap(event => event.type === 'tool/call' ? [event.data] : [])
              expect(calls.map(call => call.name)).toEqual(scenario.name === 'muse-entity-existing-binding'
                ? ['skill', 'drama_assets', 'jubian_storyboard', 'jubian_storyboard'] : ['skill', 'drama_assets'])
              expect(JSON.parse(calls[0]!.arguments)).toEqual({ name: 'tweet-drama-shot-asset-match' })
              expect(JSON.parse(calls[1]!.arguments)).toMatchObject({
                method: scenario.name === 'muse-entity-match-preview' ? 'match_preview' : 'reuse_preview', requirements_path: 'requirements.json',
              })
              const results = events.flatMap(event => event.type === 'tool/result' ? [event.data.message] : [])
              expect(results.map(message => message.toolCallId)).toEqual(calls.map(call => call.callId))
              expect(results.every(message => message.isError === false)).toBe(true)
              expect(results[0]!.content).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'text', text: expect.stringContaining('skill_content name="tweet-drama-shot-asset-match"') })]))
              const block = results[1]!.content[0]
              if (block?.type !== 'text') throw new Error('Expected matching result text')
              const preview = JSON.parse(block.text)
              if (scenario.name !== 'muse-entity-match-preview') {
                expect(preview).toMatchObject({ status: 'reuse_ready', apply_allowed: false,
                  shots: [{ storyboard_id: 901, status: 'awaiting_confirmation' }, { storyboard_id: 902, status: 'awaiting_confirmation' }] })
                expect(preview.groups).toHaveLength(3)
                expect(preview.groups[0].requirement_ids).toEqual(['character', 'character-repeat'])
              } else {
                expect(preview.counts, JSON.stringify({ preview, call: calls[1] })).toEqual({ reuse_ready: 1, needs_review: 1, missing: 1, blocked: 1 })
              }
              expect(preview).toMatchObject({ read_only: true, paid_requests: 0, local_writes: 0, remote_writes: 0 })
              if (scenario.name === 'muse-entity-existing-binding') {
                for (const [index, id] of [901, 902].entries()) {
                  expect(JSON.parse(calls[index + 2]!.arguments)).toEqual({ method: 'select_assets', storyboard_id: id,
                    selections: [{ material_key: 'lead', asset_id: 11 }, { material_key: 'bg', asset_id: 12 }],
                    idempotency_key: 'approved-selection-' + id })
                }
                const evidence = JSON.parse(await readFile(join(cwd, '_probe/handoff-fixture.json'), 'utf8'))
                expect(evidence).toMatchObject({ simulated: true, paid_requests: 0 })
                expect(evidence.writes.map((row: JsonObject) => row.storyboard_id)).toEqual([901, 902])
                expect(evidence.boards.every((row: JsonObject) => row.scriptId === 2708 && row.isGenerate === 0)).toBe(true)
                expect(evidence.boards[0].privateProviderField).toEqual({ retained: true })
                expect(evidence.boards[0].storyboardMaterialList[2]).toMatchObject({ materialType: 'audio', materialUrl: 'https://example.invalid/lu.wav' })
              }
            }
            if (scenario.name.startsWith('skill-preparation-')) {
              const events = parseSessionLog(actualLogs[0]!.content)
              const prepared = scenario.name === 'skill-preparation-catalog'
              expect(events.filter(event => event.type === 'step/start')).toHaveLength(prepared ? 1 : 0)
              expect(events.filter(event => event.type === 'request/header')).toHaveLength(prepared ? 1 : 0)
              expect(events.filter(event => event.type === 'assistant/message')).toHaveLength(prepared ? 1 : 0)
              const catalog = events.filter(event => event.type === 'user/message'
                && event.data.source.kind === 'skill-catalog')
              expect(catalog).toHaveLength(prepared ? 1 : 0)
              if (scenario.name === 'skill-preparation-cancel') {
                expect(turnReasonFromSession(actualLogs[0]!.content)).toEqual({ kind: 'aborted', reason: { kind: 'user' } })
              }
            }
            if (scenario.name === 'session-query-spill') {
              await verifySessionQuerySpill(actualLogs[0]!.content, spillRoot, locatorRoot)
            }
            if (scenario.name === 'mcp-resources' || scenario.name === 'mcp-resources-ptc') {
              verifyMcpResources(actualLogs[0]!.content, scenario.name === 'mcp-resources-ptc')
            }
            if (scenario.name === 'mcp-empty' || scenario.name === 'mcp-empty-ptc') {
              verifyNoMcpServers(actualLogs[0]!.content, scenario.name === 'mcp-empty-ptc')
            }
            if (scenario.name === 'provider-cwd') {
              await verifyProviderCwdResume(
                scenario, cwd, actualLogs, patches, model, join(scenario.dir, fixtureFiles[0] as string), task,
              )
            }
            if (scenario.name === 'background-confinement-failure') {
              await verifyBackgroundConfinementFailure(actualLogs[0]!.content, cwd)
            }
            finalWorkspace = await captureWorkspaceSnapshot(cwd, {
              ignoredRootEntries: RUNTIME_WORKSPACE_ENTRIES,
            })
            if (expectedWorkspaceRoot !== undefined) {
              preparedExpectedWorkspace = await captureExpectedWorkspaceSnapshot(expectedWorkspaceRoot)
            }
          },
        })
      } finally {
        await mcpDemo?.close()
        await rm(spillRoot, { recursive: true, force: true })
      }

      const actualContext = contextOf(actualLogs.map(log => log.content))

      if (writesCurrentSessionFixtures(scenario.manifest, mode)) {
        fixtures = await writeSessionFixtures(
          scenario,
          actualLogs,
          fixtures,
          actualContext,
        )
        fixtureFiles = actualLogs.map((log, index) => sessionFixtureName(
          index,
          sessionHeaderVersion(log.content, `harvested Session ${index}`),
        ))
      }
      if (mode !== 'replay') await writeHeaderSidecars(scenario, actualLogs, actualContext)

      expect(actualLogs, `${scenario.name}: persisted session count`).toHaveLength(fixtures.length)
      const writerFiles = (await readdir(scenario.dir)).filter(name => /^writer(?:\.[1-9]\d*)?\.expected\.jsonl$/u.test(name)).sort()
      if (mode === 'replay') {
        expect(writerFiles, 'native writer oracle inventory').toEqual(scenario.manifest.sessionFormat === undefined && scenario.manifest.writerOutput !== true
          ? [] : fixtures.map((_, index) => writerSnapshotName(index)).sort())
      }
      let expected = fixtures
      if (scenario.manifest.sessionFormat !== undefined || scenario.manifest.writerOutput === true) {
        if (mode === 'refresh') await writeSessionFixtures(scenario, actualLogs, fixtures, actualContext)
        expected = await Promise.all(fixtures.map((_, index) => readFile(join(scenario.dir, writerSnapshotName(index)), 'utf8')))
        for (const [index, content] of expected.entries()) {
          expect(sessionHeaderVersion(content, writerSnapshotName(index))).toBeLessThanOrEqual(SESSION_FORMAT_VERSION)
        }
        expect(await fixtureSessions(scenario), 'historical replay input remains unchanged').toEqual(fixtures)
      }
      const outputLog = expected[0]
      if (outputLog === undefined) throw new Error(`${scenario.name}: CLI projection has no primary session`)
      expect(result.stdout).toBe(`${finalTextFromSession(outputLog)}\n`)
      expect(result.stderr).toBe(stderrFromSession(outputLog))
      const actualSnapshots = normalizeSessionSnapshots(actualLogs.map(log => log.content), actualContext, { nativeWriterOutput: true })
      const expectedSnapshots = normalizeSessionSnapshots(expected, contextOf(expected), { nativeWriterOutput: true })
      for (const [index, actual] of actualSnapshots.entries()) {
        const actualRecords = records(actual)
        const expectedRecords = scenario.name === 'session-reference-spill' && index === 0
          ? sessionReferenceSpillExpected(
            actualRecords,
            expectedSnapshots[index] as string,
            sessionHeaderVersion(expected[index] as string, 'session-reference-spill fixture'),
          )
          : records(expectedSnapshots[index] as string)
        expect(actualRecords, `${scenario.name}: session ${index}`).toEqual(expectedRecords)
      }
      await verifyHeaders(scenario, actualLogs, actualContext)

      if (initialWorkspace === undefined || finalWorkspace === undefined) {
        throw new Error(`${scenario.name}: workspace was not captured around the profile run`)
      }
      if (scenario.manifest.workspace?.final === true) {
        const expectedWorkspace = preparedExpectedWorkspace
          ?? await captureExpectedWorkspaceSnapshot(join(scenario.dir, 'workspace.expected'))
        expect(finalWorkspace, `${scenario.name}: complete final workspace`).toEqual(expectedWorkspace)
      } else {
        expect(finalWorkspace, `${scenario.name}: a changed workspace requires workspace.final`).toEqual(initialWorkspace)
      }
    }, scenario.name === 'provider-cwd' ? 3 * LOADER_SMOKE_TEST_TIMEOUT_MS : LOADER_SMOKE_TEST_TIMEOUT_MS)
  }
})
