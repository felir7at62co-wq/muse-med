import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join, dirname, relative, isAbsolute } from 'node:path'
import { tmpdir } from 'node:os'
import { runInNewContext } from 'node:vm'
import { afterEach, expect, it, vi } from 'vitest'
import { desktopSmokePluginSource, smokeDesktopRuntime } from '../scripts/smoke-runtime.ts'
import { DesktopHostProcess } from '../src/host-process.ts'
import { runtimeFixture } from './runtime-fixture.ts'

vi.mock('../src/profile-packages.ts', () => ({ linkDesktopHostPackages: vi.fn(), validateDesktopPluginGraph: vi.fn() }))

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'desktop-product-smoke-test-'))
  roots.push(root)
  const home = join(root, 'home')
  mkdirSync(home)
  const ids = ['short-drama-local', 'standard', 'ptc']
  const presetPath = (id: string) => join(root, 'node_modules/@deepseek-ai/dsh-desktop-host/presets', id, 'agent.cordis.yml')
  for (const id of ids) {
    mkdirSync(dirname(presetPath(id)), { recursive: true })
    writeFileSync(presetPath(id), '[]')
  }
  const skillRoot = join(root, 'node_modules/@deepseek-ai/dsh-drama-skills/skills')
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
  const agent = { preset: 'short-drama-local' }
  const agentCtx = {}
  const dispose = vi.fn(async () => {})
  const mount = vi.fn(async (_context: object, _id: string) => {})
  const names = ['jubian_asset', 'jubian_catalog', 'jubian_model', 'jubian_storyboard', 'jubian_video',
    'jubian_media', 'jubian_watch', 'bgm_match', 'ffmpeg_probe', 'ffmpeg_encode', 'skill',
    'drama_assets', 'drama_shot', 'drama_bgm', 'drama_render', 'read', 'present', process.platform === 'win32' ? 'pwsh' : 'bash']
  class TestContext {
    agentPresets = {
      defaultId: 'short-drama-local',
      list: vi.fn(async () => ids.map(id => ({ id }))),
      resolve: vi.fn(async (id: string) => ({ path: presetPath(id), trust: 'system' })), mount,
    }
    agents = { create: vi.fn(async (options: { setup: (context: object) => Promise<void>; meta: { agentPreset: string } }) => {
      await options.setup(agentCtx)
      return { agent: options.meta.agentPreset === 'short-drama-local' ? agent : { preset: options.meta.agentPreset }, dispose }
    }) }
    tools = { schemas: vi.fn((key: { preset: string }) => {
      const shell = process.platform === 'win32' ? 'pwsh' : 'bash'
      return (key.preset === 'short-drama-local' ? names
        : ['read', 'skill', shell, 'subagent', ...(key.preset === 'ptc' ? ['run_code'] : ['workflow'])]).map(name => ({ name }))
    }) }
    skills = { list: vi.fn(async () => skills) }
  }
  // Execute exactly the emitted plugin body; fixture services never impersonate a real prepared-runtime smoke.
  const source = desktopSmokePluginSource(root, home)
  expect(source).toMatch(/export const inject = \[[^\]]*'credentials'/u)
  const body = source.replace(/^import .*$/gmu, '').replace(/^export /gmu, '')
  const apply = runInNewContext(`${body}\napply`, {
    Context: TestContext, existsSync, realpathSync, writeFileSync, join, relative, isAbsolute, process: { platform: process.platform },
  }) as (ctx: TestContext) => Promise<void>
  return { ctx: new TestContext(), apply, agent, agentCtx, mount, dispose, names, skills, skillRoot, home }
}

it('awaits full preset mounting and reads agent-scoped tools and bundled skills before disposal', async () => {
  const f = fixture()
  await f.apply(f.ctx)
  expect(f.mount).toHaveBeenCalledWith(f.agentCtx, 'short-drama-local')
  expect(f.ctx.tools.schemas).toHaveBeenCalledWith(f.agent)
  expect(f.ctx.skills.list).toHaveBeenCalledWith({ scope: f.agent, cwd: f.home })
  expect(f.dispose).toHaveBeenCalledTimes(6)
  expect(f.ctx.agents.create).toHaveBeenCalledTimes(6)
  expect(existsSync(join(f.home, '.desktop-product-smoke-complete'))).toBe(true)
})

it('rejects Host readiness when the private preset smoke never completes', async () => {
  const start = vi.spyOn(DesktopHostProcess.prototype, 'start').mockResolvedValue({ protocolVersion: 3, dshVersion: '1.0.0' })
  const fetch = vi.spyOn(DesktopHostProcess.prototype, 'fetch').mockResolvedValue(new Response('<html></html>'))
  const stop = vi.spyOn(DesktopHostProcess.prototype, 'stop').mockResolvedValue()
  try {
    const root = fixture().home
    const runtime = runtimeFixture(root)
    await expect(smokeDesktopRuntime(root, process.execPath, runtime)).rejects.toThrow('product preset smoke did not complete')
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
    const result = expect(smokeDesktopRuntime(root, process.execPath, runtime)).rejects.toThrow('smoke startup timed out')
    await vi.advanceTimersByTimeAsync(60_000)
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
  f.mount.mockImplementation(async (_context, id) => { if (id === 'ptc') throw new Error('waiting for ptcRuntime') })
  await expect(f.apply(f.ctx)).rejects.toThrow('waiting for ptcRuntime')
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
  f.ctx.agentPresets.list.mockResolvedValue([{ id: 'short-drama-local' }, { id: 'personal' }])
  await expect(f.apply(f.ctx)).rejects.toThrow('expected exactly the four product presets')
  expect(f.ctx.agents.create).not.toHaveBeenCalled()
})

it('fails missing tools and still disposes the created agent', async () => {
  const f = fixture()
  f.names.splice(f.names.indexOf('bgm_match'), 1)
  await expect(f.apply(f.ctx)).rejects.toThrow('missing product tool bgm_match')
  expect(f.dispose).toHaveBeenCalledTimes(2)
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
