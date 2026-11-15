/** Launch the Desktop profile through the Web application and report its URL to Electron. */

import { delimiter, join, sep } from 'node:path'
import { existsSync, mkdirSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import { composeEntries, loadLayeredEnv, loadOverlayPatches, loadProfileDirectory, reportSkippedBundles, type Profile } from '@deepseek-ai/dsh-app-boot'
import { bundledSkillDirectory, productSkillDirectory, desktopSkillDirectories } from './bundled-skills.ts'
import { bundledBridgeModules, verifyBundledImClient } from './bundled-bridge.ts'
import { feishuGateLayer, migrateFeishuProfileName } from './feishu-gate.ts'
import { randomUUID } from 'node:crypto'
import type { PluginOperationRunId } from '@deepseek-ai/dsh-plugin-manager/diagnostic'
import { formatFatalDiagnostic } from './fatal-diagnostic.ts'
import { runProfile } from '@deepseek-ai/dsh/profile-boot'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-deepseek-account'
import { dshHomePath, resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import * as desktopOffice from './office.ts'
import { readPrimaryRuntime, workspaceDependencyPaths } from '@deepseek-ai/dsh-tool-workspace-dependencies'
import { localDragResource } from './file-drag.ts'

import * as approvedEpisodeRender from './approved-episode-render.ts'
import { installDesktopUpdateTaskControl } from './update-tasks.ts'
import { shutdownDesktopHost } from './shutdown.ts'
import { installDesktopQuitInspection } from './quit-inspection.ts'
import { installPlatformSessionPublisher } from './platform-session.ts'
import { attentionSoundForEvent } from './attention-sound.ts'
import { installOfficeEngineResolution } from './office-engine.ts'
import { installOperationDiagnostics } from './operation-diagnostics.ts'
import { desktopDownloadEnvironment } from './download-runtime.ts'
import { installDesktopDouyinBrowser } from './douyin-browser.ts'
import { DESKTOP_HOST_PROTOCOL_VERSION, DESKTOP_HOST_SHUTDOWN_GRACE_MS } from './host-protocol.ts'
import { workspaceStorageLayer } from './workspace-storage-composition.ts'
import { generationLoopLayer } from './generation-loop-composition.ts'

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
  readonly moduleOverrides: Readonly<Record<string, string>>
}

async function desktopComposition(
  runtimeDir: string,
  projectDir: string,
  allowLinkedPackages: boolean,
): Promise<DesktopComposition> {
  const installAnchor = packageManifestPath(runtimeDir, '@deepseek-ai/dsh')
  verifyBundledImClient(runtimeDir, projectDir)
  await migrateFeishuProfileName(projectDir, resolveDshHome())
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
  const inheritedEntries = composeEntries(layers.slice(0, -1))
  const configuredSkillFilesystem = inheritedEntries.find(row => row.id === 'skill-filesystem')
  layers.push(workspaceStorageLayer(inheritedEntries, dshHomePath('storages')))
  layers.push(generationLoopLayer(composeEntries(layers)))
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
  const skillConfig: unknown = skillFilesystem.config ?? {}
  if (typeof skillConfig !== 'object' || skillConfig === null || Array.isArray(skillConfig)) {
    throw new Error('muse-med: skill-filesystem requires an object config')
  }
  layers.push([{
    id: 'skill-filesystem',
    config: {
      ...skillConfig,
      bundledSkillDir,
      customSkillDirs: desktopSkillDirectories(productSkillDir, userSkillDir, configuredSkillFilesystem?.config),
    },
  }])
  // Resolve bridge Config only after the setup service installs its startup hook.
  layers.push(feishuGateLayer([...rows.values()]))
  return { profile, patches: layers.slice(profile.layers.length + 1).flat(), moduleOverrides: { ...bundledBridgeModules(runtimeDir), 'muse-workspace-owned-storage': fileURLToPath(new URL('./workspace-owned-storage.js', import.meta.url)), 'ds-bot': fileURLToPath(new URL('./retired-bot.js', import.meta.url)), 'muse-bot': fileURLToPath(new URL('./retired-bot.js', import.meta.url)) } }
}

async function main(): Promise<void> {
  const runId = randomUUID() as PluginOperationRunId
  if (process.connected) process.send?.({ type: 'starting', runId }, (error) => { if (error !== null) console.error(error) })
  const args = process.argv.slice(2)
  const allowLinkedPackages = args.at(-1) === '--allow-linked-profile'
  if (allowLinkedPackages) args.pop()
  const [runtimeDir, projectDir, primaryRuntime, pnpm, nodeBin] = args
  if (runtimeDir === undefined || projectDir === undefined || args.length > 5
    || (pnpm === undefined) !== (nodeBin === undefined) || process.send === undefined) {
    throw new Error('muse-med: expected runtime and profile directories, optional primary runtime and paired package-manager paths, and Node IPC')
  }
  const primarySource = primaryRuntime ?? join(runtimeDir, '..', 'runtime', 'primary-runtime')
  process.env.MUSE_OCR_PYTHON_PATH = workspaceDependencyPaths(primarySource, await readPrimaryRuntime(primarySource)).python
  const downloadEnvironment = await desktopDownloadEnvironment(primarySource, process.env)
  process.env.MUSE_DOUYIN_PYTHON_PATH = downloadEnvironment.MUSE_DOUYIN_PYTHON_PATH
  for (const field of ['DSH_FFMPEG_PATH', 'DSH_FFPROBE_PATH']) {
    const value = downloadEnvironment[field]
    if (value === undefined) Reflect.deleteProperty(process.env, field)
    else process.env[field] = value
  }
  // The shipped driver runs in its own process; no PATH lookup or user installation is needed.
  process.env.MUSE_COMPUTER_USE_EXECUTABLE = join(primarySource, '..', 'cua', process.platform === 'win32' ? 'cua-driver.exe' : 'cua-driver')
  installOfficeEngineResolution(runtimeDir)
  const installAnchor = join(runtimeDir, 'package.json')
  const { profile, patches, moduleOverrides } = await desktopComposition(runtimeDir, projectDir, allowLinkedPackages)
  reportSkippedBundles('muse-med', profile)
  // JSON is YAML-compatible; inherited bundle rows remain owned by runProfile.
  const overlayPath = join(projectDir, 'desktop.product.patch.yml')
  writeFileSync(overlayPath, JSON.stringify(patches), { mode: 0o600 })
  const application = runProfile({
    environment: loadLayeredEnv('muse-med'),
    profile: 'desktop',
    shutdownTimeoutMs: DESKTOP_HOST_SHUTDOWN_GRACE_MS,
    resolvedProfile: { profile, installAnchor, moduleOverrides },
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
  const dragReads = new Map<number, AbortController>()
  const dragTasks = new Set<Promise<void>>()
  const control: {
    updateTasks?: ReturnType<typeof installDesktopUpdateTaskControl>
    quitInspection?: ReturnType<typeof installDesktopQuitInspection>
  } = {}
  const send = (message: object): Promise<void> => new Promise((resolve, reject) => {
    if (!process.connected || process.send === undefined) { resolve(); return }
    process.send(message, (error) => { if (error === null) resolve(); else reject(error) })
  })
  const stop = (): Promise<void> => stopping ??= (async () => {
    for (const abort of dragReads.values()) abort.abort()
    await Promise.allSettled(dragTasks)
    await shutdownDesktopHost(application, () => send({ type: 'shutdown-complete' }))
  })()
  process.on('message', (message: unknown) => {
    if (typeof message !== 'object' || message === null || !('type' in message)) return
    if (message.type === 'shutdown') { void stop(); return }
    if (message.type === 'file-drag-cancel') {
      if ('requestId' in message && typeof message.requestId === 'number') dragReads.get(message.requestId)?.abort()
      return
    }
    if (message.type === 'file-drag-resource') {
      if (!('requestId' in message) || typeof message.requestId !== 'number' || !Number.isSafeInteger(message.requestId)
        || !('address' in message) || typeof message.address !== 'string') return
      const { requestId, address } = message
      const abort = new AbortController()
      dragReads.set(requestId, abort)
      const task = (async () => {
        try {
          if (stopping !== undefined) throw new Error('Host stopping')
          const { ctx } = await application
          const resource = await localDragResource(ctx, address, abort.signal)
          await send({ type: 'file-drag-resource', requestId, resource })
        } catch (error) {
          if (!abort.signal.aborted) console.error(error)
          await send({ type: 'file-drag-resource', requestId, resource: null, error: 'File drag resource unavailable' })
        } finally { dragReads.delete(requestId) }
      })().catch((error: unknown) => { console.error(error) })
      dragTasks.add(task)
      void task.finally(() => { dragTasks.delete(task) })
      return
    }
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
  installOperationDiagnostics(ctx, record => send({ type: 'plugin-operation', record }), 32, runId)
  await ctx.plugin(approvedEpisodeRender, approvedEpisodeRender.Config.parse({ runtimeDir, allowLinkedProfile: allowLinkedPackages,
    endingAssetRoot: join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh-drama-skills', 'skills') })).await()
  control.updateTasks = installDesktopUpdateTaskControl(ctx)
  control.quitInspection = installDesktopQuitInspection(ctx)
  const forceDraftSubtitleVisual = process.env.MUSE_FORCE_SUBTITLE_VISUAL === '1'
  const productSubtitleVisual = process.env.MUSE_DEFAULT_SUBTITLE_VISUAL
  if (forceDraftSubtitleVisual && productSubtitleVisual === undefined) {
    throw new Error('Forced product subtitle visual is missing from the Desktop environment')
  }
  await ctx.plugin(desktopOffice, {
    runtimeDir,
    source: primarySource,
    root: join(resolveDshHome(), 'dsh-runtimes', 'dsh-primary-runtime'),
    docxReviewMode: 'advisory',
    ...(forceDraftSubtitleVisual && productSubtitleVisual !== undefined ? { jianyingDraft: {
      enforceSubtitleVisual: true,
      defaultSubtitleVisual: JSON.parse(productSubtitleVisual) as NonNullable<NonNullable<desktopOffice.Config['jianyingDraft']>['defaultSubtitleVisual']>,
      ...(process.env.MUSE_FONTS_DIR === undefined ? {} : { fontsDir: process.env.MUSE_FONTS_DIR }),
      ...(process.env.MUSE_SUBTITLE_FONT_FAMILY === undefined ? {} : { subtitleFontFamily: process.env.MUSE_SUBTITLE_FONT_FAMILY }),
    } } : {}),
  })
  installPlatformSessionPublisher(ctx, (session) => {
    if (process.connected) process.send?.({ type: 'platform-session', session })
  })
  const url = ctx.connection.authenticatedUrl(`${ctx.webServer.protocol}//127.0.0.1:${String(ctx.webServer.port)}`)
  if (process.connected) process.send({ type: 'ready', hostProtocolVersion: DESKTOP_HOST_PROTOCOL_VERSION, url, injections: ctx.webServer.collectIndexInjections(ctx.connection.browserPeer) }, (error) => { if (error !== null) console.error(error) })
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    // The shell receives the complete inspected error here, not through stderr:
    // stderr bytes and this IPC message race, and the shell reports the first
    // failure it sees.
    const diagnostic = formatFatalDiagnostic(error)
    if (process.connected) process.send?.({ type: 'fatal', message, diagnostic }, (error) => { if (error !== null) console.error(error) })
    console.error(error)
    process.exitCode = 1
    if (process.connected) {
      if (process.disconnect === undefined) throw new Error('desktop host: connected IPC has no disconnect method')
      process.disconnect()
    }
  })
}
