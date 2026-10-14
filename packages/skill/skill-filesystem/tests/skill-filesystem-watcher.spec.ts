import { EventEmitter } from 'node:events'
import type { Stats } from 'node:fs'
import { mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'

interface FakeWatcherControl {
  emitter: EventEmitter
  closeCalls: number
  options: Record<string, unknown>
  path: string
}

interface FakeWatchFileControl {
  path: string
  listener(current: Stats, previous: Stats): void
}

interface FakeStatGate {
  started: PromiseWithResolvers<undefined>
  release: PromiseWithResolvers<undefined>
  completed?: PromiseWithResolvers<undefined>
}

const watcherHarness = vi.hoisted(() => ({
  watchers: [] as FakeWatcherControl[],
  startupErrors: [] as Error[],
  closeErrors: 0,
  deferredReady: 0,
  watchFiles: [] as FakeWatchFileControl[],
  statGates: [] as FakeStatGate[],
  statCalls: [] as string[],
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    watchFile(path: string, _options: unknown, listener: FakeWatchFileControl['listener']) {
      watcherHarness.watchFiles.push({ path, listener })
    },
    unwatchFile(path: string, listener: FakeWatchFileControl['listener']) {
      const index = watcherHarness.watchFiles.findIndex(control => control.path === path && control.listener === listener)
      if (index !== -1) watcherHarness.watchFiles.splice(index, 1)
    },
  }
})

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    async stat(...args: Parameters<typeof actual.stat>) {
      watcherHarness.statCalls.push(String(args[0]))
      const gate = watcherHarness.statGates.shift()
      if (gate !== undefined) {
        gate.started.resolve(undefined)
        await gate.release.promise
      }
      const result = await actual.stat(...args)
      gate?.completed?.resolve(undefined)
      return result
    },
  }
})

vi.mock('chokidar', () => ({
  default: {
    watch(path: unknown, options: Record<string, unknown>) {
      const emitter = new EventEmitter() as EventEmitter & { close(): Promise<void> }
      const control: FakeWatcherControl = { emitter, closeCalls: 0, options, path: String(path) }
      emitter.close = async () => {
        control.closeCalls += 1
        if (watcherHarness.closeErrors > 0) {
          watcherHarness.closeErrors -= 1
          throw new Error('close failed')
        }
      }
      watcherHarness.watchers.push(control)
      queueMicrotask(() => {
        if (watcherHarness.deferredReady > 0) {
          watcherHarness.deferredReady -= 1
          return
        }
        const error = watcherHarness.startupErrors.shift()
        if (error === undefined) emitter.emit('ready')
        else emitter.emit('error', error)
      })
      return emitter
    },
  },
}))

const SkillFileSystem = await import('../src/index.ts')

/** Every temp dir created by this file, removed after each test. */
const tempDirs: string[] = []
let previousMuseHome: string | undefined
afterEach(async () => {
  if (previousMuseHome === undefined) delete process.env.MUSE_HOME
  else process.env.MUSE_HOME = previousMuseHome
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function tempDir(name: string): Promise<string> {
  const dir = await import('node:fs/promises').then(fs => fs.mkdtemp(join(tmpdir(), `dsh-${name}-`)))
  tempDirs.push(dir)
  return dir
}

async function writeSkill(root: string, name: string): Promise<void> {
  const directory = join(root, name)
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name}\n---\n\nBody.\n`)
}

async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

beforeEach(async () => {
  watcherHarness.watchers.length = 0
  watcherHarness.startupErrors.length = 0
  watcherHarness.closeErrors = 0
  watcherHarness.deferredReady = 0
  watcherHarness.watchFiles.length = 0
  watcherHarness.statGates.length = 0
  watcherHarness.statCalls.length = 0
  // The muse user root defaults to `$MUSE_HOME` or `~/.muse`; pin it inside a
  // temp dir so no case here probes or watches the machine's real muse home.
  previousMuseHome = process.env.MUSE_HOME
  process.env.MUSE_HOME = await tempDir('skill-watch-muse-home')
})

describe('skill-filesystem watcher failures', () => {
  it('bounds missing readiness, closes the failed watcher, and reuses recovered hot catalogs', async () => {
    const root = await tempDir('skill-watch-ready-deadline')
    await writeSkill(root, 'ready-skill')
    watcherHarness.deferredReady = 1
    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    const fiber = await ctx.plugin(SkillFileSystem, {
      includeDefaultRoots: false, customSkillDirs: [root], watchReadyTimeoutMs: 20,
    })
    try {
      const cold = await ctx.skills.snapshot()
      expect(cold).toMatchObject({ skills: [{ name: 'ready-skill' }], complete: false })
      expect(watcherHarness.watchers[0]?.closeCalls).toBe(1)
      expect(watcherHarness.watchers[0]?.emitter.listenerCount('ready')).toBe(0)
      expect(await ctx.skills.snapshot()).toMatchObject({ skills: [{ name: 'ready-skill' }], complete: true })
      expect(watcherHarness.watchers).toHaveLength(2)
      await ctx.skills.snapshot()
      await ctx.skills.snapshot({ cwd: join(root, 'other') })
      expect(watcherHarness.watchers).toHaveLength(2)
    } finally {
      await fiber.dispose()
    }
    expect(watcherHarness.watchers.every(watcher => watcher.closeCalls === 1)).toBe(true)
  })

  it('cancels one discovery without cancelling a shared watcher or another waiting caller', async () => {
    const root = await tempDir('skill-watch-cancel-caller')
    await writeSkill(root, 'shared-skill')
    watcherHarness.deferredReady = 1
    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    let provider!: InstanceType<typeof SkillFileSystem.FileSystemSkillProvider>
    const unregister = ctx.skills.registerProvider((control) => {
      provider = new SkillFileSystem.FileSystemSkillProvider(ctx, control, {
        includeDefaultRoots: false, customSkillDirs: [root],
      })
      return provider
    })
    const cancellation = new AbortController()
    const cancelled = provider.list({ signal: cancellation.signal })
    const rejected = expect(cancelled).rejects.toThrow('cancel preparation')
    const survivor = provider.list({})
    try {
      await vi.waitFor(() => { expect(watcherHarness.watchers).toHaveLength(1) })
      cancellation.abort(new Error('cancel preparation'))
      await rejected
      expect(watcherHarness.watchers[0]?.closeCalls).toBe(0)
      watcherHarness.watchers[0]?.emitter.emit('ready')
      expect(await survivor).toMatchObject([{ name: 'shared-skill' }])
    } finally {
      await provider.dispose()
      unregister()
      await Promise.allSettled([cancelled, survivor])
    }
    expect(watcherHarness.watchers[0]?.closeCalls).toBe(1)
  })

  it('bounds the complete discovery while a root probe is stalled and stops after cancellation', async () => {
    const root = await tempDir('skill-watch-discovery-deadline')
    await writeSkill(root, 'delayed-skill')
    const gate: FakeStatGate = {
      started: Promise.withResolvers<undefined>(), release: Promise.withResolvers<undefined>(),
    }
    watcherHarness.statGates.push(gate)
    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    let provider!: InstanceType<typeof SkillFileSystem.FileSystemSkillProvider>
    const unregister = ctx.skills.registerProvider((control) => {
      provider = new SkillFileSystem.FileSystemSkillProvider(ctx, control, {
        includeDefaultRoots: false, customSkillDirs: [root], discoveryTimeoutMs: 20,
      })
      return provider
    })
    const discovery = provider.list({})
    const rejected = expect(discovery).rejects.toThrow('discovery timed out after 20ms')
    try {
      await gate.started.promise
      await rejected
    } finally {
      gate.release.resolve(undefined)
      await provider.dispose()
      unregister()
    }
    expect(watcherHarness.watchers.every(watcher => watcher.closeCalls === 1)).toBe(true)
  })

  it('stops inspecting native symlinks after discovery cancellation', async () => {
    const root = await tempDir('skill-native-cancel')
    const target = await tempDir('skill-native-target')
    for (const name of ['first', 'second', 'third']) {
      await symlink(target, join(root, name), process.platform === 'win32' ? 'junction' : 'dir')
    }
    const gate = {
      started: Promise.withResolvers<undefined>(), release: Promise.withResolvers<undefined>(),
      completed: Promise.withResolvers<undefined>(),
    }
    watcherHarness.statGates.push(gate)
    const provider = new SkillFileSystem.FileSystemSkillProvider(new Context(), {
      signal: new AbortController().signal, invalidate() {},
    }, { includeDefaultRoots: false, customSkillDirs: [root], watch: false })
    const cancellation = new AbortController()
    const discovery = provider.list({ signal: cancellation.signal })
    const rejected = expect(discovery).rejects.toThrow('stop discovery')
    try {
      await gate.started.promise
      cancellation.abort(new Error('stop discovery'))
      await rejected
      await provider.dispose()
      gate.release.resolve(undefined)
      await gate.completed.promise
      await new Promise<void>((resolve) => { setImmediate(resolve) })
      expect(watcherHarness.statCalls.filter(path => path.startsWith(root))).toHaveLength(1)
    } finally {
      gate.release.resolve(undefined)
      await provider.dispose()
    }
  })

  it.each(['watchReadyTimeoutMs', 'discoveryTimeoutMs'] as const)('rejects invalid %s timer bounds', async (field) => {
    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    for (const value of [0, -1, 0.5, 2_147_483_648, Infinity]) {
      expect(() => ctx.skills.registerProvider(control => new SkillFileSystem.FileSystemSkillProvider(ctx, control, {
        includeDefaultRoots: false, [field]: value,
      }))).toThrow(field)
    }
  })

  it('canonicalizes an existing root before opening its native watcher', async () => {
    const target = await tempDir('skill-watch-canonical-target')
    const aliasParent = await tempDir('skill-watch-canonical-alias')
    const alias = join(aliasParent, 'alias')
    await symlink(target, alias, process.platform === 'win32' ? 'junction' : 'dir')
    const root = join(alias, '.dsh/skills')
    await writeSkill(root, 'canonical-skill')
    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    const fiber = await ctx.plugin(SkillFileSystem, {
      dshHome: join(alias, '.dsh'),
      agentsHome: join(alias, '.agents'),
      watch: true,
    })

    expect((await ctx.skills.list()).map(skill => skill.name)).toEqual(['canonical-skill'])
    expect(watcherHarness.watchers[0]?.path).toBe(await realpath(root))
    expect(watcherHarness.watchers[0]?.options.persistent).toBe(true)
    await fiber.dispose()
  })

  it('preserves a symlink root when link following is disabled', async () => {
    const target = await tempDir('skill-watch-link-target')
    const aliasParent = await tempDir('skill-watch-link-alias')
    const alias = join(aliasParent, 'skills')
    await writeSkill(target, 'linked-skill')
    await symlink(target, alias, process.platform === 'win32' ? 'junction' : 'dir')
    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    const fiber = await ctx.plugin(SkillFileSystem, {
      includeDefaultRoots: false,
      customSkillDirs: [alias],
      watch: true,
      watchFollowSymlinks: false,
    })

    try {
      expect((await ctx.skills.list()).map(skill => skill.name)).toEqual(['linked-skill'])
      expect(watcherHarness.watchers[0]?.path).toBe(alias)
      expect(watcherHarness.watchers[0]?.options.followSymlinks).toBe(false)
    } finally {
      await fiber.dispose()
      await rm(aliasParent, { recursive: true, force: true })
      await rm(target, { recursive: true, force: true })
    }
  })

  it('ignores missing-path probes until the observed path actually changes', async () => {
    const home = await tempDir('skill-watch-missing-stable')
    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    const fiber = await ctx.plugin(SkillFileSystem, {
      dshHome: join(home, '.dsh'),
      agentsHome: join(home, '.agents'),
      watch: true,
      watchPollIntervalMs: 10,
    })
    expect(await ctx.skills.snapshot()).toEqual({ skills: [], complete: true })
    // One missing-path probe per absent user root: muse, dsh, and agents.
    expect(watcherHarness.watchFiles).toHaveLength(3)
    let invalidations = 0
    ctx.on('skills/change', () => { invalidations += 1 })

    for (const control of watcherHarness.watchFiles) {
      control.listener({} as Stats, {} as Stats)
    }
    await settle()

    expect(invalidations).toBe(0)
    expect(watcherHarness.watchFiles).toHaveLength(3)
    await fiber.dispose()
  })

  it('keeps skills loadable across persistent watcher startup failures without caching them', async () => {
    const home = await tempDir('skill-watch-start-error')
    const root = join(home, '.dsh/skills')
    await writeSkill(root, 'retry-skill')
    watcherHarness.startupErrors.push(
      new Error('watch failed once'),
      new Error('watch failed twice'),
      new Error('watch failed three times'),
    )
    watcherHarness.closeErrors = 1
    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    const fiber = await ctx.plugin(SkillFileSystem, {
      dshHome: join(home, '.dsh'),
      agentsHome: join(home, '.agents'),
      watch: true,
      watchUsePolling: true,
      watchFollowSymlinks: false,
      watchPollIntervalMs: 10,
      watchStabilityThresholdMs: 20,
    })

    expect(await ctx.skills.snapshot()).toMatchObject({
      skills: [{ name: 'retry-skill' }],
      complete: false,
    })
    expect((await ctx.skills.get('retry-skill'))?.content).toBe('Body.')
    expect(await ctx.skills.snapshot()).toMatchObject({
      skills: [{ name: 'retry-skill' }],
      complete: false,
    })
    expect(watcherHarness.watchers).toHaveLength(3)
    expect(watcherHarness.watchers[0]?.options).toMatchObject({
      atomic: true,
      depth: 1,
      followSymlinks: false,
      usePolling: true,
      interval: 10,
      awaitWriteFinish: {
        stabilityThreshold: 20,
        pollInterval: 10,
      },
    })

    await fiber.dispose()
  })

  it('filters events, coalesces invalidation, recovers runtime errors, and contains late callbacks', async () => {
    const home = await tempDir('skill-watch-runtime-error')
    const root = join(home, '.dsh/skills')
    await writeSkill(root, 'watched-skill')
    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    const fiber = await ctx.plugin(SkillFileSystem, {
      dshHome: join(home, '.dsh'),
      agentsHome: join(home, '.agents'),
      watch: true,
      watchPollIntervalMs: 10,
      watchStabilityThresholdMs: 20,
    })
    expect((await ctx.skills.list()).map(skill => skill.name)).toEqual(['watched-skill'])
    let invalidations = 0
    ctx.on('skills/change', () => { invalidations += 1 })
    const first = watcherHarness.watchers[0]
    if (first === undefined) throw new Error('expected a root watcher')

    first.emitter.emit('change', join(first.path, 'notes.txt'))
    first.emitter.emit('change', join(home, 'outside.md'))
    first.emitter.emit('change', join(first.path, 'watched-skill/references.md'))
    first.emitter.emit('change', join(first.path, '.system/SKILL.md'))
    await settle()
    expect(invalidations).toBe(0)

    first.emitter.emit('change', join(first.path, 'watched-skill/SKILL.md'))
    first.emitter.emit('change', join(first.path, 'watched-skill/SKILL.md'))
    await settle()
    expect(invalidations).toBe(1)

    watcherHarness.closeErrors = 1
    watcherHarness.startupErrors.push(new Error('runtime rewatch failed'))
    first.emitter.emit('error', new Error('runtime watch failed'))
    await vi.waitFor(() => { expect(watcherHarness.watchers.length).toBeGreaterThanOrEqual(2) })
    expect(invalidations).toBeGreaterThanOrEqual(2)
    expect(await ctx.skills.snapshot()).toMatchObject({
      skills: [{ name: 'watched-skill' }],
      complete: true,
    })

    await fiber.dispose()
    first.emitter.emit('change', join(first.path, 'watched-skill/SKILL.md'))
    first.emitter.emit('error', new Error('late error'))
    await settle()
  })

  it('replaces a retained watcher when its root emits unlinkDir', async () => {
    const home = await tempDir('skill-watch-root-unlink')
    const root = join(home, '.dsh/skills')
    await writeSkill(root, 'removed-skill')
    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    const fiber = await ctx.plugin(SkillFileSystem, {
      dshHome: join(home, '.dsh'),
      agentsHome: join(home, '.agents'),
      watch: true,
      watchPollIntervalMs: 10,
      watchStabilityThresholdMs: 20,
    })

    expect((await ctx.skills.list()).map(skill => skill.name)).toEqual(['removed-skill'])
    const original = watcherHarness.watchers[0]
    if (original === undefined) throw new Error('expected a root watcher')

    await rm(root, { recursive: true })
    original.emitter.emit('unlinkDir', original.path)
    await vi.waitFor(() => { expect(original.closeCalls).toBeGreaterThan(0) })
    await vi.waitFor(() => {
      expect(watcherHarness.watchFiles.some(control => control.path === original.path)).toBe(true)
    })

    await fiber.dispose()
  })

  it('re-probes a retained root after child unlink and observes immediate recreation', async () => {
    const home = await tempDir('skill-watch-root-reprobe')
    const root = join(home, '.dsh/skills')
    await writeSkill(root, 'old-skill')
    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    const fiber = await ctx.plugin(SkillFileSystem, {
      dshHome: join(home, '.dsh'),
      agentsHome: join(home, '.agents'),
      watch: true,
      watchPollIntervalMs: 10,
      watchStabilityThresholdMs: 20,
    })

    expect((await ctx.skills.list()).map(skill => skill.name)).toEqual(['old-skill'])
    const original = watcherHarness.watchers[0]
    if (original === undefined) throw new Error('expected a root watcher')

    await rm(root, { recursive: true })
    original.emitter.emit('unlink', join(original.path, 'old-skill/SKILL.md'))
    await settle()
    expect(await ctx.skills.snapshot()).toEqual({ skills: [], complete: true })

    const missingRoot = watcherHarness.watchFiles.find(control => control.path === original.path)
    expect(missingRoot).toBeDefined()
    await writeSkill(root, 'recreated-skill')
    missingRoot!.listener({} as Stats, {} as Stats)
    await vi.waitFor(() => { expect(watcherHarness.watchers).toHaveLength(2) })
    await settle()

    expect((await ctx.skills.list()).map(skill => skill.name)).toEqual(['recreated-skill'])
    await fiber.dispose()
  })

  it('settles an opening watcher when plugin disposal races its ready event', async () => {
    const home = await tempDir('skill-watch-opening-dispose')
    const root = join(home, '.dsh/skills')
    await writeSkill(root, 'racing-skill')
    watcherHarness.deferredReady = 1
    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    let provider!: InstanceType<typeof SkillFileSystem.FileSystemSkillProvider>
    const disposeProvider = ctx.skills.registerProvider((control) => {
      provider = new SkillFileSystem.FileSystemSkillProvider(ctx, control, {
        dshHome: join(home, '.dsh'),
        agentsHome: join(home, '.agents'),
        watch: true,
        watchPollIntervalMs: 10,
        watchStabilityThresholdMs: 20,
      })
      return provider
    })

    const discovery = provider.list({})
    await vi.waitFor(() => { expect(watcherHarness.watchers).toHaveLength(1) })
    const first = watcherHarness.watchers[0]
    if (first === undefined) throw new Error('expected an opening root watcher')
    const disposal = provider.dispose()

    await expect(discovery).rejects.toThrow('skill-filesystem watcher disposed')
    await disposal
    disposeProvider()
    await settle()
    expect(first.closeCalls).toBeGreaterThan(0)
  })

  it('closes an opening watcher when disposal wins the mode probe', async () => {
    const home = await tempDir('skill-watch-probe-dispose')
    const root = join(home, '.dsh/skills')
    await writeSkill(root, 'racing-skill')
    watcherHarness.deferredReady = 1
    const statGate: FakeStatGate = {
      started: Promise.withResolvers<undefined>(),
      release: Promise.withResolvers<undefined>(),
    }
    watcherHarness.statGates.push(statGate)
    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    let provider!: InstanceType<typeof SkillFileSystem.FileSystemSkillProvider>
    const disposeProvider = ctx.skills.registerProvider((control) => {
      provider = new SkillFileSystem.FileSystemSkillProvider(ctx, control, {
        dshHome: join(home, '.dsh'),
        agentsHome: join(home, '.agents'),
        watch: true,
        watchPollIntervalMs: 10,
        watchStabilityThresholdMs: 20,
      })
      return provider
    })

    const discovery = provider.list({})
    await statGate.started.promise
    const disposal = provider.dispose()
    statGate.release.resolve(undefined)

    await expect(discovery).rejects.toThrow('skill-filesystem watcher disposed')
    await disposal
    expect(watcherHarness.watchers).toHaveLength(1)
    expect(watcherHarness.watchers[0]?.closeCalls).toBeGreaterThan(0)
    disposeProvider()
  })

  it('contains an opening watcher rejection during provider teardown', async () => {
    const home = await tempDir('skill-watch-opening-reject')
    const root = join(home, '.dsh/skills')
    await writeSkill(root, 'rejected-skill')
    watcherHarness.deferredReady = 1
    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    let provider!: InstanceType<typeof SkillFileSystem.FileSystemSkillProvider>
    const disposeProvider = ctx.skills.registerProvider((control) => {
      provider = new SkillFileSystem.FileSystemSkillProvider(ctx, control, {
        dshHome: join(home, '.dsh'),
        agentsHome: join(home, '.agents'),
        watch: true,
        watchPollIntervalMs: 10,
        watchStabilityThresholdMs: 20,
      })
      return provider
    })

    const discovery = provider.list({})
    await vi.waitFor(() => { expect(watcherHarness.watchers).toHaveLength(1) })
    const first = watcherHarness.watchers[0]
    if (first === undefined) throw new Error('expected an opening root watcher')
    first.emitter.emit('error', new Error('opening failed during disposal'))
    const disposal = provider.dispose()

    await expect(discovery).rejects.toThrow('opening failed during disposal')
    await disposal
    disposeProvider()
  })
})
