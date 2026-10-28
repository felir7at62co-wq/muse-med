/** Resolve Muse Bot settings before registering effects or opening team data.
 * @param {object} config Plugin settings from the Muse profile.
 * @returns {object} Settings with explicit preset, context, goal and memory-review policies.
 */
export function resolveMuseConfig(config = {}) {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) throw new TypeError('Muse Bot config must be an object')
  const resolved = {
    ...config,
    agentPreset: config.agentPreset ?? 'short-drama',
    mainAgentPreset: config.mainAgentPreset ?? 'bot-coordinator',
    ensureMuseSpecialist: config.ensureMuseSpecialist ?? true,
    contextManagement: config.contextManagement ?? 'host',
    goals: config.goals ?? 'host',
    memoryReview: config.memoryReview ?? false,
    autoSessionBots: config.autoSessionBots ?? true,
    sessionBotSyncIntervalMs: config.sessionBotSyncIntervalMs ?? 30000,
    github: config.github ?? false,
    updateCheck: false,
  }
  if (typeof resolved.agentPreset !== 'string' || !/^[a-z][a-z0-9-]*$/.test(resolved.agentPreset)) throw new TypeError('Muse Bot agentPreset must be a preset id')
  if (typeof resolved.mainAgentPreset !== 'string' || !/^[a-z][a-z0-9-]*$/.test(resolved.mainAgentPreset)) throw new TypeError('Muse Bot mainAgentPreset must be a preset id')
  if (!['host', 'bot'].includes(resolved.contextManagement)) throw new TypeError('Muse Bot contextManagement must be host or bot')
  if (!['host', 'disabled'].includes(resolved.goals)) throw new TypeError('Muse Bot goals must be host or disabled')
  if (typeof resolved.ensureMuseSpecialist !== 'boolean') throw new TypeError('Muse Bot ensureMuseSpecialist must be a boolean')
  if (typeof resolved.memoryReview !== 'boolean') throw new TypeError('Muse Bot memoryReview must be a boolean')
  if (typeof resolved.autoSessionBots !== 'boolean') throw new TypeError('Muse Bot autoSessionBots must be a boolean')
  if (!Number.isSafeInteger(resolved.sessionBotSyncIntervalMs) || resolved.sessionBotSyncIntervalMs < 1000) throw new TypeError('Muse Bot sessionBotSyncIntervalMs must be an integer of at least 1000')
  if (resolved.contextManagement === 'bot' && resolved.goals === 'host') throw new TypeError('Bot-managed conversation parts require goals: disabled; use host context management to retain Muse goals')
  if (config.updateCheck === true) throw new TypeError('Muse Bot updates with Muse; upstream updates cannot be enabled')
  return resolved
}
