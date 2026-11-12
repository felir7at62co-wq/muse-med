import { expect, it } from 'vitest'
import { parsePtcJsonResult, PARTIAL_SANDBOX_NOTICE } from './fixtures/ptc-json-result.mjs'

const json = '{"state":"reviewed","label":"原始文本"}'
const value = { state: 'reviewed', label: '原始文本' }

it.each([
  ['plain', [{ type: 'text', text: json }], []],
  ['known suffix', [{ type: 'text', text: json + '\n' + PARTIAL_SANDBOX_NOTICE }], [PARTIAL_SANDBOX_NOTICE]],
  ['separate notice', [{ type: 'text', text: json }, { type: 'text', text: PARTIAL_SANDBOX_NOTICE }], [PARTIAL_SANDBOX_NOTICE]],
] as const)('retains the object and explicit notice: %s', (_name, content, notices) => {
  expect(parsePtcJsonResult(content)).toEqual({ value, notices })
})

it.each([
  ['malformed JSON', [{ type: 'text', text: '{broken}\n' + PARTIAL_SANDBOX_NOTICE }]],
  ['unknown suffix', [{ type: 'text', text: json + '\nUnrecognized warning' }]],
  ['extra text after notice', [{ type: 'text', text: json + '\n' + PARTIAL_SANDBOX_NOTICE + '\nextra' }]],
  ['two payloads', [{ type: 'text', text: json }, { type: 'text', text: json }]],
  ['duplicate notice', [{ type: 'text', text: json + '\n' + PARTIAL_SANDBOX_NOTICE }, { type: 'text', text: PARTIAL_SANDBOX_NOTICE }]],
  ['notice without payload', [{ type: 'text', text: PARTIAL_SANDBOX_NOTICE }]],
  ['non-text block', [{ type: 'image' }]],
  ['non-object payload', [{ type: 'text', text: 'null' }]],
] as const)('rejects an invalid PTC fixture result: %s', (_name, content) => {
  expect(() => parsePtcJsonResult(content)).toThrow()
})
