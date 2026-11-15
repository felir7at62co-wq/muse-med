import { expect, it } from 'vitest'
import { readPtcFixtureResult } from './fixtures/ptc-fixture-result.mjs'

const value = { review_status: 'consistent', delivery_mode: 'reviewed', label: '已复核本文件全部提取正文（仅当前版本）' }
const json = JSON.stringify(value, null, 2)
const notice = '\nFile sandbox enforcement is partial on this host.'

it.each(['', notice])('reads the actual program result with optional renderer notice %j without mutating the message', (suffix) => {
  const block = Object.freeze({ type: 'text', text: json + suffix })
  const message = Object.freeze({ content: Object.freeze([block]) })
  expect(readPtcFixtureResult(message)).toEqual(value)
  expect(message.content[0]?.text).toBe(json + suffix)
})

it.each([
  { content: [] },
  { content: [{ type: 'text', text: '' }] },
  { content: [{ type: 'text', text: notice }] },
  { content: [{ type: 'text', text: json + '\nUnknown notice.' }] },
  { content: [{ type: 'text', text: json + notice + notice }] },
  { content: [{ type: 'text', text: json + '\n' + json }] },
  { content: [{ type: 'text', text: json }, { type: 'text', text: json }] },
  { content: [{ type: 'text', text: 'null' }] },
  { content: [{ type: 'text', text: '[]' }] },
  { content: [{ type: 'image', text: json }] },
])('refuses missing, ambiguous or unrecognized result output: %j', (message) => {
  expect(() => readPtcFixtureResult(message)).toThrow()
})
