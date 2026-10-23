/** Incremental duplicate-member detection without retaining argument values. */

/** A repeated member in one JSON object; parameter names and values stay private. */
export interface ArgumentLoopMatch {
  /** Number of occurrences of the same decoded member name. */
  occurrences: number
  /** Container depth, with a root object at depth one. */
  depth: number
}

type ObjectPhase = 'key-or-end' | 'key' | 'colon' | 'value' | 'comma-or-end'
type Frame = {
  kind: 'object'
  phase: ObjectPhase
  counts: Map<string, number>
  characters: number
  pendingKey: string
} | {
  kind: 'array'
  phase: 'value-or-end' | 'value' | 'comma-or-end'
}
type NumberPhase = 'minus' | 'zero' | 'integer' | 'dot' | 'fraction' | 'exponent' | 'exponent-sign' | 'exponent-digits'
type Token = {
  kind: 'string'
  frame: Extract<Frame, { kind: 'object' }> | undefined
  value: string
  escape: 'none' | 'slash' | 'unicode'
  unicode: number
  digits: number
} | {
  kind: 'number'
  phase: NumberPhase
} | {
  kind: 'literal'
  value: 'true' | 'false' | 'null'
  offset: number
}

// Exhausting scanner storage disables this advisory detector, not the JSON input.
const MAX_DEPTH = 128
const MAX_KEYS = 4096
const MAX_KEY_CHARACTERS = 65_536
const MAX_KEY_LENGTH = 1024

function isWhitespace(character: string): boolean {
  return character === ' ' || character === '\t' || character === '\n' || character === '\r'
}

function isDigit(character: string): boolean {
  return character >= '0' && character <= '9'
}

/**
 * Scans a JSON prefix once, counting decoded member names separately per object.
 * Invalid prefixes and storage-cap exhaustion permanently disable detection.
 * Values are not retained; a match concerns the valid prefix through its colon,
 * not validation of the unfinished JSON document or subsequent input.
 */
export class ArgumentLoopDetector {
  private readonly limit: number
  private readonly frames: Frame[] = []
  private rootPhase: 'value' | 'end' = 'value'
  private token: Token | undefined
  private disabled = false
  private match: ArgumentLoopMatch | undefined
  private keys = 0
  private characters = 0

  /** @param limit Explicit occurrence threshold; a safe integer of at least two. */
  constructor(limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 2) {
      throw new RangeError('ArgumentLoopDetector limit must be a safe integer of at least two')
    }
    this.limit = limit
  }

  /**
   * Scan the next raw fragment and retain the first high-confidence match.
   * @param fragment Next raw argument fragment, in wire order.
   * @returns First threshold match, retained for later pushes, or no match.
   */
  push(fragment: string): ArgumentLoopMatch | undefined {
    for (let index = 0; index < fragment.length && !this.disabled && !this.match;) {
      const character = fragment.charAt(index)
      if (this.token?.kind === 'string') {
        this.consumeString(character, this.token)
      } else if (this.token?.kind === 'number') {
        if (!this.consumeNumber(character, this.token)) continue
      } else if (this.token?.kind === 'literal') {
        if (character !== this.token.value[this.token.offset]) {
          this.disable()
        } else if (++this.token.offset === this.token.value.length) {
          this.token = undefined
          this.completeValue()
        }
      } else {
        this.consumeStructure(character)
      }
      index++
    }
    return this.match
  }

  private disable(): void {
    this.disabled = true
    this.frames.length = 0
    this.token = undefined
    this.keys = 0
    this.characters = 0
  }

  private completeValue(): void {
    const frame = this.frames.at(-1)
    if (frame) frame.phase = 'comma-or-end'
    else this.rootPhase = 'end'
  }

  private openContainer(kind: 'object' | 'array'): void {
    if (this.frames.length === MAX_DEPTH) {
      this.disable()
      return
    }
    this.completeValue()
    this.frames.push(kind === 'object'
      ? { kind, phase: 'key-or-end', counts: new Map(), characters: 0, pendingKey: '' }
      : { kind, phase: 'value-or-end' })
  }

  private closeContainer(frame: Frame): void {
    this.frames.pop()
    if (frame.kind === 'object') {
      this.keys -= frame.counts.size
      this.characters -= frame.characters
    }
  }

  private consumeStructure(character: string): void {
    if (isWhitespace(character)) return
    const frame = this.frames.at(-1)
    if (!frame) {
      if (this.rootPhase === 'end') this.disable()
      else this.beginValue(character)
    } else if (frame.phase === 'comma-or-end') {
      if (character === ',') frame.phase = frame.kind === 'object' ? 'key' : 'value'
      else if (character === (frame.kind === 'object' ? '}' : ']')) this.closeContainer(frame)
      else this.disable()
    } else if (frame.kind === 'object') {
      if (frame.phase === 'key-or-end' && character === '}') {
        this.closeContainer(frame)
      } else if (frame.phase === 'key-or-end' || frame.phase === 'key') {
        if (character === '"') this.beginString(frame)
        else this.disable()
      } else if (frame.phase === 'colon') {
        if (character === ':') this.countMember(frame)
        else this.disable()
      } else {
        this.beginValue(character)
      }
    } else if (frame.phase === 'value-or-end' && character === ']') {
      this.closeContainer(frame)
    } else {
      this.beginValue(character)
    }
  }

  private beginString(frame: Extract<Frame, { kind: 'object' }> | undefined): void {
    this.token = { kind: 'string', frame, value: '', escape: 'none', unicode: 0, digits: 0 }
  }

  private beginValue(character: string): void {
    if (character === '{') this.openContainer('object')
    else if (character === '[') this.openContainer('array')
    else if (character === '"') this.beginString(undefined)
    else if (character === '-') this.token = { kind: 'number', phase: 'minus' }
    else if (isDigit(character)) this.token = { kind: 'number', phase: character === '0' ? 'zero' : 'integer' }
    else if (character === 't' || character === 'f' || character === 'n') {
      this.token = { kind: 'literal', value: character === 't' ? 'true' : character === 'f' ? 'false' : 'null', offset: 1 }
    } else this.disable()
  }

  private appendKey(token: Extract<Token, { kind: 'string' }>, character: string): void {
    if (!token.frame) return
    if (token.value.length === MAX_KEY_LENGTH) this.disable()
    else token.value += character
  }

  private consumeString(character: string, token: Extract<Token, { kind: 'string' }>): void {
    if (token.escape === 'unicode') {
      if (!/^[\da-fA-F]$/.test(character)) {
        this.disable()
        return
      }
      token.unicode = token.unicode * 16 + Number.parseInt(character, 16)
      if (++token.digits === 4) {
        this.appendKey(token, String.fromCharCode(token.unicode))
        token.escape = 'none'
      }
    } else if (token.escape === 'slash') {
      if (character === 'u') {
        token.escape = 'unicode'
        token.unicode = 0
        token.digits = 0
      } else {
        const decoded = character === '"' || character === '\\' || character === '/' ? character
          : character === 'b' ? '\b' : character === 'f' ? '\f' : character === 'n' ? '\n'
            : character === 'r' ? '\r' : character === 't' ? '\t' : undefined
        if (decoded === undefined) this.disable()
        else {
          this.appendKey(token, decoded)
          token.escape = 'none'
        }
      }
    } else if (character === '\\') {
      token.escape = 'slash'
    } else if (character === '"') {
      this.token = undefined
      if (token.frame) {
        token.frame.pendingKey = token.value
        token.frame.phase = 'colon'
      } else this.completeValue()
    } else if (character.charCodeAt(0) < 0x20) {
      this.disable()
    } else this.appendKey(token, character)
  }

  private countMember(frame: Extract<Frame, { kind: 'object' }>): void {
    const previous = frame.counts.get(frame.pendingKey)
    if (previous === undefined) {
      if (this.keys === MAX_KEYS || this.characters + frame.pendingKey.length > MAX_KEY_CHARACTERS) {
        this.disable()
        return
      }
      this.keys++
      this.characters += frame.pendingKey.length
      frame.characters += frame.pendingKey.length
    }
    const occurrences = (previous ?? 0) + 1
    frame.counts.set(frame.pendingKey, occurrences)
    frame.pendingKey = ''
    frame.phase = 'value'
    if (occurrences === this.limit) {
      this.match = { occurrences, depth: this.frames.length }
      this.frames.length = 0
      this.keys = 0
      this.characters = 0
    }
  }

  /** False reconsumes a number's delimiter as container structure. */
  private consumeNumber(character: string, token: Extract<Token, { kind: 'number' }>): boolean {
    if (isDigit(character)) {
      if (token.phase === 'zero') this.disable()
      else if (token.phase === 'minus') token.phase = character === '0' ? 'zero' : 'integer'
      else if (token.phase === 'dot') token.phase = 'fraction'
      else if (token.phase === 'exponent' || token.phase === 'exponent-sign') token.phase = 'exponent-digits'
      return true
    }
    if (character === '.' && (token.phase === 'zero' || token.phase === 'integer')) token.phase = 'dot'
    else if ((character === 'e' || character === 'E') && ['zero', 'integer', 'fraction'].includes(token.phase)) token.phase = 'exponent'
    else if ((character === '+' || character === '-') && token.phase === 'exponent') token.phase = 'exponent-sign'
    else if (['zero', 'integer', 'fraction', 'exponent-digits'].includes(token.phase)
      && (isWhitespace(character) || character === ',' || character === '}' || character === ']')) {
      this.token = undefined
      this.completeValue()
      return false
    } else this.disable()
    return true
  }
}
