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

// External interpreter calls are isolated; the Office fixture writes the three
// documents consumed by the Host checks, while downloader help needs no files.
const { payload } = vi.hoisted(() => ({ payload: vi.fn(async (_file: string, args: string[]) => {
  if (args.at(-1) === '--help') return { stdout: 'usage: download.py' }
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

const retiredHostSkills = ['douyin-download', 'editing', 'jubian-snatch', 'media-link-import',
  'muse-llm-wiki', 'muse-project-participation',
  'muse-script-doctor', 'muse-dialogue-polish', 'muse-episode-design', 'reviewing-micro-drama-scripts', 'screenplay-format', 'muse-creation',
  'novel-to-script', 'screenplay-project', 'transcript-to-novel', 'transcript-to-script',
  'trope-adaptation', 'video-review', 'wechat-shortdrama-harvest']

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
  const ids = ['short-drama', 'standard', 'ptc', 'minimal', 'cordis', 'creation']
  const presetPath = (id: string) => join(root, 'node_modules/@deepseek-ai/dsh-desktop-host/presets', id, 'agent.cordis.yml')
  for (const id of ids) {
    mkdirSync(dirname(presetPath(id)), { recursive: true })
    writeFileSync(presetPath(id), '[]')
  }
  const skillRoot = unpacked(join(root, 'node_modules/@deepseek-ai/dsh-drama-skills/skills'))
  const skillNames = ['tweet-drama-core', 'tweet-drama-script-convert',
    'tweet-drama-script-split', 'tweet-drama-asset-vision-check',
    'tweet-drama-shot-asset-match', 'jubian-snatch',
    'shot-script-creator-16-9-3d', 'shot-script-creator-9-16',
    'tweet-drama-draft-build', 'tweet-drama-background-render', 'tweet-drama-project-inspect', 'tweet-drama-project-bible', 'tweet-drama-voice-continuity', 'tweet-drama-delivery']
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
  for (const name of ['audio-transcribe']) {
    const path = unpacked(join(root, 'node_modules/@deepseek-ai/dsh-desktop-host/skills', name, 'SKILL.md'))
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, '# fixture')
    skills.push({ name, path, invocation: { modelInvocable: true } })
  }
  const exporter = unpacked(join(root, 'node_modules/@deepseek-ai/dsh-desktop-host/skills/office-support/export_docx.py'))
  mkdirSync(dirname(exporter), { recursive: true })
  writeFileSync(exporter, '# Word export helper')
  for (const name of retiredHostSkills) {
    const path = unpacked(join(root, 'node_modules/@deepseek-ai/dsh-desktop-host/skills', name, 'SKILL.md.disabled'))
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, '# disabled fixture')
  }
  const transcribeScript = unpacked(join(root, 'node_modules/@deepseek-ai/dsh-desktop-host/skills/audio-transcribe/scripts/transcribe.py'))
  mkdirSync(dirname(transcribeScript), { recursive: true })
  writeFileSync(transcribeScript, '# fixture')
  const mediaImportScript = unpacked(join(root, 'node_modules/@deepseek-ai/dsh-desktop-host/skills/media-link-import/scripts/import_media.py'))
  mkdirSync(dirname(mediaImportScript), { recursive: true })
  writeFileSync(mediaImportScript, '# fixture')
  for (const script of ['doctor.py', 'discover.py', 'harvest.py', 'drive.py', 'finalize.py', 'win_bridge.ps1']) {
    const path = unpacked(join(root, 'node_modules/@deepseek-ai/dsh-desktop-host/skills/wechat-shortdrama-harvest/scripts', script))
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, '# fixture')
  }
  const ocrBridge = unpacked(join(root, 'node_modules/@deepseek-ai/dsh-tool-video-inspect/scripts/ocr_bridge.ps1'))
  mkdirSync(dirname(ocrBridge), { recursive: true })
  writeFileSync(ocrBridge, '# fixture')
  for (const name of ['office-docx', 'office-xlsx', 'office-pptx']) {
    const path = unpacked(join(root, 'node_modules/@deepseek-ai/dsh-desktop-host/skills', name, 'SKILL.md'))
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, '# fixture')
    skills.push({ name, path, invocation: { modelInvocable: true } })
  }
  const creationSkills = skills.filter(skill => skill.name !== 'desktop-user-skill')
  const agent = { preset: 'short-drama' }
  const agentCtx = {}
  const dispose = vi.fn(async () => {})
  const mount = vi.fn(async (_context: object, _id: string) => {})
  const names = ['jubian_asset', 'jubian_catalog', 'jubian_model', 'jubian_storyboard', 'jubian_video', 'jubian_budget',
    'jubian_media', 'jubian_watch', 'bgm_match', 'ffmpeg_probe', 'ffmpeg_encode', 'skill', 'hindsight_memory',
    'drama_assets', 'drama_bgm', 'drama_render', 'drama_project', 'drama_draft_dir', 'jianying_draft', 'manuscript_revision', 'source_recover', 'screenplay_export_docx', 'read', 'present', 'audio_transcribe', 'video_inspect', 'video_ocr',
    process.platform === 'win32' ? 'pwsh' : 'bash']
  type SmokeResponse = { statusCode: number; end(text: string): void }
  let route: { path: string; handler(request: object, response: SmokeResponse): Promise<void> } | undefined
  const accountMcpNames = ['jubian_find', 'jubian_claim', 'jubian_snatch', ...Object.keys(editingModelInput.tools)]
  const standardCapabilityNames = ['subagent', 'subagent_fork', 'send_message', 'interrupt_agent', 'list_agents', 'workflow',
    'ask_user_question', 'todo_write', 'todo_update', 'jubian_video', 'audio_transcribe']
  const editingCapabilityNames = ['ask_user_question', 'todo_write', 'todo_update', 'jubian_video', 'audio_transcribe']
  const loadSkill = (catalog: typeof skills, name: string) => {
    const skill = catalog.find(value => value.name === name)
    return skill === undefined ? undefined : { ...skill, content: readFileSync(skill.path, 'utf8') }
  }
  class TestContext {
    museAccount: { feedback?: () => void } = { feedback: () => {} }
    webServer = { register: vi.fn((value: NonNullable<typeof route>) => {
      route = value
      return () => { route = undefined }
    }) }
    effect(acquire: () => () => void) { return acquire() }
    agentPresets = {
      defaultId: 'short-drama',
      list: vi.fn(async () => ids.map(id => ({ id }))),
      resolve: vi.fn(async (id: string) => ({ id: id === 'editing' ? 'short-drama' : id })),
      compositionInventory: vi.fn(async () => ids.map(id => ({ id, isDefault: id === 'short-drama', rows: [{ id: 'persona' }] }))),
      mount,
      serviceFor: vi.fn((agent: { preset: string }, name: string) => agent.preset === 'creation' && name === 'skills'
        ? { list: vi.fn(async () => creationSkills), get: vi.fn(async (name: string) => loadSkill(creationSkills, name)) } : undefined),
    }
    agents = { create: vi.fn(async (options: { setup: (context: object) => Promise<void>; meta: { agentPreset: string } }) => {
      await options.setup(agentCtx)
      return { agent: options.meta.agentPreset === 'short-drama' ? agent : { preset: options.meta.agentPreset }, dispose }
    }) }
    tools = { schemas: vi.fn((key?: { preset: string }) => {
      if (key === undefined) return []
      const shell = process.platform === 'win32' ? 'pwsh' : 'bash'
      return (key.preset === 'short-drama' ? [...names.filter(name => !['jubian_video', 'ask_user_question', 'todo_write', 'todo_update'].includes(name)), ...editingCapabilityNames]
        : key.preset === 'minimal' ? [shell]
          : key.preset === 'short-drama' ? ['read', 'skill', shell, 'present', ...editingCapabilityNames, ...accountMcpNames]
            : key.preset === 'creation' ? ['read', 'skill', shell, 'present', 'run_code', 'audio_transcribe', 'video_contact_sheet', 'video_ocr',
              'drama_assets', 'drama_bgm', 'drama_render', 'drama_project', 'drama_draft_dir', 'jianying_draft', ...accountMcpNames]
              : key.preset === 'standard' ? ['read', 'skill', shell, 'present', ...standardCapabilityNames, ...accountMcpNames]
                : ['read', 'skill', shell, 'subagent', 'audio_transcribe', ...(key.preset === 'ptc' ? ['run_code'] : ['workflow'])]).map(name => ({ name }))
    }) }
    systemPrompt = { assemble: vi.fn(async (context: { agent: { preset: string }; scope: { preset: string } }) => ({
      sections: context.scope.preset === 'short-drama'
        ? [{ name: 'deployment:persona-prefix', text: editingModelInput.personaPrefix },
          { name: 'editing:delivery', text: '文字稿默认使用 Word（.docx），通过 screenplay_export_docx 转换。' }]
        : [],
      tools: context.scope.preset === 'short-drama'
        ? Object.entries(editingModelInput.tools).map(([name, description]) => ({ name, description }))
        : [],
    })) }
    skills = {
      list: vi.fn(async (options: { scope: { preset: string } }): Promise<{
        name: string
        path?: string
        invocation: { modelInvocable: boolean }
      }[]> =>
        options.scope.preset === 'cordis' ? [...skills, cordisSkill] : skills),
      get: vi.fn(async (name: string) => loadSkill(skills, name)),
    }
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
    accountMcpNames, editingCapabilityNames, skills, creationSkills, cordisSkill, skillRoot, home, root }
}

it('defers preset checks until the Host-ready caller requests them', async () => {
  const f = fixture()
  f.register(f.ctx)
  expect(f.ctx.agents.create).not.toHaveBeenCalled()
  expect(existsSync(join(f.home, '.desktop-product-smoke-complete'))).toBe(false)
  await f.request()
  expect(f.ctx.agents.create).toHaveBeenCalledTimes(12)
})

it('rejects a product runtime without the Muse inbox feedback entry', async () => {
  const f = fixture()
  delete f.ctx.museAccount.feedback
  await expect(f.apply(f.ctx)).rejects.toThrow('Muse inbox feedback method is missing')
})

it('awaits full preset mounting and reads agent-scoped tools and bundled skills before disposal', async () => {
  const f = fixture()
  await f.apply(f.ctx)
  expect(f.mount).toHaveBeenCalledWith(f.agentCtx, 'short-drama')
  expect(f.ctx.tools.schemas).toHaveBeenCalledWith(f.agent)
  expect(f.ctx.systemPrompt.assemble).toHaveBeenCalledWith({ agent: { preset: 'short-drama' }, scope: { preset: 'short-drama' } })
  expect(f.ctx.skills.list).toHaveBeenCalledWith({ scope: f.agent, cwd: f.home })
  expect(f.ctx.agentPresets.serviceFor).toHaveBeenCalledWith({ preset: 'creation' }, 'skills')
  expect(f.ctx.skills.list).not.toHaveBeenCalledWith({ scope: { preset: 'creation' }, cwd: f.home })
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

it.each(['drama_project', 'drama_draft_dir', 'jianying_draft', 'manuscript_revision', 'source_recover', 'screenplay_export_docx', 'jubian_budget', 'video_inspect', 'video_ocr', 'hindsight_memory'])('rejects a missing project tool %s', async (name) => {
  const f = fixture()
  const schemas = f.ctx.tools.schemas.getMockImplementation()!
  f.ctx.tools.schemas.mockImplementation(key => key?.preset === 'short-drama'
    ? schemas(key).filter(tool => tool.name !== name)
    : schemas(key))
  await expect(f.apply(f.ctx)).rejects.toThrow('missing product tool ' + name)
  expect(existsSync(join(f.home, '.desktop-product-smoke-complete'))).toBe(false)
})

it.each(['tweet-drama-project-bible', 'tweet-drama-voice-continuity', 'shot-script-creator-16-9-3d', 'shot-script-creator-9-16'])('rejects a missing product skill %s', async (name) => {
  const f = fixture()
  const index = f.skills.findIndex(skill => skill.name === name)
  f.skills.splice(index, 1)
  await expect(f.apply(f.ctx)).rejects.toThrow(name)
  expect(existsSync(join(f.home, '.desktop-product-smoke-complete'))).toBe(false)
})

it('rejects a missing shared snatch skill', async () => {
  const f = fixture()
  const index = f.skills.findIndex(skill => skill.name === 'jubian-snatch')
  f.skills.splice(index, 1)
  await expect(f.apply(f.ctx)).rejects.toThrow('missing product skill jubian-snatch')
})

it.each([false, true])('rejects a runtime without its Word export helper (packaged=%s)', async (packaged) => {
  const f = fixture(packaged)
  const path = join(f.root, 'node_modules/@deepseek-ai/dsh-desktop-host/skills/office-support/export_docx.py')
    .replace(/([\\/])app\.asar([\\/])/u, '$1app.asar.unpacked$2')
  rmSync(path)
  await expect(f.apply(f.ctx)).rejects.toThrow('missing Word export helper')
})

it('rejects a shared transcription skill without its packaged script', async () => {
  const f = fixture()
  const script = join(dirname(f.skills.find(skill => skill.name === 'audio-transcribe')!.path), 'scripts', 'transcribe.py')
  rmSync(script)
  await expect(f.apply(f.ctx)).rejects.toThrow('missing shared Muse transcription script')
})

it('rejects the media import skill without its packaged script', async () => {
  const f = fixture()
  const script = join(f.root, 'node_modules/@deepseek-ai/dsh-desktop-host/skills/media-link-import/scripts/import_media.py')
  rmSync(script)
  await expect(f.apply(f.ctx)).rejects.toThrow('missing shared Muse media import script')
})

it('rejects WeChat acquisition without its packaged Windows bridge', async () => {
  const f = fixture()
  rmSync(join(f.root, 'node_modules/@deepseek-ai/dsh-desktop-host/skills/wechat-shortdrama-harvest/scripts/win_bridge.ps1'))
  await expect(f.apply(f.ctx)).rejects.toThrow('missing WeChat helper win_bridge.ps1')
})

it.runIf(process.platform === 'win32')('rejects an installed runtime without its packaged video OCR bridge', async () => {
  const f = fixture(true)
  const script = join(f.root, 'node_modules/@deepseek-ai/dsh-tool-video-inspect/scripts/ocr_bridge.ps1')
    .replace(/([\\/])app\.asar([\\/])/u, '$1app.asar.unpacked$2')
  rmSync(script)
  await expect(f.apply(f.ctx)).rejects.toThrow('missing packaged video OCR bridge')
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

it.each(['short-drama', 'ptc', 'standard', 'cordis', 'creation'])('rejects missing transcription in %s', async (preset) => {
  const f = fixture()
  const schemas = f.ctx.tools.schemas.getMockImplementation()!
  f.ctx.tools.schemas.mockImplementation(key => key?.preset === preset
    ? schemas(key).filter(tool => tool.name !== 'audio_transcribe')
    : schemas(key))
  await expect(f.apply(f.ctx)).rejects.toThrow('transcription availability differs in ' + preset)
  expect(existsSync(join(f.home, '.desktop-product-smoke-complete'))).toBe(false)
})

it.each(['run_code', 'drama_assets', 'mcp__muse-account__muse_kb_read_opening', 'video_contact_sheet', 'video_ocr'])('rejects creation without %s', async (name) => {
  const f = fixture()
  const schemas = f.ctx.tools.schemas.getMockImplementation()!
  f.ctx.tools.schemas.mockImplementation(key => key?.preset === 'creation'
    ? schemas(key).filter(tool => tool.name !== name)
    : schemas(key))
  await expect(f.apply(f.ctx)).rejects.toThrow('missing product tool ' + name + ' in creation')
  expect(existsSync(join(f.home, '.desktop-product-smoke-complete'))).toBe(false)
})

it.each(['subagent', 'subagent_fork', 'subagent_codex', 'subagent_claude_code'])('rejects delegation tool %s in creation', async (name) => {
  const f = fixture()
  const schemas = f.ctx.tools.schemas.getMockImplementation()!
  f.ctx.tools.schemas.mockImplementation(key => key?.preset === 'creation'
    ? [...schemas(key), { name }]
    : schemas(key))
  await expect(f.apply(f.ctx)).rejects.toThrow('creation mode must use a single agent')
  expect(existsSync(join(f.home, '.desktop-product-smoke-complete'))).toBe(false)
})

it.each(['ptc', 'creation'])('rejects workflow presentation in %s', async (preset) => {
  const f = fixture()
  const schemas = f.ctx.tools.schemas.getMockImplementation()!
  f.ctx.tools.schemas.mockImplementation(key => key?.preset === preset
    ? [...schemas(key), { name: 'workflow' }]
    : schemas(key))
  await expect(f.apply(f.ctx)).rejects.toThrow('PTC tool presentation is incomplete in ' + preset)
})

it('rejects creation without its isolated skill registry', async () => {
  const f = fixture()
  f.ctx.agentPresets.serviceFor.mockReturnValue(undefined)
  await expect(f.apply(f.ctx)).rejects.toThrow('creation skill registry is not isolated')
})

it.each(['office-docx', 'office-xlsx', 'office-pptx'])('rejects creation without %s', async (name) => {
  const f = fixture()
  f.creationSkills.splice(f.creationSkills.findIndex(skill => skill.name === name), 1)
  await expect(f.apply(f.ctx)).rejects.toThrow('missing creation skill ' + name)
})

it.each(['desktop-user-skill', 'editing-cordis-compositions', 'unreviewed-runtime-skill'])('rejects creation exposing %s', async (name) => {
  const f = fixture()
  f.creationSkills.push({ name, path: '', invocation: { modelInvocable: true } })
  await expect(f.apply(f.ctx)).rejects.toThrow('creation skill registry exposes unreviewed skills')
})

it('rejects transcription in the minimal preset', async () => {
  const f = fixture()
  const schemas = f.ctx.tools.schemas.getMockImplementation()!
  f.ctx.tools.schemas.mockImplementation(key => key?.preset === 'minimal'
    ? [...schemas(key), { name: 'audio_transcribe' }]
    : schemas(key))
  await expect(f.apply(f.ctx)).rejects.toThrow('transcription availability differs in minimal')
  expect(existsSync(join(f.home, '.desktop-product-smoke-complete'))).toBe(false)
})

it('rejects Host readiness when the private preset smoke never completes', async () => {
  let packageManager: unknown
  const start = vi.spyOn(DesktopHostProcess.prototype, 'start').mockImplementation(async function (this: DesktopHostProcess) {
    packageManager = Reflect.get(this, 'packageManager')
    return { pid: 2468, url: 'http://127.0.0.1:1/' }
  })
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('<html></html>'))
  const stop = vi.spyOn(DesktopHostProcess.prototype, 'stop').mockResolvedValue()
  try {
    const root = fixture().home
    const runtime = runtimeFixture(root)
    const resources = primaryRuntimeFixture(root)
    await expect(smokeDesktopRuntime(root, process.execPath, runtime, {}, resources))
      .rejects.toThrow('product preset smoke did not complete')
    expect(packageManager).toEqual({ pnpm: join(resources, 'pnpm', 'bin', 'pnpm.mjs'), nodeBin: join(resources, 'bin') })
    expect(stop).toHaveBeenCalledOnce()
  } finally {
    start.mockRestore()
    fetch.mockRestore()
    stop.mockRestore()
  }
})

it.each([false, true])('runs downloader help from the native filesystem before Host startup, archived=%s', async (archived) => {
  const start = vi.spyOn(DesktopHostProcess.prototype, 'start')
  const stop = vi.spyOn(DesktopHostProcess.prototype, 'stop').mockResolvedValue()
  try {
    const f = fixture(archived)
    const root = f.root
    const runtime = runtimeFixture(root)
    payload.mockRejectedValueOnce(new Error('Python cannot read download script'))
    await expect(smokeDesktopRuntime(root, process.execPath, runtime, {}, primaryRuntimeFixture(f.home)))
      .rejects.toThrow('Python cannot read download script')
    const invocation = payload.mock.calls.at(-1)
    expect(invocation?.[1]).toEqual(['-I', '-B', join(root, 'node_modules', 'muse-douyin-download', 'python', 'scripts', 'download.py')
      .replace(/([\\/])app\.asar([\\/])/u, '$1app.asar.unpacked$2'), '--help'])
    expect(start).not.toHaveBeenCalled()
    expect(stop).toHaveBeenCalledOnce()
  } finally {
    start.mockRestore()
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

it('rejects an editing mode missing a standard tool', async () => {
  const f = fixture()
  f.editingCapabilityNames.splice(f.editingCapabilityNames.indexOf('ask_user_question'), 1)
  await expect(f.apply(f.ctx)).rejects.toThrow('missing product tool ask_user_question')
})

it('accepts editing without locally mounted delegation tools', async () => {
  const f = fixture()
  await expect(f.apply(f.ctx)).resolves.toBeUndefined()
  expect(existsSync(join(f.home, '.desktop-product-smoke-complete'))).toBe(true)
})

it('accepts inherited delegation tools in editing', async () => {
  const f = fixture()
  f.editingCapabilityNames.push('subagent', 'subagent_fork', 'send_message', 'interrupt_agent', 'list_agents', 'workflow')
  await expect(f.apply(f.ctx)).resolves.toBeUndefined()
})

it('rejects an editing persona that differs from the current identity', async () => {
  const f = fixture()
  const assemble = f.ctx.systemPrompt.assemble.getMockImplementation()!
  f.ctx.systemPrompt.assemble.mockImplementation(async (context) => {
    const result = await assemble(context)
    if (context.scope.preset === 'short-drama') result.sections[0]!.text = '你是 muse-med 的小说与短剧剧本编辑。'
    return result
  })
  await expect(f.apply(f.ctx)).rejects.toThrow('unified creative persona changed')
  expect(existsSync(join(f.home, '.desktop-product-smoke-complete'))).toBe(false)
})

it.each(['missing', 'without Word', 'without export'])('rejects editing delivery guidance %s', async (change) => {
  const f = fixture()
  const assemble = f.ctx.systemPrompt.assemble.getMockImplementation()!
  f.ctx.systemPrompt.assemble.mockImplementation(async (context) => {
    const result = await assemble(context)
    if (context.scope.preset === 'short-drama') {
      if (change === 'missing') result.sections = result.sections.filter(section => section.name !== 'editing:delivery')
      else result.sections[1]!.text = change === 'without Word' ? 'screenplay_export_docx' : '默认使用 Word（.docx）'
    }
    return result
  })
  await expect(f.apply(f.ctx)).rejects.toThrow('editing Word delivery guidance is missing')
  expect(existsSync(join(f.home, '.desktop-product-smoke-complete'))).toBe(false)
})

it.each(Object.keys(editingModelInput.tools))('rejects a changed model-visible description for %s', async (name) => {
  const f = fixture()
  const assemble = f.ctx.systemPrompt.assemble.getMockImplementation()!
  f.ctx.systemPrompt.assemble.mockImplementation(async (context) => {
    const result = await assemble(context)
    if (context.scope.preset === 'short-drama') result.tools.find(tool => tool.name === name)!.description = 'Generic read.'
    return result
  })
  await expect(f.apply(f.ctx)).rejects.toThrow('editing model tool description changed: ' + name)
  expect(existsSync(join(f.home, '.desktop-product-smoke-complete'))).toBe(false)
})

it('rejects an editing mode that loses a standard video tool', async () => {
  const f = fixture()
  f.editingCapabilityNames.splice(f.editingCapabilityNames.indexOf('jubian_video'), 1)
  await expect(f.apply(f.ctx)).rejects.toThrow('missing product tool jubian_video')
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

it('resolves retired editing to the unified short-drama preset without adding it to the roster', async () => {
  const f = fixture()
  await f.apply(f.ctx)
  expect(f.ctx.agentPresets.resolve).toHaveBeenCalledWith('editing')
  expect(f.ctx.agents.create.mock.calls.every(([options]) => options.meta.agentPreset !== 'editing')).toBe(true)
})

it('rejects a retired editing alias that resolves to a different preset', async () => {
  const f = fixture()
  const resolve = f.ctx.agentPresets.resolve.getMockImplementation()!
  f.ctx.agentPresets.resolve.mockImplementation(id => id === 'editing' ? Promise.resolve({ id: 'editing' }) : resolve(id))
  await expect(f.apply(f.ctx)).rejects.toThrow('retired editing preset must resolve to short-drama')
  expect(f.ctx.agents.create).not.toHaveBeenCalled()
})

it('accepts an additional model-invocable virtual skill without a filesystem path', async () => {
  const f = fixture()
  const list = f.ctx.skills.list.getMockImplementation()!
  f.ctx.skills.list.mockImplementation(async options => [...await list(options), {
    name: 'virtual-runtime-guidance', invocation: { modelInvocable: true },
  }])
  await f.apply(f.ctx)
  expect(existsSync(join(f.home, '.desktop-product-smoke-complete'))).toBe(true)
  expect(f.dispose).toHaveBeenCalledTimes(12)
})

it.each(['audio-transcribe',
  'shot-script-creator-16-9-3d', 'shot-script-creator-9-16'])('rejects required packaged skill %s without a filesystem path', async (name) => {
  const f = fixture()
  const list = f.ctx.skills.list.getMockImplementation()!
  f.ctx.skills.list.mockImplementation(async options => (await list(options)).map(skill =>
    skill.name === name ? { name: skill.name, invocation: skill.invocation } : skill))
  await expect(f.apply(f.ctx)).rejects.toThrow(name.startsWith('shot-script-creator-')
    ? 'missing product skill ' + name : 'missing shared Muse skill ' + name)
})

it.each(['editing', 'transcript-to-novel', 'transcript-to-script', 'media-link-import', 'muse-script-doctor', 'muse-dialogue-polish', 'muse-episode-design', 'screenplay-format'])('rejects re-enabling retired Host skill %s', async (name) => {
  const f = fixture()
  const path = join(f.root, 'node_modules/@deepseek-ai/dsh-desktop-host/skills', name, 'SKILL.md')
  writeFileSync(path, '# enabled old resource')
  await expect(f.apply(f.ctx)).rejects.toThrow('retired Host skill is enabled: ' + name)
})

it.each(['audio-transcribe',
  'shot-script-creator-16-9-3d', 'shot-script-creator-9-16'])('rejects a disabled file pretending to be active skill %s', async (name) => {
  const f = fixture()
  const skill = f.skills.find(value => value.name === name)!
  const disabled = skill.path + '.disabled'
  writeFileSync(disabled, '# disabled content')
  skill.path = disabled
  await expect(f.apply(f.ctx)).rejects.toThrow('disabled skill is model-invocable')
})

it.each(['audio-transcribe', 'shot-script-creator-16-9-3d', 'shot-script-creator-9-16'])('rejects %s whose full content cannot be loaded', async (name) => {
  const f = fixture()
  const get = f.ctx.skills.get.getMockImplementation()!
  f.ctx.skills.get.mockImplementation(async target => target === name ? undefined : get(target))
  await expect(f.apply(f.ctx)).rejects.toThrow(name === 'audio-transcribe'
    ? 'shared skill did not load from the packaged Host: ' + name
    : 'shot-writing skill did not load from its packaged resource: ' + name)
})

it('loads the transcription and shot-writing skills through the scoped registry', async () => {
  const f = fixture()
  await f.apply(f.ctx)
  for (const name of ['audio-transcribe',
    'shot-script-creator-16-9-3d', 'shot-script-creator-9-16']) {
    expect(f.ctx.skills.get).toHaveBeenCalledWith(name, { scope: f.agent, cwd: f.home })
  }
  for (const name of ['editing', 'transcript-to-novel', 'transcript-to-script', 'media-link-import']) {
    const directory = join(f.root, 'node_modules/@deepseek-ai/dsh-desktop-host/skills', name)
    expect(existsSync(join(directory, 'SKILL.md'))).toBe(false)
    expect(existsSync(join(directory, 'SKILL.md.disabled'))).toBe(true)
  }
})
