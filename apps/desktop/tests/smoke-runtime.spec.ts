import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join, dirname, relative, isAbsolute } from 'node:path'
import { tmpdir } from 'node:os'
import { runInNewContext } from 'node:vm'
import { afterEach, expect, it, vi } from 'vitest'
import { desktopSmokePluginSource, smokeDesktopRuntime } from '../scripts/smoke-runtime.ts'
import { DesktopHostProcess } from '../src/host-process.ts'
import { runtimeFixture } from './runtime-fixture.ts'

const editingModelInput = JSON.parse(readFileSync(new URL('./expected/editing-model-input.json', import.meta.url), 'utf8')) as {
  personaPrefix: string
  tools: Record<string, string>
}

vi.mock('../src/profile-packages.ts', () => ({ recordDesktopRuntimeProfile: vi.fn(), validateDesktopPluginGraph: vi.fn() }))

// The Office-conversion fixture script and the Host startup are the two halves of
// this smoke; only the Host startup is under test, so the interpreter call is
// stubbed with the one thing the smoke reads back from it: the three sample
// documents it writes into the smoke home named by its last argument.
const { payload } = vi.hoisted(() => ({ payload: vi.fn(async (_file: string, args: string[]) => {
  const home = args[args.length - 1]!
  for (const extension of ['docx', 'xlsx', 'pptx']) writeFileSync(join(home, `input.${extension}`), Buffer.from('fixture'))
  return { stdout: '' }
}) }))
vi.mock('node:child_process', async (importOriginal) => {
  const { promisify } = await import('node:util')
  return { ...await importOriginal<typeof import('node:child_process')>(),
    execFile: Object.assign(vi.fn(), { [promisify.custom]: payload }) }
})

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

/**
 * Write the primary-runtime payload the smoke reads before it starts the Host.
 * @param root - Directory the resources directory is created under.
 * @returns The resources directory holding `primary-runtime`.
 */
function primaryRuntimeFixture(root: string): string {
  const resources = join(root, 'resources')
  const runtime = join(resources, 'primary-runtime')
  mkdirSync(runtime, { recursive: true })
  writeFileSync(join(runtime, 'runtime.json'), JSON.stringify({
    desktopVersion: '1.0.0', platform: process.platform, arch: process.arch,
    python: '3.12.14', pythonPackages: { numpy: '2.3.5', pandas: '3.0.1' },
  }))
  return resources
}

function fixture(packaged = false) {
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'desktop-product-smoke-test-'))
  roots.push(temporaryRoot)
  const root = packaged ? join(temporaryRoot, 'resources', 'app.asar', 'dsh') : temporaryRoot
  const unpacked = (path: string) => path.replace(/([\\/])app\.asar([\\/])/u, '$1app.asar.unpacked$2')
  const home = join(temporaryRoot, 'home')
  mkdirSync(home)
  const ids = ['short-drama', 'standard', 'ptc', 'minimal', 'cordis', 'editing']
  const presetPath = (id: string) => join(root, 'node_modules/@deepseek-ai/dsh-desktop-host/presets', id, 'agent.cordis.yml')
  for (const id of ids) {
    mkdirSync(dirname(presetPath(id)), { recursive: true })
    writeFileSync(presetPath(id), '[]')
  }
  const skillRoot = unpacked(join(root, 'node_modules/@deepseek-ai/dsh-drama-skills/skills'))
  const skillNames = ['tweet-drama-pipeline', 'tweet-drama-core', 'tweet-drama-script-convert',
    'tweet-drama-script-split', 'tweet-drama-asset-extract', 'tweet-drama-asset-vision-check',
    'shot-script-creator-9-16', 'tweet-drama-shot-asset-match', 'tweet-drama-early-shot-script',
    'tweet-drama-draft-build', 'tweet-drama-background-render', 'tweet-drama-project-inspect', 'tweet-drama-delivery']
  const skills = skillNames.map((name) => {
    const path = join(skillRoot, name, 'SKILL.md')
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, '# fixture')
    return { name, path, invocation: { modelInvocable: true } }
  })
  const customPath = join(home, 'skills/desktop-user-skill/SKILL.md')
  mkdirSync(dirname(customPath), { recursive: true })
  writeFileSync(customPath, '# fixture')
  skills.push({ name: 'desktop-user-skill', path: customPath, invocation: { modelInvocable: true } })
  const cordisSkill = {
    name: 'editing-cordis-compositions',
    path: unpacked(join(root, 'node_modules/@deepseek-ai/dsh-desktop-host/presets/cordis/skills/editing-cordis-compositions/SKILL.md')),
    invocation: { modelInvocable: true },
  }
  mkdirSync(dirname(cordisSkill.path), { recursive: true })
  writeFileSync(cordisSkill.path, '# fixture')
  const editingSkill = {
    name: 'muse-script-editing',
    path: unpacked(join(root, 'node_modules/@deepseek-ai/dsh-desktop-host/skills/editing/SKILL.md')),
    invocation: { modelInvocable: true },
  }
  mkdirSync(dirname(editingSkill.path), { recursive: true })
  writeFileSync(editingSkill.path, '# fixture')
  skills.push(editingSkill)
  for (const name of ['audio-transcribe', 'transcript-to-novel', 'transcript-to-script', 'media-link-import',
    'novel-to-script', 'trope-adaptation', 'jubian-snatch']) {
    const path = unpacked(join(root, 'node_modules/@deepseek-ai/dsh-desktop-host/skills', name, 'SKILL.md'))
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, '# fixture')
    skills.push({ name, path, invocation: { modelInvocable: true } })
  }
  const transcribeScript = unpacked(join(root, 'node_modules/@deepseek-ai/dsh-desktop-host/skills/audio-transcribe/scripts/transcribe.py'))
  mkdirSync(dirname(transcribeScript), { recursive: true })
  writeFileSync(transcribeScript, '# fixture')
  const mediaImportScript = unpacked(join(root, 'node_modules/@deepseek-ai/dsh-desktop-host/skills/media-link-import/scripts/import_media.py'))
  mkdirSync(dirname(mediaImportScript), { recursive: true })
  writeFileSync(mediaImportScript, '# fixture')
  const agent = { preset: 'short-drama' }
  const agentCtx = {}
  const dispose = vi.fn(async () => {})
  const mount = vi.fn(async (_context: object, _id: string) => {})
  const names = ['jubian_asset', 'jubian_catalog', 'jubian_model', 'jubian_storyboard', 'jubian_video',
    'jubian_media', 'jubian_watch', 'bgm_match', 'ffmpeg_probe', 'ffmpeg_encode', 'skill',
    'drama_assets', 'drama_shot', 'drama_bgm', 'drama_render', 'read', 'present', process.platform === 'win32' ? 'pwsh' : 'bash']
  type SmokeResponse = { statusCode: number; end(text: string): void }
  let route: { path: string; handler(request: object, response: SmokeResponse): Promise<void> } | undefined
  const accountMcpNames = ['jubian_find', 'jubian_claim', 'jubian_snatch',
    'mcp__muse-account__muse_account_status', 'mcp__muse-account__muse_kb_search',
    'mcp__muse-account__muse_kb_read', 'mcp__muse-account__muse_kb_read_opening',
    'mcp__muse-account__muse_kb_ingest_script']
  class TestContext {
    webServer = { register: vi.fn((value: NonNullable<typeof route>) => {
      route = value
      return () => { route = undefined }
    }) }
    effect(acquire: () => () => void) { return acquire() }
    agentPresets = {
      defaultId: 'short-drama',
      list: vi.fn(async () => ids.map(id => ({ id }))),
      resolve: vi.fn(async (id: string) => ({ id })),
      compositionInventory: vi.fn(async () => ids.map(id => ({ id, isDefault: id === 'short-drama', rows: [{ id: 'persona' }] }))),
      mount,
    }
    agents = { create: vi.fn(async (options: { setup: (context: object) => Promise<void>; meta: { agentPreset: string } }) => {
      await options.setup(agentCtx)
      return { agent: options.meta.agentPreset === 'short-drama' ? agent : { preset: options.meta.agentPreset }, dispose }
    }) }
    tools = { schemas: vi.fn((key?: { preset: string }) => {
      if (key === undefined) return []
      const shell = process.platform === 'win32' ? 'pwsh' : 'bash'
      return (key.preset === 'short-drama' ? names
        : key.preset === 'minimal' ? [shell]
          : key.preset === 'editing' ? ['read', 'skill', shell, 'present', ...accountMcpNames]
            : ['read', 'skill', shell, 'subagent', ...(key.preset === 'ptc' ? ['run_code'] : ['workflow'])]).map(name => ({ name }))
    }) }
    systemPrompt = { assemble: vi.fn(async (context: { agent: { preset: string }; scope: { preset: string } }) => ({
      sections: context.scope.preset === 'editing'
        ? [{ name: 'deployment:persona-prefix', text: editingModelInput.personaPrefix }]
        : [],
      tools: context.scope.preset === 'editing'
        ? Object.entries(editingModelInput.tools).map(([name, description]) => ({ name, description }))
        : [],
    })) }
    skills = { list: vi.fn(async (options: { scope: { preset: string } }) =>
      options.scope.preset === 'cordis' ? [...skills, cordisSkill] : skills) }
  }
  // Execute exactly the emitted plugin body; fixture services never impersonate a real prepared-runtime smoke.
  const source = desktopSmokePluginSource(root, home)
  expect(source).toMatch(/export const inject = \[[^\]]*'credentials'/u)
  const body = source.replace(/^import .*$/gmu, '').replace(/^export /gmu, '')
  const register = runInNewContext(`${body}\napply`, {
    Context: TestContext, existsSync, realpathSync, writeFileSync, join, relative, isAbsolute, process: { platform: process.platform },
  }) as (ctx: TestContext) => void
  const request = async () => {
    if (route === undefined) throw new Error('smoke route was not registered')
    expect(route.path).toBe('/desktop-product-smoke')
    let text = ''
    const response = { statusCode: 200, end(value: string) { text = value } }
    await route.handler({}, response)
    if (response.statusCode !== 200) throw new Error(text)
  }
  const apply = async (ctx: TestContext) => { register(ctx); await request() }
  return { ctx: new TestContext(), apply, register, request, agent, agentCtx, mount, dispose, names,
    accountMcpNames, skills, cordisSkill, skillRoot, home }
}

it('defers preset checks until the Host-ready caller requests them', async () => {
  const f = fixture()
  f.register(f.ctx)
  expect(f.ctx.agents.create).not.toHaveBeenCalled()
  expect(existsSync(join(f.home, '.desktop-product-smoke-complete'))).toBe(false)
  await f.request()
  expect(f.ctx.agents.create).toHaveBeenCalledTimes(12)
})

it('awaits full preset mounting and reads agent-scoped tools and bundled skills before disposal', async () => {
  const f = fixture()
  await f.apply(f.ctx)
  expect(f.mount).toHaveBeenCalledWith(f.agentCtx, 'short-drama')
  expect(f.ctx.tools.schemas).toHaveBeenCalledWith(f.agent)
  expect(f.ctx.systemPrompt.assemble).toHaveBeenCalledWith({ agent: { preset: 'editing' }, scope: { preset: 'editing' } })
  expect(f.ctx.skills.list).toHaveBeenCalledWith({ scope: f.agent, cwd: f.home })
  expect(f.dispose).toHaveBeenCalledTimes(12)
  expect(f.ctx.agents.create).toHaveBeenCalledTimes(12)
  expect(existsSync(join(f.home, '.desktop-product-smoke-complete'))).toBe(true)
})

it('accepts product skills loaded from the installed ASAR unpack directory', async () => {
  const f = fixture(true)
  await f.apply(f.ctx)
  expect(existsSync(join(f.home, '.desktop-product-smoke-complete'))).toBe(true)
})

it('rejects a Cordis authoring skill served from the virtual ASAR path', async () => {
  const f = fixture(true)
  const virtualPath = f.cordisSkill.path.replace('app.asar.unpacked', 'app.asar')
  mkdirSync(dirname(virtualPath), { recursive: true })
  writeFileSync(virtualPath, '# fixture')
  f.cordisSkill.path = virtualPath
  await expect(f.apply(f.ctx)).rejects.toThrow('cordis authoring skill is not mounted')
})

it('rejects a shared Muse skill missing from the packaged Host', async () => {
  const f = fixture()
  const index = f.skills.findIndex(skill => skill.name === 'audio-transcribe')
  if (index >= 0) f.skills.splice(index, 1)
  await expect(f.apply(f.ctx)).rejects.toThrow('missing shared Muse skill audio-transcribe')
  expect(existsSync(join(f.home, '.desktop-product-smoke-complete'))).toBe(false)
})

it('rejects a missing shared snatch skill', async () => {
  const f = fixture()
  const index = f.skills.findIndex(skill => skill.name === 'jubian-snatch')
  f.skills.splice(index, 1)
  await expect(f.apply(f.ctx)).rejects.toThrow('missing shared Muse skill jubian-snatch')
})

it('rejects a shared transcription skill without its packaged script', async () => {
  const f = fixture()
  const script = join(dirname(f.skills.find(skill => skill.name === 'audio-transcribe')!.path), 'scripts', 'transcribe.py')
  rmSync(script)
  await expect(f.apply(f.ctx)).rejects.toThrow('missing shared Muse transcription script')
})

it('rejects the media import skill without its packaged script', async () => {
  const f = fixture()
  const script = join(dirname(f.skills.find(skill => skill.name === 'media-link-import')!.path), 'scripts', 'import_media.py')
  rmSync(script)
  await expect(f.apply(f.ctx)).rejects.toThrow('missing shared Muse media import script')
})

it('rejects extra agent-local tools in the minimal preset', async () => {
  const f = fixture()
  const schemas = f.ctx.tools.schemas.getMockImplementation()!
  f.ctx.tools.schemas.mockImplementation(key => key?.preset === 'minimal'
    ? [{ name: process.platform === 'win32' ? 'pwsh' : 'bash' }, { name: 'read' }]
    : schemas(key))
  await expect(f.apply(f.ctx)).rejects.toThrow('minimal must add only its persistent shell')
  expect(existsSync(join(f.home, '.desktop-product-smoke-complete'))).toBe(false)
})

it('rejects Host readiness when the private preset smoke never completes', async () => {
  const start = vi.spyOn(DesktopHostProcess.prototype, 'start').mockResolvedValue({ url: 'http://127.0.0.1:1/' })
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('<html></html>'))
  const stop = vi.spyOn(DesktopHostProcess.prototype, 'stop').mockResolvedValue()
  try {
    const root = fixture().home
    const runtime = runtimeFixture(root)
    await expect(smokeDesktopRuntime(root, process.execPath, runtime, {}, primaryRuntimeFixture(root)))
      .rejects.toThrow('product preset smoke did not complete')
    expect(stop).toHaveBeenCalledOnce()
  } finally {
    start.mockRestore()
    fetch.mockRestore()
    stop.mockRestore()
  }
})

it('bounds startup when an activation never settles', async () => {
  vi.useFakeTimers()
  const start = vi.spyOn(DesktopHostProcess.prototype, 'start').mockImplementation(async () => new Promise(() => {}))
  const stop = vi.spyOn(DesktopHostProcess.prototype, 'stop').mockResolvedValue()
  try {
    const root = fixture().home
    const runtime = runtimeFixture(root)
    const result = expect(smokeDesktopRuntime(root, process.execPath, runtime, {}, primaryRuntimeFixture(root)))
      .rejects.toThrow('Host readiness exceeded')
    // The smoke reads its fixtures before it reaches the Host; the readiness
    // budget only starts once it does.
    await vi.waitFor(() => { expect(start).toHaveBeenCalledOnce() })
    await vi.advanceTimersByTimeAsync(120_000)
    await result
    expect(stop).toHaveBeenCalledOnce()
  } finally {
    start.mockRestore()
    stop.mockRestore()
    vi.useRealTimers()
  }
})

it('propagates a preset mount rejection without announcing a successful smoke', async () => {
  const f = fixture()
  f.mount.mockRejectedValue(new Error('full preset rejected'))
  await expect(f.apply(f.ctx)).rejects.toThrow('full preset rejected')
  expect(f.ctx.tools.schemas).not.toHaveBeenCalled()
  expect(existsSync(join(f.home, '.desktop-product-smoke-complete'))).toBe(false)
})

it('rejects a missing native provider rather than reporting a partial roster success', async () => {
  const f = fixture()
  f.mount.mockImplementation(async (_context, id) => { if (id === 'short-drama') throw new Error('waiting for dramaRuntime') })
  await expect(f.apply(f.ctx)).rejects.toThrow('waiting for dramaRuntime')
  expect(existsSync(join(f.home, '.desktop-product-smoke-complete'))).toBe(false)
})

it.each(['missing', 'legacy-only', 'shadow'])('rejects %s custom skill isolation failures', async (kind) => {
  const f = fixture()
  const custom = f.skills.find(skill => skill.name === 'desktop-user-skill')!
  if (kind === 'missing') f.skills.splice(f.skills.indexOf(custom), 1)
  else if (kind === 'legacy-only') f.skills.push({ ...custom, name: 'desktop-legacy-only' })
  else {
    const path = join(f.home, '.agents/skills/desktop-user-skill/SKILL.md')
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, '# legacy')
    custom.path = path
  }
  await expect(f.apply(f.ctx)).rejects.toThrow('product custom skills missing or legacy skills discovered')
  expect(existsSync(join(f.home, '.desktop-product-smoke-complete'))).toBe(false)
})

it('refuses a roster with additional presets before creating an agent', async () => {
  const f = fixture()
  f.ctx.agentPresets.list.mockResolvedValue([{ id: 'short-drama' }, { id: 'personal' }])
  await expect(f.apply(f.ctx)).rejects.toThrow('expected exactly the six product presets')
  expect(f.ctx.agents.create).not.toHaveBeenCalled()
})

it('fails missing tools and still disposes the created agent', async () => {
  const f = fixture()
  f.names.splice(f.names.indexOf('bgm_match'), 1)
  await expect(f.apply(f.ctx)).rejects.toThrow('missing product tool bgm_match')
  expect(f.dispose).toHaveBeenCalledTimes(2)
  expect(existsSync(join(f.home, '.desktop-product-smoke-complete'))).toBe(false)
})

it('rejects an editing mode without its account-scoped source reader', async () => {
  const f = fixture()
  f.accountMcpNames.splice(f.accountMcpNames.indexOf('mcp__muse-account__muse_kb_read_opening'), 1)
  await expect(f.apply(f.ctx)).rejects.toThrow('missing product tool mcp__muse-account__muse_kb_read_opening')
  expect(existsSync(join(f.home, '.desktop-product-smoke-complete'))).toBe(false)
})

it('rejects an editing mode without private script ingestion', async () => {
  const f = fixture()
  f.accountMcpNames.splice(f.accountMcpNames.indexOf('mcp__muse-account__muse_kb_ingest_script'), 1)
  await expect(f.apply(f.ctx)).rejects.toThrow('missing product tool mcp__muse-account__muse_kb_ingest_script')
  expect(existsSync(join(f.home, '.desktop-product-smoke-complete'))).toBe(false)
})

it('rejects an editing mode without its script-pool reader', async () => {
  const f = fixture()
  f.accountMcpNames.splice(f.accountMcpNames.indexOf('jubian_find'), 1)
  await expect(f.apply(f.ctx)).rejects.toThrow('missing product tool jubian_find')
})

it('rejects an editing persona without the chosen-outline workflow', async () => {
  const f = fixture()
  const assemble = f.ctx.systemPrompt.assemble.getMockImplementation()!
  f.ctx.systemPrompt.assemble.mockImplementation(async (context) => {
    const result = await assemble(context)
    if (context.scope.preset === 'editing') result.sections[0]!.text = '你是 muse-med 的小说与短剧剧本编辑。'
    return result
  })
  await expect(f.apply(f.ctx)).rejects.toThrow('editing persona changed')
  expect(existsSync(join(f.home, '.desktop-product-smoke-complete'))).toBe(false)
})

it.each(Object.keys(editingModelInput.tools))('rejects a changed model-visible description for %s', async (name) => {
  const f = fixture()
  const assemble = f.ctx.systemPrompt.assemble.getMockImplementation()!
  f.ctx.systemPrompt.assemble.mockImplementation(async (context) => {
    const result = await assemble(context)
    if (context.scope.preset === 'editing') result.tools.find(tool => tool.name === name)!.description = 'Generic read.'
    return result
  })
  await expect(f.apply(f.ctx)).rejects.toThrow('editing model tool description changed: ' + name)
  expect(existsSync(join(f.home, '.desktop-product-smoke-complete'))).toBe(false)
})

it('rejects an editing mode that exposes a video tool', async () => {
  const f = fixture()
  f.accountMcpNames.push('jubian_video')
  await expect(f.apply(f.ctx)).rejects.toThrow('editing mode inherited Jubian video tools')
  expect(existsSync(join(f.home, '.desktop-product-smoke-complete'))).toBe(false)
})

it('rejects an editing mode without its packaged writing skill', async () => {
  const f = fixture()
  const skill = f.skills.find(value => value.name === 'muse-script-editing')!
  f.skills.splice(f.skills.indexOf(skill), 1)
  await expect(f.apply(f.ctx)).rejects.toThrow('editing skill is not mounted')
  expect(existsSync(join(f.home, '.desktop-product-smoke-complete'))).toBe(false)
})

it.each(['directory', 'registry'])('rejects XHS in the product %s and disposes the created agent', async (source) => {
  const f = fixture()
  if (source === 'directory') mkdirSync(join(f.skillRoot, 'xiaohongshu-reference'))
  else f.skills.push({ name: 'xiaohongshu-reference', path: '', invocation: { modelInvocable: false } })
  await expect(f.apply(f.ctx)).rejects.toThrow('XHS must not ship')
  expect(f.dispose).toHaveBeenCalledTimes(2)
})

it('rejects a personal skill shadow and still disposes the created agent', async () => {
  const f = fixture()
  const personal = join(f.home, 'SKILL.md')
  writeFileSync(personal, '# personal')
  f.skills[0]!.path = personal
  await expect(f.apply(f.ctx)).rejects.toThrow('skill outside product bundle')
  expect(f.dispose).toHaveBeenCalledTimes(2)
})
