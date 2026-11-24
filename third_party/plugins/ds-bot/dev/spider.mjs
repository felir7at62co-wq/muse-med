// Traces the Muse spider artwork into the parts of src/client/muse-spider.js. The artwork
// is a cel-shaded picture in one purple: a base tone, darker regions (crisp shadows and a
// few soft falloffs) and lighter regions (the gloss streak and the lit leg faces). The trace
// keeps the drawing and drops the color: an outline is filled with the Bot's color, the
// darker regions are nested translucent steps laid over it, and the lighter regions are one
// translucent layer. The steps' colors and opacities are measured, so that on the
// artwork's own purple they give the artwork's tones: a run of steps shares the color its
// tones lead to, and each step's opacity brings the tone under it to the artwork's tone
// there. The painted eyes are left out; the character system draws them on top.
//
// The drawing comes apart into the torso and six legs, so the legs can move. A leg is an
// ellipse in the artwork. A part that lies under another one is completed there (the torso
// under the near legs, a far leg under the torso), so at rest the parts give the same
// picture as the whole, and nothing opens when a leg moves.
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

// The legs that move, back to front, with where the artwork shows each one's edge (box
// units): `outline` is a box whose stretch of the artwork's outline is the leg's own edge,
// and `rim` is a point on the leg's lit rim, whose outer edge is the leg's edge too. A far
// leg with `behind` passes behind the dome: where the dome's outline, continued, covers
// plain base tone inside the leg's ellipse, that is the torso.
const LEGS = [
  { id: 'far-upper', outline: [7.5, 41.25, 16, 52.5], behind: true },
  { id: 'far-lower', outline: [2.5, 55, 15, 71.25] },
  { id: 'far-right', outline: [90.75, 50, 98.75, 65], behind: true },
  { id: 'near-left', near: true, rim: [25.4, 56.2], outline: [26.25, 76.25, 36.25, 100] },
  { id: 'near-right', near: true, rim: [89.9, 59.4], outline: [78.125, 76.25, 89.375, 100] },
  { id: 'near-middle', near: true, rim: [53.4, 61.4], outline: [43.125, 78.125, 58.75, 100] },
]
// No leg touches the dome's outline above this line.
const DOME_ABOVE = 41.25
// How far past its fitted ellipse a leg reaches, in artwork pixels: a near leg takes its
// whole antialiased edge with it, and a far leg also the thin strips of the artwork that lie
// between two legs.
const PAD = { near: 1.5, far: 4 }
// A far leg's root under the torso: its ellipse moved toward the middle of the dome by this
// share of its long half axis, and this many times as large.
const ROOT = { shift: 0.55, grow: 1.45 }

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

// The convex hull of points, counterclockwise in pixel coordinates (y down).
function hullOf(points) {
  const sorted = [...points].sort((p, q) => p[0] - q[0] || p[1] - q[1])
  const turn = (o, p, q) => (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0])
  const chain = (list) => {
    const out = []
    for (const p of list) {
      while (out.length >= 2 && turn(out.at(-2), out.at(-1), p) <= 0) out.pop()
      out.push(p)
    }
    return out.slice(0, -1)
  }
  return [...chain(sorted), ...chain(sorted.reverse())]
}

// The ellipse through points, by least squares on a conic about their mean. `reach(x, y)`
// is 1 on the ellipse and less inside; `a` and `b` are the half axes and [ux, uy] is the
// direction of the long one.
function ellipseThrough(points) {
  const mx = points.reduce((sum, p) => sum + p[0], 0) / points.length
  const my = points.reduce((sum, p) => sum + p[1], 0) / points.length
  const normal = Array.from({ length: 5 }, () => new Float64Array(6))
  for (const [px, py] of points) {
    const [x, y] = [px - mx, py - my]
    const row = [x * x, x * y, y * y, x, y]
    for (let i = 0; i < 5; i += 1) {
      for (let j = 0; j < 5; j += 1) normal[i][j] += row[i] * row[j]
      normal[i][5] += row[i]
    }
  }
  for (let i = 0; i < 5; i += 1) {
    let pivot = i
    for (let r = i + 1; r < 5; r += 1) if (Math.abs(normal[r][i]) > Math.abs(normal[pivot][i])) pivot = r
    ;[normal[i], normal[pivot]] = [normal[pivot], normal[i]]
    for (let r = 0; r < 5; r += 1) {
      if (r === i) continue
      const factor = normal[r][i] / normal[i][i]
      for (let j = i; j < 6; j += 1) normal[r][j] -= factor * normal[i][j]
    }
  }
  const [A, B, C, D, E] = normal.map((row, i) => row[5] / row[i])
  const det = 4 * A * C - B * B
  const [cx, cy] = [(-2 * C * D + B * E) / det, (-2 * A * E + B * D) / det]
  const k = 1 - (A * cx * cx + B * cx * cy + C * cy * cy + D * cx + E * cy)
  const [qa, qb, qc] = [A / k, B / (2 * k), C / k]
  const mid = (qa + qc) / 2
  const swing = Math.hypot((qa - qc) / 2, qb)
  const [a, b] = [1 / Math.sqrt(mid - swing), 1 / Math.sqrt(mid + swing)]
  const axis = Math.abs(qb) > 1e-12 ? [qb, mid - swing - qa] : qa < qc ? [1, 0] : [0, 1]
  const length = Math.hypot(...axis)
  const reach = (x, y) => { const [dx, dy] = [x - mx - cx, y - my - cy]; return Math.sqrt(qa * dx * dx + 2 * qb * dx * dy + qc * dy * dy) }
  return { cx: mx + cx, cy: my + cy, a, b, ux: axis[0] / length, uy: axis[1] / length, reach }
}

// Fills `value` where `open` is set from the values around it, by repeated averaging inside
// `member`: how a part is completed where another part covers it in the artwork.
function complete(value, member, open, size) {
  const list = []
  let sum = 0
  let known = 0
  for (let k = 0; k < value.length; k += 1) {
    if (!member[k]) continue
    if (open[k]) list.push(k)
    else { sum += value[k]; known += 1 }
  }
  const start = known ? sum / known : 0
  for (const k of list) value[k] = start
  for (let sweep = 0; sweep < 240; sweep += 1) {
    for (let at = 0; at < list.length; at += 1) {
      const k = list[sweep % 2 ? list.length - 1 - at : at]
      let total = 0
      let count = 0
      for (const other of [k - 1, k + 1, k - size, k + size]) {
        if (other < 0 || other >= value.length || !member[other]) continue
        total += value[other]
        count += 1
      }
      if (count) value[k] = total / count
    }
  }
}

/**
 * Traces the artwork.
 * @param {string} [file] - The artwork PNG; the approved copy when omitted.
 * @returns {{ base: string, body: string, steps: Array<[string, number]>, layers: string[], parts: Array<{ id: string, pivot?: [number, number], near?: boolean, body: string, layers: string[] }> }}
 * The artwork's base color; the whole outline; the overlays' [color, opacity] in paint order
 * and the whole drawing's path for each; and the same drawing in parts, back to front, each
 * with its outline and one path (or '') per overlay. A leg has the point it turns about.
 */
export function trace(file = ARTWORK) {
  const { size, pixels, inside, eye, shade, light } = tones(readPng(file))
  const count = size * size
  const n = size - 1
  const unit = 100 / size
  // Samples sit on pixel centers; a loop point (x, y up, origin in the middle) goes to the box.
  const place = ([x, y]) => [(x + n / 2 + 0.5) * unit, (n / 2 - y + 0.5) * unit]
  const outline = inside.map(value => 0.5 - value)
  const pathIn = (field, precision) => pathOf(contours(field, n, n / 2).filter(loop => area(loop) * unit * unit > 0.2), place, ...precision)
  // The middle tone of the pixels that `member` picks.
  const toneOf = (member) => {
    const picked = []
    for (let k = 0; k < count; k += 1) if (inside[k] > 0.98 && !eye[k] && member(k)) picked.push(k)
    return picked.length ? [0, 1, 2].map(c => median(picked.map(k => pixels[k * 4 + c]))) : undefined
  }
  const settled = settle(shade, size)
  const cuts = [...SOFT_CUTS, ...CRISP_CUTS].sort((a, b) => a - b)
  const crisp = level => CRISP_CUTS.includes(level)
  const lit = []
  for (let k = 0; k < count; k += 1) if (inside[k] > 0.98 && light[k] > 0.1) lit.push(light[k])
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
  // The overlays in paint order: [the field it is cut from, the level, precision, color, opacity].
  const overlays = []
  let under = base
  for (const run of runs) {
    const start = under
    const { color, toColor, shares } = lineThrough(start, run.map(index => bands[index]))
    let covered = 0
    run.forEach((index, position) => {
      const opacity = +(1 - (1 - shares[position]) / (1 - covered)).toFixed(3)
      if (!(opacity >= 0.004)) return
      overlays.push(['shade', cuts[index], crisp(cuts[index]) ? CRISP : SOFT, hex(color), opacity])
      covered = 1 - (1 - covered) * (1 - opacity)
      under = start.map((v, c) => v + toColor[c] * covered)
    })
  }
  const shine = lineThrough(base, [toneOf(k => light[k] >= gloss)])
  overlays.push(['light', gloss, CRISP, hex(shine.color), +shine.shares[0].toFixed(3)])

  // The legs. Edge points come from the artwork's outline and from the lit rims.
  const [colOf, rowOf] = [k => k % size, k => Math.floor(k / size)]
  const edgeOf = member => { const out = []; for (let k = 0; k < count; k += 1) if (member(k) && [k - 1, k + 1, k - size, k + size].some(other => other < 0 || other >= count || !member(other))) out.push([colOf(k), rowOf(k)]); return out }
  const outlinePoints = edgeOf(k => inside[k] >= 0.5)
  const within = ([x0, y0, x1, y1]) => outlinePoints.filter(([x, y]) => x * unit > x0 && x * unit < x1 && y * unit > y0 && y * unit < y1)
  const bright = k => inside[k] >= 0.5 && !eye[k] && light[k] >= gloss
  const rimOf = ([x, y]) => {
    const seed = Math.round(y / unit) * size + Math.round(x / unit)
    if (!bright(seed)) throw new Error(`no lit rim at ${x}, ${y}`)
    const seen = new Uint8Array(count)
    const queue = [seed]
    seen[seed] = 1
    for (let at = 0; at < queue.length; at += 1) for (const other of [queue[at] - 1, queue[at] + 1, queue[at] - size, queue[at] + size]) if (other >= 0 && other < count && !seen[other] && bright(other)) { seen[other] = 1; queue.push(other) }
    return hullOf(edgeOf(k => seen[k] === 1))
  }
  const dome = ellipseThrough(outlinePoints.filter(([, y]) => y * unit < DOME_ABOVE))
  const legs = LEGS.map(leg => ({ ...leg, ...ellipseThrough([...(leg.rim ? rimOf(leg.rim) : []), ...within(leg.outline)]) }))
  // Who owns a pixel of the artwork: the frontmost near leg that reaches it, else the
  // frontmost far leg that shows there, else the torso (0). A far leg shows on the pixels
  // joined to its own stretch of the outline; one that passes behind the dome stops where
  // the dome's outline, continued, covers plain base tone.
  const padOf = leg => (leg.near ? PAD.near : PAD.far)
  const reaches = (leg, k) => leg.reach(colOf(k), rowOf(k)) <= 1 + padOf(leg) / leg.b
  const toned = k => settled[k] >= 0.05 || light[k] >= gloss
  const owner = new Uint8Array(count)
  for (let k = 0; k < count; k += 1) for (let index = legs.length - 1; index >= 0 && !owner[k]; index -= 1) if (legs[index].near && reaches(legs[index], k)) owner[k] = index + 1
  for (let index = legs.length - 1; index >= 0; index -= 1) {
    const leg = legs[index]
    if (leg.near) continue
    const free = k => !owner[k] && reaches(leg, k) && (!leg.behind || toned(k) || dome.reach(colOf(k), rowOf(k)) > 1)
    const queue = within(leg.outline).map(([x, y]) => y * size + x).filter(free)
    for (const k of queue) owner[k] = index + 1
    for (let at = 0; at < queue.length; at += 1) for (const other of [queue[at] - 1, queue[at] + 1, queue[at] - size, queue[at] + size]) if (other >= 0 && other < count && free(other)) { owner[other] = index + 1; queue.push(other) }
  }
  // A leg turns about the end of its long axis that is nearer the middle of the dome. A leg
  // that passes behind the dome turns about the point where its own outline meets the
  // dome's, so the corner between the two stays closed.
  const pivotOf = (leg) => {
    if (leg.behind) return outlinePoints.filter(([x, y]) => owner[y * size + x] === legs.indexOf(leg) + 1).reduce((best, p) => (Math.hypot(p[0] - dome.cx, p[1] - dome.cy) < Math.hypot(best[0] - dome.cx, best[1] - dome.cy) ? p : best))
    const side = Math.sign((dome.cx - leg.cx) * leg.ux + (dome.cy - leg.cy) * leg.uy) || 1
    return [leg.cx + side * 0.7 * leg.a * leg.ux, leg.cy + side * 0.7 * leg.a * leg.uy]
  }
  // A soft edge for a membership, so its traced outline is smooth.
  const soften = (member) => {
    let field = Float64Array.from(member)
    for (let pass = 0; pass < 3; pass += 1) {
      const next = new Float64Array(count)
      for (let k = 0; k < count; k += 1) {
        const [col, row] = [colOf(k), rowOf(k)]
        let sum = 0
        let weight = 0
        for (let i = Math.max(0, row - 3); i <= Math.min(size - 1, row + 3); i += 1) for (let j = Math.max(0, col - 3); j <= Math.min(size - 1, col + 3); j += 1) { sum += field[i * size + j]; weight += 1 }
        next[k] = sum / weight
      }
      field = next
    }
    return field
  }
  // Under a near leg the torso goes on inside the hull of what shows of it (thin strips
  // left out) and of a shoulder around each near leg's pivot, as far as the line between
  // the two points where the leg's stretch of the outline begins and ends.
  const torso = Uint8Array.from(owner, (value, k) => (value === 0 && inside[k] >= 0.5 ? 1 : 0))
  const core = soften(torso)
  const shoulders = legs.filter(leg => leg.near).flatMap(leg => Array.from({ length: 24 }, (_, at) => [pivotOf(leg)[0] + 0.5 * leg.b * Math.cos(at * Math.PI / 12), pivotOf(leg)[1] + 0.5 * leg.b * Math.sin(at * Math.PI / 12)]))
  const hull = hullOf([...edgeOf(k => core[k] > 0.9), ...shoulders])
  const inHull = (x, y) => hull.every(([px, py], at) => { const [qx, qy] = hull[(at + 1) % hull.length]; return (qx - px) * (y - py) - (qy - py) * (x - px) >= 0 })
  for (let k = 0; k < count; k += 1) if (owner[k] === 0) torso[k] = 1
  legs.forEach((leg, index) => {
    if (!leg.near) return
    const own = outlinePoints.filter(([x, y]) => owner[y * size + x] === index + 1)
    // The two ends are the leg's outline points farthest toward the dome on either side of its long axis.
    const across = ([x, y]) => (x - leg.cx) * -leg.uy + (y - leg.cy) * leg.ux
    const side = Math.sign((dome.cx - leg.cx) * leg.ux + (dome.cy - leg.cy) * leg.uy) || 1
    const along = ([x, y]) => side * ((x - leg.cx) * leg.ux + (y - leg.cy) * leg.uy)
    const [[x0, y0], [x1, y1]] = [own.filter(p => across(p) < 0), own.filter(p => across(p) >= 0)].map(list => list.reduce((best, p) => (along(p) > along(best) ? p : best)))
    const inner = Math.sign((x1 - x0) * (dome.cy - y0) - (y1 - y0) * (dome.cx - x0))
    for (let k = 0; k < count; k += 1) if (owner[k] === index + 1 && Math.sign((x1 - x0) * (rowOf(k) - y0) - (y1 - y0) * (colOf(k) - x0)) === inner && inHull(colOf(k), rowOf(k))) torso[k] = 1
  })
  // Each part's field (negative inside), back to front: the far legs, the torso, the near
  // legs. A far leg also has a root: its ellipse again, larger and nearer the middle of the
  // dome, kept to where the torso covers it at rest, so the torso can move without a gap.
  const soft = soften(torso)
  const torsoField = Float64Array.from(outline, (value, k) => Math.max(value, 0.5 - soft[k]))
  const legField = (leg) => {
    const toDome = Math.hypot(dome.cx - leg.cx, dome.cy - leg.cy)
    const [dx, dy] = [((dome.cx - leg.cx) / toDome) * leg.a * ROOT.shift, ((dome.cy - leg.cy) / toDome) * leg.a * ROOT.shift]
    return Float64Array.from(outline, (value, k) => {
      const own = (leg.reach(colOf(k), rowOf(k)) - 1) * leg.b - padOf(leg)
      const root = leg.near ? Infinity : Math.max((leg.reach(colOf(k) - dx, rowOf(k) - dy) - ROOT.grow) * leg.b, torsoField[k])
      return Math.max(value, Math.min(own, root))
    })
  }
  const order = [...legs.filter(leg => !leg.near), { id: 'torso' }, ...legs.filter(leg => leg.near)]
  const fields = order.map(part => (part.id === 'torso' ? torsoField : legField(part)))
  // The part that shows at a pixel when the spider is at rest: the frontmost one there.
  const top = new Int8Array(count).fill(-1)
  for (let k = 0; k < count; k += 1) for (let at = order.length - 1; at >= 0 && top[k] < 0; at -= 1) if (fields[at][k] < 0) top[k] = at
  const parts = order.map((part, at) => {
    const field = fields[at]
    // The part's own tones: the artwork's where the part shows, completed from there under
    // whatever covers it.
    const member = Uint8Array.from(field, value => (value < 0.5 ? 1 : 0))
    const open = Uint8Array.from(member, (inPart, k) => (inPart && top[k] !== at ? 1 : 0))
    const values = { shade: Float64Array.from(settled), light: Float64Array.from(light) }
    complete(values.shade, member, open, size)
    complete(values.light, member, open, size)
    return {
      id: part.id,
      ...(part.reach ? { pivot: pivotOf(part).map(v => +((v + 0.5) * unit).toFixed(1)) } : {}),
      ...(part.near ? { near: true } : {}),
      body: pathIn(field, CRISP),
      // A region never passes its part's outline: its field is the outline's field where it applies.
      layers: overlays.map(([kind, level, precision]) => pathIn(field.map((value, k) => Math.max(value, level - values[kind][k])), precision)),
    }
  })
  // The whole drawing in one piece too, for a mark that does not move its legs.
  const whole = { shade: settled, light }
  return {
    base: hex(base),
    body: pathIn(outline, CRISP),
    steps: overlays.map(([, , , color, opacity]) => [color, opacity]),
    layers: overlays.map(([kind, level, precision]) => pathIn(outline.map((value, k) => Math.max(value, level - whole[kind][k])), precision)),
    parts,
  }
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
 * Draws a trace at rest in the artwork's own base color and compares it with the artwork,
 * pixel by pixel at the artwork's size. The painted eyes are left out of the color figures.
 * @param {{ base: string, steps: Array<[string, number]>, parts: Array<{ body: string, layers: string[] }> }} spider - A trace.
 * @param {string} [file] - The artwork PNG.
 * @returns {{ overlap: number, mean: number, p99: number, worst: number }} The share of the
 * two outlines' union that both cover, and the largest channel difference per pixel inside
 * both (mean, 99th percentile and maximum, in 0..255 levels).
 */
export function fidelity(spider, file = ARTWORK) {
  const picture = readPng(file)
  const { size, inside, eye } = tones(picture)
  const rgb = value => (value.length === 4 ? [1, 2, 3].map(k => parseInt(value[k] + value[k], 16)) : [1, 3, 5].map(k => parseInt(value.slice(k, k + 2), 16)))
  const drawn = new Float64Array(size * size)
  const color = new Float64Array(size * size * 3)
  const paintOver = (d, fill, opacity) => {
    const cover = coverage(d, size)
    const paint = rgb(fill)
    for (let k = 0; k < size * size; k += 1) {
      const share = cover[k] * opacity
      if (share) for (let c = 0; c < 3; c += 1) color[k * 3 + c] += (paint[c] - color[k * 3 + c]) * share
    }
    return cover
  }
  for (const part of spider.parts) {
    const cover = paintOver(part.body, spider.base, 1)
    for (let k = 0; k < size * size; k += 1) drawn[k] += cover[k] * (1 - drawn[k])
    part.layers.forEach((d, index) => { if (d) paintOver(d, ...spider.steps[index]) })
  }
  let both = 0
  let either = 0
  const differences = []
  for (let k = 0; k < size * size; k += 1) {
    const [here, painted] = [drawn[k] >= 0.5, inside[k] >= 0.5]
    if (here && painted) both += 1
    if (here || painted) either += 1
    if (drawn[k] < 0.98 || inside[k] < 0.98 || eye[k]) continue
    differences.push(Math.max(...[0, 1, 2].map(c => Math.abs(color[k * 3 + c] - picture.pixels[k * 4 + c]))))
  }
  const sorted = Float64Array.from(differences).sort()
  return { overlap: both / either, mean: sorted.reduce((sum, v) => sum + v, 0) / sorted.length, p99: sorted[Math.floor(sorted.length * 0.99)], worst: sorted.at(-1) }
}

/**
 * The trace as source text.
 * @param {object} spider - A trace.
 * @returns {string} The SPIDER block of src/client/muse-spider.js.
 */
export function block(spider) {
  const quote = value => JSON.stringify(value).replace(/"(\w+)":/g, '$1:').replaceAll('"', "'")
  return `export const SPIDER = {\n  base: ${quote(spider.base)},\n  body: ${quote(spider.body)},\n  steps: ${quote(spider.steps)},\n  layers: [\n${spider.layers.map(layer => `    ${quote(layer)},`).join('\n')}\n  ],\n  parts: [\n${spider.parts.map(part => `    ${quote(part)},`).join('\n')}\n  ],\n}`
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const file = process.argv.slice(2).find(arg => !arg.startsWith('--'))
  const spider = trace(file)
  console.log(block(spider))
  if (process.argv.includes('--check')) {
    const { overlap, mean, p99, worst } = fidelity(spider, file)
    console.error(`at rest: outline overlap ${(overlap * 100).toFixed(2)}%, color difference mean ${mean.toFixed(2)}, 99th percentile ${p99.toFixed(1)}, largest ${worst.toFixed(0)} (of 255)`)
  }
}
