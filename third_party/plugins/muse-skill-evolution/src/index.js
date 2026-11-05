/** Independent Muse Skill learning; no Bot, knowledge base, or global-memory runtime. */
import { isAbsolute, join } from 'node:path'
import { dshHomePath, resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { Config } from './config.js'
import { EvolutionRuntime } from './runtime.js'
import { createEvolutionStore } from './store.js'
import { mountEvolutionProvider } from './provider.js'
import { mountEvolutionTools } from './tools.js'

export { Config } from './config.js'

/** Cordis plugin identity. */
export const name = 'muse-skill-evolution'
/** Host services used by native review Sessions, discovery and source-policy checks. */
export const inject = ['agents', 'sessions', 'sessionPersistence', 'skills', 'tools', 'systemPrompt', 'sandboxPolicy']

/**
 * Mount user-owned learning storage, discovery, tools, and completed-turn review.
 * @param {object} ctx - Product Host context.
 * @param {object} input - Schema-validated configuration.
 * @returns {Promise<void>} Activation after the owned store is ready.
 */
export async function apply(ctx, input = {}) {
  const resolved = Config(input)
  const config = { ...resolved, home: resolved.home ?? dshHomePath('muse-skill-evolution'), skillsRoot: resolved.skillsRoot ?? join(resolveDshHome(), 'skills') }
  if (!isAbsolute(config.home) || !isAbsolute(config.skillsRoot)) throw new Error('Skill learning directories must be absolute')
  let closed = false
  const store = createEvolutionStore({ home: config.home, skillsRoot: config.skillsRoot, writable: () => !closed && config.enabled,
    maxSkillChars: config.contentMaxChars, maxDescriptionChars: config.descriptionMaxChars, maxSkills: config.maxSkills,
    maxRuns: config.maxRuns, maxProposals: config.maxProposals, maxVersions: config.maxVersions })
  await store.ready()
  const runtime = new EvolutionRuntime(ctx, { store, config })
  ctx.effect(() => async () => { closed = true; await runtime.dispose(); await store.close() }, 'muse-skill-evolution: runtime')
  ctx.inject(['museAccount'], inner => {
    const close = runtime.attachFeedback(inner.museAccount)
    inner.effect(() => close, 'muse-skill-evolution: account submissions')
  })
  mountEvolutionProvider(ctx, store)
  mountEvolutionTools(ctx, store, { outputMaxChars: config.toolOutputMaxChars, enabled: config.enabled,
    autoApplyOwned: config.autoApplyOwned, maxReviewsPerDay: config.maxReviewsPerDay,
    autoSubmitFeedback: config.autoSubmitFeedback, maxFeedbackPerDay: config.maxFeedbackPerDay })
  await runtime.start()
}
