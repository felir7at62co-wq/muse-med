/** Retained upstream cases opt into Bot-managed parts and memory review explicitly. */
import { fakeContext } from './fake-ctx.js'

export const legacyConfig = config => ({
  mainName: 'Chief',
  mainRole: 'Chief of Staff',
  agentPreset: 'standard',
  mainAgentPreset: 'standard',
  ensureMuseSpecialist: false,
  contextManagement: 'bot',
  goals: 'disabled',
  memoryReview: true,
  autoSessionBots: false,
  ...config,
})

export const legacyContext = ({ services = {} } = {}) => fakeContext({ services: {
  agentPresets: { list: async () => [{ id: 'standard' }], serviceFor: () => services.compaction },
  ...services,
} })
