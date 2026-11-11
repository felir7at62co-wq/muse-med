/** Boot the materialized target runtime without access to a user's Harness profile. */

import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { readPrimaryRuntime, workspaceDependencyPaths } from '../../../packages/skill/tool-workspace-dependencies/src/index.ts'
import { DesktopHostProcess } from '../src/host-process.ts'
import { createPluginProfile } from '../src/project-manager.ts'
import { readDesktopRuntime, type DesktopRuntimeDescriptor } from '../src/runtime-tree.ts'
import { isEntry } from '../../../scripts/release/process.ts'
import { CREATION_SKILL_NAMES } from '../../desktop-host/src/creation-skills.ts'

const editingModelInput = JSON.parse(readFileSync(new URL('../tests/expected/editing-model-input.json', import.meta.url), 'utf8')) as {
  personaPrefix: string
  tools: Record<string, string>
}

/** Isolated smoke roots with product-home skills separate from project discovery. */
export interface DesktopSmokeSkillLayout {
  /** Repository-marked workspace used by every mounted Agent. */
  cwd: string
  /** Expected winners after product and project root precedence is applied. */
  selected: Array<{ name: string; path: string; source: string }>
}

/** Describe product user roots, three project roots and their same-name precedence.
 * @param home - Private smoke product home.
 * @returns Expected filesystem selections without creating any files.
 */
export function desktopSmokeSkillLayout(home: string): DesktopSmokeSkillLayout {
  const cwd = join(home, 'workspace')
  return { cwd, selected: [
    { name: 'desktop-user-skill', path: join(home, 'skills/desktop-user-skill/SKILL.md'), source: 'custom' },
    ...(['muse', 'dsh', 'agents'] as const).map(kind => ({
      name: 'desktop-project-' + kind,
      path: join(cwd, '.' + kind, 'skills/desktop-project-' + kind + '/SKILL.md'), source: 'project-' + kind,
    })),
    { name: 'desktop-project-priority', path: join(cwd, '.muse/skills/desktop-project-priority/SKILL.md'), source: 'project-muse' },
  ] }
}

/** Create independent project roots and excluded shared-root sentinels for the real Host smoke.
 * @param home - Private smoke product home.
 * @returns Workspace and expected selected skill paths.
 */
export function prepareDesktopSmokeSkills(home: string): DesktopSmokeSkillLayout {
  const layout = desktopSmokeSkillLayout(home)
  mkdirSync(join(layout.cwd, '.git'), { recursive: true })
  const files = [...layout.selected,
    ...['.dsh', '.agents'].flatMap(directory => [
      { name: 'desktop-user-skill', path: join(home, directory, 'skills/desktop-user-skill/SKILL.md') },
      { name: 'desktop-shared-only', path: join(home, directory, 'skills/desktop-shared-only/SKILL.md') },
      { name: 'desktop-project-priority', path: join(layout.cwd, directory, 'skills/desktop-project-priority/SKILL.md') },
    ]),
    { name: 'desktop-project-priority', path: join(home, 'skills/desktop-project-priority/SKILL.md') },
  ]
  for (const { name, path } of files) {
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, `---\nname: ${name}\ndescription: Isolated Desktop smoke fixture.\n---\n# ${name}\n`)
  }
  return layout
}

/** Generate the private startup plugin that mounts the complete product preset through Host services.
 * @param root - Prepared product package root.
 * @param home - Disposable smoke product home containing a separate workspace.
 * @returns ESM plugin source checking current product tools, technical skills, retired resources,
 * native skill locations, the private reviewer registration, and completed Agent disposal.
 * Historical editing resolves to short-drama; only user presets are mounted here.
 * Preset failures retain their instance, phase and original stack; every created Agent's disposal is awaited before failures are reported.
 */
export function desktopSmokePluginSource(root: string, home: string): string {
  return `
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { existsSync, realpathSync, writeFileSync } from 'node:fs'
import { join, relative, isAbsolute } from 'node:path'
import { getCallSites } from 'node:util'
export const inject = ['agentPresets', 'agents', 'agentLoop', 'systemPrompt', 'tools', 'skills', 'credentials', 'webServer', 'museAccount', 'toolDiscovery']
export function apply(ctx) {
  const callerFiber = ctx.fiber
  const callerAgents = ctx.agents
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/desktop-product-smoke', handler: async (_request, response) => {
  if (!(ctx instanceof Context)) throw new Error('desktop runtime: external plugin loaded another Cordis instance')
  const root = ${JSON.stringify(root)}
  const home = ${JSON.stringify(home)}
  const skillLayout = ${JSON.stringify(desktopSmokeSkillLayout(home))}
  const cwd = skillLayout.cwd
  const editingModelInput = ${JSON.stringify(editingModelInput)}
  const creationSkillNames = new Set(${JSON.stringify(CREATION_SKILL_NAMES)})
  const creationUserSources = new Set(['custom', 'user-muse', 'user-dsh', 'user-agents', 'project-muse', 'project-dsh', 'project-agents'])
  const failureText = error => error && error.stack ? error.stack : String(error)
  const withContext = (error, preset, index, phase) => {
    const failure = new Error('desktop runtime: preset=' + preset + ' index=' + index + ' phase=' + phase, { cause: error })
    failure.stack += '\\nCaused by: ' + failureText(error)
    return failure
  }
  const identities = new WeakMap()
  const birthUIDs = new WeakMap()
  let nextIdentity = 0
  const identity = value => {
    if ((typeof value !== 'object' || value === null) && typeof value !== 'function') return null
    if (!identities.has(value)) identities.set(value, ++nextIdentity)
    return identities.get(value)
  }
  const describeFiber = fiber => {
    if (fiber === undefined) return null
    const uid = fiber.uid
    if (typeof uid === 'number' && !birthUIDs.has(fiber)) birthUIDs.set(fiber, uid)
    return { identity: identity(fiber), birthUID: birthUIDs.get(fiber) ?? null, uid,
      state: fiber.state, label: fiber.runtime?.name ?? null }
  }
  const tracked = []
  const firstRecords = []
  const lastRecords = []
  const observerErrors = []
  let droppedRecords = 0, droppedObserverErrors = 0, sequence = 0
  let location = { preset: null, index: -1, phase: 'request' }
  const observerError = (event, error) => {
    let message = 'Observer failure could not be rendered'
    let renderingFailed = false
    try { message = String(failureText(error)).slice(0, 4096) } catch { renderingFailed = true }
    if (observerErrors.length < 8) observerErrors.push({ event, ...location, message, renderingFailed })
    else droppedObserverErrors++
  }
  const disposalCallSites = () => {
    try {
      const aliases = ${JSON.stringify([[pathToFileURL(home).href + '/', '<home>/'], [pathToFileURL(root).href + '/', '<runtime>/']])}
      return getCallSites(48, { sourceMap: false }).map(frame => {
        let file = frame.scriptName
        for (const [prefix, alias] of aliases) {
          if (file.startsWith(prefix)) { file = alias + file.slice(prefix.length); break }
        }
        return { fn: frame.functionName.slice(0, 96), file: file.slice(0, 320),
          line: frame.lineNumber, column: frame.columnNumber }
      })
    } catch (error) { observerError('getCallSites', error); return [] }
  }
  const appendRecord = record => {
    record.sequence = ++sequence
    if (firstRecords.length < 128) firstRecords.push(record)
    else {
      lastRecords.push(record)
      if (lastRecords.length > 384) { lastRecords.shift(); droppedRecords++ }
    }
  }
  const trackedState = (registries, currentAgents) => tracked.map(row => ({
    preset: row.preset, index: row.index, agentIdentity: identity(row.agent),
    contextIdentity: identity(row.context), fiber: describeFiber(row.fiber),
    ...(registries ? {
      agentRegistryIdentity: identity(callerAgents[Symbol.for('cordis.original')] ?? callerAgents),
      registeredAgentMatches: callerAgents.get(row.agent.id) === row.agent,
      currentRegisteredAgentMatches: currentAgents.get(row.agent.id) === row.agent,
    } : {}),
  }))
  const checkpoint = (event, preset, index, phase) => {
    location = { preset, index, phase }
    try {
      const currentAgents = ctx.agents
      appendRecord({ event, ...location, owner: describeFiber(callerFiber),
        currentAgentRegistryIdentity: identity(currentAgents[Symbol.for('cordis.original')] ?? currentAgents),
        tracked: trackedState(true, currentAgents) })
    } catch (error) { observerError(event, error) }
  }
  const observe = (event, fiber, oldState) => {
    try {
      const description = describeFiber(fiber)
      appendRecord({ event, ...location, fiber: description, oldState, owner: describeFiber(callerFiber),
        tracked: trackedState(false),
        ...(event === 'internal/plugin' && description.uid === null ? { disposalCallSites: disposalCallSites() } : {}),
        ...(description.uid === null || event === 'internal/status'
          ? { stack: new Error('Desktop lifecycle ' + event).stack?.slice(0, 4096) } : {}) })
    } catch (error) { observerError(event, error) }
  }
  const observerReleases = []
  for (const event of ['internal/plugin', 'internal/status']) {
    try { observerReleases.push(ctx.root.on(event, (fiber, oldState) => { observe(event, fiber, oldState) })) }
    catch (error) { observerError('register-' + event, error) }
  }
  let failed = false, failure
  try {
  if (typeof ctx.museAccount.feedback !== 'function') throw new Error('desktop runtime: Muse inbox feedback method is missing')
  const ids = ['short-drama', 'ptc', 'standard', 'minimal', 'cordis', 'bot-coordinator', 'creation']
  const rosterIds = [...ids, 'muse-manuscript-continuity-reviewer']
  const presets = await ctx.agentPresets.list()
  if (presets.length !== rosterIds.length || rosterIds.some(id => !presets.some(preset => preset.id === id))) {
    throw new Error('desktop runtime: product preset roster differs; expected ' + rosterIds.join(', ') + '; found ' + presets.map(preset => preset.id).join(', '))
  }
  if (ctx.agentPresets.defaultId !== 'short-drama') throw new Error('desktop runtime: product default preset changed')
  if ((await ctx.agentPresets.resolve('editing')).id !== 'short-drama') {
    throw new Error('desktop runtime: retired editing preset must resolve to short-drama')
  }
  const inventory = await ctx.agentPresets.compositionInventory()
  for (const id of ids) {
  const handles = []
  const failures = []
  let index = -1
  let phase = 'resolve'
  try {
  const preset = await ctx.agentPresets.resolve(id)
  const expected = join(root, 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'presets', id, 'agent.cordis.yml')
  const composition = inventory.find(row => row.id === id)
  if (preset.broken !== undefined || !existsSync(expected) || composition === undefined || composition.rows.length === 0) {
    throw new Error('desktop runtime: preset is broken or missing from the product package: ' + id + '; ' + (preset.broken ?? 'composition absent'))
  }
    for (index = 0; index < 2; index++) {
      phase = 'create'
      checkpoint('before-create', id, index, phase)
      handles.push(await ctx.agents.create({
        sessionId: 'desktop-product-smoke-' + id + '-' + index, meta: { cwd, agentPreset: id },
        setup: async agentCtx => { await ctx.agentPresets.mount(agentCtx, id) },
      }))
      try {
        const agent = handles[index].agent
        const context = agent.ctx
        tracked.push({ preset: id, index, agent, context, fiber: context?.fiber })
      } catch (error) { observerError('track-created-agent', error) }
      checkpoint('after-create', id, index, phase)
    }
    for (const [handleIndex, handle] of handles.entries()) {
    index = handleIndex
    phase = 'tools'
    checkpoint('before-tools', id, index, phase)
    const names = new Set(ctx.tools.schemas(handle.agent).map(tool => tool.name))
    checkpoint('after-tools', id, index, phase)
    const retiredTools = ['list_bots', 'message_bot', 'create_bot', 'update_bot', 'stop_bot', 'start_task', 'ask_user']
    for (const name of retiredTools) if (names.has(name)) throw new Error('desktop runtime: archived Bot tool remains active: ' + name + ' in ' + id)
    for (const name of names) if (name.startsWith('mcp__muse-account__')) {
      throw new Error('desktop runtime: retired built-in account MCP remains active: ' + name + ' in ' + id)
    }
    const shell = process.platform === 'win32' ? 'pwsh' : 'bash'
    const required = id === 'short-drama' ? ['jubian_asset', 'jubian_catalog', 'jubian_model', 'jubian_storyboard', 'jubian_video', 'jubian_budget',
      'jubian_media', 'jubian_watch', 'bgm_match', 'ffmpeg_probe', 'ffmpeg_encode', 'skill', 'ask_user_question', 'todo_write', 'todo_update',
      'drama_assets', 'drama_bgm', 'drama_render', 'drama_project', 'drama_draft_dir', 'jianying_draft', 'manuscript_revision', 'source_recover', 'screenplay_export_docx', 'read', 'present', 'video_inspect', 'video_ocr',
      process.platform === 'win32' ? 'pwsh' : 'bash']
      : id === 'minimal' ? [shell]
        : id === 'creation' ? ['read', 'skill', shell, 'present', 'video_contact_sheet', 'video_ocr',
          'drama_assets', 'drama_bgm', 'drama_render', 'drama_project', 'drama_draft_dir', 'jianying_draft',
          'jubian_find', 'jubian_claim', 'jubian_snatch', 'source_snapshot', 'source_report', 'work_mapping']
        : id === 'bot-coordinator' ? ['read', 'write', 'edit', 'glob', 'grep', 'skill', shell, 'present',
          'web_search', 'web_fetch', 'ask_user_question', 'todo_write', 'todo_update', 'subagent',
          'tool_search', 'tool_context']
          : ['read', 'skill', shell, 'subagent']
    for (const name of required) if (!names.has(name)) throw new Error('desktop runtime: missing product tool ' + name + ' in ' + id + ' (visible: ' + [...names].sort().join(', ') + ')')
    phase = 'assemble-initial'
    checkpoint('before-assemble', id, index, phase)
    const modelInput = await ctx.systemPrompt.assemble({ agent: handle.agent, scope: handle.agent })
    checkpoint('after-assemble', id, index, phase)
    const modelNames = modelInput.tools.map(tool => tool.name)
    if (['ptc', 'creation', 'cordis'].includes(id)) {
      if (modelNames.length !== 1 || modelNames[0] !== 'run_code') {
        throw new Error('desktop runtime: PTC preset must expose only run_code: ' + id)
      }
    } else if (modelNames.includes('run_code')) {
      throw new Error('desktop runtime: native preset executor differs: ' + id)
    }
    if (names.has('audio_transcribe') !== (id !== 'minimal')) throw new Error('desktop runtime: transcription availability differs in ' + id)
    if (id === 'minimal') {
      const inherited = new Set(ctx.tools.schemas().map(tool => tool.name))
      const local = [...names].filter(name => !inherited.has(name))
      if (local.length !== 1 || local[0] !== shell) throw new Error('desktop runtime: minimal must add only its persistent shell; found ' + local.join(', '))
    }
    if (id === 'short-drama') {
      const assembly = modelInput
      const persona = assembly.sections.find(section => section.name === 'deployment:persona-prefix')?.text
      if (!persona?.startsWith(editingModelInput.personaPrefix)) {
        throw new Error('desktop runtime: unified creative persona changed')
      }
      const delivery = assembly.sections.find(section => section.name === 'editing:delivery')?.text
      if (!delivery?.includes('默认使用 Word（.docx）') || !delivery.includes('screenplay_export_docx')) {
        throw new Error('desktop runtime: editing Word delivery guidance is missing')
      }
      const deferredTools = Object.keys(editingModelInput.tools)
      const authorized = ctx.tools.schemas(handle.agent)
      for (const [name, description] of Object.entries(editingModelInput.tools)) {
        const tool = authorized.find(tool => tool.name === name)
        if (!tool) throw new Error('desktop runtime: missing product tool ' + name + ' in short-drama')
        if (tool.description !== description) {
          throw new Error('desktop runtime: editing authorized tool description changed: ' + name)
        }
      }
      for (const name of ['read', 'skill', 'tool_search', 'tool_context']) {
        if (!assembly.tools.some(tool => tool.name === name)) {
          throw new Error('desktop runtime: missing resident tool ' + name)
        }
      }
      const initialNames = assembly.tools.map(tool => tool.name).sort()
      if (deferredTools.some(name => initialNames.includes(name))) {
        throw new Error('desktop runtime: source tools must remain deferred before discovery')
      }
      const manage = async operation => {
        phase = 'tool-context-' + operation
        const callId = ToolCallId(handle.agent.id + ':desktop-smoke-' + operation)
        const args = { operation, tools: deferredTools }
        const batch = await ctx.tools.execute({
          calls: [{ type: 'tool-call', id: callId, name: 'tool_context', arguments: JSON.stringify(args) }],
          agent: handle.agent, signal: AbortSignal.timeout(30_000), log: { turn: 1, step: 1 },
        })
        const outcome = batch.results[0]
        if (batch.results.length !== 1 || outcome?.callId !== callId) {
          throw new Error('desktop runtime: invalid tool_context batch result')
        }
        const result = outcome.result
        if (result.isError) throw new Error('desktop runtime: tool_context ' + operation + ' failed')
      }
      await manage('load')
      phase = 'assemble-loaded'
      checkpoint('before-assemble', id, index, phase)
      const loaded = await ctx.systemPrompt.assemble({ agent: handle.agent, scope: handle.agent })
      checkpoint('after-assemble', id, index, phase)
      for (const [name, description] of Object.entries(editingModelInput.tools)) {
        if (loaded.tools.find(tool => tool.name === name)?.description !== description) {
          throw new Error('desktop runtime: editing model tool description changed after loading: ' + name)
        }
      }
      await manage('release')
      phase = 'assemble-released'
      checkpoint('before-assemble', id, index, phase)
      const released = await ctx.systemPrompt.assemble({ agent: handle.agent, scope: handle.agent })
      checkpoint('after-assemble', id, index, phase)
      if (JSON.stringify(released.tools.map(tool => tool.name).sort()) !== JSON.stringify(initialNames)
        || deferredTools.some(name => ctx.toolDiscovery.state(handle.agent).loaded.includes(name))) {
        throw new Error('desktop runtime: releasing source tools did not restore initial model tools')
      }
    }
    if ((id === 'ptc' || id === 'creation') && names.has('workflow')) {
      throw new Error('desktop runtime: PTC tool presentation is incomplete in ' + id)
    }
    if (id === 'creation' && ['subagent', 'subagent_fork', 'subagent_codex', 'subagent_claude_code'].some(name => names.has(name))) {
      throw new Error('desktop runtime: creation mode must use a single agent')
    }
    const skillRegistry = id === 'creation' ? ctx.agentPresets.serviceFor(handle.agent, 'skills') : ctx.skills
    if (skillRegistry === undefined) throw new Error('desktop runtime: creation skill registry is not isolated')
    phase = 'skills-list'
    const skills = await skillRegistry.list({ scope: handle.agent, cwd })
    if (id === 'creation') {
      for (const name of ['office-docx', 'office-xlsx', 'office-pptx']) {
        if (!skills.some(skill => skill.name === name && skill.invocation.modelInvocable)) {
          throw new Error('desktop runtime: missing creation skill ' + name)
        }
      }
      if (skills.some(skill => !creationSkillNames.has(skill.name) && !creationUserSources.has(skill.source))) {
        throw new Error('desktop runtime: creation skill registry exposes unreviewed skills')
      }
    }
    if (names.has('skill')) {
      const productSkills = join(root, 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'skills')
        .replace(/([\\\\/])app\\.asar([\\\\/])/u, '$1app.asar.unpacked$2')
      for (const directory of ['douyin-download', 'editing', 'jubian-snatch', 'media-link-import',
        'muse-llm-wiki', 'muse-project-participation',
        'reviewing-micro-drama-scripts', 'muse-creation', 'screenplay-project', 'transcript-to-novel', 'transcript-to-script',
        'trope-adaptation', 'wechat-shortdrama-harvest']) {
        if (existsSync(join(productSkills, directory, 'SKILL.md'))) {
          throw new Error('desktop runtime: retired Host skill is enabled: ' + directory)
        }
      }
      if (skills.some(skill => skill.invocation.modelInvocable && skill.path !== undefined
        && skill.path.endsWith('SKILL.md.disabled'))) {
        throw new Error('desktop runtime: disabled skill is model-invocable')
      }
      for (const name of ['audio-transcribe', 'muse-script-doctor', 'novel-to-script', 'muse-dialogue-polish', 'muse-episode-design', 'screenplay-format', 'video-review']) {
        const skill = skills.find(value => value.name === name)
        const expected = join(productSkills, name, 'SKILL.md')
        if (!skill?.invocation.modelInvocable || !skill.path || !existsSync(expected)
          || realpathSync.native(skill.path) !== realpathSync.native(expected)) {
          throw new Error('desktop runtime: missing shared Muse skill ' + name)
        }
        phase = 'skills-get:' + name
        const loaded = await skillRegistry.get(name, { scope: handle.agent, cwd })
        if (!loaded?.content?.trim() || !loaded.path || !existsSync(loaded.path)
          || realpathSync.native(loaded.path) !== realpathSync.native(expected)) {
          throw new Error('desktop runtime: shared skill did not load from the packaged Host: ' + name)
        }
      }
      if (!existsSync(join(productSkills, 'office-support', 'export_docx.py'))) {
        throw new Error('desktop runtime: missing Word export helper')
      }
      for (const script of ['doctor.py', 'discover.py', 'harvest.py', 'drive.py', 'finalize.py', 'win_bridge.ps1']) {
        if (!existsSync(join(productSkills, 'wechat-shortdrama-harvest', 'scripts', script))) {
          throw new Error('desktop runtime: missing WeChat helper ' + script)
        }
      }
      if (process.platform === 'win32') {
        const ocrBridge = join(root, 'node_modules', '@deepseek-ai', 'dsh-tool-video-inspect', 'scripts', 'ocr_bridge.ps1')
          .replace(/([\\\\/])app\.asar([\\\\/])/u, '$1app.asar.unpacked$2')
        if (!existsSync(ocrBridge)) throw new Error('desktop runtime: missing packaged video OCR bridge')
      }
      if (!existsSync(join(productSkills, 'audio-transcribe', 'scripts', 'transcribe.py'))) {
        throw new Error('desktop runtime: missing shared Muse transcription script')
      }
      if (!existsSync(join(productSkills, 'media-link-import', 'scripts', 'import_media.py'))) {
        throw new Error('desktop runtime: missing shared Muse media import script')
      }
    }
    if (id === 'cordis') {
      const cordisSkill = skills.find(skill => skill.name === 'editing-cordis-compositions')
      const expected = join(root, 'node_modules', '@deepseek-ai', 'dsh-desktop-host',
        'presets', 'cordis', 'skills', 'editing-cordis-compositions', 'SKILL.md')
        .replace(/([\\\\/])app\\.asar([\\\\/])/u, '$1app.asar.unpacked$2')
      if (!cordisSkill?.invocation.modelInvocable || !existsSync(expected)
        || realpathSync.native(cordisSkill.path) !== realpathSync.native(expected)) {
        throw new Error('desktop runtime: cordis authoring skill is not mounted')
      }
    }
    for (const expected of skillLayout.selected) {
      const skill = skills.find(skill => skill.name === expected.name)
      if (!skill?.path || !skill.invocation.modelInvocable || skill.source !== expected.source
        || realpathSync.native(skill.path) !== realpathSync.native(expected.path)) {
        throw new Error('desktop runtime: custom or project skill selection differs in ' + id + ': ' + expected.name
          + '; actual=' + (skill?.path ?? 'missing') + '; expected=' + expected.path)
      }
      phase = 'skills-get:' + expected.name
      const loaded = await skillRegistry.get(expected.name, { scope: handle.agent, cwd })
      if (!loaded?.path || !loaded.content?.trim() || realpathSync.native(loaded.path) !== realpathSync.native(expected.path)) {
        throw new Error('desktop runtime: custom or project skill could not load in ' + id + ': ' + expected.name)
      }
    }
    if (skills.some(skill => skill.name === 'desktop-shared-only')) {
      throw new Error('desktop runtime: excluded shared user skill was discovered in ' + id)
    }
    const bundled = realpathSync.native(join(root, 'node_modules', '@deepseek-ai', 'dsh-drama-skills', 'skills')
      .replace(/([\\\\/])app\\.asar([\\\\/])/u, '$1app.asar.unpacked$2'))
    if (existsSync(join(bundled, 'xiaohongshu-reference')) || skills.some(skill => skill.name === 'xiaohongshu-reference')) {
      throw new Error('desktop runtime: XHS must not ship in the product directory or skill registry')
    }
    const requiredSkills = ['tweet-drama-core', 'tweet-drama-script-convert',
      'tweet-drama-script-split', 'tweet-drama-asset-vision-check',
      'tweet-drama-shot-asset-match', 'jubian-snatch',
      'shot-script-creator-16-9-3d', 'shot-script-creator-9-16',
      'tweet-drama-draft-build', 'tweet-drama-background-render', 'tweet-drama-project-inspect', 'tweet-drama-project-bible', 'tweet-drama-voice-continuity', 'tweet-drama-delivery']
    for (const name of requiredSkills) {
      const skill = skills.find(value => value.name === name)
      if (!skill || !skill.path || !skill.invocation.modelInvocable) throw new Error('desktop runtime: missing product skill ' + name)
      const path = relative(bundled, realpathSync.native(skill.path))
      if (isAbsolute(path) || path === '..' || path.startsWith('../') || path.startsWith('..\\\\')) {
        throw new Error('desktop runtime: skill outside product bundle ' + name)
      }
      if (name === 'shot-script-creator-16-9-3d' || name === 'shot-script-creator-9-16') {
        const expected = join(bundled, name, 'SKILL.md')
        phase = 'skills-get:' + name
        const loaded = await skillRegistry.get(name, { scope: handle.agent, cwd })
        if (!loaded?.content?.trim() || !loaded.path || !existsSync(expected) || !existsSync(loaded.path)
          || realpathSync.native(skill.path) !== realpathSync.native(expected)
          || realpathSync.native(loaded.path) !== realpathSync.native(expected)) {
          throw new Error('desktop runtime: shot-writing skill did not load from its packaged resource: ' + name)
        }
      }
    }
    }
  } catch (error) {
    checkpoint('failure', id, index, phase)
    failures.push(withContext(error, id, index, phase))
  } finally {
    checkpoint('before-cleanup', id, index, phase)
    for (index = handles.length - 1; index >= 0; index--) {
      checkpoint('before-dispose', id, index, 'dispose')
      try {
        await handles[index].dispose()
        checkpoint('after-dispose', id, index, 'dispose')
      } catch (error) {
        checkpoint('dispose-failure', id, index, 'dispose')
        failures.push(withContext(error, id, index, 'dispose'))
      }
    }
  }
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) {
    const failure = new AggregateError(failures, 'desktop runtime: preset checks or cleanup failed')
    failure.stack += '\\n' + failures.map(failureText).join('\\n')
    throw failure
  }
  }
  writeFileSync(join(home, '.desktop-product-smoke-complete'), 'ok\\n', { flag: 'wx' })
  } catch (error) {
    failed = true
    failure = error
  } finally {
    for (const release of observerReleases) {
      try { await release() } catch (error) { observerError('unregister', error) }
    }
  }
  const diagnostic = '\\nDesktop lifecycle diagnostics: ' + JSON.stringify({
    records: [...firstRecords, ...lastRecords], droppedRecords, observerErrors, droppedObserverErrors,
  })
  if (failed) {
    const report = failureText(failure) + diagnostic
    writeFileSync(join(home, '.desktop-product-smoke-error'), report, { flag: 'wx' })
    response.statusCode = 500
    response.end(report)
  } else response.end('ok' + diagnostic)
  } }))
}
`
}

/** Select immutable package qualification or the linked project used by the local Dev application. */
export type DesktopSmokeMode = 'strict' | 'development'

/**
 * Check CLI package operations, Host startup, its frontend, external plugins and real Office-to-PDF conversion.
 * @param root - Materialized dsh resources.
 * @param node - Prepared target Electron executable.
 * @param runtime - Verified resource descriptor.
 * @param environment - Credential-scrubbed build environment and private native cache.
 * @param resourcesRuntime - Bundled interpreters outside the application archive.
 * @param mode - Strict by default; development permits workspace links through the existing local inspector launch.
 * @returns Resolves after checks and teardown; rejects on a check or teardown failure.
 */
export async function smokeDesktopRuntime(
  root: string, node: string, runtime: DesktopRuntimeDescriptor, environment: NodeJS.ProcessEnv, resourcesRuntime: string,
  mode: DesktopSmokeMode = 'strict',
): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'dsh-desktop-smoke-'))
  const profile = join(home, 'profiles', 'desktop')
  const hostEnvironment = {
    ...Object.fromEntries(Object.entries(environment).filter(([name]) => !/^(?:npm|pnpm|corepack)_/iu.test(name))),
    DSH_HOME: home, MUSE_HOME: home, HOME: home, USERPROFILE: home,
    XDG_CONFIG_HOME: home, XDG_CACHE_HOME: home, XDG_STATE_HOME: home,
    APPDATA: home, LOCALAPPDATA: home,
    npm_config_userconfig: join(home, 'npmrc'), npm_config_globalconfig: join(home, 'npmrc'),
    npm_config_store_dir: join(home, 'store'), npm_config_enable_global_virtual_store: 'false',
  }
  const host = new DesktopHostProcess(node, root, profile, mode === 'development' ? 0 : undefined, hostEnvironment,
    undefined, join(resourcesRuntime, 'primary-runtime'),
    { pnpm: join(resourcesRuntime, 'primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.mjs'), nodeBin: join(resourcesRuntime, 'bin') })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    writeFileSync(join(home, 'npmrc'), '')
    createPluginProfile(profile)
    prepareDesktopSmokeSkills(home)
    const pluginName = 'desktop-runtime-smoke-plugin'
    const plugin = join(home, pluginName)
    mkdirSync(plugin, { recursive: true })
    const installedName = 'desktop-installed-smoke-plugin'
    const installedPlugin = join(home, installedName)
    mkdirSync(installedPlugin)
    writeFileSync(join(installedPlugin, 'package.json'), JSON.stringify({
      name: installedName, version: '1.0.0', type: 'module', exports: './index.js', dsh: { bundle: { patch: './bundle.yml' } },
    }))
    writeFileSync(join(installedPlugin, 'index.js'), `
export function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/desktop-smoke-installed',
    handler(_request, response) { response.end('installed plugin ready') } }))
}
`)
    writeFileSync(join(installedPlugin, 'bundle.yml'), `- insert:\n    - id: ${installedName}\n      name: ${installedName}\n      inject: [webServer]\n`)
    appendFileSync(join(profile, 'pnpm-workspace.yaml'), 'offline: true\nupdateNotifier: false\n')
    const installedCli = join(root, 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js')
    const cli = mode === 'development' ? join(home, 'desktop-cli.mjs') : installedCli
    if (mode === 'development') {
      writeFileSync(cli, `import { runDesktopCli } from ${JSON.stringify(pathToFileURL(installedCli).href)}\n`
        + `await runDesktopCli(${JSON.stringify(root)}, ${JSON.stringify(resourcesRuntime)})\n`, { flag: 'wx' })
    }
    const runCli = (args: string[]) => promisify(execFile)(node,
      ['--expose-internals', cli, 'plugin', '--profile', 'desktop', ...args],
      { cwd: home, env: { ...hostEnvironment, ELECTRON_RUN_AS_NODE: '1' }, timeout: 120_000, windowsHide: true })
    await runCli(['add', `file:${installedPlugin}`, '--offline', '--ignore-scripts'])
    const installedEntry = join(profile, 'node_modules', installedName, 'index.js')
    if (readFileSync(installedEntry, 'utf8') !== readFileSync(join(installedPlugin, 'index.js'), 'utf8')) {
      throw new Error('desktop runtime: CLI did not install the local plugin')
    }
    await runCli(['remove', installedName])
    if (existsSync(installedEntry)) throw new Error('desktop runtime: CLI did not remove the local plugin')
    console.log('desktop runtime: CLI offline plugin installation and removal passed')
    const primary = join(resourcesRuntime, 'primary-runtime')
    const dependencies = workspaceDependencyPaths(primary, await readPrimaryRuntime(primary))
    const downloadScript = join(root, 'node_modules', 'muse-douyin-download', 'python', 'scripts', 'download.py')
      .replace(/([\\/])app\.asar([\\/])/u, '$1app.asar.unpacked$2')
    await promisify(execFile)(dependencies.python, ['-I', '-B', downloadScript, '--help'],
      { env: hostEnvironment, timeout: 30_000, windowsHide: true })
    await promisify(execFile)(dependencies.python, ['-I', '-B',
      fileURLToPath(new URL('../tests/fixtures/office-conversion-inputs.py', import.meta.url)), home],
    { env: hostEnvironment, timeout: 120_000, windowsHide: true })
    const inputs = ['docx', 'xlsx', 'pptx'].map(extension => ({ extension,
      bytes: readFileSync(join(home, `input.${extension}`)).toString('base64') }))
    const cordis = runtime.sharedPackages.find(entry => entry.name === '@deepseek-ai/cordis')
    if (cordis === undefined) throw new Error('desktop runtime: missing shared Cordis package')
    writeFileSync(join(plugin, 'package.json'), JSON.stringify({
      name: pluginName, version: '1.0.0', type: 'module', exports: './index.js',
      peerDependencies: { '@deepseek-ai/cordis': cordis.version }, dsh: { bundle: { patch: './bundle.yml' } },
    }))
    writeFileSync(join(plugin, 'index.js'), `
import { Context } from '@deepseek-ai/cordis'
import { inspect, promisify } from 'node:util'
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
export function apply(ctx) {
  if (!(ctx instanceof Context)) throw new Error('desktop runtime: external plugin loaded another Cordis instance')
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/desktop-smoke',
    handler(_request, response) { response.end('plugin route ready') } }))
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/desktop-smoke-install',
    async handler(_request, response) {
      try {
        response.end(JSON.stringify(await ctx.pluginManager.installBundle(${JSON.stringify(installedPlugin)})))
      } catch (error) {
        response.statusCode = 500
        response.end(inspect(error, { depth: 5 }))
      }
    } }))
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/desktop-smoke-office-cli',
    async handler(_request, response) {
      try {
        const skill = await ctx.skills.get('office-export-pdf')
        const json = skill?.content.match(/\\n(\\{\\n[\\s\\S]+)$/u)?.[1]
        if (json === undefined) throw new Error('Office skill did not supply CLI paths')
        const { libreofficeKit: { node, cli } } = JSON.parse(json)
        const options = { cwd: ${JSON.stringify(home)}, env: { ...process.env, PATH: '' }, timeout: 120_000 }
        const capabilities = await promisify(execFile)(node, [cli, 'capabilities'], options)
        const output = ${JSON.stringify(join(home, 'cli.pdf'))}
        await promisify(execFile)(node, [cli, 'convert', '--input', ${JSON.stringify(join(home, 'input.docx'))}, '--output', output], options)
        response.end(JSON.stringify({ capabilities: JSON.parse(capabilities.stdout), pdf: (await readFile(output)).toString('base64') }))
      } catch (error) {
        response.statusCode = 500
        response.end(inspect(error, { depth: 5 }))
      }
    } }))
  for (const input of ${JSON.stringify(inputs)}) {
    ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/desktop-smoke-office/' + input.extension,
      async handler(_request, response) {
        try {
          const bytes = Buffer.from(input.bytes, 'base64')
          const result = await ctx.officeToPdf.convert({ extension: input.extension, priority: 'foreground',
            source: { key: 'desktop-smoke-' + input.extension, version: 'fixture', bytes: bytes.length,
              async read() { return { bytes, version: 'fixture' } } } })
          response.end(Buffer.from(result.pdf))
        } catch (error) {
          response.statusCode = 500
          response.end(inspect(error, { depth: 5 }))
        }
      } }))
  }
}
`)
    writeFileSync(join(plugin, 'bundle.yml'), '- insert:\n    - id: desktop-runtime-smoke-plugin\n      name: desktop-runtime-smoke-plugin\n      inject: [webServer, officeToPdf, skills, pluginManager]\n')
    const productPluginName = 'desktop-runtime-product-smoke-plugin'
    const productPlugin = join(profile, 'node_modules', productPluginName)
    mkdirSync(productPlugin, { recursive: true })
    writeFileSync(join(productPlugin, 'package.json'), JSON.stringify({
      name: productPluginName, version: '1.0.0', type: 'module', exports: './index.js',
      peerDependencies: { '@deepseek-ai/cordis': cordis.version, '@deepseek-ai/dsh-llm': runtime.release.version },
      dsh: { bundle: { patch: './bundle.yml' } },
    }))
    writeFileSync(join(productPlugin, 'index.js'), desktopSmokePluginSource(root, home))
    writeFileSync(join(productPlugin, 'bundle.yml'), '- insert:\n    - id: desktop-runtime-product-smoke-plugin\n      name: desktop-runtime-product-smoke-plugin\n')
    cpSync(plugin, join(profile, 'node_modules', pluginName), { recursive: true })
    const manifest = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
      dsh: { profile: { bundles: string[] } }
    }
    manifest.dependencies = { ...manifest.dependencies, [pluginName]: `file:${plugin}`, [productPluginName]: `file:${productPlugin}` }
    manifest.dsh.profile.bundles.push(pluginName, productPluginName)
    writeFileSync(join(profile, 'package.json'), JSON.stringify(manifest))
    writeFileSync(join(profile, 'cordis.patch.yml'), '- id: webserver\n  config:\n    host: 127.0.0.1\n    port: 0\n')
    const ready = await Promise.race([host.start(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => { reject(new Error('desktop runtime: Host readiness exceeded 120 seconds')) }, 120_000)
    })])
    clearTimeout(timer)
    // Preset contributors have settled only after Host readiness, not during fixture activation.
    const productSmoke = await fetch(new URL('/desktop-product-smoke', ready.url), { signal: AbortSignal.timeout(120_000) })
    const productSmokeText = await productSmoke.text()
    const diagnosticStart = productSmokeText.indexOf('\nDesktop lifecycle diagnostics: ')
    if (diagnosticStart >= 0) console.log(productSmokeText.slice(diagnosticStart + 1))
    if (!productSmoke.ok || !existsSync(join(home, '.desktop-product-smoke-complete'))) {
      const failure = existsSync(join(home, '.desktop-product-smoke-error'))
        ? readFileSync(join(home, '.desktop-product-smoke-error'), 'utf8').trim()
        : 'no activation error was recorded'
      throw new Error(`desktop runtime: product preset smoke did not complete: ${failure}`)
    }
    const hostUrl = new URL(ready.url)
    if (hostUrl.protocol !== 'http:' || hostUrl.hostname !== '127.0.0.1' || Number(hostUrl.port) <= 0) {
      throw new Error('desktop runtime: Host must report an assigned loopback HTTP port')
    }
    const unauthenticated = await fetch(new URL('/api/settings/describe', hostUrl))
    await unauthenticated.body?.cancel()
    if (![401, 403].includes(unauthenticated.status)) throw new Error('desktop runtime: unauthenticated API access was not rejected')
    const login = await fetch(ready.url, { redirect: 'manual' })
    const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
    const response = await fetch(new URL('/', ready.url), { headers: { cookie } })
    if (response.status !== 200 || !(await response.text()).includes('<html')) {
      throw new Error('desktop runtime: packaged frontend smoke failed')
    }
    const pluginResponse = await fetch(new URL('/desktop-smoke', ready.url), { headers: { cookie } })
    if (await pluginResponse.text() !== 'plugin route ready') throw new Error('desktop runtime: plugin HTTP route failed')
    const installation = await fetch(new URL('/desktop-smoke-install', ready.url), {
      headers: { cookie }, signal: AbortSignal.timeout(120_000),
    })
    const installationResult = await installation.text()
    const installed = await fetch(new URL('/desktop-smoke-installed', ready.url), { headers: { cookie } })
    if (!installation.ok || !installed.ok || await installed.text() !== 'installed plugin ready') {
      throw new Error(`desktop runtime: bundled pnpm plugin installation failed: ${installationResult}`)
    }
    for (const { extension } of inputs) {
      const converted = await fetch(new URL(`/desktop-smoke-office/${extension}`, ready.url), {
        headers: { cookie }, signal: AbortSignal.timeout(120_000),
      })
      if (!converted.ok) throw new Error(`desktop runtime: ${extension} conversion failed: ${await converted.text()}`)
      const pdf = Buffer.from(await converted.arrayBuffer())
      if (!/^%PDF-\d\.\d/u.test(pdf.subarray(0, 8).toString())
        || !pdf.subarray(-1024).toString().trimEnd().endsWith('%%EOF')) {
        throw new Error(`desktop runtime: invalid ${extension} PDF output`)
      }
    }
    const cliResponse = await fetch(new URL('/desktop-smoke-office-cli', ready.url), {
      headers: { cookie }, signal: AbortSignal.timeout(120_000),
    })
    if (!cliResponse.ok) throw new Error(`desktop runtime: skill CLI failed: ${await cliResponse.text()}`)
    const cliResult = await cliResponse.json() as { capabilities: { runtime: { cliPath: string } }; pdf: string }
    if (!cliResult.capabilities.runtime.cliPath.endsWith('cli.js') || Buffer.from(cliResult.pdf, 'base64').subarray(0, 5).toString() !== '%PDF-') {
      throw new Error('desktop runtime: skill CLI did not return capabilities and a PDF')
    }
    console.log('desktop runtime: DOCX, XLSX, PPTX to PDF and skill CLI discovery passed')
  } finally {
    clearTimeout(timer)
    try { await host.stop() } finally {
      await rm(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
    }
  }
}

if (isEntry(import.meta.url)) {
  const args = process.argv.slice(2)
  const mode = args.at(-1) === '--development' ? 'development' : 'strict'
  if (mode === 'development') args.pop()
  const [root, node, resourcesRuntime] = args
  if (args.length !== 3 || root === undefined || node === undefined || resourcesRuntime === undefined) {
    throw new Error('desktop smoke: expected runtime root, Electron executable and external runtime directory, optionally --development')
  }
  await smokeDesktopRuntime(root, node, readDesktopRuntime(root), process.env, resourcesRuntime, mode)
}
