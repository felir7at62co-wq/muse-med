import { describe, expect, it } from 'vitest'
import { ArgumentLoopDetector } from '../src/detector.ts'

/** Push one UTF-16 code unit at a time to exercise every lexical split. */
function scanCharacters(input: string, limit = 2) {
  const detector = new ArgumentLoopDetector(limit)
  for (let index = 0; index < input.length; index++) {
    const match = detector.push(input[index]!)
    if (match) return match
  }
  return undefined
}

describe('same-object member repetition', () => {
  it('stops the synthetic 18000-member page_num loop at the explicit 64th occurrence', () => {
    const detector = new ArgumentLoopDetector(64)
    const members = Array.from({ length: 18_000 }, (_, index) => `"page_num":${index}`)
    let readMembers = 0
    let match
    detector.push('{')
    for (const member of members) {
      match = detector.push(`${readMembers === 0 ? '' : ','}${member}`)
      readMembers++
      if (match) break
    }
    expect(match).toEqual({ occurrences: 64, depth: 1 })
    expect(readMembers).toBe(64)
    expect(readMembers).toBeLessThan(members.length)
    expect(detector.push('ignored after settlement')).toBe(match)
  })

  it('detects a loop in a single large fragment without returning member names or values', () => {
    const input = `{${'"private-name":"private-value",'.repeat(17_999)}"private-name":0}`
    expect(new ArgumentLoopDetector(64).push(input)).toEqual({ occurrences: 64, depth: 1 })
  })

  it('does not fire below the caller threshold', () => {
    const detector = new ArgumentLoopDetector(3)
    expect(detector.push('{"a":1,"a":2}')).toBeUndefined()
    expect(detector.push(' ')).toBeUndefined()
  })

  it('counts nonconsecutive members of the same object', () => {
    expect(scanCharacters('{"a":null,"b":false,"a":true}')).toEqual({ occurrences: 2, depth: 1 })
  })

  it('waits for the colon before counting a quoted key', () => {
    const detector = new ArgumentLoopDetector(2)
    expect(detector.push('{"a":0,"a"')).toBeUndefined()
    expect(detector.push(' \r\n\t')).toBeUndefined()
    expect(detector.push(':')).toEqual({ occurrences: 2, depth: 1 })
  })

  it('keeps parent counts while nested values complete', () => {
    expect(scanCharacters('{"a":{"a":1},"list":[{"a":2}],"a":3}'))
      .toEqual({ occurrences: 2, depth: 1 })
  })

  it('detects repeated members within a nested object', () => {
    expect(scanCharacters('{"list":[0,{"a":1,"a":2}]}')).toEqual({ occurrences: 2, depth: 3 })
  })

  it('does not combine counters from different objects in an array', () => {
    const input = JSON.stringify(Array.from({ length: 18_000 }, () => ({ page_num: 1 })))
    expect(new ArgumentLoopDetector(2).push(input)).toBeUndefined()
  })

  it('does not combine counters from nested and sibling objects', () => {
    expect(scanCharacters('{"a":1,"nested":{"a":1},"siblings":[{"a":1},{"a":1}]}'))
      .toBeUndefined()
  })

  it('counts empty and prototype-named keys without object prototype collisions', () => {
    expect(scanCharacters('{"":0,"":1}')).toEqual({ occurrences: 2, depth: 1 })
    expect(scanCharacters('{"__proto__":0,"constructor":0,"__proto__":1}'))
      .toEqual({ occurrences: 2, depth: 1 })
  })
})

describe('JSON lexical boundaries', () => {
  it.each([
    ['Unicode ASCII escape', String.raw`{"page_num":0,"page_\u006eum":1}`],
    ['Unicode surrogate pair', String.raw`{"😀":0,"\ud83d\ude00":1}`],
    ['slash', String.raw`{"/":0,"\/":1}`],
    ['quote', String.raw`{"\"":0,"\u0022":1}`],
    ['backslash', String.raw`{"\\":0,"\u005c":1}`],
    ['escaped controls', String.raw`{"\b\f\n\r\t":0,"\u0008\u000c\u000a\u000d\u0009":1}`],
  ])('compares decoded key names across every chunk split: %s', (_label, input) => {
    expect(scanCharacters(input)).toEqual({ occurrences: 2, depth: 1 })
    for (let split = 0; split <= input.length; split++) {
      const detector = new ArgumentLoopDetector(2)
      const first = detector.push(input.slice(0, split))
      expect(first ?? detector.push(input.slice(split))).toEqual({ occurrences: 2, depth: 1 })
    }
  })

  it('does not count JSON-looking text in string values or ordinary repeated prose', () => {
    const prose = 'page_num page_num '.repeat(18_000)
    expect(new ArgumentLoopDetector(2).push(prose)).toBeUndefined()
    expect(new ArgumentLoopDetector(2).push(JSON.stringify({ text: `${prose}{"page_num":1,"page_num":2}` })))
      .toBeUndefined()
    expect(new ArgumentLoopDetector(2).push(JSON.stringify(prose))).toBeUndefined()
  })

  it('does not retain or count long string values, number digits, or array items', () => {
    const detector = new ArgumentLoopDetector(2)
    expect(detector.push('{"text":"')).toBeUndefined()
    for (let index = 0; index < 100; index++) expect(detector.push('x'.repeat(10_000))).toBeUndefined()
    expect(detector.push('","number":1')).toBeUndefined()
    for (let index = 0; index < 100; index++) expect(detector.push('2'.repeat(10_000))).toBeUndefined()
    expect(detector.push(',"array":["a","a",true,false,null,{},[],0],"text":')).toEqual({ occurrences: 2, depth: 1 })
  })

  it.each(['0', '-0', '123', '-123', '0.5', '-1.25', '1e3', '1E+3', '0.5e-2'])('accepts a number value: %s', (number) => {
    expect(scanCharacters(`{"n":${number},"a":0,"a":1}`)).toEqual({ occurrences: 2, depth: 1 })
  })

  it.each(['true', 'false', 'null', '"value"', '[]', '{}', '[{},[]]', '{"n":1}'])('accepts a non-number value: %s', (value) => {
    expect(scanCharacters(`{"v":${value},"a":0,"a":1}`)).toEqual({ occurrences: 2, depth: 1 })
  })

  it.each(['', ' ', '\r\n\t', '{}', '[]', '[true,null]', '"text"', '42', 'false'])('leaves a valid nonmatching prefix alone: %j', (input) => {
    expect(scanCharacters(input)).toBeUndefined()
  })

  it('keeps incomplete keys and escape sequences across empty pushes', () => {
    const detector = new ArgumentLoopDetector(2)
    expect(detector.push('{"a":0,"\\u0')).toBeUndefined()
    expect(detector.push('')).toBeUndefined()
    expect(detector.push('061"')).toBeUndefined()
    expect(detector.push(':')).toEqual({ occurrences: 2, depth: 1 })
  })
})

describe('conservative disablement', () => {
  it.each([
    '{unquoted:1,', '{"a" 1,', '{"a":undefined,', '{"v":True,', '{"v":truX,',
    '{"v":01,', '{"v":-,', '{"v":1.,', '{"v":1e,', '{"v":1e+,', '{"v":1+2,',
    '{"v":"\\x",', '{"v":"\\u00xz",', '{"v":"line\nbreak",',
    '{"v":[],}', '{"v":[1,]}', '{"v":{1:0}}', '{"v":1 "a":0,',
    '{"v":1]', '[}', '{}{}', '{"v":truefalse,', '{"v":0.1.2,',
  ])('stays disabled after an invalid prefix: %j', (invalid) => {
    const detector = new ArgumentLoopDetector(2)
    expect(detector.push(invalid)).toBeUndefined()
    expect(detector.push('{"a":0,"a":1}')).toBeUndefined()
  })

  it('disables when nesting exceeds the scanner budget', () => {
    const detector = new ArgumentLoopDetector(2)
    expect(detector.push('['.repeat(128))).toBeUndefined()
    expect(detector.push('{"a":0,"a":1}')).toBeUndefined()
  })

  it('still detects at the deepest supported container', () => {
    expect(new ArgumentLoopDetector(2).push(`${'['.repeat(127)}{"a":0,"a":1}`))
      .toEqual({ occurrences: 2, depth: 128 })
  })

  it('disables on an oversized decoded key, including escaped code units', () => {
    const detector = new ArgumentLoopDetector(2)
    expect(detector.push(`{"${'a'.repeat(1025)}":0,"a":0,"a":1}`)).toBeUndefined()
    const escaped = new ArgumentLoopDetector(2)
    expect(escaped.push(`{"${'\\u0061'.repeat(1025)}":0,"a":0,"a":1}`)).toBeUndefined()
  })

  it('supports keys exactly at the per-key budget', () => {
    const key = JSON.stringify('a'.repeat(1024))
    expect(new ArgumentLoopDetector(2).push(`{${key}:0,${key}:1}`)).toEqual({ occurrences: 2, depth: 1 })
  })

  it('disables on too many simultaneously retained distinct keys', () => {
    const detector = new ArgumentLoopDetector(2)
    const prefix = Array.from({ length: 4097 }, (_, index) => `"k${index}":0`).join(',')
    expect(detector.push(`{${prefix},"a":0,"a":1}`)).toBeUndefined()
  })

  it('supports exactly the distinct-key budget', () => {
    const prefix = Array.from({ length: 4096 }, (_, index) => `"k${index}":0`).join(',')
    expect(new ArgumentLoopDetector(2).push(`{${prefix},"k0":1}`)).toEqual({ occurrences: 2, depth: 1 })
  })

  it('disables when total retained decoded-key characters exceed the budget', () => {
    const prefix = Array.from({ length: 65 }, (_, index) => `${JSON.stringify(`${index}:`.padEnd(1024, 'x'))}:0`).join(',')
    expect(new ArgumentLoopDetector(2).push(`{${prefix},"a":0,"a":1}`)).toBeUndefined()
  })

  it('supports the exact total key-character budget and releases closed-object storage', () => {
    const members = Array.from({ length: 64 }, (_, index) => JSON.stringify(`${index}:`.padEnd(1024, 'x')))
    const object = `{${members.map(key => `${key}:0`).join(',')}}`
    expect(new ArgumentLoopDetector(2).push(`[${object},${object},{"a":0,"a":1}]`))
      .toEqual({ occurrences: 2, depth: 2 })
    expect(new ArgumentLoopDetector(2).push(`{${members.map(key => `${key}:0`).join(',')},${members[0]}:1}`))
      .toEqual({ occurrences: 2, depth: 1 })
  })

  it.each([0, 1, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])('requires a usable explicit limit: %s', (limit) => {
    expect(() => new ArgumentLoopDetector(limit)).toThrow(RangeError)
  })
})
