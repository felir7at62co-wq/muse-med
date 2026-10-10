/** Compiler excerpts identify user-code locations without exposing host stack frames. */
import { expect, it } from 'vitest'
import { programParseDiagnostic } from '../src/parse-diagnostic.ts'

it.each([undefined, 'failure', 42])('retains non-Error parse failures: %s', (value) => {
  expect(programParseDiagnostic(value)).toBe(String(value))
})
it.each([undefined, 'SyntaxError: bad syntax\n    at internal:secret', ':3\nsource\n    at internal:secret']) (
  'retains plain messages when no compiler excerpt is available: %s', (stack) => {
    const error = new Error('bad syntax'); error.stack = stack
    expect(programParseDiagnostic(error)).toBe('bad syntax')
  },
)
it.each([['2', 'SyntaxError [ERR_INVALID_TYPESCRIPT_SYNTAX]'], ['1', 'TypeError: invalid syntax']])(
  'locates the original program without internal frames: %s', (line, type) => {
    const error = new SyntaxError("Expected ',', got ')'")
    error.stack = `:${line}\n]});\n  ^\n\n${type}: bad syntax\n    at internal:secret`
    expect(programParseDiagnostic(error)).toBe("Expected ',', got ')'\nPTC program line 1:\n]});\n  ^")
  },
)
