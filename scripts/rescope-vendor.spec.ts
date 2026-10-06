/** Recorded npm evidence stays intact while authored files and exact edits remain checked. */

import { execFileSync, spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { exactEditState, isRescopeExcluded, rewriteRescopeReferences } from './rescope-vendor.ts'

const ANCHOR = '\n## Sync procedure'
const INSERTED = `\n15. **rescope**: one log entry.\n${ANCHOR}`
const root = resolve(import.meta.dirname, '..')
const ownedRoots: string[] = []

afterEach(() => {
  for (const directory of ownedRoots.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('rescope file selection', () => {
  it('preserves the recorded npm resolution', () => {
    expect(isRescopeExcluded('scripts/dependency-catalog/package-lock.json')).toBe(true)
  })

  it.each([
    'third_party/plugins/dsh-bridge/package-lock.json',
    'third_party/plugins/dshmarket/package-lock.json',
    'third_party/plugins/dsh-ponytail/scripts/sync-dist.mjs',
    'third_party/plugins/dsh-ponytail/scripts/verify-dist.mjs',
  ])('preserves the fixed upstream file %s', (file) => {
    expect(isRescopeExcluded(file)).toBe(true)
    const text = "const upstream = 'cordis'\n"
    expect(rewriteRescopeReferences(text, file)).toEqual({ text, lines: 0 })
  })

  it.each([
    'scripts/dependency-catalog/package.json',
    'scripts/dependency-catalog/source.ts',
    'scripts/other/package-lock.json',
    'packages/example/src/index.ts',
    'packages/example/package.json',
    'third_party/plugins/dsh-bridge/package.json',
    'third_party/plugins/dshmarket/src/index.ts',
    'third_party/plugins/dsh-ponytail/scripts/other.mjs',
  ])('keeps %s subject to upstream package-name checks', (file) => {
    expect(isRescopeExcluded(file)).toBe(false)
  })
})

describe('product identifiers and module references', () => {
  const file = 'apps/desktop-host/src/native-preset.ts'

  it.each([
    "import { Context } from 'cordis'",
    "import {\n  Context,\n} from /* framework */ 'cordis'",
    "export * from 'cordis/context'",
    "const framework = import(/* framework */ 'cordis')",
    "const framework = require('cordis')",
    "const framework = require.resolve('cordis')",
    "import framework = require('cordis')",
    "declare module 'cordis' {}",
    "type Framework = import('cordis').Context",
    "/** @param {import('cordis').Context} context */\nfunction inspect(context) {}",
  ])('renames the parsed module reference %s in a product-id file', (reference) => {
    const text = `${reference}\nconst preset = 'cordis'\n`
    const actual = rewriteRescopeReferences(text, file)
    expect(actual.text).toContain(reference.replace("'cordis", "'@deepseek-ai/cordis"))
    expect(actual.text).toContain("const preset = 'cordis'")
    expect(actual.lines).toBe(1)
  })

  it('keeps wire topics and reverses only the framework import', () => {
    const text = "import { Context } from '@deepseek-ai/cordis'\nctx.on('cordis/inspect-query', listener)\n"
    expect(rewriteRescopeReferences(text, 'snapshots/session/cordis-inspect-liveness/client-fixture.mjs', true).text)
      .toBe("import { Context } from 'cordis'\nctx.on('cordis/inspect-query', listener)\n")
  })

  it('retains escaped subpath characters as valid JavaScript after renaming', () => {
    const text = "const framework = require('cordis/a\\u0027b')\nconst preset = 'cordis'\n"
    expect(rewriteRescopeReferences(text, file).text)
      .toBe("const framework = require('@deepseek-ai/cordis/a\\'b')\nconst preset = 'cordis'\n")
  })

  it('keeps documented preset ids while renaming module references in fences', () => {
    const text = "The `cordis` preset.\n\n```ts\nimport { Context } from 'cordis'\nconst preset = 'cordis'\n```\n"
    expect(rewriteRescopeReferences(text, 'docs/subsystems/schedule.md').text)
      .toBe(text.replace("from 'cordis'", "from '@deepseek-ai/cordis'"))
  })

  it('keeps YAML preset ids while renaming plugin module names', () => {
    const text = '# The `cordis` preset\n- id: cordis\n  name: cordis\n'
    expect(rewriteRescopeReferences(text, 'apps/desktop-host/presets/cordis/agent.cordis.yml').text)
      .toBe('# The `cordis` preset\n- id: cordis\n  name: @deepseek-ai/cordis\n')
  })
})

function fixtureTree(): string {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-rescope-'))
  ownedRoots.push(directory)
  const source = readFileSync(join(root, 'scripts/rescope-vendor.ts'), 'utf8')
  const files = new Set(['scripts/rescope-vendor.ts',
    ...[...source.matchAll(/file: '([^']+)'/gu)].map(match => String(match[1]))])
  for (const file of files) {
    mkdirSync(dirname(join(directory, file)), { recursive: true })
    cpSync(join(root, file), join(directory, file))
  }
  symlinkSync(join(root, 'node_modules'), join(directory, 'node_modules'), 'junction')
  execFileSync('git', ['init', '--quiet', directory])
  execFileSync('git', ['-C', directory, 'config', 'core.autocrlf', 'false'])
  execFileSync('git', ['-C', directory, 'add', '--', ...files])
  return directory
}

function runCheck(directory: string): SpawnSyncReturns<string> {
  const outcome = spawnSync(process.execPath,
    ['--import', createRequire(import.meta.url).resolve('tsx/esm'), join(directory, 'scripts/rescope-vendor.ts'), '--check'],
    { cwd: directory, encoding: 'utf8', timeout: 30_000 })
  expect(outcome.error).toBeUndefined()
  expect(outcome.signal).toBeNull()
  return outcome
}

describe('executed rescope check', () => {
  it('accepts product identifiers without changing source or fixed upstream files', () => {
    const directory = fixtureTree()
    const file = 'apps/desktop-host/src/native-preset.ts'
    const original = readFileSync(join(directory, file), 'utf8')
    const outcome = runCheck(directory)
    expect(outcome.status, outcome.stderr).toBe(0)
    expect(outcome.stdout).toContain('post-state verified')
    expect(readFileSync(join(directory, file), 'utf8')).toBe(original)
    expect(execFileSync('git', ['-C', directory, 'diff', '--name-only'], { encoding: 'utf8' })).toBe('')
  })

  it.each([
    'apps/desktop-host/src/native-preset.ts',
    'packages/example/src/index.ts',
  ])('rejects a new bare module import in %s', (file) => {
    const directory = fixtureTree()
    const path = join(directory, file)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, "import 'cordis'\n")
    execFileSync('git', ['-C', directory, 'add', '--', file])
    const outcome = runCheck(directory)
    expect(outcome.status).toBe(1)
    expect(outcome.stderr).toContain(`residue: ${file}`)
    expect(readFileSync(path, 'utf8')).toBe("import 'cordis'\n")
  })
})

describe('exactEditState', () => {
  it('classifies an insertion by its target form, so a duplicate is invalid', () => {
    expect(exactEditState(`log\n${ANCHOR}\n`, ANCHOR, INSERTED, 1)).toBe('pending')
    expect(exactEditState(`log${INSERTED}\n`, ANCHOR, INSERTED, 1)).toBe('applied')
    // The anchor survives an insertion, so counting the source form would have
    // called this pending and inserted the entry a second time.
    expect(exactEditState(`log${INSERTED}${INSERTED}\n`, ANCHOR, INSERTED, 1)).toBe('invalid')
    expect(exactEditState('log\n', ANCHOR, INSERTED, 1)).toBe('invalid')
  })

  it('classifies a deletion by its source form, and requires its remainder to survive', () => {
    const remainder = 'exclude:\n'
    const withEntries = 'exclude:\n  - cordis@4\n'
    expect(exactEditState(withEntries, withEntries, remainder, 1)).toBe('pending')
    expect(exactEditState(remainder, withEntries, remainder, 1)).toBe('applied')
    // Upstream dropped the whole field: the source form is gone, but so is the
    // remainder, so this is a moved site rather than a completed deletion.
    expect(exactEditState('unrelated:\n', withEntries, remainder, 1)).toBe('invalid')
  })

  it('requires a replacement to leave no source form and the exact target count', () => {
    expect(exactEditState('a = 1\n', 'a = 1', 'b = 2', 1)).toBe('pending')
    expect(exactEditState('b = 2\n', 'a = 1', 'b = 2', 1)).toBe('applied')
    expect(exactEditState('b = 2\nb = 2\n', 'a = 1', 'b = 2', 1)).toBe('invalid')
    // A moved or partially applied site: neither state is complete.
    expect(exactEditState('a = 1\nb = 2\n', 'a = 1', 'b = 2', 1)).toBe('invalid')
    expect(exactEditState('x\n', 'a = 1', 'b = 2', 1)).toBe('invalid')
  })
})
