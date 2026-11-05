/** Provide a local draft/export stand-in while leaving the authenticated verifier active. */
import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

const execute = promisify(execFile)
const receipt = 'approved-source.json'

export function apply(ctx, { ffmpeg }) {
  ctx.effect(() => ctx.provide('approvedClipDraft', {
    async create(input) {
      const name = 'Fixture draft ' + input.taskId
      const path = join(input.projectDir, 'fixture-draft')
      await mkdir(path)
      await writeFile(join(path, receipt), JSON.stringify(input), { flag: 'wx' })
      return { path, name, editorOpenVerified: false }
    },
    async export({ draftName, draftPath, outputPath }, signal) {
      const input = JSON.parse(await readFile(join(draftPath, receipt), 'utf8'))
      if (draftName !== 'Fixture draft ' + input.taskId || dirname(dirname(outputPath)) !== input.projectDir) {
        throw new Error('Fixture draft identity or output location changed')
      }
      await execute(ffmpeg, [
        '-nostdin', '-v', 'error', '-n', '-i', input.path,
        '-c:v', 'mpeg4', '-q:v', '4', '-c:a', 'aac', '-ar', '44100', outputPath,
      ], { signal, timeout: 10_000, windowsHide: true, env: { SystemRoot: process.env.SystemRoot } })
      return { path: outputPath }
    },
  }))
}
