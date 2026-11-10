/** Isolated subprocess fixture for the private workspace owner lease. */
import fs from 'node:fs'
import { registerHooks, syncBuiltinESMExports } from 'node:module'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { SessionId } from '@deepseek-ai/dsh-session'
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === './workspace-process-snapshot.ts' && context.parentURL?.endsWith('/workspace-handoff.ts')) {
      return { url: new URL('./workspace-isolated-snapshot.ts', import.meta.url).href, shortCircuit: true }
    }
    return next(specifier, context)
  },
})
const { OwnedWorkspaceStorage } = await import('../../src/workspace-owned-storage.ts')

const [sourceRoot, ownedRoot, mode] = process.argv.slice(2)
if (sourceRoot === undefined || ownedRoot === undefined) throw new Error('workspace fixture paths required')
if (mode === 'crash-before-publish') {
  const rename = fs.promises.rename
  fs.promises.rename = async (from, to) => {
    if (String(to) === ownedRoot) {
      process.kill(process.pid, 'SIGKILL')
      await new Promise(() => {})
    }
    return rename(from, to)
  }
  syncBuiltinESMExports()
}
const source = new JsonStorageBackend(sourceRoot)
const owned = new OwnedWorkspaceStorage({ sourceBackend: 'json', root: ownedRoot }, source)
await owned.kv.open({ name: 'workspace', version: 2, tables: ['workspaces'], hasGlobal: true })
const show = async () => {
  const identity = await owned.capture(SessionId('session-original'), new AbortController().signal)
  process.stdout.write(`${JSON.stringify({ ready: true, identity })}\n`)
}
await show()
process.stdin.setEncoding('utf8')
let input = ''
process.stdin.on('data', (chunk: string) => {
  input += chunk
  const commands = input.split('\n')
  input = commands.pop() ?? ''
  for (const command of commands) {
    if (command === 'snapshot') void show()
    if (command === 'close') void owned.close().then(() => source.close()).then(() => { process.stdin.pause() })
  }
})
