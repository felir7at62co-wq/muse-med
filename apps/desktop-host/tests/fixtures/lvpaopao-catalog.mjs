/** Source-only schema registration keeps the independently compiled plugin outside the Host TypeScript program. */
import { registerLvpaopao } from '../../../../third_party/plugins/muse-lvpaopao/src/index.ts'

/**
 * Register the production schema without native IO or an executable task.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Test-owned tools context.
 * @returns {void} After the real production registration completes.
 */
export function registerLvpaopaoCatalog(ctx) {
  registerLvpaopao(ctx, {
    request: () => { throw new Error('Schema discovery cannot contact the native bridge') },
    async dispose() {},
  }, { maxQueryChars: 80, maxEpisodeCount: 20, maxResultItems: 50, maxSeriesEpisodes: 400 })
}
