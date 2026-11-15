/** Validated limits and user-owned locations for independent Skill learning. */
import Schema from '@deepseek-ai/schemastery'

/** Product-overridable learning limits; timers only defer work until the Host is idle. */
export const Config = Schema.object({
  enabled: Schema.boolean().default(true),
  autoApplyOwned: Schema.boolean().default(true),
  autoSubmitFeedback: Schema.boolean().default(true),
  maxFeedbackPerDay: Schema.number().step(1).min(0).max(1000).default(4),
  home: Schema.string(),
  skillsRoot: Schema.string(),
  idleMs: Schema.number().step(1).min(0).max(86_400_000).default(600_000),
  minToolCalls: Schema.number().step(1).min(1).max(1000).default(3),
  maxReviewsPerDay: Schema.number().step(1).min(0).max(1000).default(4),
  inputMaxChars: Schema.number().step(1).min(4000).max(1_000_000).default(24_000),
  outputMaxTokens: Schema.number().step(1).min(256).max(64_000).default(4096),
  requestTimeoutMs: Schema.number().step(1).min(100).max(1_800_000).default(120_000),
  maxSkills: Schema.number().step(1).min(1).max(1000).default(20),
  maxRuns: Schema.number().step(1).min(1).max(100_000).default(1000),
  maxProposals: Schema.number().step(1).min(1).max(100_000).default(200),
  maxVersions: Schema.number().step(1).min(1).max(100_000).default(1000),
  descriptionMaxChars: Schema.number().step(1).min(20).max(2000).default(300),
  contentMaxChars: Schema.number().step(1).min(100).max(100_000).default(8000),
  toolOutputMaxChars: Schema.number().step(1).min(1000).max(1_000_000).default(24_000),
})
