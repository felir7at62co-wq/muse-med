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

const editingModelInput = JSON.parse(readFileSync(new URL('../tests/expected/editing-model-input.json', import.meta.url), 'utf8')) as {
  personaPrefix: string
  tools: Record<string, string>
}

/** Generate the private startup plugin that mounts the complete product preset through Host services.
 * @param root - Prepared product package root.
 * @param home - Disposable smoke home and workspace.
 * @returns ESM plugin source that records completion only after preset, model inputs, skills, and Agent disposal succeed.
 */
export function desktopSmokePluginSource(root: string, home: string): string {
  return `
import { Context } from '@deepseek-ai/cordis'
import { existsSync, realpathSync, writeFileSync } from 'node:fs'
import { join, relative, isAbsolute } from 'node:path'
export const inject = ['agentPresets', 'agents', 'agentLoop', 'systemPrompt', 'tools', 'skills', 'credentials', 'webServer']
export function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/desktop-product-smoke', handler: async (_request, response) => {
  if (!(ctx instanceof Context)) throw new Error('desktop runtime: external plugin loaded another Cordis instance')
  const root = ${JSON.stringify(root)}
  const home = ${JSON.stringify(home)}
  const editingModelInput = ${JSON.stringify(editingModelInput)}
  try {
  const ids = ['short-drama', 'ptc', 'standard', 'minimal', 'cordis', 'editing']
  const presets = await ctx.agentPresets.list()
  if (presets.length !== ids.length || ids.some(id => !presets.some(preset => preset.id === id))) {
    throw new Error('desktop runtime: expected exactly the six product presets; found ' + presets.map(preset => preset.id).join(', '))
  }
  if (ctx.agentPresets.defaultId !== 'short-drama') throw new Error('desktop runtime: product default preset changed')
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
        sessionId: 'desktop-product-smoke-' + id + '-' + index, meta: { cwd: home, agentPreset: id },
        setup: async agentCtx => { await ctx.agentPresets.mount(agentCtx, id) },
      }))
    }
    for (const handle of handles) {
    const names = new Set(ctx.tools.schemas(handle.agent).map(tool => tool.name))
    const shell = process.platform === 'win32' ? 'pwsh' : 'bash'
    const required = id === 'short-drama' ? ['jubian_asset', 'jubian_catalog', 'jubian_model', 'jubian_storyboard', 'jubian_video',
      'jubian_media', 'jubian_watch', 'bgm_match', 'ffmpeg_probe', 'ffmpeg_encode', 'skill',
      'drama_assets', 'drama_shot', 'drama_bgm', 'drama_render', 'read', 'present',
      process.platform === 'win32' ? 'pwsh' : 'bash']
      : id === 'minimal' ? [shell]
        : id === 'editing' ? ['read', 'skill', shell, 'present',
          'mcp__muse-account__muse_account_status', 'mcp__muse-account__muse_kb_search',
          'mcp__muse-account__muse_kb_read', 'mcp__muse-account__muse_kb_read_opening']
        : ['read', 'skill', shell, 'subagent']
    for (const name of required) if (!names.has(name)) throw new Error('desktop runtime: missing product tool ' + name + ' in ' + id + ' (visible: ' + [...names].sort().join(', ') + ')')
    if (id === 'minimal') {
      const inherited = new Set(ctx.tools.schemas().map(tool => tool.name))
      const local = [...names].filter(name => !inherited.has(name))
      if (local.length !== 1 || local[0] !== shell) throw new Error('desktop runtime: minimal must add only its persistent shell; found ' + local.join(', '))
    }
    if (id === 'editing' && [...names].some(name => name.startsWith('jubian_'))) {
      throw new Error('desktop runtime: editing mode inherited Jubian video tools')
    }
    if (id === 'editing') {
      const assembly = await ctx.systemPrompt.assemble({ agent: handle.agent, scope: handle.agent })
      const persona = assembly.sections.find(section => section.name === 'deployment:persona-prefix')?.text
      if (persona !== editingModelInput.personaPrefix
        || !persona?.includes('正式写作前先检索并阅读获授权知识库的相关案例 Wiki 页，再实际阅读有来源的爆款剧本开头')) {
        throw new Error('desktop runtime: editing persona changed')
      }
      for (const [name, description] of Object.entries(editingModelInput.tools)) {
        if (assembly.tools.find(tool => tool.name === name)?.description !== description) {
          throw new Error('desktop runtime: editing model tool description changed: ' + name)
        }
      }
    }
    if (id === 'ptc' && (!names.has('run_code') || names.has('workflow'))) throw new Error('desktop runtime: PTC tool presentation is incomplete')
    const skills = await ctx.skills.list({ scope: handle.agent, cwd: home })
    if (names.has('skill')) {
      const productSkills = join(root, 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'skills')
      for (const name of ['audio-transcribe', 'transcript-to-novel', 'transcript-to-script', 'media-link-import']) {
        const skill = skills.find(value => value.name === name)
        const expected = join(productSkills, name, 'SKILL.md')
        if (!skill?.invocation.modelInvocable || !existsSync(expected)
          || realpathSync(skill.path) !== realpathSync(expected)) {
          throw new Error('desktop runtime: missing shared Muse skill ' + name)
        }
      }
      if (!existsSync(join(productSkills, 'audio-transcribe', 'scripts', 'transcribe.py'))) {
        throw new Error('desktop runtime: missing shared Muse transcription script')
      }
      if (!existsSync(join(productSkills, 'media-link-import', 'scripts', 'import_media.py'))) {
        throw new Error('desktop runtime: missing shared Muse media import script')
      }
    }
    if (id === 'cordis' && !skills.some(skill => skill.name === 'editing-cordis-compositions')) {
      throw new Error('desktop runtime: cordis authoring skill is not mounted')
    }
    const editingSkill = skills.find(skill => skill.name === 'muse-script-editing')
    if (id === 'editing' && (!editingSkill
      || realpathSync(editingSkill.path) !== realpathSync(join(root, 'node_modules', '@deepseek-ai',
        'dsh-desktop-host', 'skills', 'editing', 'SKILL.md')))) {
      throw new Error('desktop runtime: editing skill is not mounted')
    }
    const custom = skills.find(skill => skill.name === 'desktop-user-skill')
    if (!custom || realpathSync(custom.path) !== realpathSync(join(home, 'skills/desktop-user-skill/SKILL.md'))
      || skills.some(skill => skill.name === 'desktop-legacy-only')) {
      throw new Error('desktop runtime: product custom skills missing or legacy skills discovered in ' + id)
    }
    const bundled = realpathSync(join(root, 'node_modules', '@deepseek-ai', 'dsh-drama-skills', 'skills')
      .replace(/([\\\\/])app\\.asar([\\\\/])/u, '$1app.asar.unpacked$2'))
    if (existsSync(join(bundled, 'xiaohongshu-reference')) || skills.some(skill => skill.name === 'xiaohongshu-reference')) {
      throw new Error('desktop runtime: XHS must not ship in the product directory or skill registry')
    }
    const requiredSkills = ['tweet-drama-pipeline', 'tweet-drama-core', 'tweet-drama-script-convert',
      'tweet-drama-script-split', 'tweet-drama-asset-extract', 'tweet-drama-asset-vision-check',
      'shot-script-creator-9-16', 'tweet-drama-shot-asset-match', 'tweet-drama-early-shot-script',
      'tweet-drama-draft-build', 'tweet-drama-background-render', 'tweet-drama-project-inspect', 'tweet-drama-delivery']
    for (const name of requiredSkills) {
      const skill = skills.find(value => value.name === name)
      if (!skill || !skill.path || !skill.invocation.modelInvocable) throw new Error('desktop runtime: missing product skill ' + name)
      const path = relative(bundled, realpathSync(skill.path))
      if (isAbsolute(path) || path === '..' || path.startsWith('../') || path.startsWith('..\\\\')) {
        throw new Error('desktop runtime: skill outside product bundle ' + name)
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
    ...environment, DSH_HOME: home, HOME: home, USERPROFILE: home,
    APPDATA: join(home, 'AppData', 'Roaming'), LOCALAPPDATA: join(home, 'AppData', 'Local'),
  }, undefined, join(resourcesRuntime, 'primary-runtime'),
  { pnpm: join(resourcesRuntime, 'pnpm', 'bin', 'pnpm.cjs'), nodeBin: join(resourcesRuntime, 'bin') })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    createPluginProfile(profile)
    for (const [directory, name] of [
      ['skills', 'desktop-user-skill'], ['.agents/skills', 'desktop-user-skill'],
      ['.agents/skills', 'desktop-legacy-only'], ['.dsh/skills', 'desktop-legacy-only'],
    ] as const) {
      const skill = join(home, directory, name)
      mkdirSync(skill, { recursive: true })
      writeFileSync(join(skill, 'SKILL.md'), `---\nname: ${name}\ndescription: Isolated Desktop smoke fixture.\n---\n# ${name}\n`)
    }
    const pluginName = 'desktop-runtime-smoke-plugin'
    const plugin = join(profile, 'node_modules', pluginName)
    mkdirSync(plugin, { recursive: true })
    const primary = join(resourcesRuntime, 'primary-runtime')
    const dependencies = workspaceDependencyPaths(primary, await readPrimaryRuntime(primary))
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
      peerDependencies: { '@deepseek-ai/cordis': cordis.version }, dsh: { bundle: { patch: './bundle.yml' } },
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
