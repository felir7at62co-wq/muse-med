/** Actual Word and Present checks against a separately verified synthetic story project. */
import { appendFile, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { appendFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, ToolCallId, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { PROJECT_FILE, acceptedScripts } from '@deepseek-ai/dsh-screenplay-project'

export const name = 'story-delivery-fixture'
export const inject = ['llm', 'tools']

/**
 * Register a keyless delivery Adapter while preserving original inspection logs.
 * @param ctx - Fixture model and tool services.
 */
export function apply(ctx: Context): void {
  const results: { name: string; isError: boolean; content: unknown }[] = []
  ctx.on('tools/result', (exec, result) => {
    if (exec.name === 'run_code') {
      results.push({ name: exec.name, isError: result.isError, content: result.content })
      writeFileSync('story-host-results.json', JSON.stringify(results))
    }
    if (result.isError) appendFileSync('story-host-errors.txt', `${exec.name}: ${JSON.stringify(result.content)}\n`)
  })
  class FixtureAdapter extends LlmAdapter {
    async *stream(): AsyncIterable<StreamChunk> {
      const project = PROJECT_FILE.parse(JSON.parse(await readFile('project.json', 'utf8')))
      const candidate = acceptedScripts(project).at(-1)
      if (candidate === undefined || candidate.modification_notes === undefined) throw Error('Story fixture requires a genuinely accepted candidate and notes')
      const managed = resolve('managed/qa/screenplay-project.json'), input = resolve('managed/final/episode.md')
      const report = resolve('managed/final/modification-notes.md'), word = resolve('managed/final/episode.docx')
      if (results.length === 0) {
        await mkdir(join(resolve('managed'), 'qa'), { recursive: true })
        await mkdir(join(resolve('managed'), 'final'), { recursive: true })
        await copyFile('project.json', managed)
        await writeFile(input, candidate.script)
        await writeFile(report, candidate.modification_notes)
      }
      const present = (files: string[]) => `return await tools.present({files:${JSON.stringify(files.map(path => ({ path })))}});`
      const cases = [
        `return await tools.screenplay_export_docx(${JSON.stringify({ inputs: [input], output: word, project: managed })});`,
        present([word]), present([word, report]), present([input, report]),
        `return await tools.screenplay_export_docx(${JSON.stringify({ inputs: [input], output: resolve('resent.docx'), project: managed })});`,
        present([resolve('resent.docx')]), present([report]),
      ]
      const code = cases[results.length]
      if (code !== undefined) {
        if (results.length === cases.length - 1) await appendFile(report, 'Unverified additional claim.\n')
        const id = ToolCallId(`story-host-${results.length + 1}`), args = JSON.stringify({ description: 'Verify accepted story delivery.', code })
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'run_code', arguments: args } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      } else {
        const text = 'Synthetic accepted story delivery checks finished.'
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
  }
  ctx.llm.registerAdapter(['story-delivery-fixture'], new FixtureAdapter())
}
