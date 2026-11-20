/** Stable error identities for failed Muse video tool operations. */
import { HarnessError } from '@deepseek-ai/dsh-error'

type SessionVideoErrorCode =
  | 'SESSION_VIDEO_SOURCE_UNAVAILABLE'
  | 'SESSION_VIDEO_BUSY'
  | 'SESSION_VIDEO_HASH_MISMATCH'
  | 'SESSION_VIDEO_EVIDENCE_UNAVAILABLE'
  | 'SESSION_VIDEO_SOURCE_CHANGED'
  | 'SESSION_VIDEO_REVIEW_SCOPE_DENIED'
  | 'SESSION_VIDEO_LIMIT_REACHED'
  | 'SESSION_VIDEO_NO_DECODABLE_FRAME'
  | 'SESSION_VIDEO_OPERATION_FAILED'

/** Expected tool failure; Remote inventory and detection keep their own result types. */
export class SessionVideoError extends HarnessError {
  override readonly code: SessionVideoErrorCode

  /**
   * @param message - Actionable explanation for the model.
   * @param code - Stable failure class for recorded tool-result consumers.
   * @param options - Original dependency failure as `cause`, when present.
   */
  constructor(message: string, code: SessionVideoErrorCode, options?: ErrorOptions) {
    super(message, code, options)
    this.name = 'SessionVideoError'
    this.code = code
  }
}
