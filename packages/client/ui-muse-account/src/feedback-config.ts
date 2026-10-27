/** Public feedback configuration shared by the Host and browser. */
import z from '@deepseek-ai/schemastery'

/** Product-owned feedback destination. */
export interface FeedbackConfig {
  /** HTTPS or exact loopback HTTP page opened without appending account credentials. */
  feedbackUrl: string
}

/** Validate the product's public feedback URL. */
export const FeedbackConfig: z<Partial<FeedbackConfig>, FeedbackConfig> = z.object({
  feedbackUrl: z.transform(z.string().pattern(
    /^(?:https:\/\/[^/\s?#]+|http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::[0-9]+)?)\/[^\s]*$/u,
  ), (value) => {
    let url: URL
    try { url = new URL(value) }
    catch { throw new Error('feedbackUrl must name an HTTPS or loopback HTTP page without credentials') }
    if (url.username !== '' || url.password !== '' || (url.protocol === 'http:' && url.pathname === '/') || value.includes('\\')) {
      throw new Error('feedbackUrl must name an HTTPS or loopback HTTP page without credentials')
    }
    return value
  }).required(),
})

/** Bootstrap key for the public feedback configuration. */
export const FEEDBACK_CONFIG_GLOBAL = '__MUSE_FEEDBACK_CONFIG__'
