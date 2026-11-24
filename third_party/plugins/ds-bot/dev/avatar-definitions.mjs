// Muse: builds src/client/avatar-definitions.js, the default characters as open-bot-avatar
// definitions (one outline in a 0 0 100 100 box and a level eye pair), from the CHARACTERS
// table in src/client/characters.js.
//
//   node dev/avatar-definitions.mjs           writes the module
//   node dev/avatar-definitions.mjs --check   exits 1 when the module differs from a fresh build
//
// The outline is the character's own body. A body reaches 4..96 of its box and the package keeps
// bodies within 6..94 and asks for 8..92, so the outline is scaled about the middle of the box
// until it fits 8..92. The eyes go through the same scaling: the pair sits at the midpoint of the
// character's two capsules, as far apart as their centres, and is drawn as tall as they are.
// A character drawn turned to the right has its far eye at the edge of the body, where the
// package's renderer has no room to move the eyes; there the pair moves the shortest way, on a
// half-unit grid, to where the eyes can look fully left, right, up and down.
//
// How much room the eyes have is the package's own measure. Its public entry does not export it,
// so this script reads the installed files; the package is pinned to one exact version.
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { CHARACTERS, DEFAULT_SHAPES, SHAPES } from '../src/client/characters.js'
import { analyzeBody, drawnEyesFit, eyesFit, gazeRange } from '../node_modules/open-bot-avatar/dist/validate.js'
import { boostedEyeScale } from '../node_modules/open-bot-avatar/dist/volume.js'

const OUTPUT = fileURLToPath(new URL('../src/client/avatar-definitions.js', import.meta.url))
// Half the side of the 8..92 box the package asks bodies to stay in.
const REACH = 42
// The package's neutral eye is 11 units tall at scale 1, and it draws eyes up to 1.45 times the
// definition's scale where the body has room, trying these factors in turn.
const EYE_HEIGHT = 11
const BOOSTS = [1.45, 1.38, 1.3, 1.22, 1.15, 1.08, 1]
// The gap the renderer keeps between a drawn eye and the outline while the eyes look around.
const CLEARANCE = 1.5
// How far the pair may move, in units; the farthest any character needs is 6.5.
const MOVE_MAX = 10

const tenth = value => Math.round(value * 10) / 10

// The corners of a body: every character's is one `M`, relative `l` steps and `z`.
function corners(body) {
  const points = []
  let x = 0
  let y = 0
  for (const [, command, rest] of body.matchAll(/([a-zA-Z])([^a-zA-Z]*)/g)) {
    const numbers = (rest.match(/-?\d*\.?\d+/g) ?? []).map(Number)
    if (command === 'M' && numbers.length === 2) { [x, y] = numbers; points.push([x, y]) }
    else if (command === 'l') for (let index = 0; index < numbers.length; index += 2) { x += numbers[index]; y += numbers[index + 1]; points.push([x, y]) }
    else if (command !== 'z') throw new Error(`avatar definitions: a body with a ${command} command needs a new conversion`)
  }
  return points
}

// Moves of the pair on the half-unit grid, nearest first; equal distances keep one fixed order.
const MOVES = []
for (let dx = -MOVE_MAX; dx <= MOVE_MAX; dx += 0.5) for (let dy = -MOVE_MAX; dy <= MOVE_MAX; dy += 0.5) MOVES.push([dx, dy])
MOVES.sort((a, b) => Math.hypot(...a) - Math.hypot(...b) || a[0] - b[0] || a[1] - b[1])

// The definition scale the renderer enlarges to `drawn`, or undefined where none passes validation.
function scaleFor(body, eyes, drawn) {
  for (const boost of BOOSTS) {
    const scale = Math.round(drawn / boost * 100) / 100
    if (scale < 0.6 || scale > 1.8 || eyes.spacing < 7 * scale) continue
    const candidate = { ...eyes, scale }
    if (eyesFit(body.polys, candidate, 0, 0, 1.2) === null && Math.abs(boostedEyeScale(body, candidate) - drawn) < 0.03) return scale
  }
  return undefined
}

function definitionOf(id) {
  const { body, eyes: [[leftX, leftY, , leftHeight], [rightX, rightY, , rightHeight]] } = CHARACTERS[id]
  const points = corners(body)
  const factor = Math.min(1, REACH / Math.max(...points.flatMap(([x, y]) => [Math.abs(x - 50), Math.abs(y - 50)])))
  const place = value => tenth(50 + (value - 50) * factor)
  const path = `${points.map(([x, y], index) => `${index === 0 ? 'M' : 'L'}${place(x)} ${place(y)}`).join('')}Z`
  const analysis = analyzeBody(path)
  const pair = { x: place((leftX + rightX) / 2), y: place((leftY + rightY) / 2), spacing: tenth(Math.hypot(rightX - leftX, rightY - leftY) * factor) }
  const drawn = (leftHeight + rightHeight) / 2 * factor / EYE_HEIGHT
  for (const [dx, dy] of MOVES) {
    const moved = { ...pair, x: tenth(pair.x + dx), y: tenth(pair.y + dy) }
    const shown = { ...moved, scale: drawn }
    if (drawnEyesFit(analysis.polys, shown, 0, 0, CLEARANCE) !== null) continue
    const range = gazeRange(analysis.polys, shown)
    if (Math.min(range.left, range.right, range.up, range.down) < 1) continue
    const scale = scaleFor(analysis, moved, drawn)
    if (scale !== undefined) return { version: 1, id, name: SHAPES[id].label, body: { path }, eyes: { ...moved, scale } }
  }
  throw new Error(`avatar definitions: ${id} has no place for its eyes within ${MOVE_MAX} units`)
}

/**
 * The default characters as open-bot-avatar definitions.
 * @returns {Record<string, object>} One definition for each of DEFAULT_SHAPES, by shape id.
 */
export function buildDefinitions() {
  return Object.fromEntries(DEFAULT_SHAPES.map(id => [id, definitionOf(id)]))
}

/**
 * The text of src/client/avatar-definitions.js for a set of definitions.
 * @param {Record<string, object>} definitions - What buildDefinitions returned.
 * @returns {string} The module source.
 */
export function moduleText(definitions) {
  const row = ({ id, name, body, eyes }) => `  ${id}: {version:1,id:'${id}',name:'${name}',body:{path:'${body.path}'},eyes:{x:${eyes.x},y:${eyes.y},spacing:${eyes.spacing},scale:${eyes.scale}}},`
  return [
    '// Muse: the default characters as open-bot-avatar definitions (the package\'s version 1',
    '// format: one outline in a 0 0 100 100 box and a level eye pair), for the animated avatars in',
    '// animated-avatar.js. The outline is the character\'s body scaled to fit 8..92 of the box; the',
    '// eyes sit at the midpoint of its two capsules, as far apart and as tall, moved the shortest',
    '// way to where the package can turn them every way. dev/avatar-definitions.mjs builds this table.',
    'export const AVATAR_DEFINITIONS = {',
    ...Object.values(definitions).map(row),
    '}',
    '',
  ].join('\n')
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const next = moduleText(buildDefinitions())
  if (process.argv.includes('--check')) {
    let current = null
    try { current = readFileSync(OUTPUT, 'utf8') } catch { /* a missing module counts as stale */ }
    if (current !== next) {
      console.error('src/client/avatar-definitions.js is stale: run `node dev/avatar-definitions.mjs` in ds-bot')
      process.exit(1)
    }
  } else {
    writeFileSync(OUTPUT, next)
  }
}
