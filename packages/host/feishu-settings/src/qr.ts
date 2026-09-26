/**
 * Host-side QR rendering.
 *
 * The browser bundle carries no QR encoder, so the Host turns each registration
 * URL into an SVG data URL the page shows through an ordinary `<img src>`.
 *
 * @module @deepseek-ai/dsh-feishu-settings/qr
 */

import qrcode from 'qrcode-generator'

/** Size of one QR module and of the quiet zone, in SVG units. */
export interface QrRenderOptions {
  /** Edge length of one module. */
  readonly cellSize?: number
  /** Quiet zone width. */
  readonly margin?: number
}

/**
 * Render one URL as an SVG data URL.
 * @param url - the registration URL the platform wants scanned.
 * @param options - module size and quiet zone; defaults suit a settings page.
 * @returns `data:image/svg+xml;base64,…`, safe to place in `img.src`.
 */
export function qrSvgDataUrl(url: string, options: QrRenderOptions = {}): string {
  const code = qrcode(0, 'M')
  code.addData(url)
  code.make()
  const svg = code.createSvgTag({
    cellSize: options.cellSize ?? 4,
    margin: options.margin ?? 8,
    scalable: true,
  })
  return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`
}
