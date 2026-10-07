/**
 * Read one Muse session log and print structural first-turn evidence only.
 * Message text, tool arguments/results, credentials, and endpoint URLs never
 * leave this process. Run with: node scripts/diagnose-first-turn.mjs <log file>
 */
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const finishKinds = new Set(['stop', 'tool-calls', 'max-tokens', 'aborted', 'error'])
const turnEndKinds = new Set(['completed', 'aborted', 'blocked', 'error', 'max-tokens', 'interrupted', 'forked'])

/** Bound route identifiers before including them in structural output. */
function routeName(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1024) throw new Error('Invalid route name')
  return value
}

/** Accept only numeric turn and step indexes from durable input. */
function positiveIndex(value) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Invalid event index')
  return value
}

/** Print known reason tags without echoing arbitrary durable fields. */
function knownKind(value, kinds) {
  if (!kinds.has(value)) throw new Error('Invalid reason kind')
  return value
}

// Muse appends independently compressed frames. Node's one-shot decoder reads
// only the first frame, so locate each frame before decoding it. Keep this
// structural scan aligned with session-persistence-jsonl/src/zstd.ts.
function decodeZstdFrames(source) {
  const frames = []
  let offset = 0
  while (offset < source.length) {
    const start = offset
    if (source.length - offset < 5 || source.readUInt32LE(offset) !== 0xFD2FB528) throw new Error('Invalid frame')
    offset += 4
    const descriptor = source.readUInt8(offset++)
    if ((descriptor & 0x18) !== 0) throw new Error('Invalid frame')
    const sizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 0x20) !== 0
    const checksum = (descriptor & 0x04) !== 0
    const dictionaryFlag = descriptor & 0x03
    const headerBytes = (singleSegment ? 0 : 1)
      + (dictionaryFlag === 3 ? 4 : dictionaryFlag)
      + (sizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << sizeFlag)
    if (source.length - offset < headerBytes) throw new Error('Incomplete frame')
    offset += headerBytes
    for (;;) {
      if (source.length - offset < 3) throw new Error('Incomplete frame')
      const blockHeader = source.readUIntLE(offset, 3)
      offset += 3
      const blockType = (blockHeader >>> 1) & 0x03
      if (blockType === 3) throw new Error('Invalid block')
      const payloadBytes = blockType === 1 ? 1 : blockHeader >>> 3
      if (source.length - offset < payloadBytes) throw new Error('Incomplete frame')
      offset += payloadBytes
      if ((blockHeader & 1) !== 0) break
    }
    if (checksum) {
      if (source.length - offset < 4) throw new Error('Incomplete frame')
      offset += 4
    }
    frames.push(zstdDecompressSync(source.subarray(start, offset)))
  }
  if (frames.length === 0) throw new Error('Empty frame stream')
  return Buffer.concat(frames)
}

const file = process.argv[2]
if (!file || !/\.jsonl(?:\.zstd)?$/u.test(basename(file))) {
  console.error('Usage: node scripts/diagnose-first-turn.mjs <session.jsonl[.zstd]>')
  process.exitCode = 2
} else {
  try {
    const source = readFileSync(file)
    const decoded = file.endsWith('.zstd') ? decodeZstdFrames(source) : source
    const rows = decoded.toString('utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
    if (rows[0]?.type !== 'session') throw new Error('Input is not a Muse session log')

    let route
    let toolSchemaCount
    const turns = new Map()
    const turnOf = turn => {
      positiveIndex(turn)
      let entry = turns.get(turn)
      if (!entry) {
        entry = { turn, steps: [], toolCalls: 0, toolResults: 0 }
        turns.set(turn, entry)
      }
      return entry
    }
    for (const row of rows.slice(1)) {
      const data = row.data ?? {}
      if (row.type === 'request/header') {
        route = {
          provider: routeName(data.header?.config?.provider),
          model: routeName(data.header?.config?.model),
        }
        toolSchemaCount = Array.isArray(data.header?.tools) ? data.header.tools.length : undefined
      } else if (row.type === 'turn/start') {
        turnOf(data.turn)
      } else if (row.type === 'assistant/message') {
        const blocks = Array.isArray(data.message?.content) ? data.message.content : []
        const types = { text: 0, reasoning: 0, toolCall: 0, other: 0 }
        for (const block of blocks) {
          if (block.type === 'text') types.text++
          else if (block.type === 'reasoning') types.reasoning++
          else if (block.type === 'tool-call') types.toolCall++
          else types.other++
        }
        const finish = data.stream?.findLast(record => record.type === 'chunk' && record.chunk?.type === 'finish')
        turnOf(data.turn).steps.push({
          step: positiveIndex(data.step),
          provider: route?.provider,
          model: route?.model,
          toolSchemaCount,
          blocks: types,
          finish: finish === undefined ? 'unknown' : knownKind(finish.chunk?.reason?.kind, finishKinds),
        })
      } else if (row.type === 'tool/call') {
        turnOf(data.turn).toolCalls++
      } else if (row.type === 'tool/result') {
        turnOf(data.turn).toolResults++
      } else if (row.type === 'turn/end') {
        turnOf(data.turn).end = knownKind(data.reason?.kind, turnEndKinds)
      }
    }
    console.log(JSON.stringify({ turns: [...turns.values()] }, null, 2))
  } catch (error) {
    // Parser exceptions can contain source excerpts. Keep all failures generic.
    console.error('Could not read a valid Muse session log')
    process.exitCode = 1
  }
}
