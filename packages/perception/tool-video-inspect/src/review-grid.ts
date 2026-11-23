/** Grid-page delivery of one complete-review batch; every tile remains an individually observed frame. */
import type { Context } from '@deepseek-ai/cordis'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { Config } from './index.ts'
import { contactCellSize, contactPageFits, renderContactPage, type ContactLayout, type ContactTile } from './contact.ts'
import type { ReviewFrame } from './review-state.ts'

/** One extracted batch frame and its stored image. */
export interface ReviewGridCell {
  frame: ReviewFrame
  image: ImageAttachmentRef
}

/** One saved grid page and the frames it tiles, in reading order. */
export interface ReviewGrid {
  frame_ids: string[]
  image: ImageAttachmentRef
}

/**
 * Caption a grid tile with the identity and time that single-frame delivery states.
 * @param frame - Tiled review frame.
 * @returns Frame ID and planned source time.
 */
export function reviewGridLabel(frame: Pick<ReviewFrame, 'id' | 'time'>): string {
  return `${frame.id} ${frame.time}s`
}

/**
 * Tile extracted batch frames into saved grid pages of at most `contactColumns × contactRows` frames. Rows are balanced
 * under the `contactColumns` limit. A page that would hold one frame is not created; that frame keeps single-image delivery.
 * @param ctx - Attachment store holding frame images and receiving grid pages.
 * @param config - Grid geometry, page limits and frame encoding.
 * @param reviewId - Review identity used in saved page names.
 * @param frames - Batch frames in delivery order, each with its extracted image.
 * @param signal - Cancels image reads.
 * @returns Saved pages in delivery order.
 */
export async function renderReviewGrids(ctx: Context, config: Config, reviewId: string,
  frames: readonly ReviewGridCell[], signal: AbortSignal): Promise<ReviewGrid[]> {
  const capacity = config.contactColumns * config.contactRows, grids: ReviewGrid[] = []
  let total = 0
  for (let offset = 0; offset < frames.length; offset += capacity) {
    const cells = frames.slice(offset, offset + capacity)
    if (cells.length < 2) continue
    const page = cells.map(cell => cell.frame)
    const rows = Math.ceil(page.length / config.contactColumns)
    // Frames of one source share an aspect ratio; the tallest one sizes every cell so none is cropped.
    const aspect = Math.max(...cells.map(({ image }) => image.height / image.width))
    const layout: ContactLayout = { columns: Math.ceil(page.length / rows), rows, tileWidth: config.contactTileWidth,
      ...contactCellSize(config.contactTileWidth, 1, aspect) }
    if (!contactPageFits(layout, config.maxContactPixels, ctx.attachments.imageLimits)) {
      throw Error('VIDEO_REVIEW_GRID_LIMIT: 网格页超过maxContactPixels或图片存储尺寸上限；部署需调小contactTileWidth、contactColumns或contactRows。')
    }
    const tiles: ContactTile[] = []
    for (const { frame, image } of cells) {
      tiles.push({ bytes: (await ctx.attachments.readImage(image, signal)).data, label: reviewGridLabel(frame) })
    }
    const png = config.frameFormat === 'png'
    const bytes = await renderContactPage(tiles, layout, config.maxSourcePixels,
      png ? { format: 'png' } : { format: 'jpeg', quality: config.reviewContactJpegQuality })
    total += bytes.length
    if (total > config.maxContactBytes) throw Error('VIDEO_REVIEW_GRID_LIMIT: 本批网格页超过maxContactBytes；部署需调小contactTileWidth或reviewBatchFrames。')
    signal.throwIfAborted()
    const first = page[0] as ReviewFrame, last = page[page.length - 1] as ReviewFrame
    grids.push({ frame_ids: page.map(frame => frame.id), image: await ctx.attachments.saveImage({ data: bytes,
      mediaType: png ? 'image/png' : 'image/jpeg', name: `video-${reviewId}-grid-${first.id}-${last.id}.${config.frameFormat}` }) })
  }
  return grids
}
