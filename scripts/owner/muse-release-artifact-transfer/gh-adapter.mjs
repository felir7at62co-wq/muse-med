/** Execute fixed GitHub CLI reads and one-file draft uploads with a narrowly owned credential environment. */
import { execFileSync } from 'node:child_process'
import { isAbsolute } from 'node:path'

const REPOSITORY = 'felir7at62co-wq/muse-med'

/**
 * Keep the GitHub token in process memory and omit child output from failures.
 * @param token - Workflow-scoped GitHub token, supplied from the runner environment.
 * @param options - Optional command runner and environment used by isolated owner tests.
 * @returns A repository-scoped JSON reader and single-file uploader with no publish/delete/clobber operation.
 */
export function createGitHubTransferAdapter(token, options = {}) {
  if (typeof token !== 'string' || token.length === 0) throw new Error('A workflow-scoped GitHub token is required')
  const execute = options.execute ?? execFileSync
  const inherited = options.environment ?? process.env
  const environment = { GH_TOKEN: token, GH_HOST: 'github.com', GH_PROMPT_DISABLED: '1' }
  for (const name of ['PATH', 'HOME', 'TMPDIR', 'LANG']) {
    if (typeof inherited[name] === 'string') environment[name] = inherited[name]
  }
  function invoke(args, timeout, operation) {
    try {
      return execute('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: environment, timeout, maxBuffer: 4194304 })
    } catch (error) {
      const status = Number.isInteger(error.status) ? error.status : 'unknown'
      const signal = typeof error.signal === 'string' && /^[A-Z0-9]+$/u.test(error.signal) ? error.signal : 'none'
      throw new Error(`GitHub ${operation} failed: exit=${status}, signal=${signal}, timeout=${error.code === 'ETIMEDOUT'}`)
    }
  }
  return {
    async json(route) {
      if (typeof route !== 'string'
        || !/^(?:actions\/runs\/[1-9][0-9]*(?:\/(?:jobs|artifacts)\?per_page=100)?|git\/ref\/tags\/v\d+\.\d+\.\d+(?:-rc\.muse-stable)?|git\/tags\/[a-f0-9]{40}|releases\/(?:[1-9][0-9]*|latest))$/u.test(route)) {
        throw new Error('Unexpected GitHub transfer API route')
      }
      const output = invoke(['api', '--method', 'GET', `repos/${REPOSITORY}/${route}`], 30000, 'metadata read')
      try { return JSON.parse(output) }
      catch (error) { throw new Error('GitHub metadata response was not JSON', { cause: error }) }
    },
    async upload(tag, path) {
      if (!/^v\d+\.\d+\.\d+(?:-rc\.muse-stable)?$/u.test(tag) || typeof path !== 'string'
        || !isAbsolute(path) || /[\r\n#]/u.test(path) || !/\.(?:exe|dmg|zip)$/u.test(path)) {
        throw new Error('Invalid single-file draft upload')
      }
      invoke(['release', 'upload', tag, path, '--repo', REPOSITORY], 1800000, 'asset upload')
    },
  }
}
