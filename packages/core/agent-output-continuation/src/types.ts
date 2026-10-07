/** Configuration and logged input supplied by automatic output continuation. */

/** Deployment limits for continuing one output-limited turn. */
export interface ContinuationConfig {
  /** Maximum additional model responses per turn; null (default) leaves progressing continuations uncapped. */
  maxContinuations?: number | null
  /** Consecutive empty or repeated output-limited responses before stopping; defaults to two. */
  maxNoProgressResponses?: number
  /** Characters of recent answer text retained for contained-repeat detection; defaults to 16384. */
  repeatWindowChars?: number
  /** Characters from the exact response end included in continuation input; defaults to 1024. */
  continuationTailChars?: number
}

/** Producer attribution for a logged automatic continuation; live reservations remain process-local. */
export interface OutputContinuationSource {
  readonly kind: 'output-continuation'
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Automatic continuation attribution; never authority to resume a restored session.
     * @persistenceAttribution
     */
    'output-continuation': OutputContinuationSource
  }
}
