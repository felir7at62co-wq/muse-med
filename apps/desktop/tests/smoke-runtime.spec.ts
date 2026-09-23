import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join, dirname, relative, isAbsolute } from 'node:path'
import { tmpdir } from 'node:os'
import { runInNewContext } from 'node:vm'
import { afterEach, expect, it, vi } from 'vitest'
import { desktopSmokePluginSource, smokeDesktopRuntime } from '../scripts/smoke-runtime.ts'
import { DesktopHostProcess } from '../src/host-process.ts'
import type { DesktopRuntimeDescriptor } from '../src/runtime-tree.ts'

vi.mock('../src/profile-packages.ts', () => ({ linkDesktopHostPackages: vi.fn(), validateDesktopPluginGraph: vi.fn() }))

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'desktop-product-smoke-test-'))
  roots.push(root)
  const home = join(root, 'home')
  mkdirSync(home)
  const preset = join(root, 'node_modules/@deepseek-ai/dsh-desktop-host/presets/short-drama-local/agent.cordis.yml')
  mkdirSync(dirname(preset), { recursive: true })
  writeFileSync(preset, '[]')
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
  const agent = {}
  const agentCtx = {}
  const dispose = vi.fn(async () => {})
  const mount = vi.fn(async () => {})
  const names = ['jubian_asset', 'jubian_catalog', 'jubian_model', 'jubian_storyboard', 'jubian_video',
    'jubian_media', 'jubian_watch', 'bgm_match', 'ffmpeg_probe', 'ffmpeg_encode', 'skill',
    'drama_assets', 'drama_shot', 'drama_bgm', 'drama_render', 'read', 'present', process.platform === 'win32' ? 'pwsh' : 'bash']
  class TestContext {
    agentPresets = {
      list: vi.fn(async () => [{ id: 'short-drama-local' }]),
      resolve: vi.fn(async () => ({ path: preset, trust: 'system' })), mount,
    }
    agents = { create: vi.fn(async (options: { setup: (context: object) => Promise<void> }) => {
      await options.setup(agentCtx)
      return { agent, dispose }
    }) }
    tools = { schemas: vi.fn(() => names.map(name => ({ name }))) }
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
  expect(f.dispose).toHaveBeenCalledOnce()
  expect(existsSync(join(f.home, '.desktop-product-smoke-complete'))).toBe(true)
})

it('rejects Host readiness when the private preset smoke never completes', async () => {
  const start = vi.spyOn(DesktopHostProcess.prototype, 'start').mockResolvedValue({ type: 'ready', protocolVersion: 3, dshVersion: '1.0.0' })
  const fetch = vi.spyOn(DesktopHostProcess.prototype, 'fetch').mockResolvedValue(new Response('<html></html>'))
  const stop = vi.spyOn(DesktopHostProcess.prototype, 'stop').mockResolvedValue()
  try {
    const runtime = { release: { version: '1.0.0' }, sharedPackages: [{ name: '@deepseek-ai/cordis', version: '1.0.0' }] } as DesktopRuntimeDescriptor
    await expect(smokeDesktopRuntime(fixture().home, process.execPath, runtime)).rejects.toThrow('product preset smoke did not complete')
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
    const runtime = { release: { version: '1.0.0' }, sharedPackages: [{ name: '@deepseek-ai/cordis', version: '1.0.0' }] } as DesktopRuntimeDescriptor
    const result = expect(smokeDesktopRuntime(fixture().home, process.execPath, runtime)).rejects.toThrow('smoke startup timed out')
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

it('refuses a roster with additional presets before creating an agent', async () => {
  const f = fixture()
  f.ctx.agentPresets.list.mockResolvedValue([{ id: 'short-drama-local' }, { id: 'personal' }])
  await expect(f.apply(f.ctx)).rejects.toThrow('expected only short-drama-local')
  expect(f.ctx.agents.create).not.toHaveBeenCalled()
})

it('fails missing tools and still disposes the created agent', async () => {
  const f = fixture()
  f.names.splice(f.names.indexOf('bgm_match'), 1)
  await expect(f.apply(f.ctx)).rejects.toThrow('missing product tool bgm_match')
  expect(f.dispose).toHaveBeenCalledOnce()
  expect(existsSync(join(f.home, '.desktop-product-smoke-complete'))).toBe(false)
})

it.each(['directory', 'registry'])('rejects XHS in the product %s and disposes the created agent', async (source) => {
  const f = fixture()
  if (source === 'directory') mkdirSync(join(f.skillRoot, 'xiaohongshu-reference'))
  else f.skills.push({ name: 'xiaohongshu-reference', path: '', invocation: { modelInvocable: false } })
  await expect(f.apply(f.ctx)).rejects.toThrow('XHS must not ship')
  expect(f.dispose).toHaveBeenCalledOnce()
})

it('rejects a personal skill shadow and still disposes the created agent', async () => {
  const f = fixture()
  const personal = join(f.home, 'SKILL.md')
  writeFileSync(personal, '# personal')
  f.skills[0]!.path = personal
  await expect(f.apply(f.ctx)).rejects.toThrow('skill outside product bundle')
  expect(f.dispose).toHaveBeenCalledOnce()
})
