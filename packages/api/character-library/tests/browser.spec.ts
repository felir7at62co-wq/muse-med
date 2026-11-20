/** The browser facade delegates reads and exposes no storage mutation method. */
import { Context } from '@deepseek-ai/cordis'
import { CharacterLibrary, CharacterLibraryError, CharacterLibraryObjectStore } from '@deepseek-ai/dsh-character-library'
import type { CharacterLibraryObjectGet, CharacterLibraryObjectHead, CharacterLibraryObjectListPage, CharacterLibraryObjectListRequest } from '@deepseek-ai/dsh-character-library'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import { expect, it, onTestFinished, vi } from 'vitest'
import CharacterLibraryBrowser from '../src/index.ts'

class EmptyStore extends CharacterLibraryObjectStore {
  status() { return { readConfigured: true, writeConfigured: false } }
  async list(_request: CharacterLibraryObjectListRequest): Promise<CharacterLibraryObjectListPage> {
    return { objects: [], nextCursor: null }
  }
  async head(_key: string): Promise<CharacterLibraryObjectHead | null> { return null }
  async get(_key: string, _maxBytes: number): Promise<CharacterLibraryObjectGet> { throw new Error('No stored object') }
}

function setup() {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  new EmptyStore(ctx)
  const domain = new CharacterLibrary(ctx)
  return { domain, browser: new CharacterLibraryBrowser(ctx) }
}

it('offers only status, bounded catalog browsing and image preview', async () => {
  const { browser } = setup()
  expect(remoteMethods(browser).map(value => value.method).sort()).toEqual(['browse', 'preview', 'status'])
  await expect(browser.status()).resolves.toMatchObject({ configured: true, readOnly: true })
  await expect(browser.browse({ collection: 'ancient', limit: 12 }, new AbortController().signal))
    .resolves.toEqual({ entries: [], nextCursor: null, scanned: 0 })
})

it('encodes verified previews without exposing an object URL', async () => {
  const { browser, domain } = setup()
  const catalogAssetId = 'character:muse-character-reference-qa:portrait-a' as Awaited<ReturnType<typeof domain.preview>>['catalogAssetId']
  const signal = new AbortController().signal
  const preview = vi.spyOn(domain, 'preview').mockResolvedValue({
    catalogAssetId, contentType: 'image/png', data: new Uint8Array([1, 2, 3]), bytes: 3,
    sha256: 'a'.repeat(64), metadataStatus: 'pending_review',
    safety: { canPublish: false, canReuse: false, canBind: false, applyAllowed: false },
  })
  await expect(browser.preview({ catalogAssetId }, signal)).resolves.toEqual({ catalogAssetId,
    dataUrl: 'data:image/png;base64,AQID', sha256: 'a'.repeat(64) })
  expect(preview).toHaveBeenCalledWith({ catalogAssetId }, signal)
})

it('reports a stable catalog failure while preserving unexpected errors', async () => {
  const { browser, domain } = setup()
  const browse = vi.spyOn(domain, 'browse').mockRejectedValue(new CharacterLibraryError('CATALOG_REJECTED', 'browse'))
  await expect(browser.browse({}, new AbortController().signal)).rejects.toMatchObject({
    code: 'character-library/read-failed', details: { code: 'CATALOG_REJECTED' },
  })
  const unexpected = new Error('Unexpected domain failure')
  browse.mockRejectedValue(unexpected)
  await expect(browser.browse({}, new AbortController().signal)).rejects.toBe(unexpected)
})
