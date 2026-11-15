/** Publish only unchanged plugin-owned files through the existing Skill registry. */
import { dirname } from 'node:path'

/**
 * Register learned Skills and invalidate the native catalog after committed changes.
 * @param {object} ctx - Context with the Skill registry.
 * @param {object} store - Owned Skill storage.
 */
export function mountEvolutionProvider(ctx, store) {
  ctx.skills.registerProvider(control => {
    const unsubscribe = store.subscribe(control.invalidate)
    control.signal.addEventListener('abort', unsubscribe, { once: true })
    const summary = skill => ({ name: skill.name, description: skill.description, source: 'user-muse',
      provider: 'muse-skill-evolution', path: skill.path, resourceBase: { kind: 'directory', path: dirname(skill.path) },
      invocation: { modelInvocable: true, userInvocable: true } })
    return {
      name: 'muse-skill-evolution',
      async list({ signal } = {}) {
        signal?.throwIfAborted()
        const catalog = await store.catalog()
        signal?.throwIfAborted()
        return catalog.filter(skill => skill.owned).map(skill => ({ ...summary(skill), rank: 389, locator: { name: skill.name, hash: skill.currentHash } }))
      },
      async get(candidate, { signal } = {}) {
        signal?.throwIfAborted()
        const skill = (await store.catalog()).find(item => item.name === candidate.name)
        signal?.throwIfAborted()
        return skill?.owned ? { ...summary(skill), content: skill.content } : undefined
      },
    }
  })
}
