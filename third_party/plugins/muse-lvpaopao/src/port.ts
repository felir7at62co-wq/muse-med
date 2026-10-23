/** Private helper vocabulary; never exposes native CDP or media URLs. */
export const ACTIONS = ['status', 'search', 'detail', 'episodes', 'download_first_episode', 'download_episode', 'download_status', 'rankings'] as const
/** High-level operations accepted by the target-specific helper. */
export type Action = typeof ACTIONS[number]
/** Tool and helper parameters; method-specific requirements are checked by the executor. */
export interface Parameters {
  readonly query?: string
  readonly boardType?: number
  readonly pageIndex?: number
  readonly coldStartTime?: number
  readonly srcAppId?: string
  readonly dramaId?: string
  readonly start?: number
  readonly count?: number
  readonly episodeNo?: number
  readonly idempotencyKey?: string
}
/** One request transport with owned, awaited shutdown. */
export interface RequestPort {
  /**
   * Request one high-level operation; cancellation waits for settlement.
   * @param action - An allowlisted business operation.
   * @param params - Validated operation fields.
   * @param signal - Calling tool cancellation.
   * @returns Untrusted JSON to validate before model presentation.
   */
  request(action: Action, params: Parameters, signal: AbortSignal): Promise<unknown>
  /** Stop admission and settle owned work; a failed remote cleanup must reject. */
  dispose(): Promise<void>
}
/** Fixed safe error identifiers from the adapter or helper. */
export class BridgeError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'BridgeError' }
}
