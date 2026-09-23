/** Fail preparation when the packaged Codex CLI or its native platform payload is incomplete. */
import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'

interface PackageManifest {
  name?: string
  version?: string
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  bin?: { codex?: string }
}

/**
 * Resolve only payload-local packages and run the CLI without profile credentials.
 * @param root - Final copied Desktop runtime, before its descriptor is published.
 * @param node - Bundled target Node executable, never a PATH lookup.
 * @param expectedVersion - Exact CLI dependency from the source provider manifest.
 * @param target - Platform and architecture selected for the bundled Node.
 * @returns Resolves after the CLI reports the exact expected version; otherwise rejects preparation.
 */
export async function verifyCodexRuntime(
  root: string, node: string, expectedVersion: string, target: { platform: NodeJS.Platform; arch: string },
): Promise<void> {
  const directory = realpathSync(root)
  const owned = (path: string): string => {
    const physical = realpathSync(path)
    const local = relative(directory, physical)
    if (local === '..' || local.startsWith(`..${sep}`) || isAbsolute(local)) {
      throw new Error('desktop runtime: Codex dependency resolved outside the packaged runtime')
    }
    return physical
  }
  const manifest = (path: string): PackageManifest => JSON.parse(readFileSync(owned(path), 'utf8')) as PackageManifest
  // Package-set roots are direct runtime dependencies; bypass the build launcher's workspace aliases.
  const providerPath = owned(join(directory, 'node_modules/@deepseek-ai/dsh-subagent-codex/package.json'))
  if (manifest(providerPath).dependencies?.['@openai/codex'] !== expectedVersion) {
    throw new Error('desktop runtime: Codex provider dependency differs from its source pin')
  }
  const providerRequire = createRequire(providerPath)
  const cliPath = owned(providerRequire.resolve('@openai/codex/package.json'))
  const cli = manifest(cliPath)
  if (cli.version !== expectedVersion || typeof cli.bin?.codex !== 'string' || !cli.bin.codex) {
    throw new Error('desktop runtime: Codex CLI manifest version or wrapper is invalid')
  }
  const platformName = `@openai/codex-${target.platform}-${target.arch}`
  const platform = manifest(createRequire(cliPath).resolve(`${platformName}/package.json`))
  if (typeof platform.version !== 'string' || platform.name !== '@openai/codex'
    || cli.optionalDependencies?.[platformName] !== `npm:@openai/codex@${platform.version}`) {
    throw new Error('desktop runtime: Codex platform dependency differs from the CLI manifest')
  }
  const wrapper = owned(resolve(dirname(cliPath), cli.bin.codex))
  const home = mkdtempSync(join(tmpdir(), 'dsh-codex-payload-smoke-'))
  try {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(?:path|systemroot|windir|comspec)$/iu.test(key)))
    Object.assign(env, { HOME: home, USERPROFILE: home, CODEX_HOME: home, TMP: home, TEMP: home, TMPDIR: home })
    const { stdout } = await promisify(execFile)(node, [wrapper, '--version'], {
      cwd: home, env, timeout: 10_000, maxBuffer: 4096, windowsHide: true,
    })
    if (stdout.trim() !== `codex-cli ${expectedVersion}`) throw new Error('desktop runtime: Codex executable reported another version')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}
