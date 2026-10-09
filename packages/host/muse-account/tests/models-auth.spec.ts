import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { AttachmentId, AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentRef, SaveImageAttachment, StoredImageAttachment } from '@deepseek-ai/dsh-attachment'
import type { PiAiAdapterOptions } from '@deepseek-ai/dsh-llm-pi-ai'
import { afterEach, expect, it, vi } from 'vitest'
import { MuseModels } from '../src/models.ts'

const captured = vi.hoisted(() => ({ options: undefined as PiAiAdapterOptions | undefined }))
vi.mock('@deepseek-ai/dsh-llm-pi-ai', async (original) => {
  const actual = await original<typeof import('@deepseek-ai/dsh-llm-pi-ai')>()
  return { ...actual, PiAiAdapter: class extends actual.PiAiAdapter {
    constructor(options: PiAiAdapterOptions) { super(options); captured.options = options }
  } }
})
afterEach(() => { vi.unstubAllEnvs() })

it('keeps the account adapter outside provider credential storage and ambient authentication', async () => {
  const context = new Context()
  await context.plugin(LlmRuntime)
  const owner = new MuseModels(context, { baseUrl: 'https://muse.example', sessionFile: '/unused/account/session.json', requestTimeoutMs: 1000 })
  try {
    const options = captured.options
    if (!options) throw new Error('Adapter options were not supplied')
    vi.stubEnv('MUSE_AUTH_TEST_TOKEN', 'ambient-private-token')
    expect(await options.auth.credentials.read('provider')).toBeUndefined()
    expect(await options.auth.credentials.list()).toEqual([])
    await expect(options.auth.credentials.modify('provider', async () => undefined)).rejects.toThrow('managed by account login')
    await expect(options.auth.credentials.delete('provider')).resolves.toBeUndefined()
    expect(await options.auth.authContext.env('MUSE_AUTH_TEST_TOKEN')).toBeUndefined()
    expect(await options.auth.authContext.fileExists('/private/provider/credentials')).toBe(false)
  } finally { await owner.dispose(); await context.fiber.dispose() }
})

it('resolves attachments mounted after the account adapter and exposes no execution path mapping', async () => {
  const context = new Context()
  await context.plugin(LlmRuntime)
  const owner = new MuseModels(context, { baseUrl: 'https://muse.example', sessionFile: '/unused/account/session.json', requestTimeoutMs: 1000 })
  const ref: ImageAttachmentRef = { attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`), mediaType: 'image/png', bytes: 1, width: 1, height: 1 }
  class Images extends AttachmentStore {
    readonly imageLimits = { maxImageBytes: 1, maxImagesPerMessage: 1, maxMessageImageBytes: 1,
      maxImagePixels: 1, maxImageDimension: 1, mediaTypes: ['image/png'] as const }
    validateImage(_input: SaveImageAttachment) { return Promise.resolve() }
    saveImage(_input: SaveImageAttachment) { return Promise.resolve(ref) }
    readImage(_ref: ImageAttachmentRef): Promise<StoredImageAttachment> { return Promise.resolve({ ref, data: Uint8Array.of(1) }) }
    override imageHostPath(_ref: ImageAttachmentRef) { return '/private/images/object' }
  }
  try {
    const options = captured.options
    if (!options) throw new Error('Adapter options were not supplied')
    expect(options.resolveAttachments?.()).toBeUndefined()
    await context.plugin(Images)
    const images = options.resolveAttachments?.()
    expect(images).toBeInstanceOf(Images)
    if (!images) throw new Error('Late-mounted attachment provider was not found')
    expect(options.resolveImageAccess?.(images, ref)).toBeUndefined()
  } finally { await owner.dispose(); await context.fiber.dispose() }
})
