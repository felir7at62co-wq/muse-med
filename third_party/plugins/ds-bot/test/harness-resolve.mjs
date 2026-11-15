// Tests import web-search.js outside a dsh profile, so its @deepseek-ai peers resolve from a
// DeepSeek Harness, as a profile would supply them: DSH_HARNESS, else the packages that
// `npm run harness` installs in dev/harness, else the nearest deepseek-harness/ checkout in a
// folder above ds-bot, else the same search from ds-bot's place in the main worktree (a git
// worktree has no checkout of its own).
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const plugin = resolve(import.meta.dirname, '..')
const above = (start) => {
  for (let dir = start; ; dir = dirname(dir)) {
    if (existsSync(join(dir, 'packages/bundle/web-app/package.json')) && existsSync(join(dir, 'apps/cli/package.json'))) return dir
    if (existsSync(join(dir, 'deepseek-harness'))) return join(dir, 'deepseek-harness')
    if (dirname(dir) === dir) return undefined
  }
}
const installed = join(plugin, 'dev', 'harness')
const findHarness = () => {
  if (process.env.DSH_HARNESS) return process.env.DSH_HARNESS
  if (existsSync(join(installed, 'node_modules'))) return installed
  const near = above(dirname(plugin))
  if (near) return near
  const beside = resolve(plugin, '../deepseek-harness')
  try {
    const git = (...args) => execFileSync('git', ['-C', dirname(plugin), 'rev-parse', ...args], { encoding: 'utf8' }).trim()
    return above(join(dirname(git('--path-format=absolute', '--git-common-dir')), git('--show-prefix'))) ?? beside
  } catch {
    return beside
  }
}
const harness = findHarness()
// Tests that load other harness packages (jsdom) read the same checkout.
process.env.DSH_HARNESS = harness
// The Web profile composes both bundles; neither bundle alone carries every peer.
const anchors = ['packages/bundle/web-app/package.json', 'packages/bundle/base/package.json']
  .map(path => resolve(harness, path)).filter(existsSync).map(path => pathToFileURL(path).href)
if (anchors.length === 0) anchors.push(pathToFileURL(resolve(harness, 'package.json')).href)
const pluginUrl = `${pathToFileURL(plugin).href}/`

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@deepseek-ai/') && context.parentURL?.startsWith(pluginUrl)) {
      for (const [index, anchor] of anchors.entries()) {
        try {
          return nextResolve(specifier, { ...context, parentURL: anchor })
        } catch (error) {
          if (error?.code !== 'ERR_MODULE_NOT_FOUND' || index === anchors.length - 1) throw error
        }
      }
    }
    return nextResolve(specifier, context)
  },
})
