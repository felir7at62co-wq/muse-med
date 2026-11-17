/** Browser-safe durable image selection declaration and pure replay definition. */

import type { Message } from '@deepseek-ai/dsh-llm'
import type { SessionSeq } from '@deepseek-ai/dsh-session/types'
import type { SessionMessageProjection } from '@deepseek-ai/dsh-session/surface'
import { offloadMessageImages } from './project-message.ts'

/** Exact input-image occurrences selected by one durable offload decision. */
export interface ImageOffloadTarget {
  /** Current message-producing event containing these occurrences. */
  seq: SessionSeq
  /** Zero-based depth-first image indexes within the immutable message. */
  imageIndexes: number[]
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Permanently omit selected input-image occurrences from subsequent model requests.
     * Targets name unique current user/message or tool/result nodes. Nonempty, strictly
     * increasing indexes count all images in depth-first order, including nested tool
     * results and already omitted images. Message nodes and identities remain unchanged.
     * @messageProjection
     */
    'image/offload': {
      targets: ImageOffloadTarget[]
      /**
       * Model-visible reason the selecting plugin gives for these omissions, sent after each image identity instead of
       * the request-limit placeholder; absent in request-limit decisions and in logs written before this field existed.
       */
      notice?: string
    }
  }
}

/** Longest accepted `notice`; the text reaches every later request once per selected occurrence. */
const MAX_NOTICE_LENGTH = 1000

/** A durable `notice` value, validated. */
function noticeOf(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > MAX_NOTICE_LENGTH) {
    throw new Error(`image/offload: notice must be nonblank text of at most ${MAX_NOTICE_LENGTH} characters`)
  }
  return value
}

/** Whether a durable value is a JSON object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Whether a durable occurrence index or sequence is canonical. */
function isIndex(value: unknown): value is SessionSeq {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0)
}

/** Atomic validation and reconstruction shared by live sessions and detached replay. */
export const imageOffloadProjection: SessionMessageProjection<'image/offload'> = {
  type: 'image/offload',
  project(event, context) {
    const data: unknown = event.data
    if (!isRecord(data) || !Array.isArray(data['targets']) || data['targets'].length === 0
      || Object.keys(data).some(key => key !== 'targets' && key !== 'notice')) {
      throw new Error('image/offload: data must contain a nonempty targets array and an optional notice')
    }
    const notice = data['notice'] === undefined ? undefined : noticeOf(data['notice'])
    const messages = new Map<SessionSeq, Message>()
    const nodes = new Set(context.nodes)
    for (const target of data['targets'] as unknown[]) {
      if (!isRecord(target) || Object.keys(target).length !== 2 || !isIndex(target['seq'])
        || !Array.isArray(target['imageIndexes']) || target['imageIndexes'].length === 0) {
        throw new Error('image/offload: each target must contain a seq and nonempty imageIndexes')
      }
      const seq = target['seq']
      if (messages.has(seq)) throw new Error(`image/offload: duplicate target seq ${seq}`)
      if (!nodes.has(seq)) throw new Error(`image/offload: target seq ${seq} is not a current surface node`)
      const source = context.events[seq - context.baseSeq]
      if (source?.type !== 'user/message' && source?.type !== 'tool/result') {
        throw new Error(`image/offload: target seq ${seq} must be user/message or tool/result`)
      }
      let previous = -1
      for (const index of target['imageIndexes'] as unknown[]) {
        if (!isIndex(index) || index <= previous) {
          throw new Error('image/offload: imageIndexes must be strictly increasing non-negative safe integers')
        }
        previous = index
      }
      const message = context.messages.get(seq)
        ?? (source.type === 'user/message' ? source.data : source.data.message)
      messages.set(seq, offloadMessageImages(message, target['imageIndexes'] as number[], notice))
    }
    return messages
  },
}
