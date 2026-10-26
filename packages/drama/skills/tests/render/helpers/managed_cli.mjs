/** Test-only CLI ownership through the same managed ranges used by the native Host. */
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'

const input = JSON.parse(process.argv[2])
const controller = new AbortController()
let timedOut = false, stdout = '', outcome, error, handle, stdoutEnded, quiescent = false
const abort = () => { controller.abort(new Error('The owning Python test cancelled its CLI')) }
const onInput = (data) => { if (data.toString().includes('abort')) abort() }
process.stdin.on('data', onInput)
process.stdin.on('end', abort)
process.stdin.resume()
process.on('SIGTERM', abort)
process.on('SIGINT', abort)
const timer = setTimeout(() => {
  timedOut = true
  controller.abort(new Error('Managed CLI deadline exceeded'))
}, input.timeout_ms)
const ctx = new Context()
try {
  await ctx.plugin(LocalSubprocessRuntime)
  handle = ctx.subprocess.spawn({ argv: input.argv, cwd: input.cwd,
    env: { PYTHONUTF8: '1' }, signal: controller.signal, graceMs: 100,
    stdio: { stdin: 'ignore', stdout: 'pipe', stderr: { maxBytes: 16 * 1024 * 1024 } } })
  const done = handle.done.then(value => { outcome = value }, failure => { error = String(failure) })
  stdoutEnded = new Promise(resolve => { handle.stdout.once('end', resolve); handle.stdout.once('close', resolve) })
  handle.stdout.on('data', (data) => {
    stdout += data.toString()
    if (stdout.length > 16 * 1024 * 1024) controller.abort(new Error('Managed CLI output limit exceeded'))
    if (input.cancel_on_stdout !== undefined && stdout.includes(input.cancel_on_stdout)) abort()
  })
  await done
} catch (failure) {
  error = String(failure)
} finally {
  try {
    if (handle !== undefined) {
      handle.terminate()
      quiescent = await handle.waitForExit()
      await stdoutEnded
    }
  } finally {
    await ctx.fiber.dispose()
    clearTimeout(timer)
    process.stdin.off('data', onInput)
    process.stdin.off('end', abort)
    process.stdin.pause()
    process.stdin.unref?.()
    process.off('SIGTERM', abort)
    process.off('SIGINT', abort)
  }
}
const stderr = handle?.collected.stderr?.readFrom(0)
console.log(JSON.stringify({ code: outcome?.exitCode ?? null, signal: outcome?.signal ?? null,
  stdout, stderr: stderr?.text ?? '', error: error ?? null,
  aborted: controller.signal.aborted, timed_out: timedOut, quiescent }))
if (!quiescent) process.exitCode = 1
