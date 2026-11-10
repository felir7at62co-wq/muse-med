/** Durable assignments between a routing Session and ordinary execution Sessions. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'

/** Coordinator-owned goal identity, independent of the execution Session. */
export type CoordinationTaskId = Branded<'CoordinationTaskId'>

/** One execution revision's delivery and settlement state. */
export type AssignmentStatus = 'dispatching' | 'accepted' | 'running' | 'finishing'
  | 'needs-report' | 'interrupted' | 'stopping' | 'stopped'
  | 'completed' | 'blocked' | 'needs-input' | 'failed'

/** A worker's explicit account; completion remains distinct from human acceptance. */
export interface WorkerReport {
  readonly outcome: 'completed' | 'blocked' | 'needs-input' | 'failed'
  readonly summary: string
  /** Paths declared by successful native present calls in this assignment. */
  readonly files: readonly { readonly path: string; readonly description?: string | undefined }[]
  readonly throughSeq: number
}

/** Immutable request and mutable receipt for one revision of a goal. */
export interface Assignment {
  readonly revision: number
  readonly key: string
  /** SHA-256 of the complete explicit routing request for conflicting-key detection. */
  readonly requestHash: string
  readonly instructions: string
  readonly reason: string
  readonly sourceSeq: number
  readonly messageId: MessageId
  /** Stable relay metadata identity; never presented as human-authored requirements. */
  readonly briefId: MessageId
  /** New delivery identities for the exact verified human messages, in revision order. */
  readonly forwardedIds: readonly MessageId[]
  readonly sessionId: SessionId
  readonly createSession: boolean
  readonly cwd: string
  /** Directory in which the human supplied relative input references. */
  readonly sourceCwd: string | null
  readonly videoKey: string | null
  readonly status: AssignmentStatus
  readonly report: WorkerReport | null
  readonly issue: string | null
  readonly noticeId: MessageId
  /** Native receipt for the most recent terminal notification; null until one is durably enqueued. */
  readonly notifiedStatus: AssignmentStatus | null
}

/** Persisted task with the complete assignment history retained for routing and retry checks. */
export interface CoordinationTask {
  readonly id: CoordinationTaskId
  readonly owner: SessionId
  readonly title: string
  readonly createdAt: number
  readonly attempts: readonly Assignment[]
}

/** Agent-selected routing decision. Omitted target creates an ordinary worker. */
export interface DispatchRequest {
  readonly key: string
  readonly title: string
  readonly instructions: string
  readonly reason: string
  readonly sessionId?: SessionId
  readonly cwd?: string
  /** Omitted starts an independent goal; present continues that goal with an expected revision. */
  readonly taskId?: CoordinationTaskId
  readonly expectedRevision?: number
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /**
     * Routing instructions or worker receipts, never human-authored authority.
     * @persistenceAttribution
     */
    'muse-coordination': {
      readonly kind: 'muse-coordination'
      readonly taskId: CoordinationTaskId
      readonly revision: number
      readonly sender: SessionId
      readonly purpose: 'assignment' | 'receipt'
    } & ContextFormed
  }
}
