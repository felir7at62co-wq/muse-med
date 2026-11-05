/** Preserve product bundle upgrades before the shared Host plugin manager loads an existing profile. */
import { copyFileSync, existsSync, fsyncSync, openSync, closeSync, readFileSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { DESKTOP_FEISHU_PACKAGE, DESKTOP_CODEX_PACKAGE } from './core-package-set.ts'
import { disableRetiredBotProfilePatch, disableRetiredSubscriptionProfilePatch, isRetiredBotBundle } from './retired-bot-profile.ts'

interface DesktopProjectManifest {
  readonly name: string
  readonly private: true
  readonly version: string
  readonly dependencies: Record<string, string>
  readonly dsh: {
    readonly profile: {
      readonly bundles: string[]
    }
  }
}

/** Product bundles for fresh profiles and native recovery; archived Bot packages are excluded. */
export const DESKTOP_PROFILE_BUNDLES = [
  '@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app',
  'dsh-ffmpeg', '@wenbin_wb/dsh-bridge',
  '@deepseek-ai/dsh-feishu-settings', 'dsh-skill-mcp-panel', '@deepseek-ai/dsh-desktop-host', 'muse-hongguo-search',
  DESKTOP_FEISHU_PACKAGE,
  DESKTOP_CODEX_PACKAGE,
  'muse-skill-evolution',
] as const
const BUILT_IN_BUNDLE_LIST: readonly string[] = DESKTOP_PROFILE_BUNDLES
const RETIRED_FEISHU_PACKAGE = '@dsh-feishu/dsh-feishu'
const RETIRED_CODEX_PACKAGE = 'dsh-codex-subscription'
const PROJECT_NAME = '@deepseek-ai/dsh-desktop-runtime'
const PACKAGE_NAME_PATTERN = /^(?:@[a-z0-9][a-z0-9._~-]*\/[a-z0-9][a-z0-9._~-]*|[a-z0-9][a-z0-9._~-]*)$/u

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, undefined, 2)}\n`, { mode: 0o600 })
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function assertPackageName(name: string): void {
  if (!PACKAGE_NAME_PATTERN.test(name)) throw new Error(`desktop project: invalid npm package name ${JSON.stringify(name)}`)
}

function projectManifest(projectDir: string): DesktopProjectManifest {
  const path = join(projectDir, 'package.json')
  const value = readJson(path)
  const dsh = isRecord(value) && isRecord(value.dsh) ? value.dsh : undefined
  const profile = isRecord(dsh?.profile) ? dsh.profile : undefined
  if (!isRecord(value) || value.name !== PROJECT_NAME && value.name !== 'dsh-profile-desktop' || value.private !== true
    || value.version !== undefined && typeof value.version !== 'string' || (value.dependencies !== undefined && !isRecord(value.dependencies))
    || !Array.isArray(profile?.bundles) || !profile.bundles.every(bundle => typeof bundle === 'string')) {
    throw new Error(`desktop project: invalid desktop profile manifest ${path}`)
  }
  const dependencies: Record<string, string> = {}
  for (const [name, version] of Object.entries(value.dependencies ?? {})) {
    if (!PACKAGE_NAME_PATTERN.test(name) || typeof version !== 'string' || version.trim() === '') {
      throw new Error('desktop project: plugin dependencies must use nonempty package specs')
    }
    dependencies[name] = version
  }
  return { ...value, name: value.name, private: true, version: typeof value.version === 'string' ? value.version : '0.0.0', dependencies,
    dsh: { ...dsh, profile: { ...profile, bundles: profile.bundles } } }
}

function pendingBuiltInBundles(stored: readonly string[]): readonly string[] | undefined {
  const legacyCodexPosition = stored.indexOf(DESKTOP_CODEX_PACKAGE)
  const normalized = legacyCodexPosition >= 0 && legacyCodexPosition < DESKTOP_PROFILE_BUNDLES.indexOf(DESKTOP_CODEX_PACKAGE)
    ? stored.filter(bundle => bundle !== DESKTOP_CODEX_PACKAGE) : stored
  const missingAt = DESKTOP_PROFILE_BUNDLES.findIndex((bundle, index) => normalized[index] !== bundle)
  if (missingAt === -1) return undefined
  const tail = normalized.slice(missingAt)
  const promoted = new Set<string>([DESKTOP_FEISHU_PACKAGE, DESKTOP_CODEX_PACKAGE, 'muse-skill-evolution'])
  if ([...promoted].some(bundle => tail.filter(candidate => candidate === bundle).length > 1)) {
    throw new Error('desktop project: profile bundle list contains a duplicate package')
  }
  const plugins = tail.filter(bundle => !promoted.has(bundle))
  if (plugins.some(bundle => BUILT_IN_BUNDLE_LIST.includes(bundle))) {
    throw new Error('desktop project: profile must begin with the built-in desktop bundle list')
  }
  return plugins
}

function backupProfileManifest(projectDir: string): void {
  const path = join(projectDir, 'package.json')
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:]/gu, '').replace('T', '-')
  const descriptor = openSync(`${path}.${stamp}-${randomUUID()}.bak`, 'wx', 0o600)
  try { writeFileSync(descriptor, readFileSync(path)); fsyncSync(descriptor) }
  finally { closeSync(descriptor) }
}

function profilePluginNames(projectDir: string): readonly string[] {
  const manifest = projectManifest(projectDir)
  const retired = manifest.dsh.profile.bundles.includes('@moyu-good/dsh-lark-bridge')
  const retiredPonytail = manifest.dsh.profile.bundles.includes('@mengyuly/dsh-ponytail')
  const retiredFeishu = manifest.dsh.profile.bundles.includes(RETIRED_FEISHU_PACKAGE)
  const retiredBot = manifest.dsh.profile.bundles.some(isRetiredBotBundle)
  const retiredCodex = manifest.dsh.profile.bundles.includes(RETIRED_CODEX_PACKAGE)
    || Object.hasOwn(manifest.dependencies, RETIRED_CODEX_PACKAGE)
  if (new Set(manifest.dsh.profile.bundles).size !== manifest.dsh.profile.bundles.length) {
    throw new Error('desktop project: profile bundle list contains a duplicate package')
  }
  const normalized = manifest.dsh.profile.bundles
    .filter(bundle => bundle !== '@mengyuly/dsh-ponytail' && bundle !== RETIRED_FEISHU_PACKAGE
      && bundle !== RETIRED_CODEX_PACKAGE && !isRetiredBotBundle(bundle))
    .map(bundle => bundle === '@moyu-good/dsh-lark-bridge' ? '@wenbin_wb/dsh-bridge' : bundle)
  const pending = pendingBuiltInBundles(normalized)
  const bundles = pending === undefined ? normalized : [...DESKTOP_PROFILE_BUNDLES, ...pending]
  if (new Set(bundles).size !== bundles.length) {
    throw new Error('desktop project: profile bundle list contains a duplicate package')
  }
  const plugins = bundles.slice(DESKTOP_PROFILE_BUNDLES.length)
  for (const plugin of plugins) assertPackageName(plugin)
  disableRetiredBotProfilePatch(projectDir)
  disableRetiredSubscriptionProfilePatch(projectDir)
  if (pending !== undefined || retired || retiredPonytail || retiredFeishu || retiredBot || retiredCodex) {
    backupProfileManifest(projectDir)
    if (retired) {
      const patchPath = join(projectDir, 'cordis.patch.yml')
      const oldPatch = existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : ''
      if (existsSync(patchPath)) copyFileSync(patchPath, `${patchPath}.${String(Date.now())}.bak`)
      writeFileSync(patchPath, `${oldPatch.trimEnd()}\n\n- id: feishu\n  config:\n    enabled: false\n- id: feishu-channel\n  name: '@xmanrui/dsh-im'\n  disabled: false\n`, { mode: 0o600 })
    }
    writeJson(join(projectDir, 'package.json'), {
      ...manifest,
      dependencies: Object.fromEntries(Object.entries(manifest.dependencies).filter(([name]) => name !== RETIRED_CODEX_PACKAGE)),
      dsh: { ...manifest.dsh, profile: { ...manifest.dsh.profile, bundles } },
    } satisfies DesktopProjectManifest)
  }
  return plugins
}

/**
 * Normalize recognized product bundles, removing the retired subscription dependency while retaining unrelated plugins and data files.
 * @param projectDir Initialized reserved Desktop profile; caller owns shutdown and the profile lock.
 * @returns Nothing; changed manifests and Bot patches receive private exact-content backups first.
 */
export function migrateDesktopProductProfile(projectDir: string): void { profilePluginNames(projectDir) }
