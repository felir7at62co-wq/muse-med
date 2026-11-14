/** Test-owned Host source generation, outside the instrumented jsdom process. */

import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { z } from 'zod'

const FACE_FILES = z.array(z.tuple([z.string(), z.string()])).nonempty()
const GENERATE_SOURCE = `
const { generateViewerRemoteFaces } = await import(process.argv[1]);
const faces = generateViewerRemoteFaces(process.argv[2], process.argv[3]);
process.stdout.write(JSON.stringify([...faces]));
`

/** One source-generation process owned until its output streams close. */
export interface ViewerRemoteFacesProcess {
  /** Complete generated files, or an error containing the exit status and both output streams. */
  readonly result: Promise<ReadonlyMap<string, string>>
  /** Terminate unfinished generation and await process and output-stream closure. */
  dispose(): Promise<void>
}

/** Inputs for the test-owned code generator; no application or profile is launched. */
export interface ViewerRemoteFacesProcessOptions {
  /** Workspace whose current source aliases the tsx ESM hook must use. */
  readonly workspaceRoot: string
  /** Private, caller-owned directory receiving the generated files. */
  readonly directory: string
  /** Generation deadline, shorter than the enclosing test's deadline. */
  readonly timeoutMs: number
  /** File URL of the source module exporting the pure generator. */
  readonly generatorModule: string
}

/**
 * Generate the same source Remote faces under plain Node with the tsx ESM hook. The child does not
 * inherit Vitest's inspector coverage, while its generated modules are still consumed by the real
 * instrumented viewer. Disposal joins the child before the caller removes its staging directory.
 * @param options - Source workspace, private output directory, and process deadline.
 * @returns Generation result and an idempotent, quiescent disposer.
 */
export function startViewerRemoteFacesProcess(options: ViewerRemoteFacesProcessOptions): ViewerRemoteFacesProcess {
  const child = spawn(process.execPath, [
    '--import', import.meta.resolve('tsx/esm'), '--input-type=module', '--eval', GENERATE_SOURCE,
    options.generatorModule,
    options.workspaceRoot, options.directory,
  ], {
    cwd: options.workspaceRoot,
    env: { ...process.env, TSX_TSCONFIG_PATH: join(options.workspaceRoot, 'tsconfig.base.json') },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  let spawnError: Error | undefined
  let stopped: 'deadline' | 'disposed' | undefined
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => { stdout += chunk })
  child.stderr.on('data', (chunk: string) => { stderr += chunk })
  child.once('error', (error) => { spawnError = error })
  const closed = new Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>((resolve) => {
    child.once('close', (code, signal) => { resolve({ code, signal }) })
  })
  const terminate = (reason: 'deadline' | 'disposed'): void => {
    if (child.exitCode !== null || child.signalCode !== null || stopped !== undefined) return
    stopped = reason
    child.kill('SIGKILL')
  }
  const deadline = setTimeout(() => { terminate('deadline') }, options.timeoutMs)
  const result = (async (): Promise<ReadonlyMap<string, string>> => {
    const { code, signal } = await closed
    clearTimeout(deadline)
    const diagnostic = (): string => `viewer source generation: ${stopped ?? 'exited'}; code=${String(code)}; signal=${String(signal)}; spawn=${spawnError?.message ?? 'none'}\nstdout:\n${stdout}\nstderr:\n${stderr}`
    if (stopped !== undefined || spawnError !== undefined || code !== 0 || signal !== null) {
      throw new Error(diagnostic())
    }
    try {
      const entries = FACE_FILES.parse(JSON.parse(stdout))
      const files = new Map(entries)
      if (files.size !== entries.length) throw new Error('duplicate generated package')
      for (const [name, file] of files) {
        if (resolve(file) !== resolve(options.directory, `${name.replaceAll('/', '__')}.js`)) {
          throw new Error(`unexpected generated file for ${name}: ${file}`)
        }
        readFileSync(file)
      }
      return files
    } catch (error) {
      throw new Error(`${diagnostic()}\nincomplete generated output: ${String(error)}`, { cause: error })
    }
  })()
  return {
    result,
    async dispose() {
      terminate('disposed')
      await closed
      clearTimeout(deadline)
    },
  }
}
