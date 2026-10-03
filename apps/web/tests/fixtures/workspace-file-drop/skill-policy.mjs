/** Scoped invocation policy for the two skills recorded by the file-reference fixture. */
export const name = 'workspace-file-drop-skill-policy'
/** The ordinary skill registry carries both platform and preset contributions. */
export const inject = ['skills']

/**
 * Hide unrelated host skills within this fixture's preset scope.
 * @param {import('@deepseek-ai/cordis').Context} ctx Preset-scoped context.
 * @param {{ names: readonly string[] }} config Recorded skill allowlist.
 * @returns {Promise<void>} Completion after scoped invocation policies are registered.
 */
export async function apply(ctx, config) {
  const allowed = new Set(config.names)
  for (const skill of await ctx.skills.list()) {
    if (allowed.has(skill.name)) continue
    ctx.skills.register({
      ...skill,
      content: 'This skill is excluded from the file-reference fixture.',
      invocation: { modelInvocable: false, userInvocable: false },
    })
  }
}
