/** Candidate metadata must retain the exact native installer and recorded build identity. */
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { candidateUpdateSpec } from '../scripts/muse-candidate-update-acceptance.ts'

function retryFixture(state: Record<string, unknown>) {
  const source = readFileSync(new URL('./fixtures/muse-candidate-update.mjs', import.meta.url), 'utf8')
  const file = ts.createSourceFile('muse-candidate-update.mjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  let diagnostic: ts.FunctionDeclaration | undefined
  let retry: ts.VariableStatement | undefined
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'updateStateDiagnostic') diagnostic = node
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'retried'
      && ts.isVariableStatement(node.parent.parent)) retry = node.parent.parent
    ts.forEachChild(node, visit)
  }
  visit(file)
  if (diagnostic === undefined || retry === undefined || !ts.isBlock(retry.parent)) {
    throw new Error('Expected the real candidate retry diagnostic before its readiness assertion')
  }
  const start = retry.parent.statements.indexOf(retry)
  const statements = retry.parent.statements.slice(start, start + 4).map(node => node.getText(file)).join('\n')
  const diagnosticSource = diagnostic.getText(file)
  const report: Record<string, unknown> = {}
  const persisted: unknown[] = []
  const downloads: unknown[] = []
  const run = () => runInNewContext(`(async () => { ${diagnosticSource}\n${statements} })()`, {
    root: 'private-fixture-root', report, spec: { version: '1.2.8' }, assert,
    recovery: { coordinator: { download: async (version: string) => { downloads.push(version); return state } } },
    persist: async () => { persisted.push(structuredClone(report)) },
  }) as Promise<void>
  return { run, report, persisted, downloads }
}

function fixture(target: 'mac-arm64' | 'win-x64' = 'mac-arm64') {
  const options = { target, version: '1.2.4', fromVersion: '1.2.3', sourceCommit: 'a'.repeat(40) }
  const base = `muse-med-1.2.4-${target}`
  const primary = `${base}.${target === 'mac-arm64' ? 'zip' : 'exe'}`
  const channel = target === 'mac-arm64' ? 'latest-mac.yml' : 'latest.yml'
  const artifacts: Record<string, { size: number; sha256: string; sha512: string }> = {}
  for (const filename of [primary, `${primary}.blockmap`, channel, ...(target === 'mac-arm64' ? [`${base}.dmg`] : [])]) {
    artifacts[filename] = { size: Buffer.byteLength(filename), sha256: createHash('sha256').update(filename).digest('hex'),
      sha512: createHash('sha512').update(filename).digest('base64') }
  }
  const first = artifacts[primary]!
  const record = { schemaVersion: 1, ...options, unsigned: true, artifacts }
  const metadata = { version: options.version, path: primary, sha512: first.sha512,
    files: [{ url: primary, size: first.size, sha512: first.sha512 }] }
  return { options, record, metadata, primary }
}

describe('real candidate update inputs', () => {
  it('persists the actual retry failure before retaining the readiness assertion', async () => {
    const f = retryFixture({ phase: 'error', message: 'signature seal mismatch', preparationFailure: 'signature_invalid',
      url: 'https://private.invalid/', unexpected: 'not part of the report' })
    await expect(f.run()).rejects.toMatchObject({ code: 'ERR_ASSERTION', actual: 'error', expected: 'ready' })
    const expected = { explicitRetry: { phase: 'error', message: 'signature seal mismatch', preparationFailure: 'signature_invalid' } }
    expect(f.report).toEqual(expected)
    expect(f.persisted).toEqual([expected])
    expect(f.downloads).toEqual(['1.2.8'])
  })

  it('bounds and redacts private retry details without serializing arbitrary state', async () => {
    const f = retryFixture({ phase: 'error', message: `private-fixture-root/cache Bearer synthetic-secret https://private.invalid/?token=secret ${'x'.repeat(5000)}`,
      preparationFailure: 'package_invalid', technicalDetails: { token: 'not for this report' } })
    await expect(f.run()).rejects.toMatchObject({ actual: 'error', expected: 'ready' })
    const diagnostic = f.report.explicitRetry as { message: string }
    expect(diagnostic.message).toHaveLength(4096)
    expect(diagnostic.message).toContain('[private-root]/cache Bearer [redacted] [url]')
    expect(diagnostic.message).not.toMatch(/synthetic-secret|private\.invalid|token=|private-fixture-root/u)
    expect(Object.keys(diagnostic).sort()).toEqual(['message', 'phase', 'preparationFailure'])
  })

  it('records a ready retry without error-only fields or another download', async () => {
    const f = retryFixture({ phase: 'ready', version: '1.2.8', message: 'stale failure must not be copied' })
    await f.run()
    expect(f.report).toEqual({ explicitRetry: { phase: 'ready' } })
    expect(f.persisted).toEqual([{ explicitRetry: { phase: 'ready' } }])
    expect(f.downloads).toEqual(['1.2.8'])
  })

  it.each(['mac-arm64', 'win-x64'] as const)('selects the genuine %s installer and preserves source metadata', (target) => {
    const f = fixture(target)
    const before = structuredClone(f.metadata)
    const result = candidateUpdateSpec(f.record, f.metadata, f.options)
    expect(result.payload.filename).toBe(`muse-med-1.2.4-${target}.${target === 'mac-arm64' ? 'dmg' : 'exe'}`)
    expect(result.artifacts).toHaveLength(target === 'mac-arm64' ? 4 : 3)
    expect(result.metadata.files[0]!.url).toBe(f.primary)
    expect(result.metadata.files.at(-1)!.sha512).toBe(result.payload.sha512)
    expect(f.metadata).toEqual(before)
  })

  it('rejects an older version, invalid source identity and another target build', () => {
    const f = fixture()
    expect(() => candidateUpdateSpec(f.record, f.metadata, { ...f.options, fromVersion: '1.2.5' })).toThrow('increasing versions')
    expect(() => candidateUpdateSpec(f.record, f.metadata, { ...f.options, fromVersion: '1.2.4' })).toThrow('increasing versions')
    expect(() => candidateUpdateSpec(f.record, f.metadata, { ...f.options, sourceCommit: 'main' })).toThrow('exact source')
    for (const change of [{ sourceCommit: 'b'.repeat(40) }, { target: 'win-x64' }, { version: '1.2.5' }, { unsigned: false }]) {
      expect(() => candidateUpdateSpec({ ...f.record, ...change }, f.metadata, f.options)).toThrow('another build')
    }
  })

  it('rejects a channel that points outside the recorded primary payload', () => {
    const f = fixture()
    for (const change of [{ version: '1.2.3' }, { path: '../other.zip' }, { files: [] }, { files: [...f.metadata.files, ...f.metadata.files] }]) {
      expect(() => candidateUpdateSpec(f.record, { ...f.metadata, ...change }, f.options)).toThrow('channel differs')
    }
    for (const change of [{ url: 'https://other.example/other.zip' }, { size: 1 }, { sha512: 'x'.repeat(86) + '==' }]) {
      expect(() => candidateUpdateSpec(f.record, { ...f.metadata, files: [{ ...f.metadata.files[0], ...change }] }, f.options))
        .toThrow('checksum differs')
    }
  })

  it('requires complete recorded size and hashes for every shipped candidate input', () => {
    const f = fixture()
    for (const change of [{ size: 0 }, { size: 1.5 }, { sha256: 'invalid' }, { sha512: 'invalid' }]) {
      const record = structuredClone(f.record)
      record.artifacts[f.primary] = { ...record.artifacts[f.primary]!, ...change }
      expect(() => candidateUpdateSpec(record, f.metadata, f.options)).toThrow('invalid recorded artifact')
    }
    const missing = structuredClone(f.record)
    delete missing.artifacts['muse-med-1.2.4-mac-arm64.dmg']
    expect(() => candidateUpdateSpec(missing, f.metadata, f.options)).toThrow('expected a JSON object')
  })
})
