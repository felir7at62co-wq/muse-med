/**
 * Chat Completions transport completion, independent of HTTP connection closure.
 * @module dsh-llm-pi-ai/completions-response
 */

/** Recognizes one complete SSE data event without buffering provider payloads. */
class DoneEventScanner {
  private line = ''
  private firstLine = true
  private skipLineFeed = false
  private dataIsDone: boolean | undefined

  /** Return the byte offset after a complete terminal event, if present. */
  scan(bytes: Uint8Array): number | undefined {
    for (const [index, byte] of bytes.entries()) {
      if (this.skipLineFeed && byte === 10) {
        this.skipLineFeed = false
        continue
      }
      this.skipLineFeed = byte === 13
      if (byte !== 10 && byte !== 13) {
        // Only the sentinel prefix matters; ordinary JSON lines can be arbitrarily long.
        // Three extra bytes accommodate a UTF-8 BOM on the first line.
        if (this.line.length < 16) this.line += String.fromCharCode(byte)
        continue
      }
      const line = this.firstLine ? this.line.replace(/^\xEF\xBB\xBF/, '') : this.line
      this.firstLine = false
      this.line = ''
      if (line === '') {
        if (this.dataIsDone === true) {
          return index + (byte === 13 && bytes[index + 1] === 10 ? 2 : 1)
        }
        this.dataIsDone = undefined
      } else if (line === 'data' || line.startsWith('data:')) {
        // Multiple data fields join with a newline, so none can be an exact [DONE].
        this.dataIsDone = this.dataIsDone === undefined
          && (line === 'data: [DONE]' || line === 'data:[DONE]')
      }
    }
    return undefined
  }
}

interface ToolCallSlot {
  target: number
  id: string | undefined
  drop: boolean
}

interface ChoiceToolCalls {
  slots: Map<number, ToolCallSlot>
  targets: Set<number>
  calls: Map<number, { name: string; args: string }>
}

const TOOL_CALLS = new TextEncoder().encode('"tool_calls"')

function contains(bytes: Uint8Array, needle: Uint8Array): boolean {
  outer: for (let start = 0; start + needle.length <= bytes.length; start++) {
    for (const [offset, byte] of needle.entries()) if (bytes[start + offset] !== byte) continue outer
    return true
  }
  return false
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : undefined
}

/**
 * Keeps parallel tool calls distinct when a relay streams several calls under one `tool_calls` index.
 * A delta with a new `id` at an index whose call already has another id starts a new call at the next free index;
 * such a new call whose name and arguments repeat an earlier call of the same choice is dropped as a relay duplicate.
 * Streams that never reuse an index are not rewritten.
 */
class ToolCallIndexes {
  private readonly choices = new Map<number, ChoiceToolCalls>()

  /** Return replacement event data, or undefined when the event needs no change. */
  rewrite(data: string): string | undefined {
    let event: unknown
    try { event = JSON.parse(data) } catch (error) { if (error instanceof SyntaxError) return undefined; throw error }
    const choices = record(event)?.['choices']
    if (!Array.isArray(choices)) return undefined
    let changed = false
    for (const [position, rawChoice] of choices.entries()) {
      const choice = record(rawChoice), delta = record(choice?.['delta']), calls = delta?.['tool_calls']
      if (choice === undefined || delta === undefined || !Array.isArray(calls)) continue
      const key = typeof choice['index'] === 'number' ? choice['index'] : position
      const state: ChoiceToolCalls = this.choices.get(key)
        ?? { slots: new Map<number, ToolCallSlot>(), targets: new Set<number>(), calls: new Map<number, { name: string; args: string }>() }
      this.choices.set(key, state)
      const kept: unknown[] = []
      for (const [callPosition, rawCall] of calls.entries()) {
        const call = record(rawCall)
        if (call === undefined) { kept.push(rawCall); continue }
        const source = typeof call['index'] === 'number' ? call['index'] : callPosition
        const id = typeof call['id'] === 'string' && call['id'].length > 0 ? call['id'] : undefined
        const fn = record(call['function'])
        const name = typeof fn?.['name'] === 'string' ? fn['name'] : '', args = typeof fn?.['arguments'] === 'string' ? fn['arguments'] : ''
        let slot = state.slots.get(source)
        if (slot === undefined || id !== undefined && slot.id !== undefined && id !== slot.id) {
          const reused = slot !== undefined
          let target = source
          while (state.targets.has(target)) target += 1
          state.targets.add(target)
          const duplicate = reused && [...state.calls.values()].some(previous => previous.name === name && previous.args === args)
          slot = { target, id, drop: duplicate }
          state.slots.set(source, slot)
        }
        slot.id ??= id
        if (slot.drop) { changed = true; continue }
        const previous = state.calls.get(slot.target) ?? { name: '', args: '' }
        state.calls.set(slot.target, { name: previous.name || name, args: previous.args + args })
        if (slot.target !== source) { call['index'] = slot.target; changed = true }
        kept.push(call)
      }
      if (kept.length > 0) delta['tool_calls'] = kept
      else delete delta['tool_calls']
      choice['delta'] = delta
      choices[position] = choice
    }
    if (!changed) return undefined
    return JSON.stringify({ ...record(event), choices })
  }
}

/** Splits SSE bytes into complete events and rewrites only those carrying tool calls. */
class ToolCallEventRewriter {
  private pending = new Uint8Array()
  private readonly indexes = new ToolCallIndexes()
  private readonly decoder = new TextDecoder()
  private readonly encoder = new TextEncoder()

  /** Return the bytes of every event completed by this chunk; an incomplete tail waits for more bytes. */
  push(bytes: Uint8Array): Uint8Array {
    const joined = new Uint8Array(this.pending.length + bytes.length)
    joined.set(this.pending)
    joined.set(bytes, this.pending.length)
    const output: Uint8Array[] = []
    let start = 0
    // A boundary is at most four bytes, so bytes already scanned in the pending tail need no rescan.
    for (let index = Math.max(0, this.pending.length - 3); index < joined.length; index++) {
      const end = this.boundary(joined, index)
      if (end === undefined) continue
      output.push(this.event(joined.subarray(start, end)))
      start = end
      index = end - 1
    }
    this.pending = joined.slice(start)
    const [first] = output
    return output.length === 1 && first !== undefined ? first : concat(output)
  }

  /** Release an unterminated final event unchanged. */
  flush(): Uint8Array { const rest = this.pending; this.pending = new Uint8Array(); return rest }

  private boundary(bytes: Uint8Array, index: number): number | undefined {
    const byte = bytes[index], next = bytes[index + 1]
    if (byte === 10 && next === 10) return index + 2
    if (byte === 13 && next === 10 && bytes[index + 2] === 13 && bytes[index + 3] === 10) return index + 4
    if (byte === 13 && next === 13) return index + 2
    return undefined
  }

  private event(bytes: Uint8Array): Uint8Array {
    if (!contains(bytes, TOOL_CALLS)) return bytes
    const text = this.decoder.decode(bytes)
    const lines = text.split(/(\r\n|\r|\n)/u)
    const dataLines = lines.flatMap((line, index) => index % 2 === 0 && /^data: ?/u.test(line) ? [index] : [])
    const only = dataLines[0]
    if (dataLines.length !== 1 || only === undefined) return bytes
    const line = lines[only] ?? ''
    const prefix = /^data: ?/u.exec(line)?.[0] ?? 'data:'
    const replacement = this.indexes.rewrite(line.slice(prefix.length))
    if (replacement === undefined) return bytes
    lines[only] = prefix + replacement
    return this.encoder.encode(lines.join(''))
  }
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let offset = 0
  for (const part of parts) { result.set(part, offset); offset += part.length }
  return result
}

/**
 * Close a successful Chat Completions SSE body at its complete `[DONE]` event, and keep parallel tool calls
 * distinct when a relay reuses one `tool_calls` index for several calls (see `ToolCallIndexes`).
 * Other bytes through the terminal event, response status, and headers are preserved. Finishing
 * the transform cancels the upstream body without aborting the SDK's request signal.
 * Non-SSE and unsuccessful responses pass through unchanged.
 * @param response - Provider response owned by the current model request.
 * @returns A response whose body ends at protocol completion or the original EOF.
 */
export function completeCompletionsResponse(response: Response): Response {
  if (!response.ok || response.body === null
    || response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'text/event-stream') {
    return response
  }
  const scanner = new DoneEventScanner()
  const rewriter = new ToolCallEventRewriter()
  const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(bytes, controller) {
      const end = scanner.scan(bytes)
      controller.enqueue(end === undefined ? bytes : bytes.subarray(0, end))
      if (end !== undefined) controller.terminate()
    },
  })).pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(bytes, controller) {
      const events = rewriter.push(bytes)
      if (events.length > 0) controller.enqueue(events)
    },
    flush(controller) {
      const rest = rewriter.flush()
      if (rest.length > 0) controller.enqueue(rest)
    },
  }))
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
}
