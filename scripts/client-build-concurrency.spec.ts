import { globSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { build, type TsdownHooks } from 'tsdown'
import { clientBuildConcurrency } from './client-build-concurrency.ts'

it('keeps native defaults and rejects invalid limits', () => {
  expect(clientBuildConcurrency(undefined)).toBeUndefined()
  for (const value of ['', '0', '-1', '1.5', '2x', 'Infinity', '9007199254740992']) expect(() => clientBuildConcurrency(value)).toThrow(/positive/u)
})

it('wires only the optional Client pass at the root', async () => {
  const source = readFileSync(new URL('../tsdown.config.ts', import.meta.url), 'utf8')
  expect(source).toContain('clientBuildConcurrency(process.env.DSH_BUILD_CLIENT_CONCURRENCY)')
})

it('keeps current package-local configs from overriding the bounded root hooks', () => {
  const files = globSync('{packages/*/*,vendor/*,apps/cli}/tsdown.config.*', { cwd: resolve(import.meta.dirname, '..') })
  expect(files.length).toBeGreaterThan(100)
  for (const file of files) {
    const source = readFileSync(resolve(import.meta.dirname, '..', file), 'utf8')
    expect(source, file).not.toMatch(/['"]build:(?:prepare|before)['"]\s*:/u)
  }
})

function fixture(fail = false) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-client-concurrency-'))
  onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fixture-two-faces', type: 'module' }))
  writeFileSync(join(root, 'a.js'), fail ? 'import "./missing.js"' : 'export const a = 1')
  writeFileSync(join(root, 'b.js'), 'export const b = 2')
  writeFileSync(join(root, 'tsdown.config.mjs'), 'export default [\'a\',\'b\'].map(name=>({ name, entry: name+\'.js\', outDir:\'lib\', format:\'esm\', dts:false, clean:false, fixedExtension:false, hooks:{\'build:done\'(){}} }))')
  return root
}

it('builds both same-package faces exactly once at limit one without a completion-barrier deadlock', async () => {
  const root = fixture()
  const hooks = clientBuildConcurrency('1')!
  let active = 0, peak = 0
  const started: string[] = [], finished: string[] = []
  const prepare = hooks['build:prepare']!, before = hooks['build:before']!
  const observed: Partial<TsdownHooks> = {
    async 'build:prepare'(context) { await prepare(context); active++; peak = Math.max(peak, active); started.push(context.options.name!) },
    'build:before'(context) {
      before(context)
      context.buildOptions.plugins = [context.buildOptions.plugins, { name: 'observe-release', closeBundle() { active-- } }]
    },
    'build:done'(context) { finished.push(context.options.name!) },
  }
  const result = await build({ cwd: root, hooks: observed, logLevel: 'silent' })
  expect(result).toHaveLength(2)
  expect(started.sort()).toEqual(['a', 'b'])
  expect(finished.sort()).toEqual(['a', 'b'])
  expect(peak).toBe(1)
  expect(active).toBe(0)
  expect(readFileSync(join(root, 'lib/a.js'), 'utf8')).toContain('a')
  expect(readFileSync(join(root, 'lib/b.js'), 'utf8')).toContain('b')
})

it('preserves package-local done hooks and rejects watch before creating watchers', async () => {
  const root = fixture()
  writeFileSync(join(root, 'tsdown.config.mjs'), `import {appendFileSync} from 'node:fs'; export default ['a','b'].map(name=>({ name, entry:name+'.js', outDir:'lib', format:'esm', dts:false, clean:false, hooks:{'build:done'(){appendFileSync(${JSON.stringify(join(root, 'done'))},name+'\\n')}} }))`)
  await build({ cwd: root, hooks: clientBuildConcurrency('1')!, logLevel: 'silent' })
  expect(readFileSync(join(root, 'done'), 'utf8').trim().split('\n').sort()).toEqual(['a', 'b'])
  await expect(build({ cwd: root, watch: true, hooks: clientBuildConcurrency('1')!, logLevel: 'silent' })).rejects.toThrow(/watch/u)
})

it('rejects native failure without starting queued faces or reaching a record callback', async () => {
  const root = fixture(true)
  const hooks = clientBuildConcurrency('1')!
  const started: string[] = []
  const prepare = hooks['build:prepare']!
  hooks['build:prepare'] = async (context) => { await prepare(context); started.push(context.options.name!) }
  let recorded = false
  await expect(build({ cwd: root, hooks, logLevel: 'silent' }).then(() => { recorded = true })).rejects.toThrow()
  expect(recorded).toBe(false)
  expect(started).toEqual(['a'])
})
