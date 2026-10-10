/** Compiler diagnostics for the user program, without internal runtime stack frames. */

/**
 * Retain Node's TypeScript code excerpt and correct the single wrapper-line offset.
 * @param error - Failure while stripping the wrapped user program.
 * @returns Compiler message and located excerpt when present; otherwise the original message.
 */
export function programParseDiagnostic(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  const frame = error.stack?.match(/^:(\d+)\n([\s\S]*?)\n(?:SyntaxError|TypeError) ?(?:\[|:)/u)
  if (frame === undefined || frame === null) return error.message
  // oxlint-disable-next-line typescript/no-non-null-assertion -- both captures are required by the matched expression
  return `${error.message}\nPTC program line ${Math.max(1, Number(frame[1]) - 1)}:\n${frame[2]!.trimEnd()}`
}
