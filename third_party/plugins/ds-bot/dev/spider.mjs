// Traces the Muse spider artwork into the layers of src/client/muse-spider.js. The artwork
// is a cel-shaded picture in one purple: a base tone, darker regions (crisp shadows and a
// few soft falloffs) and lighter regions (the gloss streak and the lit leg faces). The trace
// keeps the drawing and drops the color: the outline is filled with the Bot's color, the
// darker regions are nested translucent steps laid over it, and the lighter regions are one
// translucent layer. The layers' colors and opacities are measured, so that on the
// artwork's own purple they give the artwork's tones: a run of steps shares the color its
// tones lead to, and each step's opacity brings the tone under it to the artwork's tone
// there. The painted eyes are left out; the character system draws them on top.
//
//   node dev/spider.mjs               prints the SPIDER block for src/client/muse-spider.js
//   node dev/spider.mjs --check       also prints how far the layers are from the artwork
//   node dev/spider.mjs <artwork.png> traces another copy (8-bit RGBA, square, eyes painted in)
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { inflateSync } from 'node:zlib'
import { contours, pathOf } from './trace.mjs'

// The approved artwork, 800 by 800. Its square is the character's 100-unit box.
export const ARTWORK = fileURLToPath(new URL('../../../../packages/client/ui-muse-market/src/client/assets/muse-purple-spider.png', import.meta.url))

// Where the darker regions are cut, as shares of the way from the base tone along the
// artwork's own darkening until a channel reaches zero. The crisp cuts sit in the gaps
// between the artwork's flat tones: the shadows start at the first, the deepest shadows
// at the second. The soft cuts follow the falloffs toward the shadows and the slow change
// inside them, close enough together that no step shows.
const SOFT_CUTS = [0.011, 0.02, 0.032, 0.044, 0.056, 0.068, 0.08, 0.092, 0.104, 0.218, 0.243]
const CRISP_CUTS = [0.15, 0.31]
// How closely a path follows its traced line, in box units, and its points' grid to the
// unit: crisp edges are kept to a hundredth, soft falloffs to the other characters' tenth.
const CRISP = [0.03, 100]
const SOFT = [0.2, 10]

/**
 * Reads an 8-bit RGB or RGBA PNG without interlacing.
 * @param {string} file - Path of the PNG.
 * @returns {{ width: number, height: number, pixels: Uint8Array }} RGBA rows from the top.
 */
export function readPng(file) {
  const data = readFileSync(file)
  let header
  const parts = []
  for (let offset = 8; offset < data.length;) {
    const length = data.readUInt32BE(offset)
    const type = data.toString('latin1', offset + 4, offset + 8)
    const body = data.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') header = { width: body.readUInt32BE(0), height: body.readUInt32BE(4), depth: body[8], color: body[9], interlace: body[12] }
    if (type === 'IDAT') parts.push(body)
    offset += 12 + length
  }
  if (!header || header.depth !== 8 || ![2, 6].includes(header.color) || header.interlace) throw new Error(`${file}: expected an 8-bit RGB or RGBA PNG without interlacing`)
  const { width, height } = header
  const channels = header.color === 6 ? 4 : 3
  const stride = width * channels
  const raw = inflateSync(Buffer.concat(parts))
  const pixels = new Uint8Array(width * height * 4).fill(255)
  let above = new Uint8Array(stride)
  let line = new Uint8Array(stride)
  for (let y = 0; y < height; y += 1) {
    const start = y * (stride + 1)
    const filter = raw[start]
    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? line[x - channels] : 0
      const up = above[x]
      const corner = x >= channels ? above[x - channels] : 0
      let predicted = 0
      if (filter === 1) predicted = left
      else if (filter === 2) predicted = up
      else if (filter === 3) predicted = (left + up) >> 1
      else if (filter === 4) {
        const p = left + up - corner
        const [pa, pb, pc] = [Math.abs(p - left), Math.abs(p - up), Math.abs(p - corner)]
        predicted = pa <= pb && pa <= pc ? left : pb <= pc ? up : corner
      }
      line[x] = (raw[start + 1 + x] + predicted) & 255
    }
    for (let x = 0; x < width; x += 1) for (let c = 0; c < channels; c += 1) pixels[(y * width + x) * 4 + c] = line[x * channels + c]
    ;[above, line] = [line, above]
  }
  return { width, height, pixels }
}

const luma = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b
const hex = color => `#${color.map(v => Math.round(v).toString(16).padStart(2, '0')).join('')}`
const median = (values) => { const sorted = Float64Array.from(values).sort(); return sorted[sorted.length >> 1] ?? 0 }

// What the trace reads off the artwork: per pixel, how far it is inside the outline, whether
// it belongs to a painted eye, and how far its tone is from the base toward dark and toward white.
function tones({ width, height, pixels }) {
  if (width !== height) throw new Error('the artwork must be square')
  const size = width
  const count = size * size
  const inside = new Float64Array(count)
  const y = new Float64Array(count)
  for (let k = 0; k < count; k += 1) {
    inside[k] = pixels[k * 4 + 3] / 255
    y[k] = luma(pixels[k * 4], pixels[k * 4 + 1], pixels[k * 4 + 2])
  }
  const solid = k => inside[k] > 0.98
  // The painted eyes (far darker than any tone, with a white glint) and the rim around
  // them count as the base tone.
  const eye = new Uint8Array(count)
  for (let k = 0; k < count; k += 1) {
    if (!solid(k) || (y[k] > 60 && y[k] < 200)) continue
    const [row, col] = [Math.floor(k / size), k % size]
    for (let i = Math.max(0, row - 3); i <= Math.min(size - 1, row + 3); i += 1) for (let j = Math.max(0, col - 3); j <= Math.min(size - 1, col + 3); j += 1) eye[i * size + j] = 1
  }
  // The base tone: the commonest lightness inside the outline.
  const bins = new Uint32Array(256)
  for (let k = 0; k < count; k += 1) if (solid(k) && !eye[k]) bins[Math.round(y[k])] += 1
  const peak = bins.indexOf(Math.max(...bins))
  const base = [0, 0, 0]
  let basePixels = 0
  for (let k = 0; k < count; k += 1) {
    if (!solid(k) || eye[k] || Math.abs(y[k] - peak) > 1.5) continue
    for (let c = 0; c < 3; c += 1) base[c] += pixels[k * 4 + c]
    basePixels += 1
  }
  for (let c = 0; c < 3; c += 1) base[c] /= basePixels
  // The artwork's own darkening: the first principal axis of base minus pixel, continued
  // until a channel reaches zero.
  const spread = [[0, 0, 0], [0, 0, 0], [0, 0, 0]]
  for (let k = 0; k < count; k += 1) {
    if (!solid(k) || eye[k] || y[k] > peak - 8) continue
    const v = [0, 1, 2].map(c => base[c] - pixels[k * 4 + c])
    for (let a = 0; a < 3; a += 1) for (let b = 0; b < 3; b += 1) spread[a][b] += v[a] * v[b]
  }
  let axis = [1, 1, 1]
  for (let round = 0; round < 60; round += 1) {
    const next = spread.map(row => row[0] * axis[0] + row[1] * axis[1] + row[2] * axis[2])
    const length = Math.hypot(...next)
    axis = next.map(v => v / length)
  }
  const reach = Math.min(...axis.map((v, c) => base[c] / v))
  const toShade = axis.map(v => -v * reach)
  const toWhite = base.map(v => 255 - v)
  const along = (k, direction) => {
    let dot = 0
    let length = 0
    for (let c = 0; c < 3; c += 1) {
      dot += (pixels[k * 4 + c] - base[c]) * direction[c]
      length += direction[c] * direction[c]
    }
    return Math.max(0, Math.min(1, dot / length))
  }
  const shade = new Float64Array(count)
  const light = new Float64Array(count)
  for (let k = 0; k < count; k += 1) {
    if (!solid(k) || eye[k]) continue
    shade[k] = along(k, toShade)
    light[k] = along(k, toWhite)
  }
  // A pixel on the antialiased outline takes the tones of the nearest pixel inside, so a
  // region that reaches the outline ends on it.
  for (let k = 0; k < count; k += 1) {
    if (solid(k) || inside[k] === 0) continue
    const [row, col] = [Math.floor(k / size), k % size]
    let best = Infinity
    for (let i = Math.max(0, row - 3); i <= Math.min(size - 1, row + 3); i += 1) {
      for (let j = Math.max(0, col - 3); j <= Math.min(size - 1, col + 3); j += 1) {
        const other = i * size + j
        const far = (i - row) ** 2 + (j - col) ** 2
        if (!solid(other) || far >= best) continue
        best = far
        shade[k] = shade[other]
        light[k] = light[other]
      }
    }
  }
  return { size, pixels, inside, eye, shade, light }
}

// The artwork's soft falloffs carry a little grain, which would fray their steps. Each
// pixel takes the mean of the nearby pixels of about its own tone, so the grain goes and a
// crisp edge stays where it is.
function settle(field, size, radius = 6, range = 0.03) {
  const out = new Float64Array(field.length)
  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) {
      const own = field[row * size + col]
      let sum = 0
      let weight = 0
      for (let i = Math.max(0, row - radius); i <= Math.min(size - 1, row + radius); i += 1) {
        for (let j = Math.max(0, col - radius); j <= Math.min(size - 1, col + radius); j += 1) {
          const value = field[i * size + j]
          if (Math.abs(value - own) > range) continue
          sum += value
          weight += 1
        }
      }
      out[row * size + col] = sum / weight
    }
  }
  return out
}

const area = loop => Math.abs(loop.reduce((sum, [x, y], k) => { const [nx, ny] = loop[(k + 1) % loop.length]; return sum + x * ny - nx * y }, 0)) / 2

// One color for a run of steps: the line from the tone `start` through the steps' tones,
// continued until a channel leaves the color range. Laid over `start` at a tone's share
// of the way, the color gives that tone (exactly so for a run of one).
function lineThrough(start, tones) {
  const lead = [0, 1, 2].map(c => tones.reduce((sum, tone) => sum + tone[c] - start[c], 0))
  const reach = Math.min(...lead.map((v, c) => (v < 0 ? start[c] / -v : v > 0 ? (255 - start[c]) / v : Infinity)))
  const color = lead.map((v, c) => Math.round(start[c] + v * reach))
  const toColor = color.map((v, c) => v - start[c])
  const length = toColor.reduce((sum, v) => sum + v * v, 0)
  return { color, toColor, shares: tones.map(tone => toColor.reduce((sum, v, c) => sum + v * (tone[c] - start[c]), 0) / length) }
}

/**
 * Traces the artwork.
 * @param {string} [file] - The artwork PNG; the approved copy when omitted.
 * @returns {{ base: string, body: string, layers: Array<[string, string, number]> }} The
 * artwork's base color, the outline, and the overlays [path, color, opacity] in paint order.
 */
export function trace(file = ARTWORK) {
  const { size, pixels, inside, eye, shade, light } = tones(readPng(file))
  const n = size - 1
  const unit = 100 / size
  // Samples sit on pixel centers; a loop point (x, y up, origin in the middle) goes to the box.
  const place = ([x, y]) => [(x + n / 2 + 0.5) * unit, (n / 2 - y + 0.5) * unit]
  const outline = inside.map(value => 0.5 - value)
  // A region never passes the outline: its field is the outline's field where it applies.
  const region = (field, level, precision) => {
    const loops = contours(field.map((value, k) => Math.max(outline[k], level - value)), n, n / 2).filter(loop => area(loop) * unit * unit > 0.2)
    return pathOf(loops, place, ...precision)
  }
  // The middle tone of the pixels that `member` picks.
  const toneOf = (member) => {
    const picked = []
    for (let k = 0; k < shade.length; k += 1) if (inside[k] > 0.98 && !eye[k] && member(k)) picked.push(k)
    return picked.length ? [0, 1, 2].map(c => median(picked.map(k => pixels[k * 4 + c]))) : undefined
  }
  const settled = settle(shade, size)
  const cuts = [...SOFT_CUTS, ...CRISP_CUTS].sort((a, b) => a - b)
  const crisp = level => CRISP_CUTS.includes(level)
  const lit = []
  for (let k = 0; k < light.length; k += 1) if (inside[k] > 0.98 && light[k] > 0.1) lit.push(light[k])
  const gloss = median(lit) / 2
  const base = toneOf(k => settled[k] < cuts[0] && light[k] < gloss)
  const bands = cuts.map((level, index) => toneOf(k => settled[k] >= level && settled[k] < (cuts[index + 1] ?? Infinity)))
  // A crisp cut starts a new run of steps, and a run shares one color.
  const runs = []
  cuts.forEach((level, index) => {
    if (!bands[index]) return
    if (runs.length === 0 || crisp(level)) runs.push([])
    runs.at(-1).push(index)
  })
  const layers = []
  let under = base
  for (const run of runs) {
    const start = under
    const { color, toColor, shares } = lineThrough(start, run.map(index => bands[index]))
    let covered = 0
    run.forEach((index, position) => {
      const opacity = +(1 - (1 - shares[position]) / (1 - covered)).toFixed(3)
      const path = opacity >= 0.004 && region(settled, cuts[index], crisp(cuts[index]) ? CRISP : SOFT)
      if (!path) return
      layers.push([path, hex(color), opacity])
      covered = 1 - (1 - covered) * (1 - opacity)
      under = start.map((v, c) => v + toColor[c] * covered)
    })
  }
  const shine = lineThrough(base, [toneOf(k => light[k] >= gloss)])
  layers.push([region(light, gloss, CRISP), hex(shine.color), +shine.shares[0].toFixed(3)])
  return { base: hex(base), body: pathOf(contours(outline, n, n / 2), place, ...CRISP), layers }
}

// The loops of path data written by pathOf: "M x y l dx dy ... z" with relative steps.
function loopsOf(d) {
  return d.split('M').filter(Boolean).map((part) => {
    const numbers = part.match(/-?\d*\.?\d+/g).map(Number)
    const points = [[numbers[0], numbers[1]]]
    for (let k = 2; k + 1 < numbers.length; k += 2) points.push([points.at(-1)[0] + numbers[k], points.at(-1)[1] + numbers[k + 1]])
    return points
  })
}

// Even-odd coverage of path data on a size by size grid over the 100-unit box, from
// `fine` scanlines per pixel row with exact horizontal spans.
function coverage(d, size, fine = 4) {
  const cover = new Float64Array(size * size)
  const scale = size / 100
  const edges = loopsOf(d).flatMap(loop => loop.map(([x, y], k) => { const [nx, ny] = loop[(k + 1) % loop.length]; return [x * scale, y * scale, nx * scale, ny * scale] })).filter(([, y0, , y1]) => y0 !== y1)
  for (let line = 0; line < size * fine; line += 1) {
    const y = (line + 0.5) / fine
    const row = Math.floor(line / fine)
    const crossings = []
    for (const [x0, y0, x1, y1] of edges) if ((y0 <= y) !== (y1 <= y)) crossings.push(x0 + ((y - y0) * (x1 - x0)) / (y1 - y0))
    crossings.sort((a, b) => a - b)
    for (let k = 0; k + 1 < crossings.length; k += 2) {
      const [from, to] = [Math.max(0, crossings[k]), Math.min(size, crossings[k + 1])]
      for (let col = Math.floor(from); col < to; col += 1) cover[row * size + col] += (Math.min(to, col + 1) - Math.max(from, col)) / fine
    }
  }
  return cover
}

/**
 * Draws traced layers in the artwork's own base color and compares them with the artwork,
 * pixel by pixel at the artwork's size. The painted eyes are left out of the color figures.
 * @param {{ base: string, body: string, layers: Array<[string, string, number]> }} spider - A trace.
 * @param {string} [file] - The artwork PNG.
 * @returns {{ overlap: number, mean: number, p99: number, worst: number }} The share of the
 * two outlines' union that both cover, and the largest channel difference per pixel inside
 * both (mean, 99th percentile and maximum, in 0..255 levels).
 */
export function fidelity(spider, file = ARTWORK) {
  const picture = readPng(file)
  const { size, inside, eye } = tones(picture)
  const rgb = value => (value.length === 4 ? [1, 2, 3].map(k => parseInt(value[k] + value[k], 16)) : [1, 3, 5].map(k => parseInt(value.slice(k, k + 2), 16)))
  const body = coverage(spider.body, size)
  const color = new Float64Array(size * size * 3)
  const baseColor = rgb(spider.base)
  for (let k = 0; k < size * size; k += 1) for (let c = 0; c < 3; c += 1) color[k * 3 + c] = baseColor[c]
  for (const [d, fill, opacity] of spider.layers) {
    const cover = coverage(d, size)
    const paint = rgb(fill)
    for (let k = 0; k < size * size; k += 1) {
      const share = cover[k] * opacity
      if (share) for (let c = 0; c < 3; c += 1) color[k * 3 + c] += (paint[c] - color[k * 3 + c]) * share
    }
  }
  let both = 0
  let either = 0
  const differences = []
  for (let k = 0; k < size * size; k += 1) {
    const [drawn, painted] = [body[k] >= 0.5, inside[k] >= 0.5]
    if (drawn && painted) both += 1
    if (drawn || painted) either += 1
    if (body[k] < 0.98 || inside[k] < 0.98 || eye[k]) continue
    differences.push(Math.max(...[0, 1, 2].map(c => Math.abs(color[k * 3 + c] - picture.pixels[k * 4 + c]))))
  }
  const sorted = Float64Array.from(differences).sort()
  return { overlap: both / either, mean: sorted.reduce((sum, v) => sum + v, 0) / sorted.length, p99: sorted[Math.floor(sorted.length * 0.99)], worst: sorted.at(-1) }
}

/**
 * The trace as source text.
 * @param {{ base: string, body: string, layers: Array<[string, string, number]> }} spider - A trace.
 * @returns {string} The SPIDER block of src/client/muse-spider.js.
 */
export function block(spider) {
  const quote = value => JSON.stringify(value).replaceAll('"', "'")
  return `export const SPIDER = {\n  base: ${quote(spider.base)},\n  body: ${quote(spider.body)},\n  layers: [\n${spider.layers.map(layer => `    ${quote(layer)},`).join('\n')}\n  ],\n}`
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const file = process.argv.slice(2).find(arg => !arg.startsWith('--'))
  const spider = trace(file)
  console.log(block(spider))
  if (process.argv.includes('--check')) {
    const { overlap, mean, p99, worst } = fidelity(spider, file)
    console.error(`outline overlap ${(overlap * 100).toFixed(2)}%, color difference mean ${mean.toFixed(2)}, 99th percentile ${p99.toFixed(1)}, largest ${worst.toFixed(0)} (of 255)`)
  }
}
