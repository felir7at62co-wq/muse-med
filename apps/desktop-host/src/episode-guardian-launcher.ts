/** Ordinary shipped dsh carrier, fresh private profile, no Host Job. */
import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtemp, chmod, readFile, writeFile, mkdir, realpath, access } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import { initProfile, resolveProfileDir } from '@deepseek-ai/dsh-app-boot'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import type { ExecutionIdentity } from './episode-guardian-fence.ts'
import { collectGuardianReply, collectGuardianDiagnostic } from './episode-guardian-protocol.ts'
import type { GuardianParsers, GuardianRequest, GuardianReply } from './episode-guardian-protocol.ts'

const PROFILE_NAME = 'desktop-episode-render-worker'

/** Production paths originate from Host main's validated Desktop runtime arguments. */
export interface CapturedDesktopCarrier {
  readonly kind: 'desktop-runtime' | 'linked-desktop-development'
  readonly runtimeDir: string
  readonly executable: string
  readonly packageRoots: { readonly host: string; readonly cli: string; readonly subprocess: string }
}

/** Explicit test-only source launch; it is never a missing-lib fallback. */
export interface SourceDshFixture {
  readonly kind: 'source-fixture'
  readonly executable: string
  readonly cli: string
  readonly tsxEsm: string
  readonly tsconfig: string
  readonly subprocessEntry: string
  readonly workerEntry: string
}

/** Keep only OS facts and private child homes.
 * @param workerHome - Newly created private Harness home.
 * @param platform - OS environment-name semantics.
 * @returns An explicit child environment without inherited Harness selectors. */
export function guardianEnvironment(workerHome: string, platform: NodeJS.Platform): NodeJS.ProcessEnv {
  const scrubbed = scrubbedParentEnv()
  const result: NodeJS.ProcessEnv = {}
  const essentials = new Map([
    ['PATH', 'PATH'], ['HOME', 'HOME'], ['LANG', 'LANG'], ['TMPDIR', 'TMPDIR'],
    ['TEMP', 'TEMP'], ['TMP', 'TMP'], ['USERPROFILE', 'USERPROFILE'],
    ['SYSTEMROOT', 'SystemRoot'], ['WINDIR', 'WINDIR'], ['COMSPEC', 'ComSpec'],
  ])
  for (const [key, value] of Object.entries(scrubbed)) {
    const upper = key.toUpperCase()
    const canonical = essentials.get(upper) ?? (/^LC_[A-Z0-9_]+$/u.test(upper) ? upper : undefined)
    if (canonical === undefined) continue
    // Ambiguous alternate-case duplicates fail, rather than depend on enumeration order.
    if (result[canonical] !== undefined && result[canonical] !== value) {
      throw new Error(`episode guardian: conflicting environment name ${canonical}`)
    }
    if (platform !== 'win32' && key !== upper && upper !== 'SYSTEMROOT' && upper !== 'COMSPEC') continue
    result[canonical] = value
  }
  return { ...result, ELECTRON_RUN_AS_NODE: '1', MUSE_HOME: workerHome, DSH_HOME: workerHome,
    DSH_TELEMETRY_DISABLED: '1', XDG_CONFIG_HOME: join(workerHome, 'config'),
    XDG_CACHE_HOME: join(workerHome, 'cache'), XDG_STATE_HOME: join(workerHome, 'state') }
}

function inside(root: string, target: string): boolean {
  const child = relative(root, target)
  return child === '' || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child))
}

async function readDesktopEntrySet(runtimeDir: string): Promise<{
  runtime: string
  packageRoots: CapturedDesktopCarrier['packageRoots']
  entries: { cli: string; subprocess: string; worker: string }
}> {
  const runtime = await realpath(runtimeDir)
  const host = join(runtime, 'node_modules', '@deepseek-ai', 'dsh-desktop-host')
  const cliPackage = join(runtime, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
  const hostManifestPath = join(host, 'package.json')
  const manifest = z.looseObject({ name: z.string(), version: z.string().min(1) })
  const hostManifest = manifest.parse(JSON.parse(await readFile(hostManifestPath, 'utf8')))
  const cliManifest = manifest.parse(JSON.parse(await readFile(cliPackage, 'utf8')))
  if (hostManifest.name !== '@deepseek-ai/dsh-desktop-host' || cliManifest.name !== '@deepseek-ai/dsh'
    || hostManifest.version !== cliManifest.version) {
    throw new Error('episode guardian: Desktop Host and CLI package identity mismatch')
  }
  const owner = createRequire(hostManifestPath)
  const subprocessManifestPath = owner.resolve('@deepseek-ai/dsh-subprocess-local/package.json')
  const subprocessManifest = manifest.parse(JSON.parse(await readFile(subprocessManifestPath, 'utf8')))
  if (subprocessManifest.name !== '@deepseek-ai/dsh-subprocess-local' || subprocessManifest.version !== cliManifest.version) {
    throw new Error('episode guardian: subprocess package identity mismatch')
  }
  const entries = { cli: join(host, 'lib', 'cli.js'), worker: join(host, 'lib', 'episode-render-worker.js'),
    subprocess: owner.resolve('@deepseek-ai/dsh-subprocess-local') }
  const packageRoots = { host: await realpath(host), cli: await realpath(dirname(cliPackage)),
    subprocess: await realpath(dirname(subprocessManifestPath)) }
  for (const [entry, packageRoot] of [[entries.cli, packageRoots.host], [entries.worker, packageRoots.host],
    [entries.subprocess, packageRoots.subprocess]] as const) {
    if (!inside(packageRoot, await realpath(entry))) throw new Error('episode guardian: entry escaped its captured package')
    await access(entry)
  }
  return { runtime, packageRoots, entries }
}

/** Capture only at trusted Host startup, never from RPC or Settings.
 * @param runtimeDir - Validated Desktop runtime directory.
 * @param allowLinkedProfile - Trusted development carrier selection.
 * @returns Exact package roots and the current Node carrier. */
export async function captureDesktopCarrier(runtimeDir: string, allowLinkedProfile: boolean): Promise<CapturedDesktopCarrier> {
  const captured = await readDesktopEntrySet(runtimeDir)
  if (!allowLinkedProfile && Object.values(captured.packageRoots).some(root => !inside(captured.runtime, root))) {
    throw new Error('episode guardian: production package escaped Desktop runtime')
  }
  return { kind: allowLinkedProfile ? 'linked-desktop-development' : 'desktop-runtime',
    runtimeDir: captured.runtime, executable: process.execPath, packageRoots: captured.packageRoots }
}

async function desktopEntries(carrier: CapturedDesktopCarrier): Promise<{ cli: string; subprocess: string; worker: string }> {
  const current = await readDesktopEntrySet(carrier.runtimeDir)
  for (const key of ['host', 'cli', 'subprocess'] as const) {
    if (current.packageRoots[key] !== carrier.packageRoots[key]) throw new Error('episode guardian: runtime package target changed')
    if (carrier.kind === 'desktop-runtime' && !inside(current.runtime, current.packageRoots[key])) {
      throw new Error('episode guardian: production package escaped Desktop runtime')
    }
  }
  return current.entries
}

/**
 * Prepare the empty profile and spawn the trusted CLI without a shell or install.
 * The caller owns this entire preparation promise, then the returned child.
 * @param input - Captured carrier, request, limits and raw child owner.
 * @returns Child result/close observations and EOF cancellation.
 */
export async function launchGuardian(input: {
  readonly carrier: CapturedDesktopCarrier | SourceDshFixture
  /** Existing private execution directory, already bound into the descriptor hash. */
  readonly executionRoot: string
  readonly descriptorPath: string
  readonly identity: ExecutionIdentity
  readonly limits: { readonly requestBytes: number; readonly replyBytes: number; readonly diagnosticBytes: number }
  /** Owning plugin validated Config, including descriptor/output/lock/media limits. */
  readonly workerConfig: Readonly<Record<string, unknown>>
  readonly parsers: GuardianParsers
  /** Provider-owned raw children, retained even if post-spawn setup fails. */
  readonly rawChildren: Set<ChildProcessWithoutNullStreams>
}): Promise<{
  readonly pid: number | undefined
  readonly result: Promise<GuardianReply>
  readonly closed: Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>
  readonly diagnostic: () => string
  stop(): void
}> {
  const request: GuardianRequest = { version: 1, kind: 'run', identity: input.identity }
  const frame = Buffer.from(JSON.stringify(request) + '\n')
  if (frame.length > input.limits.requestBytes) throw new Error('episode guardian: request exceeds limit')
  input.parsers.parseRequest(request)
  const entries = input.carrier.kind !== 'source-fixture' ? await desktopEntries(input.carrier)
    : { cli: input.carrier.cli, subprocess: input.carrier.subprocessEntry, worker: input.carrier.workerEntry }
  const home = await mkdtemp(join(input.executionRoot, 'worker-home-'))
  await chmod(home, 0o700)
  for (const name of ['config', 'cache', 'state']) await mkdir(join(home, name), { mode: 0o700 })
  const profile = resolveProfileDir(PROFILE_NAME, home)
  initProfile(profile, [])
  const freshProfile = z.object({ dependencies: z.record(z.string(), z.never()),
    dsh: z.object({ profile: z.object({ bundles: z.array(z.string()).length(0) }) }) }).loose()
  freshProfile.parse(JSON.parse(await readFile(join(profile, 'package.json'), 'utf8')))
  // Fresh home prevents an existing profile/global patch/env from participating.
  const overlay = join(home, 'invocation.overlay.json')
  await writeFile(overlay, JSON.stringify([{ insert: [
    { id: 'episode-worker-subprocess', name: pathToFileURL(entries.subprocess).href },
    { id: 'episode-render-worker', name: pathToFileURL(entries.worker).href,
      config: { ...input.workerConfig, descriptorPath: input.descriptorPath,
        descriptorSha256: input.identity.descriptorSha256 } },
  ] }]) + '\n', { flag: 'wx', mode: 0o600 })
  const env = guardianEnvironment(home, process.platform)
  const prefix = ['--expose-internals']
  if (input.carrier.kind === 'linked-desktop-development') prefix.push('--preserve-symlinks-main')
  if (input.carrier.kind === 'source-fixture') {
    prefix.push('--import', input.carrier.tsxEsm)
    env.TSX_TSCONFIG_PATH = input.carrier.tsconfig
  }
  const child = spawn(input.carrier.executable, [...prefix, entries.cli,
    '--profile', PROFILE_NAME, '--patch', overlay], {
    cwd: profile, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  })
  input.rawChildren.add(child)
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject); child.once('close', (code, signal) => { resolve({ code, signal }) })
  })
  try {
    const diagnostic = collectGuardianDiagnostic(child.stderr, input.limits.diagnosticBytes)
    const result = collectGuardianReply(child.stdout, input.limits.replyBytes, input.parsers.parseReply).then((reply) => {
      for (const key of ['attempt', 'execution', 'planSha256', 'projectSha256', 'rendererGeneration',
        'configurationSha256', 'descriptorSha256'] as const) {
        if (reply.identity[key] !== input.identity[key]) throw new Error('episode guardian: reply identity mismatch')
      }
      if (reply.result.kind === 'drained' && reply.result.proof.guardianPid !== child.pid) {
        throw new Error('episode guardian: drained result came from another guardian PID')
      }
      return reply
    })
    // Register consumers before writing. The provider still awaits both promises.
    void closed.catch((_closedWithError: unknown) => { /* The returned promise remains authoritative. */ })
    void result.catch((_invalidResult: unknown) => { /* The returned promise remains authoritative. */ })
    child.stdin.on('error', () => { /* Missing/malformed reply plus close withholds success. */ })
    child.stdin.write(frame)
    // EOF is lifetime cancellation. Keep this pipe OPEN after writing the request.
    return { pid: child.pid, closed, result, diagnostic, stop: () => { child.stdin.end() } }
  } catch (error) {
    child.stdin.end()
    await closed.catch((_spawnFailed: unknown) => { /* The original setup error stays authoritative. */ })
    throw error
  }
}
