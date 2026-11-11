import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join, dirname, relative, isAbsolute } from 'node:path'
import { tmpdir } from 'node:os'
import { runInNewContext } from 'node:vm'
import { ToolCallId, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import type { ToolBatchInput, ToolBatchResult, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { afterEach, expect, it, vi } from 'vitest'
import { desktopSmokePluginSource, smokeDesktopRuntime, prepareDesktopSmokeSkills } from '../scripts/smoke-runtime.ts'
import { DesktopHostProcess } from '../src/host-process.ts'
import { runtimeFixture } from './runtime-fixture.ts'

const editingModelInput = JSON.parse(readFileSync(new URL('./expected/editing-model-input.json', import.meta.url), 'utf8')) as {
  personaPrefix: string
  tools: Record<string, string>
  retiredAccountTools: string[]
}

function contextArguments(input: Pick<ToolBatchInput, 'calls'>): { operation: string; tools: string[] } {
  const call = input.calls[0]
  if (input.calls.length !== 1 || call?.name !== 'tool_context') throw new Error('Expected one tool_context model call')
  const args: unknown = JSON.parse(call.arguments)
  if (typeof args !== 'object' || args === null || !('operation' in args) || typeof args.operation !== 'string'
    || !('tools' in args) || !Array.isArray(args.tools)
    || !args.tools.every((value: unknown): value is string => typeof value === 'string')) {
    throw new Error('Invalid tool_context smoke arguments')
  }
  return { operation: args.operation, tools: args.tools }
}


// External interpreter calls are isolated; the Office fixture writes the three
// documents consumed by the Host checks, while downloader help needs no files.
const { payload, payloadFailure } = vi.hoisted(() => {
  const payloadFailure: { downloader?: Error } = {}
  return { payloadFailure, payload: vi.fn(async (_file: string, args: string[], options?: { cwd?: string }) => {
    if (args[2] === 'plugin') {
      const { cp, mkdir, rm } = await import('node:fs/promises')
      const { basename, dirname, join } = await import('node:path')
      if (!options?.cwd) throw new Error('Missing CLI fixture cwd')
      if (args[5] === 'add') {
        const source = args[6]!.slice('file:'.length)
        const target = join(options.cwd, 'profiles', 'desktop', 'node_modules', basename(source))
        await mkdir(dirname(target), { recursive: true })
        await cp(source, target, { recursive: true })
      } else if (args[5] === 'remove') {
        await rm(join(options.cwd, 'profiles', 'desktop', 'node_modules', args[6]!), { recursive: true })
      }
      return { stdout: '' }
    }
    if (args.at(-1) === '--help') {
      const failure = payloadFailure.downloader
      delete payloadFailure.downloader
      if (failure) throw failure
      return { stdout: 'usage: download.py' }
    }
    const home = args[args.length - 1]!
    for (const extension of ['docx', 'xlsx', 'pptx']) writeFileSync(join(home, `input.${extension}`), Buffer.from('fixture'))
    return { stdout: '' }
  }) }
})
vi.mock('node:child_process', async (importOriginal) => {
  const { promisify } = await import('node:util')
  return { ...await importOriginal<typeof import('node:child_process')>(),
    execFile: Object.assign(vi.fn(), { [promisify.custom]: payload }) }
})

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

const retiredHostSkills = ['douyin-download', 'editing', 'jubian-snatch', 'media-link-import',
  'muse-llm-wiki', 'muse-project-participation',
  'reviewing-micro-drama-scripts', 'muse-creation', 'screenplay-project', 'transcript-to-novel', 'transcript-to-script',
  'trope-adaptation', 'wechat-shortdrama-harvest']
const defaultHostSkills = ['audio-transcribe', 'muse-script-doctor', 'novel-to-script',
  'muse-dialogue-polish', 'muse-episode-design', 'screenplay-format', 'video-review']

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
  const layout = prepareDesktopSmokeSkills(home)
  const ids = ['short-drama', 'standard', 'ptc', 'minimal', 'cordis', 'bot-coordinator', 'creation']
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
    return { name, path, source: 'bundled', invocation: { modelInvocable: true } }
  })
  skills.push(...layout.selected.map(skill => ({ ...skill, invocation: { modelInvocable: true } })))
  const cordisSkill = {
    name: 'editing-cordis-compositions',
    path: unpacked(join(root, 'node_modules/@deepseek-ai/dsh-desktop-host/presets/cordis/skills/editing-cordis-compositions/SKILL.md')),
    source: 'bundled',
    invocation: { modelInvocable: true },
  }
  mkdirSync(dirname(cordisSkill.path), { recursive: true })
  writeFileSync(cordisSkill.path, '# fixture')
  for (const name of defaultHostSkills) {
    const path = unpacked(join(root, 'node_modules/@deepseek-ai/dsh-desktop-host/skills', name, 'SKILL.md'))
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, '# fixture')
    skills.push({ name, path, source: 'bundled', invocation: { modelInvocable: true } })
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
    skills.push({ name, path, source: 'bundled', invocation: { modelInvocable: true } })
  }
  const creationSkills = [...skills]
  const selected = new Set<string>()
  const agentFiber = { uid: 101 as number | null, state: 2, runtime: { name: 'scope' } }
  const agentCtx = { fiber: agentFiber }
  const ownerFiber = { uid: 100 as number | null, state: 2, runtime: { name: 'desktop-runtime-product-smoke-plugin' } }
  type LifecycleListener = (fiber: typeof agentFiber, oldState?: number) => void
  const lifecycleListeners = new Map<string, Set<LifecycleListener>>()
  const observerDisposers: ReturnType<typeof vi.fn>[] = []
  const emitLifecycle = (event: string, fiber: typeof agentFiber, oldState?: number) => {
    for (const listener of lifecycleListeners.get(event) ?? []) listener(fiber, oldState)
  }
  const agent = { preset: 'short-drama', id: 'smoke-agent', ctx: agentCtx, session: {
    append: vi.fn((type: string, data: {
      turn?: number
      step?: number
      callId?: ToolCallId
      name?: string
      arguments?: string
      message?: { content: readonly { type: string; text?: string }[] }
    }, _options?: { surfaceOp: string; sourceEventSeqs: number[] }) => {
      if (type === 'tool/result') {
        const result = JSON.parse(data.message!.content.map(block => block.text ?? '').join('')) as {
          operation: string
          tools: string[]
        }
        for (const name of result.tools) {
          if (result.operation === 'load') selected.add(name)
          else if (result.operation === 'release') selected.delete(name)
        }
      }
      return { seq: 1 }
    }),
  } }
  const dispose = vi.fn(async () => {})
  const mount = vi.fn(async (_context: object, _id: string) => {})
  const names = ['jubian_asset', 'jubian_catalog', 'jubian_model', 'jubian_storyboard', 'jubian_video', 'jubian_budget',
    'jubian_media', 'jubian_watch', 'bgm_match', 'ffmpeg_probe', 'ffmpeg_encode', 'skill',
    'drama_assets', 'drama_bgm', 'drama_render', 'drama_project', 'drama_draft_dir', 'jianying_draft', 'manuscript_revision', 'source_recover', 'screenplay_export_docx', 'read', 'present', 'audio_transcribe', 'video_inspect', 'video_ocr',
    process.platform === 'win32' ? 'pwsh' : 'bash']
  type SmokeResponse = { statusCode: number; end(text: string): void }
  let route: { path: string; handler(request: object, response: SmokeResponse): Promise<void> } | undefined
  const sourceCapabilityNames = ['jubian_find', 'jubian_claim', 'jubian_snatch', ...Object.keys(editingModelInput.tools)]
  const standardCapabilityNames = ['subagent', 'subagent_fork', 'send_message', 'interrupt_agent', 'list_agents', 'workflow',
    'ask_user_question', 'todo_write', 'todo_update', 'jubian_video', 'audio_transcribe']
  const coordinatorCapabilityNames = ['write', 'edit', 'glob', 'grep', 'present', 'web_search', 'web_fetch',
    'ask_user_question', 'todo_write', 'todo_update', 'subagent', 'audio_transcribe', 'tool_search', 'tool_context']
  const editingCapabilityNames = ['ask_user_question', 'todo_write', 'todo_update', 'jubian_video', 'audio_transcribe']
  const loadSkill = (catalog: typeof skills, name: string) => {
    const skill = catalog.find(value => value.name === name)
    return skill === undefined ? undefined : { ...skill, content: readFileSync(skill.path, 'utf8') }
  }
  class TestContext {
    root = this
    fiber = ownerFiber
    on(event: string, listener: LifecycleListener) {
      const listeners = lifecycleListeners.get(event) ?? new Set<LifecycleListener>()
      lifecycleListeners.set(event, listeners)
      listeners.add(listener)
      const release = vi.fn(() => { listeners.delete(listener) })
      observerDisposers.push(release)
      return release
    }
    museAccount: { feedback?: () => void } = { feedback: () => {} }
    webServer = { register: vi.fn((value: NonNullable<typeof route>) => {
      route = value
      return () => { route = undefined }
    }) }
    effect(acquire: () => () => void) { return acquire() }
    agentPresets = {
      defaultId: 'short-drama',
      list: vi.fn(async () => [...ids, 'muse-manuscript-continuity-reviewer'].map(id => ({ id }))),
      resolve: vi.fn(async (id: string) => ({ id: id === 'editing' ? 'short-drama' : id })),
      compositionInventory: vi.fn(async () => ids.map(id => ({ id, isDefault: id === 'short-drama', rows: [{ id: 'persona' }] }))),
      mount,
      serviceFor: vi.fn((agent: { preset: string }, name: string) => agent.preset === 'creation' && name === 'skills'
        ? { list: vi.fn(async () => creationSkills), get: vi.fn(async (name: string) => loadSkill(creationSkills, name)) } : undefined),
    }
    agents = { get: vi.fn((id: string) => id === agent.id ? agent : undefined), create: vi.fn(async (options: {
      setup: (context: object) => Promise<void>
      meta: { agentPreset: string }
    }) => {
      await options.setup(agentCtx)
      return { agent: options.meta.agentPreset === 'short-drama' ? agent : { preset: options.meta.agentPreset }, dispose }
    }) }
    toolDiscovery = { state: vi.fn(() => ({ loaded: [...selected], pinned: [] })) }
    tools = { execute: vi.fn(async (input: Pick<ToolBatchInput, 'calls' | 'signal' | 'log'> & {
      agent: typeof agent
    }): Promise<ToolBatchResult> => {
      const args = contextArguments(input)
      const call = input.calls[0]!
      if (input.log === undefined) throw new Error('Smoke tool batch must commit its context receipts')
      const result: ToolExecutionResult = {
        isError: false, value: args, content: [{ type: 'text', text: JSON.stringify(args) }],
      }
      const event = input.agent.session.append('tool/call', { ...input.log, callId: call.id,
        name: call.name, arguments: call.arguments })
      input.agent.session.append('tool/result', { ...input.log,
        message: createToolResultMessage({ callId: call.id, content: result.content, isError: result.isError }),
      }, { surfaceOp: 'append', sourceEventSeqs: [event.seq] })
      return { results: [{ callId: call.id, result }], additionalContexts: [], concluded: false }
    }), schemas: vi.fn((key?: { preset: string }): { name: string; description?: string }[] => {
      if (key === undefined) return []
      const shell = process.platform === 'win32' ? 'pwsh' : 'bash'
      return (key.preset === 'short-drama' ? [...names.filter(name => !['jubian_video', 'ask_user_question', 'todo_write', 'todo_update'].includes(name)), ...editingCapabilityNames, ...sourceCapabilityNames, 'tool_search', 'tool_context']
        : key.preset === 'minimal' ? [shell]
          : key.preset === 'creation' ? ['read', 'skill', shell, 'present', 'audio_transcribe', 'video_contact_sheet', 'video_ocr',
            'drama_assets', 'drama_bgm', 'drama_render', 'drama_project', 'drama_draft_dir', 'jianying_draft', ...sourceCapabilityNames]
            : key.preset === 'bot-coordinator' ? ['read', 'skill', shell, ...coordinatorCapabilityNames]
              : key.preset === 'standard' ? ['read', 'skill', shell, 'present', ...standardCapabilityNames, ...sourceCapabilityNames]
                : ['read', 'skill', shell, 'subagent', 'audio_transcribe', ...(key.preset === 'ptc' ? [] : ['workflow'])]).map(name => ({ name, description: editingModelInput.tools[name] ?? 'Fixture capability.' }))
    }) }
    systemPrompt = { assemble: vi.fn(async (context: { agent: { preset: string }; scope: { preset: string } }) => ({
      sections: context.scope.preset === 'short-drama'
        ? [{ name: 'deployment:persona-prefix', text: editingModelInput.personaPrefix },
          { name: 'editing:delivery', text: '文字稿默认使用 Word（.docx），通过 screenplay_export_docx 转换。' }]
        : [],
      tools: context.scope.preset === 'short-drama'
        ? this.tools.schemas(context.scope).filter(tool => ['read', 'skill', 'tool_search', 'tool_context'].includes(tool.name) || selected.has(tool.name))
        : ['ptc', 'creation', 'cordis'].includes(context.scope.preset)
          ? [{ name: 'run_code' }] : this.tools.schemas(context.scope),
    })) }
    skills = {
      list: vi.fn(async (options: { scope: { preset: string } }): Promise<{
        name: string
        path?: string
        source?: string
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
    Context: TestContext, ToolCallId, createToolResultMessage, AbortSignal, existsSync, realpathSync, writeFileSync,
    join, relative, isAbsolute, process: { platform: process.platform },
  }) as (ctx: TestContext) => void
  let responseText = ''
  const request = async () => {
    if (route === undefined) throw new Error('smoke route was not registered')
    expect(route.path).toBe('/desktop-product-smoke')
    let text = ''
    const response = { statusCode: 200, end(value: string) { text = value } }
    await route.handler({}, response)
    responseText = text
    if (response.statusCode !== 200) throw new Error(text)
  }
  const apply = async (ctx: TestContext) => { register(ctx); await request() }
  return { ctx: new TestContext(), apply, register, request, agent, agentCtx, mount, dispose, names,
    sourceCapabilityNames, editingCapabilityNames, selected, skills, creationSkills, cordisSkill, skillRoot, layout, home, root,
    agentFiber, ownerFiber, emitLifecycle, observerDisposers, lifecycleListeners, responseText: () => responseText }
}

it('defers preset checks until the Host-ready caller requests them', async () => {
  const f = fixture()
  f.register(f.ctx)
  expect(f.ctx.agents.create).not.toHaveBeenCalled()
  expect(existsSync(join(f.home, '.desktop-product-smoke-complete'))).toBe(false)
  await f.request()
  expect(f.ctx.agents.create).toHaveBeenCalledTimes(14)
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
  expect(f.ctx.systemPrompt.assemble).toHaveBeenCalledWith({ agent: f.agent, scope: f.agent })
  expect(f.ctx.skills.list).toHaveBeenCalledWith({ scope: f.agent, cwd: f.layout.cwd })
  expect(f.ctx.agentPresets.serviceFor).toHaveBeenCalledWith({ preset: 'creation' }, 'skills')
  expect(f.ctx.skills.list).not.toHaveBeenCalledWith({ scope: { preset: 'creation' }, cwd: f.layout.cwd })
  expect(f.dispose).toHaveBeenCalledTimes(14)
  expect(f.ctx.agents.create).toHaveBeenCalledTimes(14)
  expect(f.mount).toHaveBeenCalledWith(f.agentCtx, 'bot-coordinator')
  expect(existsSync(join(f.home, '.desktop-product-smoke-complete'))).toBe(true)
})

it.each([
  { call: 0, index: 0, phase: 'assemble-initial' },
  { call: 1, index: 0, phase: 'assemble-loaded' },
  { call: 2, index: 0, phase: 'assemble-released' },
  { call: 3, index: 1, phase: 'assemble-initial' },
])('reports preset, instance $index and $phase with the original foreign-realm stack', async ({ call, index, phase }) => {
  const f = fixture()
  const failure = runInNewContext("new Error('foreign assembly failure')") as Error
  failure.stack = 'Error: foreign assembly failure\n    at foreign-owner.mjs:41:7'
  const assemble = f.ctx.systemPrompt.assemble.getMockImplementation()!
  let calls = 0
  f.ctx.systemPrompt.assemble.mockImplementation(async (context) => {
    if (calls++ === call) throw failure
    return assemble(context)
  })
  await expect(f.apply(f.ctx)).rejects.toThrow('preset=short-drama index=' + String(index) + ' phase=' + phase)
  const report = readFileSync(join(f.home, '.desktop-product-smoke-error'), 'utf8')
  expect(report).toContain(failure.stack)
  expect(f.dispose).toHaveBeenCalledTimes(2)
  expect(f.ctx.agents.create).toHaveBeenCalledTimes(2)
  expect(existsSync(join(f.home, '.desktop-product-smoke-complete'))).toBe(false)
})

it('reports a second-instance creation failure and disposes the first instance', async () => {
  const f = fixture()
  const failure = new Error('second instance could not mount')
  const create = f.ctx.agents.create.getMockImplementation()!
  f.ctx.agents.create.mockImplementationOnce(create).mockRejectedValueOnce(failure)
  await expect(f.apply(f.ctx)).rejects.toThrow('preset=short-drama index=1 phase=create')
  expect(readFileSync(join(f.home, '.desktop-product-smoke-error'), 'utf8')).toContain(failure.stack)
  expect(f.dispose).toHaveBeenCalledTimes(1)
  expect(f.ctx.agents.create).toHaveBeenCalledTimes(2)
  expect(existsSync(join(f.home, '.desktop-product-smoke-complete'))).toBe(false)
})

it('awaits every reverse-order disposal and reports all cleanup failures', async () => {
  const f = fixture()
  const firstEntered = Promise.withResolvers<undefined>()
  const firstRelease = Promise.withResolvers<undefined>()
  const secondEntered = Promise.withResolvers<undefined>()
  const secondRelease = Promise.withResolvers<undefined>()
  const order: number[] = []
  const failures = [new Error('cleanup instance zero'), new Error('cleanup instance one')]
  const create = f.ctx.agents.create.getMockImplementation()!
  let created = 0
  f.ctx.agents.create.mockImplementation(async (options) => {
    const index = created++
    const handle = await create(options)
    return { ...handle, dispose: vi.fn(async (): Promise<void> => {
      order.push(index)
      if (index === 1) {
        firstEntered.resolve(undefined)
        await firstRelease.promise
      } else {
        secondEntered.resolve(undefined)
        await secondRelease.promise
      }
      throw failures[index]
    }) }
  })
  const run = f.apply(f.ctx)
  const rejected = expect(run).rejects.toThrow('preset checks or cleanup failed')
  await firstEntered.promise
  expect(order).toEqual([1])
  expect(existsSync(join(f.home, '.desktop-product-smoke-error'))).toBe(false)
  firstRelease.resolve(undefined)
  await secondEntered.promise
  expect(order).toEqual([1, 0])
  expect(existsSync(join(f.home, '.desktop-product-smoke-error'))).toBe(false)
  secondRelease.resolve(undefined)
  await rejected
  const report = readFileSync(join(f.home, '.desktop-product-smoke-error'), 'utf8')
  expect(report).toContain('preset=short-drama index=1 phase=dispose')
  expect(report).toContain('preset=short-drama index=0 phase=dispose')
  for (const failure of failures) expect(report).toContain(failure.stack)
  expect(f.ctx.agents.create).toHaveBeenCalledTimes(2)
  expect(existsSync(join(f.home, '.desktop-product-smoke-complete'))).toBe(false)
})

it('retains the primary failure before both disposal failures', async () => {
  const f = fixture()
  const primary = new Error('primary assembly failure')
  const lastCleanup = new Error('last instance cleanup failure')
  const firstCleanup = new Error('first instance cleanup failure')
  f.ctx.systemPrompt.assemble.mockRejectedValueOnce(primary)
  f.dispose.mockRejectedValueOnce(lastCleanup).mockRejectedValueOnce(firstCleanup)
  await expect(f.apply(f.ctx)).rejects.toThrow('preset checks or cleanup failed')
  const report = readFileSync(join(f.home, '.desktop-product-smoke-error'), 'utf8')
  for (const failure of [primary, lastCleanup, firstCleanup]) expect(report).toContain(failure.stack)
  const primaryPosition = report.indexOf('preset=short-drama index=0 phase=assemble-initial')
  const lastCleanupPosition = report.indexOf('preset=short-drama index=1 phase=dispose')
  const firstCleanupPosition = report.indexOf('preset=short-drama index=0 phase=dispose')
  expect(primaryPosition).toBeGreaterThanOrEqual(0)
  expect(lastCleanupPosition).toBeGreaterThan(primaryPosition)
  expect(firstCleanupPosition).toBeGreaterThan(lastCleanupPosition)
  expect(f.dispose).toHaveBeenCalledTimes(2)
  expect(f.ctx.agents.create).toHaveBeenCalledTimes(2)
  expect(existsSync(join(f.home, '.desktop-product-smoke-complete'))).toBe(false)
})

it('records synchronous retirement during assembly before explicit cleanup and retains its original cause', async () => {
  const f = fixture()
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<never>()
  const primary = new Error('working directory owner retired during inspection')
  f.ctx.systemPrompt.assemble.mockImplementationOnce(async () => { entered.resolve(undefined); return release.promise })
  const run = f.apply(f.ctx)
  const rejected = expect(run).rejects.toThrow(primary.message)
  await entered.promise
  f.agentFiber.uid = null
  f.emitLifecycle('internal/plugin', f.agentFiber)
  f.agentFiber.state = 5
  f.emitLifecycle('internal/status', f.agentFiber, 2)
  release.reject(primary)
  await rejected
  const report = readFileSync(join(f.home, '.desktop-product-smoke-error'), 'utf8')
  expect(report).toContain(primary.stack)
  expect(report).toContain('preset=short-drama index=0 phase=assemble-initial')
  expect(report).toContain('\nDesktop lifecycle diagnostics: ')
  const diagnostic = JSON.parse(report.split('\nDesktop lifecycle diagnostics: ')[1]!) as {
    records: {
      sequence: number
      event: string
      phase: string
      fiber?: { birthUID: number; uid: number | null; state: number }
      stack?: string
    }[]
  }
  const retired = diagnostic.records.find(record => record.event === 'internal/plugin' && record.fiber?.uid === null)
  expect(retired).toMatchObject({ phase: 'assemble-initial', fiber: { birthUID: 101, uid: null, state: 2 } })
  expect(retired?.stack).toContain('emitLifecycle')
  const status = diagnostic.records.find(record => record.event === 'internal/status')
  expect(status).toMatchObject({ fiber: { birthUID: 101, uid: null, state: 5 } })
  const cleanup = diagnostic.records.find(record => record.event === 'before-dispose')
  expect(cleanup?.sequence).toBeGreaterThan(retired!.sequence)
  expect(f.dispose).toHaveBeenCalledTimes(2)
  expect(f.observerDisposers).toHaveLength(2)
  for (const dispose of f.observerDisposers) expect(dispose).toHaveBeenCalledOnce()
  for (const listeners of f.lifecycleListeners.values()) expect(listeners.size).toBe(0)
})

it('bounds lifecycle observations and isolates observer failures without changing successful checks', async () => {
  const f = fixture()
  const assemble = f.ctx.systemPrompt.assemble.getMockImplementation()!
  f.ctx.systemPrompt.assemble.mockImplementationOnce(async (context) => {
    const unreadable = { state: 2, runtime: { name: 'unreadable-observer-fixture' } }
    Object.defineProperty(unreadable, 'uid', { get() { throw new Error('observer-only getter failure') } })
    f.emitLifecycle('internal/plugin', unreadable as typeof f.agentFiber)
    for (let index = 0; index < 600; index++) f.emitLifecycle('internal/status', f.agentFiber, 1)
    return assemble(context)
  })
  await f.apply(f.ctx)
  const response = f.responseText()
  expect(response).toContain('\nDesktop lifecycle diagnostics: ')
  const diagnostic = JSON.parse(response.split('\nDesktop lifecycle diagnostics: ')[1]!) as {
    records: object[]
    droppedRecords: number
    observerErrors: { message: string }[]
  }
  expect(diagnostic.records).toHaveLength(512)
  expect(diagnostic.droppedRecords).toBeGreaterThan(0)
  expect(diagnostic.observerErrors.some(error => error.message.includes('observer-only getter failure'))).toBe(true)
  expect(existsSync(join(f.home, '.desktop-product-smoke-complete'))).toBe(true)
  expect(f.dispose).toHaveBeenCalledTimes(14)
  for (const dispose of f.observerDisposers) expect(dispose).toHaveBeenCalledOnce()
  for (const listeners of f.lifecycleListeners.values()) expect(listeners.size).toBe(0)
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

it.each(defaultHostSkills)('rejects shared Muse skill %s missing from the packaged Host', async (name) => {
  const f = fixture()
  const index = f.skills.findIndex(skill => skill.name === name)
  if (index >= 0) f.skills.splice(index, 1)
  await expect(f.apply(f.ctx)).rejects.toThrow('missing shared Muse skill ' + name)
  expect(existsSync(join(f.home, '.desktop-product-smoke-complete'))).toBe(false)
})

it.each(['drama_project', 'drama_draft_dir', 'jianying_draft', 'manuscript_revision', 'source_recover', 'screenplay_export_docx', 'jubian_budget', 'video_inspect', 'video_ocr'])('rejects a missing project tool %s', async (name) => {
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

it.each(['short-drama', 'ptc', 'standard', 'cordis', 'bot-coordinator', 'creation'])('rejects missing transcription in %s', async (preset) => {
  const f = fixture()
  const schemas = f.ctx.tools.schemas.getMockImplementation()!
  f.ctx.tools.schemas.mockImplementation(key => key?.preset === preset
    ? schemas(key).filter(tool => tool.name !== 'audio_transcribe')
    : schemas(key))
  await expect(f.apply(f.ctx)).rejects.toThrow('transcription availability differs in ' + preset)
  expect(existsSync(join(f.home, '.desktop-product-smoke-complete'))).toBe(false)
})

it.each(['run_code', 'drama_assets', 'source_snapshot', 'video_contact_sheet', 'video_ocr'])('rejects creation without %s', async (name) => {
  const f = fixture()
  if (name === 'run_code') {
    const assemble = f.ctx.systemPrompt.assemble.getMockImplementation()!
    f.ctx.systemPrompt.assemble.mockImplementation(async (context) => {
      const result = await assemble(context)
      if (context.scope.preset === 'creation') result.tools = []
      return result
    })
  } else {
    const schemas = f.ctx.tools.schemas.getMockImplementation()!
    f.ctx.tools.schemas.mockImplementation(key => key?.preset === 'creation'
      ? schemas(key).filter(tool => tool.name !== name)
      : schemas(key))
  }
  await expect(f.apply(f.ctx)).rejects.toThrow(name === 'run_code'
    ? 'PTC preset must expose only run_code: creation' : 'missing product tool ' + name + ' in creation')
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

it.each(['custom', 'user-muse', 'user-dsh', 'user-agents', 'project-muse', 'project-dsh', 'project-agents'])
('accepts additional creation skills from supported source %s', async (source) => {
  const f = fixture()
  f.creationSkills.push({ name: 'additional-user-skill', path: '', source, invocation: { modelInvocable: true } })
  await expect(f.apply(f.ctx)).resolves.toBeUndefined()
})

it.each(['desktop-user-skill', 'editing-cordis-compositions', 'unreviewed-runtime-skill'])('rejects creation exposing %s', async (name) => {
  const f = fixture()
  f.creationSkills.push({ name, path: '', source: 'runtime', invocation: { modelInvocable: true } })
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

it.each(['strict', 'development'] as const)('rejects incomplete smoke in %s mode while isolating its homes', async (mode) => {
  let packageManager: unknown
  let smokeEnvironment: unknown
  let inspectPort: unknown
  let cliEntry: string | undefined
  let cliSource: string | undefined
  const execute = payload.getMockImplementation()!
  payload.mockImplementation(async (...args) => {
    if (args[1][2] === 'plugin') {
      cliEntry = args[1][1]
      if (mode === 'development') cliSource = readFileSync(cliEntry!, 'utf8')
    }
    return execute(...args)
  })
  const start = vi.spyOn(DesktopHostProcess.prototype, 'start').mockImplementation(async function (this: DesktopHostProcess) {
    packageManager = Reflect.get(this, 'packageManager')
    smokeEnvironment = Reflect.get(this, 'environment')
    inspectPort = Reflect.get(this, 'inspectPort')
    return { pid: 2468, url: 'http://127.0.0.1:1/' }
  })
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('<html></html>'))
  const stop = vi.spyOn(DesktopHostProcess.prototype, 'stop').mockResolvedValue()
  try {
    const root = fixture().home
    const runtime = runtimeFixture(root)
    const resources = primaryRuntimeFixture(root)
    const environment = { DSH_HOME: '/must-not-read', MUSE_HOME: '/must-not-read' }
    const checking = mode === 'strict' ? smokeDesktopRuntime(root, process.execPath, runtime, environment, resources)
      : smokeDesktopRuntime(root, process.execPath, runtime, environment, resources, 'development')
    await expect(checking)
      .rejects.toThrow('product preset smoke did not complete')
    expect(inspectPort).toBe(mode === 'strict' ? undefined : 0)
    if (typeof smokeEnvironment !== 'object' || smokeEnvironment === null || !('DSH_HOME' in smokeEnvironment)
      || typeof smokeEnvironment.DSH_HOME !== 'string') throw new Error('Missing private smoke home')
    if (mode === 'development') {
      expect(cliEntry).toBe(join(smokeEnvironment.DSH_HOME, 'desktop-cli.mjs'))
      expect(cliSource).toContain('import { runDesktopCli } from ')
      expect(cliSource).toContain(`await runDesktopCli(${JSON.stringify(root)}, ${JSON.stringify(resources)})`)
    } else {
      expect(cliEntry).toBe(join(root, 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js'))
      expect(cliSource).toBeUndefined()
    }
    expect(smokeEnvironment).toMatchObject({ MUSE_HOME: smokeEnvironment.DSH_HOME, HOME: smokeEnvironment.DSH_HOME })
    expect(smokeEnvironment.DSH_HOME).not.toBe('/must-not-read')
    expect(packageManager).toEqual({ pnpm: join(resources, 'primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.mjs'), nodeBin: join(resources, 'bin') })
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
    payloadFailure.downloader = new Error('Python cannot read download script')
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
  else if (kind === 'legacy-only') f.skills.push({ ...custom, name: 'desktop-shared-only' })
  else {
    const path = join(f.home, '.agents/skills/desktop-user-skill/SKILL.md')
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, '# legacy')
    custom.path = path
  }
  await expect(f.apply(f.ctx)).rejects.toThrow(kind === 'legacy-only'
    ? 'excluded shared user skill was discovered' : 'custom or project skill selection differs')
  expect(existsSync(join(f.home, '.desktop-product-smoke-complete'))).toBe(false)
})

it.each(['short-drama', 'creation'])('rejects missing or unreadable custom/project skills in %s', async (preset) => {
  const f = fixture()
  if (preset === 'creation') f.creationSkills.splice(f.creationSkills.findIndex(skill => skill.name === 'desktop-project-muse'), 1)
  else {
    const get = f.ctx.skills.get.getMockImplementation()!
    f.ctx.skills.get.mockImplementation(async name => name === 'desktop-project-muse' ? undefined : get(name))
  }
  await expect(f.apply(f.ctx)).rejects.toThrow(preset === 'creation'
    ? 'custom or project skill selection differs in creation: desktop-project-muse'
    : 'custom or project skill could not load in short-drama: desktop-project-muse')
})

it.each(['source', 'priority'])('rejects incorrect project skill %s', async (change) => {
  const f = fixture()
  const skill = f.skills.find(skill => skill.name === 'desktop-project-priority')!
  if (change === 'source') skill.source = 'custom'
  else skill.path = join(f.layout.cwd, '.dsh/skills/desktop-project-priority/SKILL.md')
  await expect(f.apply(f.ctx)).rejects.toThrow('custom or project skill selection differs in short-drama: desktop-project-priority')
})

it('refuses a roster with additional presets before creating an agent', async () => {
  const f = fixture()
  f.ctx.agentPresets.list.mockResolvedValue([...(await f.ctx.agentPresets.list()), { id: 'personal' }])
  await expect(f.apply(f.ctx)).rejects.toThrow('product preset roster differs')
  expect(f.ctx.agents.create).not.toHaveBeenCalled()
})

it.each(['short-drama', 'ptc', 'standard', 'minimal', 'cordis', 'bot-coordinator', 'creation', 'muse-manuscript-continuity-reviewer'])
('refuses a roster missing product preset %s before creating an agent', async (missing) => {
  const f = fixture()
  f.ctx.agentPresets.list.mockResolvedValue((await f.ctx.agentPresets.list()).filter(preset => preset.id !== missing))
  await expect(f.apply(f.ctx)).rejects.toThrow('product preset roster differs')
  expect(f.ctx.agents.create).not.toHaveBeenCalled()
})

it('refuses a same-sized roster that replaces the coordinator with a personal preset', async () => {
  const f = fixture()
  f.ctx.agentPresets.list.mockResolvedValue((await f.ctx.agentPresets.list())
    .map(preset => preset.id === 'bot-coordinator' ? { id: 'personal' } : preset))
  await expect(f.apply(f.ctx)).rejects.toThrow('product preset roster differs')
  expect(f.ctx.agents.create).not.toHaveBeenCalled()
})

it('rejects changing the default product preset to the coordinator', async () => {
  const f = fixture()
  f.ctx.agentPresets.defaultId = 'bot-coordinator'
  await expect(f.apply(f.ctx)).rejects.toThrow('product default preset changed')
  expect(f.ctx.agents.create).not.toHaveBeenCalled()
})

it.each(['read', 'tool_search', 'tool_context'])
('rejects recovery coordinator missing its standard or discovery tool %s', async (missing) => {
  const f = fixture()
  const schemas = f.ctx.tools.schemas.getMockImplementation()!
  f.ctx.tools.schemas.mockImplementation(key => key?.preset === 'bot-coordinator'
    ? schemas(key).filter(tool => tool.name !== missing) : schemas(key))
  await expect(f.apply(f.ctx)).rejects.toThrow('missing product tool ' + missing + ' in bot-coordinator')
  expect(existsSync(join(f.home, '.desktop-product-smoke-complete'))).toBe(false)
})

it.each(['list_bots', 'message_bot', 'create_bot', 'update_bot', 'stop_bot', 'start_task', 'ask_user'])
('rejects archived Bot tool %s leaking into a registered composition', async (name) => {
  const f = fixture()
  const schemas = f.ctx.tools.schemas.getMockImplementation()!
  f.ctx.tools.schemas.mockImplementation(key => [...schemas(key), { name }])
  await expect(f.apply(f.ctx)).rejects.toThrow('archived Bot tool remains active: ' + name)
  expect(existsSync(join(f.home, '.desktop-product-smoke-complete'))).toBe(false)
})

it.each(editingModelInput.retiredAccountTools)('rejects retired built-in account MCP %s', async (name) => {
  const f = fixture()
  const schemas = f.ctx.tools.schemas.getMockImplementation()!
  f.ctx.tools.schemas.mockImplementation(key => [...schemas(key), { name }])
  await expect(f.apply(f.ctx)).rejects.toThrow('retired built-in account MCP remains active: ' + name)
  expect(existsSync(join(f.home, '.desktop-product-smoke-complete'))).toBe(false)
})

it.each(['short-drama', 'ptc', 'standard', 'minimal', 'cordis', 'bot-coordinator', 'creation'])
('rejects an unlisted built-in account MCP in %s', async (preset) => {
  const f = fixture()
  const name = 'mcp__muse-account__unlisted_tool'
  const schemas = f.ctx.tools.schemas.getMockImplementation()!
  f.ctx.tools.schemas.mockImplementation(key => key?.preset === preset ? [...schemas(key), { name }] : schemas(key))
  await expect(f.apply(f.ctx)).rejects.toThrow('retired built-in account MCP remains active: ' + name + ' in ' + preset)
  expect(existsSync(join(f.home, '.desktop-product-smoke-complete'))).toBe(false)
})

it('fails missing tools and still disposes the created agent', async () => {
  const f = fixture()
  f.names.splice(f.names.indexOf('bgm_match'), 1)
  await expect(f.apply(f.ctx)).rejects.toThrow('missing product tool bgm_match')
  expect(f.dispose).toHaveBeenCalledTimes(2)
  expect(existsSync(join(f.home, '.desktop-product-smoke-complete'))).toBe(false)
})

it('rejects a short-drama preset without its source snapshot tool', async () => {
  const f = fixture()
  f.sourceCapabilityNames.splice(f.sourceCapabilityNames.indexOf('source_snapshot'), 1)
  await expect(f.apply(f.ctx)).rejects.toThrow('missing product tool source_snapshot')
  expect(existsSync(join(f.home, '.desktop-product-smoke-complete'))).toBe(false)
})

it('rejects a short-drama preset without its source report tool', async () => {
  const f = fixture()
  f.sourceCapabilityNames.splice(f.sourceCapabilityNames.indexOf('source_report'), 1)
  await expect(f.apply(f.ctx)).rejects.toThrow('missing product tool source_report')
  expect(existsSync(join(f.home, '.desktop-product-smoke-complete'))).toBe(false)
})

it('rejects an editing mode without its script-pool reader', async () => {
  const f = fixture()
  f.sourceCapabilityNames.splice(f.sourceCapabilityNames.indexOf('jubian_find'), 1)
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

it('loads deferred source definitions through committed context receipts and restores initial visibility', async () => {
  const f = fixture()
  await f.apply(f.ctx)
  expect(f.ctx.tools.execute.mock.calls.map(([call]) => contextArguments(call).operation)).toEqual(['load', 'release', 'load', 'release'])
  for (const [batch] of f.ctx.tools.execute.mock.calls) {
    expect(batch.agent).toBe(f.agent)
    expect(batch.log).toEqual({ turn: 1, step: 1 })
    expect(batch.calls[0]?.type).toBe('tool-call')
  }
  expect(f.agent.session.append.mock.calls.map(([type]) => type)).toEqual([
    'tool/call', 'tool/result', 'tool/call', 'tool/result',
    'tool/call', 'tool/result', 'tool/call', 'tool/result',
  ])
  expect([...f.selected]).toEqual([])
  expect(f.dispose).toHaveBeenCalledTimes(14)
})

it.each(Object.keys(editingModelInput.tools))('rejects a missing authorized source definition %s', async (missing) => {
  const f = fixture()
  f.sourceCapabilityNames.splice(f.sourceCapabilityNames.indexOf(missing), 1)
  await expect(f.apply(f.ctx)).rejects.toThrow('missing product tool ' + missing)
})

it.each(Object.keys(editingModelInput.tools))('rejects a changed authorized description for %s', async (name) => {
  const f = fixture()
  const schemas = f.ctx.tools.schemas.getMockImplementation()!
  f.ctx.tools.schemas.mockImplementation(key => schemas(key).map(tool => tool.name === name
    ? { ...tool, description: 'Generic read.' } : tool))
  await expect(f.apply(f.ctx)).rejects.toThrow('editing authorized tool description changed: ' + name)
})

it('rejects source definitions exposed before discovery', async () => {
  const f = fixture()
  f.selected.add('source_snapshot')
  await expect(f.apply(f.ctx)).rejects.toThrow('source tools must remain deferred before discovery')
})

it.each(['read', 'skill', 'tool_search', 'tool_context'])('rejects missing initial resident definition %s', async (name) => {
  const f = fixture()
  const assemble = f.ctx.systemPrompt.assemble.getMockImplementation()!
  f.ctx.systemPrompt.assemble.mockImplementation(async (context) => {
    const result = await assemble(context)
    result.tools = result.tools.filter(tool => tool.name !== name)
    return result
  })
  await expect(f.apply(f.ctx)).rejects.toThrow('missing resident tool ' + name)
})

it.each(['load', 'release'])('rejects unsuccessful tool_context %s', async (operation) => {
  const f = fixture()
  const execute = f.ctx.tools.execute.getMockImplementation()!
  f.ctx.tools.execute.mockImplementation(async (input) => {
    if (contextArguments(input).operation !== operation) return execute(input)
    return { results: [{ callId: input.calls[0]!.id, result: { isError: true,
      error: { message: 'context rejected' }, content: [{ type: 'text', text: 'context rejected' }] } }],
    additionalContexts: [], concluded: false }
  })
  await expect(f.apply(f.ctx)).rejects.toThrow('tool_context ' + operation + ' failed')
})

it.each(['missing', 'different-call'])('rejects an uncorrelated tool_context batch result: %s', async (kind) => {
  const f = fixture()
  const execute = f.ctx.tools.execute.getMockImplementation()!
  f.ctx.tools.execute.mockImplementationOnce(async (input) => {
    const batch = await execute(input)
    return { ...batch, results: kind === 'missing' ? [] : batch.results.map(outcome => ({ ...outcome,
      callId: ToolCallId('unrelated-smoke-call'),
    })) }
  })
  await expect(f.apply(f.ctx)).rejects.toThrow('invalid tool_context batch result')
  expect(existsSync(join(f.home, '.desktop-product-smoke-complete'))).toBe(false)
})

it.each(['load', 'release'])('rejects successful %s without an applied context receipt', async (operation) => {
  const f = fixture()
  const append = f.agent.session.append.getMockImplementation()!
  f.agent.session.append.mockImplementation((type, data) => {
    if (type === 'tool/result' && data.message!.content.some(block => block.text?.includes('"operation":"' + operation + '"'))) return { seq: 1 }
    return append(type, data)
  })
  await expect(f.apply(f.ctx)).rejects.toThrow(operation === 'load'
    ? 'editing model tool description changed after loading:' : 'releasing source tools did not restore initial model tools')
})

it('rejects a loaded definition omitted from the assembled model request', async () => {
  const f = fixture()
  const assemble = f.ctx.systemPrompt.assemble.getMockImplementation()!
  f.ctx.systemPrompt.assemble.mockImplementation(async (context) => {
    const result = await assemble(context)
    result.tools = result.tools.filter(tool => tool.name !== 'source_snapshot')
    return result
  })
  await expect(f.apply(f.ctx)).rejects.toThrow('editing model tool description changed after loading: source_snapshot')
})

it('rejects a released definition that remains in model input despite cleared selections', async () => {
  const f = fixture()
  const assemble = f.ctx.systemPrompt.assemble.getMockImplementation()!
  let count = 0
  f.ctx.systemPrompt.assemble.mockImplementation(async (context) => {
    const result = await assemble(context)
    if (++count === 3) result.tools.push({ name: 'source_snapshot', description: editingModelInput.tools['source_snapshot']! })
    return result
  })
  await expect(f.apply(f.ctx)).rejects.toThrow('releasing source tools did not restore initial model tools')
})

it.each(Object.keys(editingModelInput.tools))('rejects a changed model-visible description for %s', async (name) => {
  const f = fixture()
  const assemble = f.ctx.systemPrompt.assemble.getMockImplementation()!
  f.ctx.systemPrompt.assemble.mockImplementation(async (context) => {
    const result = await assemble(context)
    const tool = result.tools.find(tool => tool.name === name)
    if (context.scope.preset === 'short-drama' && tool) tool.description = 'Generic read.'
    return result
  })
  await expect(f.apply(f.ctx)).rejects.toThrow('editing model tool description changed after loading: ' + name)
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
  else f.skills.push({ name: 'xiaohongshu-reference', path: '', source: 'runtime', invocation: { modelInvocable: false } })
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
  expect(f.dispose).toHaveBeenCalledTimes(14)
})

it.each([...defaultHostSkills,
  'shot-script-creator-16-9-3d', 'shot-script-creator-9-16'])('rejects required packaged skill %s without a filesystem path', async (name) => {
  const f = fixture()
  const list = f.ctx.skills.list.getMockImplementation()!
  f.ctx.skills.list.mockImplementation(async options => (await list(options)).map(skill =>
    skill.name === name ? { name: skill.name, invocation: skill.invocation } : skill))
  await expect(f.apply(f.ctx)).rejects.toThrow(name.startsWith('shot-script-creator-')
    ? 'missing product skill ' + name : 'missing shared Muse skill ' + name)
})

it.each(['editing', 'transcript-to-novel', 'transcript-to-script', 'media-link-import'])('rejects re-enabling retired Host skill %s', async (name) => {
  const f = fixture()
  const path = join(f.root, 'node_modules/@deepseek-ai/dsh-desktop-host/skills', name, 'SKILL.md')
  writeFileSync(path, '# enabled old resource')
  await expect(f.apply(f.ctx)).rejects.toThrow('retired Host skill is enabled: ' + name)
})

it.each([...defaultHostSkills,
  'shot-script-creator-16-9-3d', 'shot-script-creator-9-16'])('rejects a disabled file pretending to be active skill %s', async (name) => {
  const f = fixture()
  const skill = f.skills.find(value => value.name === name)!
  const disabled = skill.path + '.disabled'
  writeFileSync(disabled, '# disabled content')
  skill.path = disabled
  await expect(f.apply(f.ctx)).rejects.toThrow('disabled skill is model-invocable')
})

it.each([...defaultHostSkills, 'shot-script-creator-16-9-3d', 'shot-script-creator-9-16'])('rejects %s whose full content cannot be loaded', async (name) => {
  const f = fixture()
  const get = f.ctx.skills.get.getMockImplementation()!
  f.ctx.skills.get.mockImplementation(async target => target === name ? undefined : get(target))
  await expect(f.apply(f.ctx)).rejects.toThrow(name.startsWith('shot-script-creator-')
    ? 'shot-writing skill did not load from its packaged resource: ' + name
    : 'shared skill did not load from the packaged Host: ' + name)
})

it('loads default transcription, writing and shot-writing skills through the scoped registry', async () => {
  const f = fixture()
  await f.apply(f.ctx)
  for (const name of [...defaultHostSkills,
    'shot-script-creator-16-9-3d', 'shot-script-creator-9-16']) {
    expect(f.ctx.skills.get).toHaveBeenCalledWith(name, { scope: f.agent, cwd: f.layout.cwd })
  }
  for (const name of ['editing', 'transcript-to-novel', 'transcript-to-script', 'media-link-import']) {
    const directory = join(f.root, 'node_modules/@deepseek-ai/dsh-desktop-host/skills', name)
    expect(existsSync(join(directory, 'SKILL.md'))).toBe(false)
    expect(existsSync(join(directory, 'SKILL.md.disabled'))).toBe(true)
  }
})
