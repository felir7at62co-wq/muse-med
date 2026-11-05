/** Load DS Bot test modules with the same Harness peers as the CLI. */
import { registerHooks } from 'node:module'

const pluginRoot = new URL('../../../../third_party/plugins/ds-bot/', import.meta.url).href
const cliManifest = new URL('../../../cli/package.json', import.meta.url).href

/**
 * Resolve DS Bot's Harness peers from the CLI workspace in built Loader runs.
 * @template T
 * @param {() => Promise<T>} load - imports of the DS Bot modules used by a fixture.
 * @returns {Promise<T>} the imported fixture dependencies.
 */
export async function importDsBotFixture(load) {
  if (process.env.DSH_EXAMPLE_MODE !== 'lib') return load()
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      if ((specifier === '@deepseek-ai/dsh-tools' || specifier === '@deepseek-ai/dsh-llm')
        && context.parentURL?.startsWith(pluginRoot)) {
        return next(specifier, { ...context, parentURL: cliManifest })
      }
      return next(specifier, context)
    },
  })
  try {
    return await load()
  } finally {
    hooks.deregister()
  }
}
