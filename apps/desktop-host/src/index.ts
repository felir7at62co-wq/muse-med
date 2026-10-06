/** Launch the Desktop profile through the Web application and report its URL to Electron. */

import { delimiter, join, sep } from 'node:path'
import { existsSync, mkdirSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { inspect } from 'node:util'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import { composeEntries, loadLayeredEnv, loadOverlayPatches, loadProfileDirectory, reportSkippedBundles, type Profile } from '@deepseek-ai/dsh-app-boot'
import { bundledSkillDirectory, productSkillDirectory } from './bundled-skills.ts'
import { feishuGateLayer } from './feishu-gate.ts'
import { runProfile } from '@deepseek-ai/dsh/profile-boot'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-deepseek-account'
import { dshHomePath, resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import * as desktopOffice from './office.ts'

import { installDesktopUpdateTaskControl } from './update-tasks.ts'
import { installDesktopQuitInspection } from './quit-inspection.ts'
import { installPlatformSessionPublisher } from './platform-session.ts'
import { attentionSoundForEvent } from './attention-sound.ts'
import { installOfficeEngineResolution } from './office-engine.ts'
import { desktopDownloadEnvironment } from './download-runtime.ts'
import { installDesktopDouyinBrowser } from './douyin-browser.ts'
import { DESKTOP_HOST_PROTOCOL_VERSION } from './host-protocol.ts'

const DESKTOP_PATCH = fileURLToPath(new URL('../config/desktop.cordis.patch.yml', import.meta.url))

function packageManifestPath(projectDir: string, packageName: string): string {
  const path = join(projectDir, 'node_modules', ...packageName.split('/'), 'package.json')
  if (!existsSync(path)) throw new Error(`muse-med: installed package ${JSON.stringify(packageName)} has no manifest`)
  return path
}

function isProjectPath(projectDir: string, target: string): boolean {
  const root = realpathSync(projectDir)
  const path = realpathSync(target)
  return path === root || path.startsWith(root + sep)
}

interface DesktopComposition {
  readonly profile: Profile
  readonly patches: PatchOptions[]
}

function desktopComposition(
  runtimeDir: string,
  projectDir: string,
  allowLinkedPackages: boolean,
): DesktopComposition {
  const installAnchor = packageManifestPath(runtimeDir, '@deepseek-ai/dsh')
  const profile = loadProfileDirectory('muse-med', projectDir, installAnchor)
  for (const layer of profile.layers) {
    if (!allowLinkedPackages && !isProjectPath(projectDir, layer.packageDir) && !isProjectPath(runtimeDir, layer.packageDir)) {
      throw new Error(`muse-med: profile bundle ${JSON.stringify(layer.packageName)} resolved outside the Desktop runtime and profile`)
    }
  }
  const layers = [
    ...profile.layers.map(layer => layer.patches),
    profile.patches,
    loadOverlayPatches('muse-med', DESKTOP_PATCH),
  ]
  const rows = new Map(composeEntries(layers).flatMap(row => typeof row.id === 'string' ? [[row.id, row] as const] : []))
  if (rows.get('agent-preset-registry') === undefined) {
    throw new Error('muse-med: profile has no agent-preset-registry row')
  }
  // Product row ids are distinct from disabled base rows; the registered preset ids stay unchanged.
  // An active preset-<id> declaration already supplied by the profile takes precedence.
  const presetRoot = fileURLToPath(new URL('../presets', import.meta.url))
  const shadowedPresets: string[] = []
  const productPresetRows = readdirSync(presetRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort()
    .flatMap((preset) => {
      const declared = rows.get(`preset-${preset}`)
      if (declared !== undefined && declared.disabled !== true) {
        shadowedPresets.push(preset)
        return []
      }
      return [{
        id: `muse-preset-${preset}`,
        name: '@deepseek-ai/dsh-desktop-host/native-preset',
        config: { id: preset, directory: join(presetRoot, preset) },
      }]
    })
  if (productPresetRows.length === 0) throw new Error('muse-med: no product preset row could be declared')
  if (shadowedPresets.length > 0) {
    console.warn(`muse-med: shipped presets shadow the packaged product presets: ${shadowedPresets.join(', ')}`)
  }
  layers.push([{ insert: productPresetRows }])
  const skillFilesystem = rows.get('skill-filesystem')
  if (skillFilesystem === undefined) throw new Error('muse-med: profile has no skill-filesystem row')
  const bundledSkillDir = bundledSkillDirectory(runtimeDir)
  const productSkillDir = productSkillDirectory(fileURLToPath(new URL('..', import.meta.url)))
  const userSkillDir = dshHomePath('skills')
  mkdirSync(userSkillDir, { recursive: true })
  layers.push([{
    id: 'skill-filesystem',
    config: {
      ...(skillFilesystem.config ?? {}) as Record<string, unknown>,
      bundledSkillDir,
      customSkillDirs: [productSkillDir, userSkillDir],
    },
  }])
  // Resolve bridge Config only after the setup service installs its startup hook.
  layers.push(feishuGateLayer([...rows.values()]))
  return { profile, patches: layers.slice(profile.layers.length + 1).flat() }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const allowLinkedPackages = args.at(-1) === '--allow-linked-profile'
  if (allowLinkedPackages) args.pop()
  const [runtimeDir, projectDir, primaryRuntime, pnpm, nodeBin] = args
  if (runtimeDir === undefined || projectDir === undefined || args.length > 5
    || (pnpm === undefined) !== (nodeBin === undefined) || process.send === undefined) {
    throw new Error('muse-med: expected runtime and profile directories, optional primary runtime and paired package-manager paths, and Node IPC')
  }
  const primarySource = primaryRuntime ?? join(runtimeDir, '..', 'runtime', 'primary-runtime')
  const downloadEnvironment = await desktopDownloadEnvironment(primarySource, process.env)
  process.env.MUSE_DOUYIN_PYTHON_PATH = downloadEnvironment.MUSE_DOUYIN_PYTHON_PATH
  for (const field of ['DSH_FFMPEG_PATH', 'DSH_FFPROBE_PATH']) {
    const value = downloadEnvironment[field]
    if (value === undefined) Reflect.deleteProperty(process.env, field)
    else process.env[field] = value
  }
  installOfficeEngineResolution(runtimeDir)
  const installAnchor = join(runtimeDir, 'package.json')
  const { profile, patches } = desktopComposition(runtimeDir, projectDir, allowLinkedPackages)
  reportSkippedBundles('muse-med', profile)
  // JSON is YAML-compatible; inherited bundle rows remain owned by runProfile.
  const overlayPath = join(projectDir, 'desktop.product.patch.yml')
  writeFileSync(overlayPath, JSON.stringify(patches), { mode: 0o600 })
  const application = runProfile({
    environment: loadLayeredEnv('muse-med'),
    profile: 'desktop',
    resolvedProfile: { profile, installAnchor },
    patchFiles: [overlayPath],
    args: ['--no-open', '--host', '127.0.0.1', '--port', '0'],
    ...(pnpm === undefined ? {} : {
      packageManager: {
        command: process.execPath,
        args: ['--expose-internals', pnpm],
        env: {
          ELECTRON_RUN_AS_NODE: '1',
          DSH_DESKTOP_NODE_EXECUTABLE: process.execPath,
          PATH: `${nodeBin ?? ''}${delimiter}${process.env.PATH ?? ''}`,
        },
      },
    }),
  })
  let stopping: Promise<void> | undefined
  const control: {
    updateTasks?: ReturnType<typeof installDesktopUpdateTaskControl>
    quitInspection?: ReturnType<typeof installDesktopQuitInspection>
  } = {}
  const send = (message: object): Promise<void> => new Promise((resolve, reject) => {
    if (!process.connected || process.send === undefined) { resolve(); return }
    process.send(message, (error) => { if (error === null) resolve(); else reject(error) })
  })
  const stop = (): Promise<void> => stopping ??= (async () => {
    // Startup failure is reported by main; shutdown only owns a tree that booted.
    const running = await application.catch(() => undefined)
    await running?.shutdown.shutdown(0)
    await send({ type: 'shutdown-complete' })
    if (process.connected) process.disconnect()
  })()
  process.on('message', (message: unknown) => {
    if (typeof message !== 'object' || message === null || !('type' in message)) return
    if (message.type === 'shutdown') { void stop(); return }
    if (message.type === 'quit-inspection') {
      if (!('requestId' in message) || !Number.isSafeInteger(message.requestId)) return
      const requestId = message.requestId
      void (async () => {
        try {
          if (stopping !== undefined || control.quitInspection === undefined) throw new Error('desktop quit: Host is unavailable')
          const inspection = await control.quitInspection()
          await send({ type: 'quit-inspection', requestId, ...inspection })
        } catch (error) {
          // The shell treats an unknown state as interruptible work and asks before quitting.
          await send({ type: 'quit-inspection', requestId, activeTasks: true, scheduledTasks: false,
            error: error instanceof Error ? error.message : String(error) })
        }
      })().catch((error: unknown) => { console.error(error) })
      return
    }
    if (message.type !== 'update-tasks' || !('requestId' in message) || !Number.isSafeInteger(message.requestId)
      || !('action' in message) || !['inspect', 'lock', 'unlock'].includes(String(message.action))) return
    void (async () => {
      try {
        if (stopping !== undefined || control.updateTasks === undefined) throw new Error('desktop update: Host is unavailable')
        const active = await control.updateTasks(message.action as 'inspect' | 'lock' | 'unlock')
        await send({ type: 'update-tasks', requestId: message.requestId, active })
      } catch (error) {
        await send({ type: 'update-tasks', requestId: message.requestId, active: true,
          error: error instanceof Error ? error.message : String(error) })
      }
    })().catch((error: unknown) => { console.error(error) })
  })
  process.once('disconnect', () => { void stop() })
  const { ctx } = await application
  installDesktopDouyinBrowser(ctx)
  ctx.on('session/event', (session, event) => {
    const kind = attentionSoundForEvent(session.header, event)
    if (kind !== undefined && process.connected) process.send?.({ type: 'attention-sound', kind })
  })
  control.updateTasks = installDesktopUpdateTaskControl(ctx)
  control.quitInspection = installDesktopQuitInspection(ctx)
  await ctx.plugin(desktopOffice, {
    runtimeDir,
    source: primarySource,
    root: join(resolveDshHome(), 'dsh-runtimes', 'dsh-primary-runtime'),
  })
  installPlatformSessionPublisher(ctx, (session) => {
    if (process.connected) process.send?.({ type: 'platform-session', session })
  })
  const url = ctx.connection.authenticatedUrl(`http://127.0.0.1:${String(ctx.webServer.port)}`)
  if (process.connected) process.send({ type: 'ready', hostProtocolVersion: DESKTOP_HOST_PROTOCOL_VERSION, url, injections: ctx.webServer.collectIndexInjections() }, (error) => { if (error !== null) console.error(error) })
}

/** Upper bound of the startup diagnostic carried over IPC; the head holds the message and stack. */
const MAX_FATAL_DIAGNOSTIC_CHARS = 64 * 1024

if (import.meta.main) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    // The shell receives the complete inspected error here, not through stderr:
    // stderr bytes and this IPC message race, and the shell reports the first
    // failure it sees.
    const diagnostic = inspect(error, { depth: 4, maxArrayLength: 50 }).slice(0, MAX_FATAL_DIAGNOSTIC_CHARS)
    if (process.connected) process.send?.({ type: 'fatal', message, diagnostic }, (error) => { if (error !== null) console.error(error) })
    console.error(error)
    process.exitCode = 1
    if (process.connected) process.disconnect()
  })
}
