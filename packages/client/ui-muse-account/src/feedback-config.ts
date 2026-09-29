/** Public feedback configuration shared by the Host and browser. */
import z from '@deepseek-ai/schemastery'

/** Product-owned feedback destination. */
export interface FeedbackConfig {
  /** HTTPS page opened in the browser; no account credentials are appended. */
  feedbackUrl: string
}

/** Validate the product's public feedback URL. */
export const FeedbackConfig: z<Partial<FeedbackConfig>, FeedbackConfig> = z.object({
  feedbackUrl: z.string().pattern(/^https:\/\/[^/\s@?#]+\/[^\s]*$/).required(),
})

/** Bootstrap key for the public feedback configuration. */
export const FEEDBACK_CONFIG_GLOBAL = '__MUSE_FEEDBACK_CONFIG__'
