/**
 * Serialized-image evidence: every wire image part must bind to the exact
 * prepared bytes it represents, and any part that cannot be bound is a
 * serialization defect rather than a request to send.
 */

import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { AttachmentId, ImageVariantId } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentRef, RequestImageAttachment } from '@deepseek-ai/dsh-attachment'
import { requestImageEvidence } from '../src/request-image-evidence.ts'
import type { WireRequest } from '../src/protocols/chat-completions/types.ts'

const FILE_ID = 'file-api-1'

function imageRef(digit = 'a'): ImageAttachmentRef {
  return {
    attachmentId: AttachmentId(`sha256:${digit.repeat(64)}`),
    mediaType: 'image/png',
    bytes: 3,
    width: 1,
    height: 1,
  }
}

/** One prepared variant over `data`, declaring `bytes` (which may disagree on purpose). */
function requestVersion(ref: ImageAttachmentRef, data: Uint8Array, bytes = data.byteLength): RequestImageAttachment {
  return {
    variantId: ImageVariantId(`sha256:${'b'.repeat(64)}`),
    attachment: ref,
    data,
    mediaType: ref.mediaType,
    bytes,
    width: 1,
    height: 1,
    depth: 'uchar',
    space: 'srgb',
    hasAlpha: false,
  }
}

function wire(messages: WireRequest['messages']): WireRequest {
  return { model: 'deepseek-flash', messages, stream: true, stream_options: { include_usage: true } }
}

function dataUrl(version: RequestImageAttachment): string {
  return `data:${version.mediaType};base64,${Buffer.from(version.data).toString('base64')}`
}

function sha256(data: Uint8Array): string {
  return `sha256:${createHash('sha256').update(data).digest('hex')}`
}

describe('requestImageEvidence', () => {
  it('binds file parts to resolved file ids and inline parts to their exactly encoded bytes', () => {
    const fileRef = imageRef('a')
    const fileVersion = requestVersion(fileRef, Uint8Array.of(1, 2, 3))
    const inlineRef = imageRef('c')
    const inlineVersion = requestVersion(inlineRef, Uint8Array.of(4, 5, 6))

    const evidence = requestImageEvidence(wire([
      { role: 'system', content: 'instructions' },
      {
        role: 'user',
        content: [{ type: 'text', text: 'describe ' }, { type: 'file', file_id: FILE_ID }],
      },
      { role: 'user', content: [{ type: 'image_url', image_url: { url: dataUrl(inlineVersion) } }] },
    ]), [inlineVersion], [{ fileId: FILE_ID, version: fileVersion }])

    expect(evidence).toEqual([
      {
        attachmentId: String(fileRef.attachmentId),
        variantId: String(fileVersion.variantId),
        sha256: sha256(fileVersion.data),
        bytes: 3,
        width: 1,
        height: 1,
        representation: 'file',
        messageIndex: 1,
        partIndex: 1,
      },
      {
        attachmentId: String(inlineRef.attachmentId),
        variantId: String(inlineVersion.variantId),
        sha256: sha256(inlineVersion.data),
        bytes: 3,
        width: 1,
        height: 1,
        representation: 'base64',
        messageIndex: 2,
        partIndex: 0,
      },
    ])
  })

  it('skips messages and parts that carry no image bytes', () => {
    expect(requestImageEvidence(wire([]), [], [])).toEqual([])
    const evidence = requestImageEvidence(wire([
      { role: 'user', content: 'plain string content' },
      { role: 'assistant', content: 'answer' },
      { role: 'user', content: [{ type: 'text', text: 'no image here' }] },
      { role: 'tool', tool_call_id: 'call-1', content: 'result' },
    ]), [], [])
    expect(evidence).toEqual([])
  })

  it('rejects a wire image part with no prepared variant', () => {
    expect(() => requestImageEvidence(
      wire([{ role: 'user', content: [{ type: 'file', file_id: 'unknown' }] }]), [], [],
    )).toThrow('IMAGE_EVIDENCE_MISSING')
    expect(() => requestImageEvidence(
      wire([{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] }]), [], [],
    )).toThrow('IMAGE_EVIDENCE_MISSING')
  })

  it('rejects a matched variant whose declared bytes disagree with its data', () => {
    const ref = imageRef('a')
    const version = requestVersion(ref, Uint8Array.of(1, 2, 3), 4)
    expect(() => requestImageEvidence(
      wire([{ role: 'user', content: [{ type: 'file', file_id: FILE_ID }] }]), [], [{ fileId: FILE_ID, version }],
    )).toThrow('IMAGE_EVIDENCE_MISSING')
  })
})
