// Markdown for a Feishu card. A reply that uses Markdown goes out as a card with one
// `markdown` element (card schema 2.0), which draws headings, lists, code blocks,
// links and GFM tables as they are written; a text message would show the symbols.
// What a card cannot take is dealt with here: a picture it cannot fetch, more tables
// than one card accepts, and a code fence that chunking cut in two. The table
// detection and the two card limits are ported from dsh-im's feishu-cards.mjs
// (MIT, © 2026 xmanrui — see NOTICE).
import { chunkMarkdown } from './format.js'

// The serialised card of one chunk stays under this many bytes: Feishu caps a card's
// content near 30 KB, and JSON escaping must still fit.
export const CARD_MAX_BYTES = 24_000
// One card accepts this many tables; one more and Feishu refuses the whole card
// (230099, ErrCode 11310). dsh-im measured the boundary against a live bot.
export const CARD_MAX_TABLES = 5

// Syntax a text message would show as raw symbols. Single `*` and `_` are left out:
// they are too often arithmetic or part of a name.
const MARKDOWN = [
  /^ {0,3}(`{3,}|~{3,})/m, // code fence
  /^ {0,3}#{1,6}[ \t]+\S/m, // heading
  /^[ \t]*([-*+]|\d+[.)])[ \t]+\S/m, // list item
  /^ {0,3}>[ \t]?\S/m, // quote
  /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/m, // rule
  /^[ \t]*\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)+\|?[ \t]*$/m, // table delimiter row
  /\*\*[^*\n]+\*\*/, // bold
  /~~[^~\n]+~~/, // strikethrough
  /`[^`\n]+`/, // code span
  /!?\[[^\]\n]*\]\([^)\s]+\)/, // link, image
]
export const hasMarkdown = text => MARKDOWN.some(pattern => pattern.test(text))

// The delimiter that opens a code fence on this line, if one does. CommonMark allows
// no backtick in the info string of a backtick fence.
const fenceOpening = (line) => {
  const found = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
  return found === null || (found[1][0] === '`' && found[2].includes('`')) ? undefined : found[1]
}
const fenceCloses = (line, fence) => {
  const found = /^ {0,3}(`{3,}|~{3,})[ \t\r]*$/.exec(line)
  return found !== null && found[1][0] === fence[0] && found[1].length >= fence.length
}

// A code span: a run of backticks closed by a run of the same length.
const CODE_SPAN = /(`+)(?!`)[^\n]*?(?<!`)\1(?!`)/g
const outsideCodeSpans = (line, change) => {
  let out = ''
  let at = 0
  for (const span of line.matchAll(CODE_SPAN)) {
    out += change(line.slice(at, span.index)) + span[0]
    at = span.index + span[0].length
  }
  return out + change(line.slice(at))
}

// A card draws a picture only from an image key uploaded to Feishu. A picture given
// by its address becomes a link and one given by a local path its caption, so the
// card is not refused for a key that does not exist.
const IMAGE = /!\[([^\]\n]*)\]\(([^)\s]+)[^)\n]*\)/g
const withoutImages = text => text.replace(IMAGE, (whole, alt, source) => {
  if (source.startsWith('img_')) return whole
  const label = alt.trim()
  if (/^https?:\/\//i.test(source)) return `[${label || source}](${source})`
  return label === '' ? '［图片］' : `［图片：${label}］`
})

// One chunk of Markdown as a card's `markdown` element takes it. Code, fenced or in
// a span, stays exactly as written.
export function toFeishuMarkdown(markdown) {
  let fence
  return String(markdown ?? '').split('\n').map((line) => {
    if (fence !== undefined) {
      if (fenceCloses(line, fence)) fence = undefined
      return line
    }
    fence = fenceOpening(line)
    return fence === undefined ? outsideCodeSpans(line, withoutImages) : line
  }).join('\n')
}

// Chunks cut inside a code fence: each closes the fence it leaves open and the next
// opens it again, so every chunk draws its code as code.
function closeFences(chunks) {
  const out = []
  let carried
  for (const chunk of chunks) {
    const text = carried === undefined ? chunk : `${carried.line}\n${chunk}`
    carried = undefined
    for (const line of text.split('\n')) {
      if (carried !== undefined) {
        if (fenceCloses(line, carried.fence)) carried = undefined
        continue
      }
      const fence = fenceOpening(line)
      if (fence !== undefined) carried = { fence, line }
    }
    out.push(carried === undefined ? text : `${text}\n${carried.fence}`)
  }
  return out
}

const hasClosingRun = (text, start, length) => {
  for (let at = start; at < text.length;) {
    if (text[at] !== '`') {
      at += 1
      continue
    }
    let end = at + 1
    while (text[end] === '`') end += 1
    if (end - at === length) return true
    at = end
  }
  return false
}

// The cells of one GFM table row, or undefined when the line is not one: an indented
// code line has none, and a `|` in a code span or after a backslash divides nothing.
function tableCells(line) {
  if (line.startsWith('    ') || line.startsWith('\t')) return undefined
  const text = line.trim()
  if (text === '') return undefined
  const cells = []
  let cell = ''
  let bars = 0
  let codeRun = 0
  for (let at = 0; at < text.length;) {
    const char = text[at]
    if (char === '\\' && at + 1 < text.length) {
      cell += text.slice(at, at + 2)
      at += 2
      continue
    }
    if (char === '`') {
      let end = at + 1
      while (text[end] === '`') end += 1
      const length = end - at
      if (codeRun === length) codeRun = 0
      else if (codeRun === 0 && hasClosingRun(text, end, length)) codeRun = length
      cell += text.slice(at, end)
      at = end
      continue
    }
    if (char === '|' && codeRun === 0) {
      cells.push(cell)
      cell = ''
      bars += 1
      at += 1
      continue
    }
    cell += char
    at += 1
  }
  if (bars === 0) return undefined
  cells.push(cell)
  if (cells[0].trim() === '') cells.shift()
  if (cells.at(-1)?.trim() === '') cells.pop()
  return cells.length > 0 ? cells : undefined
}

// Where each table begins, as offsets into the Markdown. A table is a header row
// followed by a delimiter row of as many cells; a table inside a code fence is code.
function tableStarts(markdown) {
  const lines = markdown.split('\n')
  const offsets = []
  let offset = 0
  for (const line of lines) {
    offsets.push(offset)
    offset += line.length + 1
  }
  const starts = []
  let fence
  for (let at = 0; at < lines.length; at += 1) {
    if (fence !== undefined) {
      if (fenceCloses(lines[at], fence)) fence = undefined
      continue
    }
    fence = fenceOpening(lines[at])
    if (fence !== undefined) continue
    const header = tableCells(lines[at])
    const delimiter = tableCells(lines[at + 1] ?? '')
    if (header === undefined || delimiter === undefined || header.length !== delimiter.length
      || !delimiter.every(cell => /^\s*:?-+:?\s*$/.test(cell))) continue
    starts.push(offsets[at])
    at += 1
    // A data row that looks like a delimiter belongs to this table: it starts no other.
    while (at + 1 < lines.length && tableCells(lines[at + 1]) !== undefined) at += 1
  }
  return starts
}

// The Markdown in pieces of at most `max` tables each, cut where a table begins.
export function splitByTables(markdown, max = CARD_MAX_TABLES) {
  const starts = tableStarts(markdown)
  const parts = []
  let from = 0
  for (let at = max; at < starts.length; at += max) {
    parts.push(markdown.slice(from, starts[at]).trimEnd())
    from = starts[at]
  }
  parts.push(markdown.slice(from))
  return parts
}

// One reply as the Markdown of its cards: chunks of at most `limit` characters, each
// with its code fences closed and no more tables than a card accepts.
export function cardChunks(markdown, limit) {
  return closeFences(chunkMarkdown(markdown, limit)).flatMap(chunk => splitByTables(chunk)).map(toFeishuMarkdown)
}
