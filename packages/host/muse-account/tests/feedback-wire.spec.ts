import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { TypertContribution } from '@deepseek-ai/dsh-typert-registry/types'
import { WorkspaceAnalyzer } from '../../../typert/generator/src/analyzer.ts'
import { FaceModelEmitter } from '../../../typert/generator/src/emitter.ts'
import { expect, it } from 'vitest'

// Compiler analysis reads the Host program before the generated codec can be imported.
it('validates feedback identifiers and ratings through the generated Host wire codec', { timeout: Math.max(30000, Number(process.env.DSH_COVERAGE_TEST_TIMEOUT_MS ?? 0)) }, async () => {
  const workspace = new WorkspaceAnalyzer({ root: resolve(import.meta.dirname, '../../../..'),
    faces: ['host'], packages: ['@deepseek-ai/dsh-muse-account'] }).analyze()
  const host = workspace.faces.find(candidate => candidate.face === 'host')
  if (!host) throw new Error('Muse account has no Host face')
  const artifact = new FaceModelEmitter(host).emit('@deepseek-ai/dsh-muse-account')
  const root = await mkdtemp(join(import.meta.dirname, '.generated-feedback-'))
  try {
    const file = join(root, 'host.mjs')
    await writeFile(file, artifact.js)
    const generated = await import(pathToFileURL(file).href) as { TYPERT: TypertContribution }
    const invocation = generated.TYPERT.invocations?.find(candidate => candidate.method === 'feedback')
    const codec = invocation?.parameters[0]?.codec
    if (!codec || codec.mode !== 'strict') throw new Error('Feedback input lacks a strict Host codec')
    const schema = codec.create()
    const request = { sessionId: 'session-one', target: { kind: 'message', messageId: 'answer-one', rating: 'positive' },
      includeDiagnostics: false }
    expect(schema.parse(request)).toEqual(request)
    expect(schema.parse({ ...request, target: { ...request.target, rating: 'negative' } })).toMatchObject({ target: { rating: 'negative' } })
    expect(schema.parse({ ...request, target: { kind: 'session' } })).toMatchObject({ target: { kind: 'session' } })
    for (const target of [{ kind: 'message', rating: 'positive' }, { kind: 'message', messageId: 7, rating: 'positive' },
      { kind: 'message', messageId: 'answer-one', rating: 'other' }, { kind: 'message', messageId: 'answer-one', rating: false }]) {
      expect(() => schema.parse({ ...request, target })).toThrow()
    }
    expect(() => schema.parse({ ...request, sessionId: 7 })).toThrow()
    expect(() => schema.parse({ ...request, includeDiagnostics: 'true' })).toThrow()
  } finally { await rm(root, { recursive: true, force: true }) }
})
