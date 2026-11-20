/** Read-only browser commands over the Host-owned character reference library. */
import type { Context } from '@deepseek-ai/cordis'
import { CharacterLibraryError } from '@deepseek-ai/dsh-character-library'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {
  CharacterLibraryBrowseRequest, CharacterLibraryBrowseResult, CharacterLibraryImage,
  CharacterLibraryPreviewRequest, CharacterLibraryStatus,
} from './types.ts'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Read-only character library commands available to browser clients. */
    characterLibraryBrowser: CharacterLibraryBrowser
  }
}

/** Browser facade exposing catalog reads and verified previews only. */
export default class CharacterLibraryBrowser extends TypertRemoteService {
  static inject = ['characterLibrary']

  /**
   * Bind browser reads to the composed character library.
   * @param ctx - Host context containing the read-only library service.
   */
  constructor(ctx: Context) {
    super(ctx, 'characterLibraryBrowser')
  }

  /**
   * Report whether the library is available without reading storage.
   * @returns Configured state and the library's read-only status.
   */
  @Remote
  status(): Promise<CharacterLibraryStatus> {
    return Promise.resolve(this.ctx.characterLibrary.status())
  }

  /**
   * Read one bounded catalog page without modifying its metadata.
   * @param request - Collection, search text and optional continuation cursor.
   * @param signal - Caller cancellation.
   * @returns Catalog entries and their next-page cursor.
   */
  @Remote
  async browse(request: CharacterLibraryBrowseRequest, signal: AbortSignal): Promise<CharacterLibraryBrowseResult> {
    return this.read(() => this.ctx.characterLibrary.browse(request, signal))
  }

  /**
   * Read and verify one catalog image without returning a storage location.
   * @param request - Exact catalog identity and optional expected image digest.
   * @param signal - Caller cancellation.
   * @returns Verified image bytes encoded as a data URL and their digest.
   */
  @Remote
  async preview(request: CharacterLibraryPreviewRequest, signal: AbortSignal): Promise<CharacterLibraryImage> {
    return this.read(async () => {
      const image = await this.ctx.characterLibrary.preview(request, signal)
      return { catalogAssetId: image.catalogAssetId,
        dataUrl: `data:${image.contentType};base64,${Buffer.from(image.data).toString('base64')}`,
        sha256: image.sha256 }
    })
  }

  private async read<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation() }
    catch (error) {
      if (error instanceof CharacterLibraryError) {
        throw new RemoteError('character-library/read-failed', 'Character reference could not be read', { code: error.code })
      }
      throw error
    }
  }
}
