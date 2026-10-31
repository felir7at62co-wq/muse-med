/** Boot the materialized target runtime without access to a user's Harness profile. */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { readPrimaryRuntime, workspaceDependencyPaths } from '../../../packages/skill/tool-workspace-dependencies/src/index.ts'
import { DesktopHostProcess } from '../src/host-process.ts'
import { createPluginProfile } from '../src/project-manager.ts'
import { recordDesktopRuntimeProfile, validateDesktopPluginGraph } from '../src/profile-packages.ts'
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
 * native skill locations, and completed Agent disposal. Historical editing resolves to short-drama.
 */
export function desktopSmokePluginSource(root: string, home: string): string {
  return `
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import { existsSync, realpathSync, writeFileSync } from 'node:fs'
import { join, relative, isAbsolute } from 'node:path'
export const inject = ['agentPresets', 'agents', 'agentLoop', 'systemPrompt', 'tools', 'skills', 'credentials', 'webServer', 'museAccount', 'toolDiscovery']
export function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/desktop-product-smoke', handler: async (_request, response) => {
  if (!(ctx instanceof Context)) throw new Error('desktop runtime: external plugin loaded another Cordis instance')
  const root = ${JSON.stringify(root)}
  const home = ${JSON.stringify(home)}
  const skillLayout = ${JSON.stringify(desktopSmokeSkillLayout(home))}
  const cwd = skillLayout.cwd
  const editingModelInput = ${JSON.stringify(editingModelInput)}
  const creationSkillNames = new Set(${JSON.stringify(CREATION_SKILL_NAMES)})
  const creationUserSources = new Set(['custom', 'user-muse', 'user-dsh', 'user-agents', 'project-muse', 'project-dsh', 'project-agents'])
  try {
  if (typeof ctx.museAccount.feedback !== 'function') throw new Error('desktop runtime: Muse inbox feedback method is missing')
  const ids = ['short-drama', 'ptc', 'standard', 'minimal', 'cordis', 'bot-coordinator', 'creation']
  const presets = await ctx.agentPresets.list()
  if (presets.length !== ids.length || ids.some(id => !presets.some(preset => preset.id === id))) {
    throw new Error('desktop runtime: product preset roster differs; expected ' + ids.join(', ') + '; found ' + presets.map(preset => preset.id).join(', '))
  }
  if (ctx.agentPresets.defaultId !== 'short-drama') throw new Error('desktop runtime: product default preset changed')
  if ((await ctx.agentPresets.resolve('editing')).id !== 'short-drama') {
    throw new Error('desktop runtime: retired editing preset must resolve to short-drama')
  }
  const inventory = await ctx.agentPresets.compositionInventory()
  for (const id of ids) {
  const preset = await ctx.agentPresets.resolve(id)
  const expected = join(root, 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'presets', id, 'agent.cordis.yml')
  const composition = inventory.find(row => row.id === id)
  if (preset.broken !== undefined || !existsSync(expected) || composition === undefined || composition.rows.length === 0) {
    throw new Error('desktop runtime: preset is broken or missing from the product package: ' + id + '; ' + (preset.broken ?? 'composition absent'))
  }
  const handles = []
  try {
    for (let index = 0; index < 2; index++) {
      handles.push(await ctx.agents.create({
        sessionId: 'desktop-product-smoke-' + id + '-' + index, meta: { cwd, agentPreset: id },
        setup: async agentCtx => { await ctx.agentPresets.mount(agentCtx, id) },
      }))
    }
    for (const handle of handles) {
    const names = new Set(ctx.tools.schemas(handle.agent).map(tool => tool.name))
    const shell = process.platform === 'win32' ? 'pwsh' : 'bash'
    const required = id === 'short-drama' ? ['jubian_asset', 'jubian_catalog', 'jubian_model', 'jubian_storyboard', 'jubian_video', 'jubian_budget',
      'jubian_media', 'jubian_watch', 'bgm_match', 'ffmpeg_probe', 'ffmpeg_encode', 'skill', 'ask_user_question', 'todo_write', 'todo_update',
      'drama_assets', 'drama_bgm', 'drama_render', 'drama_project', 'drama_draft_dir', 'jianying_draft', 'manuscript_revision', 'source_recover', 'screenplay_export_docx', 'read', 'present', 'video_inspect', 'video_ocr',
      process.platform === 'win32' ? 'pwsh' : 'bash']
      : id === 'minimal' ? [shell]
        : id === 'creation' ? ['read', 'skill', shell, 'present', 'run_code', 'video_contact_sheet', 'video_ocr',
          'drama_assets', 'drama_bgm', 'drama_render', 'drama_project', 'drama_draft_dir', 'jianying_draft',
          'jubian_find', 'jubian_claim', 'jubian_snatch',
          'mcp__muse-account__muse_account_status', 'mcp__muse-account__muse_kb_search',
          'mcp__muse-account__muse_kb_read', 'mcp__muse-account__muse_kb_read_opening',
          'mcp__muse-account__muse_kb_ingest_script']
        : id === 'bot-coordinator' ? ['read', 'write', 'edit', 'glob', 'grep', 'skill', shell, 'present',
          'web_search', 'web_fetch', 'ask_user_question', 'todo_write', 'todo_update', 'subagent',
          'tool_search', 'tool_context', 'list_bots', 'message_bot', 'create_bot', 'update_bot', 'stop_bot']
          : ['read', 'skill', shell, 'subagent']
    for (const name of required) if (!names.has(name)) throw new Error('desktop runtime: missing product tool ' + name + ' in ' + id + ' (visible: ' + [...names].sort().join(', ') + ')')
    if (names.has('audio_transcribe') !== (id !== 'minimal')) throw new Error('desktop runtime: transcription availability differs in ' + id)
    if (id === 'minimal') {
      const inherited = new Set(ctx.tools.schemas().map(tool => tool.name))
      const local = [...names].filter(name => !inherited.has(name))
      if (local.length !== 1 || local[0] !== shell) throw new Error('desktop runtime: minimal must add only its persistent shell; found ' + local.join(', '))
    }
    if (id === 'short-drama') {
      const assembly = await ctx.systemPrompt.assemble({ agent: handle.agent, scope: handle.agent })
      const persona = assembly.sections.find(section => section.name === 'deployment:persona-prefix')?.text
      if (!persona?.startsWith(editingModelInput.personaPrefix)) {
        throw new Error('desktop runtime: unified creative persona changed')
      }
      const delivery = assembly.sections.find(section => section.name === 'editing:delivery')?.text
      if (!delivery?.includes('默认使用 Word（.docx）') || !delivery.includes('screenplay_export_docx')) {
        throw new Error('desktop runtime: editing Word delivery guidance is missing')
      }
      const accountTools = Object.keys(editingModelInput.tools)
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
      if (accountTools.some(name => initialNames.includes(name))) {
        throw new Error('desktop runtime: account tools must remain deferred before discovery')
      }
      const manage = async operation => {
        const callId = ToolCallId(handle.agent.id + ':desktop-smoke-' + operation)
        const args = { operation, tools: accountTools }
        const call = handle.agent.session.append('tool/call', {
          turn: 1, step: 1, callId, name: 'tool_context', arguments: JSON.stringify(args),
        })
        const result = await ctx.tools.execute({ name: 'tool_context', arguments: args,
          agent: handle.agent, callId, signal: AbortSignal.timeout(30_000) })
        handle.agent.session.append('tool/result', {
          turn: 1, step: 1, message: createToolResultMessage({ callId, content: result.content, isError: result.isError }),
        }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
        if (result.isError) throw new Error('desktop runtime: tool_context ' + operation + ' failed')
      }
      await manage('load')
      const loaded = await ctx.systemPrompt.assemble({ agent: handle.agent, scope: handle.agent })
      for (const [name, description] of Object.entries(editingModelInput.tools)) {
        if (loaded.tools.find(tool => tool.name === name)?.description !== description) {
          throw new Error('desktop runtime: editing model tool description changed after loading: ' + name)
        }
      }
      await manage('release')
      const released = await ctx.systemPrompt.assemble({ agent: handle.agent, scope: handle.agent })
      if (JSON.stringify(released.tools.map(tool => tool.name).sort()) !== JSON.stringify(initialNames)
        || accountTools.some(name => ctx.toolDiscovery.state(handle.agent).loaded.includes(name))) {
        throw new Error('desktop runtime: releasing account tools did not restore initial model tools')
      }
    }
    if ((id === 'ptc' || id === 'creation') && (!names.has('run_code') || names.has('workflow'))) {
      throw new Error('desktop runtime: PTC tool presentation is incomplete in ' + id)
    }
    if (id === 'creation' && ['subagent', 'subagent_fork', 'subagent_codex', 'subagent_claude_code'].some(name => names.has(name))) {
      throw new Error('desktop runtime: creation mode must use a single agent')
    }
    const skillRegistry = id === 'creation' ? ctx.agentPresets.serviceFor(handle.agent, 'skills') : ctx.skills
    if (skillRegistry === undefined) throw new Error('desktop runtime: creation skill registry is not isolated')
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
        const loaded = await skillRegistry.get(name, { scope: handle.agent, cwd })
        if (!loaded?.content?.trim() || !loaded.path || !existsSync(expected) || !existsSync(loaded.path)
          || realpathSync.native(skill.path) !== realpathSync.native(expected)
          || realpathSync.native(loaded.path) !== realpathSync.native(expected)) {
          throw new Error('desktop runtime: shot-writing skill did not load from its packaged resource: ' + name)
        }
      }
    }
    }
  } finally {
    for (const handle of handles.reverse()) await handle.dispose()
  }
  }
  writeFileSync(join(home, '.desktop-product-smoke-complete'), 'ok\\n', { flag: 'wx' })
  response.end('ok')
  } catch (error) {
    writeFileSync(join(home, '.desktop-product-smoke-error'), String(error && error.stack ? error.stack : error), { flag: 'wx' })
    response.statusCode = 500
    response.end(String(error && error.stack ? error.stack : error))
  }
  } }))
}
`
}

/**
 * Check Host startup, its matching frontend, external plugins and real Office-to-PDF conversion.
 * @param root - Materialized dsh resources.
 * @param node - Prepared target Electron executable.
 * @param runtime - Verified resource descriptor.
 * @param environment - Credential-scrubbed build environment and private native cache.
 * @param resourcesRuntime - Bundled interpreters outside the application archive.
 * @returns Resolves after checks and teardown; rejects on a check or teardown failure.
 */
export async function smokeDesktopRuntime(
  root: string, node: string, runtime: DesktopRuntimeDescriptor, environment: NodeJS.ProcessEnv, resourcesRuntime: string,
): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'dsh-desktop-smoke-'))
  const profile = join(home, 'profiles', 'desktop')
  const host = new DesktopHostProcess(node, root, profile, undefined, {
    ...environment, MUSE_HOME: home, DSH_HOME: home, DSH_AGENTS_HOME: join(home, '.agents'),
    HOME: home, USERPROFILE: home,
    APPDATA: join(home, 'AppData', 'Roaming'), LOCALAPPDATA: join(home, 'AppData', 'Local'),
  }, undefined, join(resourcesRuntime, 'primary-runtime'),
  { pnpm: join(resourcesRuntime, 'pnpm', 'bin', 'pnpm.mjs'), nodeBin: join(resourcesRuntime, 'bin') })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    createPluginProfile(profile)
    prepareDesktopSmokeSkills(home)
    const pluginName = 'desktop-runtime-smoke-plugin'
    const plugin = join(profile, 'node_modules', pluginName)
    mkdirSync(plugin, { recursive: true })
    const primary = join(resourcesRuntime, 'primary-runtime')
    const dependencies = workspaceDependencyPaths(primary, await readPrimaryRuntime(primary))
    const downloadScript = join(root, 'node_modules', 'muse-douyin-download', 'python', 'scripts', 'download.py')
      .replace(/([\\/])app\.asar([\\/])/u, '$1app.asar.unpacked$2')
    await promisify(execFile)(dependencies.python, ['-I', '-B', downloadScript, '--help'],
      { env: environment, timeout: 30_000, windowsHide: true })
    await promisify(execFile)(dependencies.python, ['-I', '-B',
      fileURLToPath(new URL('../tests/fixtures/office-conversion-inputs.py', import.meta.url)), home],
    { env: environment, timeout: 120_000, windowsHide: true })
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
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/desktop-smoke-office-cli',
    async handler(_request, response) {
      try {
        const skill = await ctx.skills.get('office-docx')
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
    writeFileSync(join(plugin, 'bundle.yml'), '- insert:\n    - id: desktop-runtime-smoke-plugin\n      name: desktop-runtime-smoke-plugin\n      inject: [webServer, officeToPdf, skills]\n')
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
    const manifest = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>
      dsh: { profile: { bundles: string[] } }
    }
    manifest.dependencies[pluginName] = '1.0.0'
    manifest.dependencies[productPluginName] = '1.0.0'
    manifest.dsh.profile.bundles.push(pluginName, productPluginName)
    writeFileSync(join(profile, 'package.json'), JSON.stringify(manifest))
    writeFileSync(join(profile, 'cordis.patch.yml'), '- id: webserver\n  config:\n    host: 127.0.0.1\n    port: 0\n')
    recordDesktopRuntimeProfile(profile, runtime)
    validateDesktopPluginGraph(profile, root, runtime, [pluginName, productPluginName], 'runtime')
    const ready = await Promise.race([host.start(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => { reject(new Error('desktop runtime: Host readiness exceeded 120 seconds')) }, 120_000)
    })])
    clearTimeout(timer)
    // Preset contributors have settled only after Host readiness, not during fixture activation.
    const productSmoke = await fetch(new URL('/desktop-product-smoke', ready.url), { signal: AbortSignal.timeout(120_000) })
    await productSmoke.text()
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
    await host.stop()
    rmSync(home, { recursive: true, force: true })
  }
}

if (isEntry(import.meta.url)) {
  const args = process.argv.slice(2)
  const [root, node, resourcesRuntime] = args
  if (args.length !== 3 || root === undefined || node === undefined || resourcesRuntime === undefined) {
    throw new Error('desktop smoke: expected runtime root, Electron executable and external runtime directory')
  }
  await smokeDesktopRuntime(root, node, readDesktopRuntime(root), process.env, resourcesRuntime)
}
