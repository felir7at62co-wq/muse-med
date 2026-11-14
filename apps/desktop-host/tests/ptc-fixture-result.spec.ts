/** PTC fixture JSON retains errors while accepting the exact platform enforcement notice. */
import { expect, it } from 'vitest'
import { parsePtcFixtureResult } from './fixtures/ptc-result.mjs'

it('reads JSON on fully and partially enforced hosts without consuming arbitrary trailing output', () => {
  const text = JSON.stringify({ status: 'reviewed', nested: { label: 'current version' } }, null, 2)
  expect(parsePtcFixtureResult(text)).toEqual({ status: 'reviewed', nested: { label: 'current version' } })
  expect(parsePtcFixtureResult(`${text}\nFile sandbox enforcement is partial on this host.`)).toEqual(JSON.parse(text))
  expect(() => parsePtcFixtureResult(`${text}\nThe read-only file sandbox denied an operation.`)).toThrow(SyntaxError)
  expect(() => parsePtcFixtureResult(`${text}\nunexpected program output`)).toThrow(SyntaxError)
  expect(() => parsePtcFixtureResult('{broken}\nFile sandbox enforcement is partial on this host.')).toThrow(SyntaxError)
})
