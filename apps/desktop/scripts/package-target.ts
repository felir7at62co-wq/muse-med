/** Build one release target with matching Electron, Node.js, and dsh architecture. */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { join, resolve } from 'node:path'
import {
  desktopBuildRecordFilename,
  resolveDesktopAutoUpdateConfig,
} from './desktop-auto-update-environment.mjs'
import { desktopTargetBuildPaths } from './desktop-build-paths.mjs'
import { packageMacOSArtifacts, type DesktopPrepackagedArtifact } from './package-macos.ts'
import {
  assertCleanWorktree,
  assertReusableArtifacts,
  collectReusedArtifacts,
  describeReuse,
  describeSteps,
  desktopPackageSteps,
  readDesktopPackageBaseline,
  runDesktopPackageSteps,
  selectPackageSteps,
  type DesktopPackageRunStep,
  type DesktopPackageStep,
  type DesktopPackageStepId,
} from './package-steps.ts'

const APP_ROOT = resolve(import.meta.dirname, '..')
const REPOSITORY_ROOT = resolve(APP_ROOT, '..', '..')
const WINDOWS_SIGNING_ENV_PREFIX = 'DSH_DESKTOP_WINDOWS_'
const WINDOWS_SIGNING_ENV_NAMES = [
  'DSH_DESKTOP_WINDOWS_CER_FILE',
  'DSH_DESKTOP_WINDOWS_KEY_CONTAINER',
  'DSH_DESKTOP_WINDOWS_SIGNTOOL',
  'DSH_DESKTOP_WINDOWS_TOKEN_PIN',
] as const
const DESKTOP_UPLOAD_CREDENTIAL_ENV_NAMES = new Set([
  'DOWNLOAD_TEST_COS_SECRET_ID',
  'DOWNLOAD_TEST_COS_SECRET_KEY',
  'DOWNLOAD_PROD_COS_SECRET_ID',
  'DOWNLOAD_PROD_COS_SECRET_KEY',
])

/** Fixed platform and architecture identifiers exposed by package scripts. */
export type DesktopPackageTargetName = 'mac-arm64' | 'mac-x64' | 'win-x64'

/** One supported release target and its electron-builder selectors. */
export interface DesktopPackageTarget {
  readonly name: DesktopPackageTargetName
  readonly platform: 'darwin' | 'win32'
  readonly arch: 'arm64' | 'x64'
  readonly builderPlatform: '--mac' | '--win'
  readonly builderArch: '--arm64' | '--x64'
}

const TARGETS: Record<DesktopPackageTargetName, DesktopPackageTarget> = {
  'mac-arm64': {
    name: 'mac-arm64',
    platform: 'darwin',
    arch: 'arm64',
    builderPlatform: '--mac',
    builderArch: '--arm64',
  },
  'mac-x64': {
    name: 'mac-x64',
    platform: 'darwin',
    arch: 'x64',
    builderPlatform: '--mac',
    builderArch: '--x64',
  },
  'win-x64': {
    name: 'win-x64',
    platform: 'win32',
    arch: 'x64',
    builderPlatform: '--win',
    builderArch: '--x64',
  },
}

/**
 * Remove Windows signing configuration from package preparation subprocesses.
 * @param environment - Packaging command environment.
 * @returns A copy without Windows signing fields.
 */
export function withoutWindowsSigningEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(environment)
    .filter(([name]) => !name.startsWith(WINDOWS_SIGNING_ENV_PREFIX)))
}

/**
 * Select signing and NSIS-compatible archive filters for electron-builder.
 * @param environment - Target packaging environment.
 * @param unsigned - Whether to create a local unsigned Windows artifact.
 * @returns Packaging environment without certificate inputs for unsigned builds.
 */
export function desktopElectronBuilderEnvironment(environment: NodeJS.ProcessEnv, unsigned: boolean): NodeJS.ProcessEnv {
  const selected: NodeJS.ProcessEnv = { ...environment, DSH_DESKTOP_UNSIGNED: unsigned ? '1' : '0' }
  // The bundled NSIS decoder cannot extract 7-Zip's automatic ARM64-filtered entries.
  if (environment.DSH_DESKTOP_TARGET_PLATFORM === 'win32') selected.ELECTRON_BUILDER_7Z_FILTER = 'BCJ'
  if (!unsigned) return selected
  return {
    ...Object.fromEntries(Object.entries(withoutWindowsSigningEnvironment(selected))
      .filter(([name]) => !/^(?:WIN_)?CSC_/iu.test(name))),
    CSC_IDENTITY_AUTO_DISCOVERY: 'false',
    DSH_DESKTOP_UNSIGNED: '1',
  }
}

/**
 * Remove upload-only COS credentials from every packaging subprocess.
 * @param environment - Packaging command environment.
 * @returns A copy without Desktop upload credentials.
 */
export function withoutDesktopUploadCredentials(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(environment)
    .filter(([name]) => !DESKTOP_UPLOAD_CREDENTIAL_ENV_NAMES.has(name)))
}

function isTargetName(value: string): value is DesktopPackageTargetName {
  return Object.hasOwn(TARGETS, value)
}

function packageVersion(path: string, label: string): string {
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as { version?: unknown }
  if (typeof manifest.version !== 'string' || manifest.version === '') {
    throw new Error(`desktop package: ${label} has no version`)
  }
  return manifest.version
}

function writeReleaseRecord(
  target: DesktopPackageTarget,
  environment: NodeJS.ProcessEnv,
  artifactsRoot: string,
): void {
  const desktopVersion = packageVersion(join(APP_ROOT, 'package.json'), 'desktop package')
  const dshVersion = packageVersion(join(REPOSITORY_ROOT, 'package.json'), 'dsh package')
  if (desktopVersion !== dshVersion) {
    throw new Error(`desktop package: desktop version ${desktopVersion} does not match dsh version ${dshVersion}`)
  }
  const update = resolveDesktopAutoUpdateConfig(environment, target.platform, target.arch)
  const recordPath = join(artifactsRoot, desktopBuildRecordFilename(target.name))
  const temporaryPath = `${recordPath}.tmp`
  writeFileSync(temporaryPath, `${JSON.stringify({
    schemaVersion: 1,
    target: target.name,
    version: dshVersion,
    environment: update.environment,
    publicUrl: update.publicUrl,
  }, null, 2)}\n`)
  renameSync(temporaryPath, recordPath)
}

/**
 * Resolve a named release target and reject hosts that cannot execute its packaged runtime.
 * @param name - One of the fixed Desktop release target names.
 * @param hostPlatform - Build-host Node.js platform.
 * @param hostArch - Build-host Node.js architecture.
 * @returns The target selectors shared by runtime preparation and electron-builder.
 */
export function resolveDesktopPackageTarget(
  name: string,
  hostPlatform: NodeJS.Platform = process.platform,
  hostArch: string = process.arch,
): DesktopPackageTarget {
  if (!isTargetName(name)) {
    throw new Error(`desktop package: unsupported target ${JSON.stringify(name)}; expected ${Object.keys(TARGETS).join(', ')}`)
  }
  const target = TARGETS[name]
  if (target.platform === 'win32' && (hostPlatform !== 'win32' || hostArch !== 'x64')) {
    throw new Error('desktop package: win-x64 requires a Windows x64 build host')
  }
  if (target.platform === 'darwin' && hostPlatform !== 'darwin') {
    throw new Error(`desktop package: ${name} requires a macOS build host`)
  }
  if (name === 'mac-arm64' && hostArch !== 'arm64') {
    throw new Error('desktop package: mac-arm64 requires an Apple Silicon build host')
  }
  if (name === 'mac-x64' && hostArch !== 'arm64' && hostArch !== 'x64') {
    throw new Error('desktop package: mac-x64 requires an Intel Mac or Apple Silicon with Rosetta')
  }
  return target
}

interface DesktopPackageInvocation {
  readonly target: DesktopPackageTarget
  readonly directory: boolean
  readonly prepareOnly: boolean
  readonly unsigned: boolean
  readonly withBgm: boolean
  /** First step to run, or undefined to start at S1. */
  readonly from: string | undefined
  /** The only step to run, or undefined to run through to the end. */
  readonly only: string | undefined
  /** Whether to print the step table instead of packaging. */
  readonly listSteps: boolean
  /** Whether to name every reused artifact instead of a sample. */
  readonly listReuse: boolean
  /** Whether to print usage instead of packaging. */
  readonly help: boolean
}

function hostTargetName(platform: NodeJS.Platform, arch: string): DesktopPackageTargetName {
  const name = `${platform === 'darwin' ? 'mac' : platform === 'win32' ? 'win' : platform}-${arch}`
  if (!isTargetName(name)) throw new Error(`desktop package: unsupported build host ${platform}-${arch}`)
  return name
}

/**
 * Parse the fixed-target packaging command line.
 * @param argv - Arguments after the script entry point.
 * @param hostPlatform - Build-host Node.js platform.
 * @param hostArch - Build-host Node.js architecture.
 * @returns The validated target and the requested output flags.
 */
export function parseDesktopPackageInvocation(
  argv: readonly string[],
  hostPlatform: NodeJS.Platform = process.platform,
  hostArch: string = process.arch,
): DesktopPackageInvocation {
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      dir: { type: 'boolean', default: false },
      'prepare-only': { type: 'boolean', default: false },
      unsigned: { type: 'boolean', default: false },
      'with-bgm': { type: 'boolean', default: false },
      from: { type: 'string' },
      only: { type: 'string' },
      'list-steps': { type: 'boolean', default: false },
      'list-reuse': { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  })
  if (positionals.length > 1) throw new Error('desktop package: expected at most one target')
  const name = positionals[0] ?? hostTargetName(hostPlatform, hostArch)
  if (values.unsigned && name !== 'win-x64') throw new Error('desktop package: --unsigned requires win-x64')
  if (values.unsigned && values['prepare-only']) throw new Error('desktop package: --unsigned cannot use --prepare-only')
  if (values['with-bgm'] && name !== 'win-x64') throw new Error('desktop package: --with-bgm requires win-x64')
  return {
    target: resolveDesktopPackageTarget(name, hostPlatform, hostArch),
    directory: values.dir,
    prepareOnly: values['prepare-only'],
    unsigned: values.unsigned,
    withBgm: values['with-bgm'],
    from: values.from,
    only: values.only,
    listSteps: values['list-steps'],
    listReuse: values['list-reuse'],
    help: values.help,
  }
}

/**
 * Build the electron-builder command arguments for one validated target.
 * @param target - Supported release target.
 * @param directory - Whether to stop at an unpacked application directory.
 * @param artifact - Optional single artifact built from an existing signed application.
 * @returns Arguments that keep publishing under the separate validated upload command.
 */
export function desktopElectronBuilderArguments(
  target: DesktopPackageTarget,
  directory: boolean,
  artifact?: DesktopPrepackagedArtifact,
): readonly string[] {
  return [
    'exec',
    'electron-builder',
    '--config',
    'electron-builder.config.mjs',
    target.builderPlatform,
    ...(artifact === undefined ? [] : [artifact.format]),
    target.builderArch,
    '--publish',
    'never',
    ...(directory ? ['--dir'] : []),
    ...(artifact === undefined ? [] : [
      ...(target.platform === 'darwin' ? ['--config.mac.notarize=false'] : []),
      '--prepackaged', artifact.appPath,
      '--config.directories.output', artifact.output,
    ]),
  ]
}

/**
 * Build the media-runtime preparation arguments for one validated target.
 *
 * Naming the emotion-model cache is what adds that runtime to the payload, so only
 * an explicit opt-in may pass it: the shipped combination is the payload without it.
 * @param target - Supported release target.
 * @param paths - Target runtime directory and the shared download cache.
 * @param withBgm - Whether this invocation explicitly requests the emotion runtime.
 * @returns Arguments for the media preparation step, absent for targets that have none.
 */
export function desktopPrepareMediaRuntimeArguments(
  target: DesktopPackageTarget,
  paths: { readonly runtime: string; readonly downloads: string },
  withBgm: boolean,
): readonly string[] | undefined {
  if (target.platform !== 'win32' || target.arch !== 'x64') return undefined
  return [
    'exec',
    'tsx',
    'apps/desktop/scripts/prepare-media-runtime.ts',
    '--output', join(paths.runtime, 'media'),
    '--cache', join(paths.downloads, 'media'),
    ...(withBgm ? ['--bgm-cache', join(paths.downloads, 'bgm')] : []),
  ]
}

/**
 * Name the emotion-runtime inputs a BGM opt-in still needs.
 * @param lockPath - The emotion-runtime lock beside this script.
 * @param cachePath - The emotion-model download cache the media step would read.
 * @returns The absent paths, empty when the opt-in can proceed.
 */
export function missingBgmRuntimeInputs(lockPath: string, cachePath: string): readonly string[] {
  return [lockPath, cachePath].filter(candidate => !existsSync(candidate))
}

function runPnpm(
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = APP_ROOT,
): Promise<void> {
  const pnpmEntry = process.env.npm_execpath
  if (pnpmEntry === undefined || pnpmEntry === '') {
    throw new Error('desktop package: invoke this script through a pnpm package command')
  }
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [pnpmEntry, ...args], {
      cwd,
      env,
      stdio: 'inherit',
    })
    child.once('error', reject)
    child.once('close', (code, signal) => {
      if (code === 0) resolvePromise()
      else reject(new Error(`desktop package: pnpm ${args.join(' ')} exited with ${String(code ?? signal)}`))
    })
  })
}

/**
 * Render the packaging command's usage, including the step and artifact table.
 * @param steps - the pipeline's steps for the selected target.
 * @returns The usage text.
 */
function describeUsage(steps: readonly DesktopPackageStep[]): string {
  return [
    'usage: pnpm run package:desktop[:<target>] [<target>] [--dir] [--prepare-only] [--unsigned] [--with-bgm]',
    '                                          [--from <S#>] [--only <S#>] [--list-reuse] [--list-steps]',
    '',
    'Packaging reads the working tree, so a run refuses to start unless the worktree is',
    'clean apart from .pi-glla, re-checks HEAD before every step, and refuses to reuse an',
    'artifact older than the commit it packages.',
    '',
    'steps, in execution order, with the paths each produces:',
    ...describeSteps(steps),
    '',
    'resuming:',
    '  --from <S#>   run that step through the end, reusing every earlier step\'s artifacts',
    '                (each must exist and be newer than HEAD\'s commit)',
    '  --only <S#>   run exactly that step',
    '  --list-reuse  name every reused file instead of the first and last few',
    '  --list-steps  print this table and exit without packaging',
  ].join('\n')
}

async function main(): Promise<void> {
  const invocation = parseDesktopPackageInvocation(process.argv.slice(2))
  const { target } = invocation
  const buildPaths = desktopTargetBuildPaths(target.name)
  const steps = desktopPackageSteps(REPOSITORY_ROOT, target.name, invocation.unsigned)
  if (invocation.help || invocation.listSteps) {
    console.log(describeUsage(steps))
    return
  }
  const selection = selectPackageSteps(steps, invocation.from, invocation.only)
  // S13 is the last step, so `--prepare-only` stops the run one step earlier.
  const lastStepIndex = steps.length - 1
  if (invocation.prepareOnly && selection.first >= lastStepIndex) {
    throw new Error(`desktop package: --prepare-only stops before ${steps[lastStepIndex]?.id ?? 'the last step'}`)
  }
  const last = invocation.prepareOnly ? Math.min(selection.last, lastStepIndex) : selection.last
  if (invocation.withBgm) {
    const missing = missingBgmRuntimeInputs(
      join(APP_ROOT, 'scripts', 'bgm-runtime.lock.json'),
      join(buildPaths.downloads, 'bgm'),
    )
    if (missing.length > 0) throw new Error(`desktop package: --with-bgm requires ${missing.join(' and ')}`)
  }
  const releaseRecordPath = join(buildPaths.artifacts, desktopBuildRecordFilename(target.name))
  if (!invocation.prepareOnly && !invocation.unsigned) {
    rmSync(releaseRecordPath, { force: true })
    rmSync(`${releaseRecordPath}.tmp`, { force: true })
  }
  const buildEnv = withoutWindowsSigningEnvironment(withoutDesktopUploadCredentials(process.env))
  const targetEnv: NodeJS.ProcessEnv = {
    ...buildEnv,
    DSH_DESKTOP_TARGET_PLATFORM: target.platform,
    DSH_DESKTOP_TARGET_ARCH: target.arch,
  }
  const electronBuilderEnv = desktopElectronBuilderEnvironment(targetEnv, invocation.unsigned)
  for (const name of WINDOWS_SIGNING_ENV_NAMES) {
    if (!invocation.unsigned && process.env[name] !== undefined) electronBuilderEnv[name] = process.env[name]
  }
  const baseline = readDesktopPackageBaseline(REPOSITORY_ROOT)
  assertCleanWorktree(baseline)
  if (selection.first > 0) {
    const inventory = collectReusedArtifacts(REPOSITORY_ROOT, steps, selection.first, baseline)
    for (const line of describeReuse(inventory, invocation.listReuse)) console.log(line)
    assertReusableArtifacts(inventory, baseline)
  }
  const bodies: Record<DesktopPackageStepId, () => Promise<void>> = {
    S1: async () => { await runPnpm(['run', 'build:official'], buildEnv, REPOSITORY_ROOT) },
    S2: async () => { await runPnpm(['run', 'release:pack', '--family', 'dsh', '--out', buildPaths.packedDsh], buildEnv, REPOSITORY_ROOT) },
    S3: async () => {
      await runPnpm([
        '--dir',
        'apps/desktop-host',
        'pack',
        '--pack-destination',
        buildPaths.packedDsh,
      ], buildEnv, REPOSITORY_ROOT)
    },
    S4: async () => {
      await runPnpm([
        '--dir', 'packages/drama/skills', 'pack', '--pack-destination', buildPaths.packedDsh,
      ], buildEnv, REPOSITORY_ROOT)
    },
    S5: async () => {
      await runPnpm([
        '--dir', 'packages/perception/perception-bgm', 'pack', '--pack-destination', buildPaths.packedDsh,
      ], buildEnv, REPOSITORY_ROOT)
    },
    S6: async () => { await runPnpm(['exec', 'node', 'third_party/plugins/build.mjs', '--out', buildPaths.packedDsh], buildEnv, REPOSITORY_ROOT) },
    S7: async () => { await runPnpm(['run', 'release:pack', '--family', 'vendor', '--out', buildPaths.packedVendor], buildEnv, REPOSITORY_ROOT) },
    S8: async () => { await runPnpm(['--dir', 'native/system', 'run', 'build:ts'], buildEnv, REPOSITORY_ROOT) },
    S9: async () => {
      rmSync(buildPaths.packedLandlock, { recursive: true, force: true })
      mkdirSync(buildPaths.packedLandlock, { recursive: true })
      await runPnpm([
        '--dir',
        'native/system/packages/entry',
        'pack',
        '--pack-destination',
        buildPaths.packedLandlock,
      ], buildEnv, REPOSITORY_ROOT)
    },
    S10: async () => {
      await runPnpm(['run', 'prepare:runtime'], targetEnv)
      const mediaArguments = desktopPrepareMediaRuntimeArguments(target, buildPaths, invocation.withBgm)
      if (mediaArguments !== undefined) {
        await runPnpm(mediaArguments, buildEnv, REPOSITORY_ROOT)
      }
    },
    S11: async () => { await runPnpm(['run', 'prepare:packages'], targetEnv) },
    S12: async () => { await runPnpm(['run', 'prepare:dsh'], targetEnv) },
    S13: async () => {
      if (target.platform === 'darwin' && !invocation.directory) {
        await runPnpm([
          ...desktopElectronBuilderArguments(target, true),
          '--config.mac.notarize=false',
        ], electronBuilderEnv)
        await packageMacOSArtifacts({
          arch: target.arch,
          version: packageVersion(join(APP_ROOT, 'package.json'), 'desktop package'),
          artifactsRoot: buildPaths.artifacts,
          environment: electronBuilderEnv,
        }, artifact => runPnpm(desktopElectronBuilderArguments(target, false, artifact), electronBuilderEnv))
      } else {
        await runPnpm(desktopElectronBuilderArguments(target, invocation.directory), electronBuilderEnv)
      }
      if (!invocation.directory && !invocation.unsigned) writeReleaseRecord(target, electronBuilderEnv, buildPaths.artifacts)
    },
  }
  const runSteps: readonly DesktopPackageRunStep[] = steps.map(step => ({ ...step, run: bodies[step.id] }))
  await runDesktopPackageSteps({
    root: REPOSITORY_ROOT,
    steps: runSteps,
    selection: { first: selection.first, last },
    baseline,
    log: line => console.log(line),
  })
}

if (process.argv[1] !== undefined && import.meta.filename === resolve(process.argv[1])) await main()
