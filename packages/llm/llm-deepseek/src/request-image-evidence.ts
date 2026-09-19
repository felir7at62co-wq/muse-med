/** Bind only serialized image parts to their exact prepared bytes. */
import { createHash } from 'node:crypto'
import type { RequestImageAttachment } from '@deepseek-ai/dsh-attachment'
import type { DeepSeekRequestImageEvidence } from '@deepseek-ai/dsh-deepseek-llm-api-extensions'
import type { WireRequest } from './protocols/chat-completions/types.ts'

/**
 * Capture image evidence after serialization, including base64 fallback.
 * @param body - Final base request.
 * @param images - Prepared request variants.
 * @param files - File IDs actually resolved during this serialization.
 * @returns Ordered, detached evidence with no credentials, file IDs or image bytes.
 */
export function requestImageEvidence(body: WireRequest, images: readonly RequestImageAttachment[],
  files: readonly { fileId: string; version: RequestImageAttachment }[]): DeepSeekRequestImageEvidence[] {
  const result: DeepSeekRequestImageEvidence[] = []
  for (const [messageIndex, message] of body.messages.entries()) {
    if (message.role !== 'user' || !Array.isArray(message.content)) continue
    for (const [partIndex, part] of message.content.entries()) {
      if (part.type !== 'file' && part.type !== 'image_url') continue
      const version = part.type === 'file' ? files.find(file => file.fileId === part.file_id)?.version
        : images.find(image => part.image_url.url === `data:${image.mediaType};base64,${Buffer.from(image.data).toString('base64')}`)
      if (!version || version.bytes !== version.data.byteLength) throw new Error('IMAGE_EVIDENCE_MISSING')
      result.push({ attachmentId: String(version.attachment.attachmentId), variantId: String(version.variantId),
        sha256: `sha256:${createHash('sha256').update(version.data).digest('hex')}`, bytes: version.data.byteLength,
        width: version.width, height: version.height, representation: part.type === 'file' ? 'file' : 'base64', messageIndex, partIndex })
    }
  }
  return result
}
