// Tracing shared by the character generators (characters.mjs, spider.mjs): a field sampled
// on a square grid, negative inside a region, is cut into closed loops by marching squares
// and written as SVG path data.

// The zero contours of `field`, which holds (n + 1) by (n + 1) samples, rows from the top.
// Loops are in a square from -extent to extent, y up.
export function contours(field, n, extent) {
  const step = (2 * extent) / n
  const at = (i, j) => field[i * (n + 1) + j]
  const point = (i, j, di, dj) => {
    const a = at(i, j)
    const b = at(i + di, j + dj)
    const k = a / (a - b)
    return [-extent + (j + dj * k) * step, extent - (i + di * k) * step]
  }
  const segments = []
  const edge = {
    top: (i, j) => [`h${i},${j}`, () => point(i, j, 0, 1)],
    bottom: (i, j) => [`h${i + 1},${j}`, () => point(i + 1, j, 0, 1)],
    left: (i, j) => [`v${i},${j}`, () => point(i, j, 1, 0)],
    right: (i, j) => [`v${i},${j + 1}`, () => point(i, j + 1, 1, 0)],
  }
  const PAIRS = {
    1: [['left', 'bottom']], 2: [['bottom', 'right']], 3: [['left', 'right']], 4: [['top', 'right']],
    5: [['left', 'top'], ['bottom', 'right']], 6: [['top', 'bottom']], 7: [['left', 'top']], 8: [['left', 'top']],
    9: [['top', 'bottom']], 10: [['left', 'bottom'], ['top', 'right']], 11: [['top', 'right']], 12: [['left', 'right']],
    13: [['bottom', 'right']], 14: [['left', 'bottom']],
  }
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j < n; j += 1) {
      const code = (at(i, j) < 0 ? 8 : 0) | (at(i, j + 1) < 0 ? 4 : 0) | (at(i + 1, j + 1) < 0 ? 2 : 0) | (at(i + 1, j) < 0 ? 1 : 0)
      for (const [a, b] of PAIRS[code] ?? []) segments.push([edge[a](i, j), edge[b](i, j)])
    }
  }
  const byEdge = new Map()
  segments.forEach(([a, b], index) => {
    for (const [key] of [a, b]) byEdge.set(key, [...(byEdge.get(key) ?? []), index])
  })
  const used = new Set()
  const loops = []
  for (let start = 0; start < segments.length; start += 1) {
    if (used.has(start)) continue
    const loop = []
    let index = start
    let [[fromKey, fromPoint], [toKey]] = segments[start]
    loop.push(fromPoint())
    for (;;) {
      used.add(index)
      const [a, b] = segments[index]
      const [nextKey, nextPoint] = a[0] === fromKey ? b : a
      loop.push(nextPoint())
      fromKey = nextKey
      const next = (byEdge.get(nextKey) ?? []).find(other => !used.has(other))
      if (next === undefined) break
      index = next
    }
    void toKey
    if (loop.length > 8) loops.push(loop)
  }
  return loops
}

export function simplify(points, tolerance) {
  if (points.length < 3) return points
  const [a, b] = [points[0], points.at(-1)]
  let far = 0
  let index = 0
  for (let i = 1; i < points.length - 1; i += 1) {
    const p = points[i]
    const dx = b[0] - a[0]
    const dy = b[1] - a[1]
    const l = Math.hypot(dx, dy) || 1
    const d = Math.abs(dy * p[0] - dx * p[1] + b[0] * a[1] - b[1] * a[0]) / l
    if (d > far) { far = d; index = i }
  }
  if (far <= tolerance) return [a, b]
  return [...simplify(points.slice(0, index + 1), tolerance).slice(0, -1), ...simplify(points.slice(index), tolerance)]
}

// Path data for loops, each point moved into the drawing's box by `place` and the loop
// thinned to within `tolerance` of its traced line. Points sit on a grid of `per` to the unit.
export const pathOf = (loops, place, tolerance, per = 10) => loops.map((loop) => {
  // A closed loop starts and ends on the same point, so split it at its far side
  // before simplifying; otherwise every point is "on" the zero-length chord.
  const ring = loop.map(place)
  const far = ring.reduce((best, p, i) => (Math.hypot(p[0] - ring[0][0], p[1] - ring[0][1]) > Math.hypot(ring[best][0] - ring[0][0], ring[best][1] - ring[0][1]) ? i : best), 0)
  const points = [...simplify(ring.slice(0, far + 1), tolerance).slice(0, -1), ...simplify(ring.slice(far), tolerance)].slice(0, -1)
  // Relative steps on the grid keep the strings short; rounding the running point
  // rather than each step stops the error from adding up around the loop.
  const grid = points.map(([x, y]) => [Math.round(x * per), Math.round(y * per)])
  const steps = grid.slice(1).map(([x, y], k) => [x - grid[k][0], y - grid[k][1]]).filter(([dx, dy]) => dx || dy)
  const num = v => (v < 0 ? '-' : ' ') + String(Math.abs(v) / per).replace(/^0\./, '.')
  return `M${grid[0][0] / per} ${grid[0][1] / per}l${steps.map(([dx, dy]) => `${num(dx)}${num(dy)}`).join('').trim()}z`
}).join('')
