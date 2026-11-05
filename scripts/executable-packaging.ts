/** Shared production-deploy preparation for the SDK and SSH executable carriers. */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * Resolve pnpm without invoking a command shell, including Windows shims.
 * @param args - pnpm arguments.
 * @param environment - environment containing the pnpm launcher or home.
 * @returns the executable and its argument vector.
 */
export function pnpmInvocation(args: string[], environment = process.env): [command: string, args: string[]] {
  const entrypoint = environment.npm_execpath?.trim()
  if (entrypoint !== undefined && entrypoint !== '') {
    const extension = extname(entrypoint).toLowerCase()
    if (extension === '.js' || extension === '.cjs' || extension === '.mjs') {
      return [process.execPath, [entrypoint, ...args]]
    }
    if (extension !== '.cmd') return [entrypoint, args]
  }
  const home = environment.PNPM_HOME?.trim()
  if (home !== undefined && home !== '') {
    const packageBin = resolve(home, '..', 'pnpm', 'bin')
    for (const filename of ['pnpm.mjs', 'pnpm.cjs']) {
      const candidate = resolve(packageBin, filename)
      if (existsSync(candidate)) return [process.execPath, [candidate, ...args]]
    }
  }
  if (process.platform === 'win32') {
    throw new Error('executable-packaging: pnpm must expose a JavaScript entrypoint through npm_execpath or PNPM_HOME on Windows.')
  }
  return ['pnpm', args]
}

/**
 * Deploy the locked production graph into its own hoisted package tree.
 * @param closure - deploy root's workspace package name.
 * @param staging - deployed runtime root.
 * @returns arguments for pnpm's lockfile-backed deploy.
 */
export function executableDeployArgs(closure: string, staging: string): string[] {
  return ['--filter', closure, 'deploy', '--prod', '--config.allow-unused-patches=true',
    '--config.node-linker=hoisted', '--config.auto-install-peers=false', staging]
}

function isBuildPolicy(value: unknown): value is Record<string, boolean> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.values(value).every(decision => typeof decision === 'boolean')
}

/**
 * Keep pnpm's effective lifecycle policy when deploy converts local file dependencies to absolute URLs.
 * @param workspace - Root of the source workspace.
 * @param environment - Environment carrying the pnpm launcher and any policy overrides.
 * @returns Child environment with equivalent rules for local deployment identities.
 */
export function executableDeployEnvironment(workspace: string, environment = process.env): NodeJS.ProcessEnv {
  const [command, args] = pnpmInvocation(['config', 'get', 'allow-builds'], environment)
  const policy: unknown = JSON.parse(execFileSync(command, args, { cwd: workspace, env: environment, encoding: 'utf8' }))
  if (!isBuildPolicy(policy)) {
    throw new Error('executable-packaging: pnpm allowBuilds must map package identities to booleans.')
  }
  const deployed = { ...policy }
  for (const [key, decision] of Object.entries(policy)) {
    const [, prefix, locator] = /^(.+@)file:([^/\\].*)$/u.exec(key) ?? []
    if (prefix === undefined || locator === undefined || isAbsolute(locator)) continue
    const source = resolve(workspace, locator)
    const path = relative(workspace, source)
    if (path === '' || path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) continue
    const identity = `${prefix}${pathToFileURL(source).href}`
    if (!Object.hasOwn(policy, identity)) deployed[identity] = deployed[identity] !== false && decision
  }
  return { ...environment, PNPM_CONFIG_ALLOW_BUILDS: JSON.stringify(deployed) }
}
