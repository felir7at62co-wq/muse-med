/** Enforce the initiating Session's existing file policy for generated Skill files. */
import { isAbsolute, relative, resolve } from 'node:path'
import { canonicalizeWatchPath } from '@deepseek-ai/dsh-home-paths'
import { writableRoots } from '@deepseek-ai/dsh-sandbox'

/**
 * Check the actual output root without requesting a wider permission mode.
 * @param {object} ctx - Host owning the sandbox policy.
 * @param {object} session - Live initiating Session.
 * @param {string} skillsRoot - Configured generated Skill root.
 * @returns {Promise<void>} Resolves only when the standing policy permits writing.
 */
export async function assertSkillWriteAllowed(ctx, session, skillsRoot) {
  if (session === undefined) throw new Error('A live initiating Session is required to change learned Skills')
  const policy = ctx.sandboxPolicy.resolve({ session })
  if (policy.mode === 'read-only') throw new Error('The current Session is read-only; the Skill proposal was retained')
  if (policy.mode === 'danger-full-access') return
  const target = await canonicalizeWatchPath(skillsRoot)
  const roots = await Promise.all(writableRoots(policy).map(root => canonicalizeWatchPath(root)))
  if (!roots.some(root => {
    const part = relative(resolve(root), target)
    return part === '' || part !== '..' && !part.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(part)
  })) throw new Error('The generated Skill directory is outside this Session\'s writable roots; the proposal was retained')
}
