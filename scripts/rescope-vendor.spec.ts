/** Recorded npm evidence stays intact while authored files and exact edits remain checked. */

import { execFileSync, spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { exactEditState, isRescopeExcluded, listRescopeFiles, rescopeText } from './rescope-vendor.ts'

const ANCHOR = '\n## Sync procedure'
const INSERTED = `\n15. **rescope**: one log entry.\n${ANCHOR}`
const root = resolve(import.meta.dirname, '..')
const ownedRoots: string[] = []

afterEach(() => {
  for (const directory of ownedRoots.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function expectRoundTrip(file: string, text: string, scoped: string, lines: number): void {
  expect(rescopeText(text, file)).toEqual({ text: scoped, lines })
  expect(rescopeText(scoped, file)).toEqual({ text: scoped, lines: 0 })
  expect(rescopeText(scoped, file, true)).toEqual({ text, lines })
}

it('lists the complete eligible corpus when tracked paths exceed one MiB', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-rescope-paths-'))
  // A Git hook or `git rebase -x` exports these; inherited, they would point the fixture at the caller's repository.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE'].includes(key.toUpperCase())))
  try {
    execFileSync('git', ['init', '--quiet'], { cwd: root, env })
    const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: root, env, input: '', encoding: 'utf8' }).trim()
    const paths = Array.from({ length: 12_000 }, (_, i) => `packages/example/src/${String(i).padStart(5, '0')}-${'x'.repeat(80)}.ts`)
    expect(Buffer.byteLength(paths.join('\0'))).toBeGreaterThan(1024 * 1024)
    // Index-only entries exercise Git's complete output without creating thousands of source files.
    const entries = [...paths, 'scripts/dependency-catalog/package-lock.json']
    execFileSync('git', ['update-index', '--index-info'], {
      cwd: root, env, input: entries.map(path => `100644 ${blob}\t${path}\n`).join(''),
    })
    expect(listRescopeFiles(root, env)).toEqual(paths)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('rescope file selection', () => {
  it('preserves the recorded npm resolution', () => {
    expect(isRescopeExcluded('scripts/dependency-catalog/package-lock.json')).toBe(true)
  })

  it.each([
    'third_party/plugins/dsh-bridge/package-lock.json',
    'third_party/plugins/dsh-im/package-lock.json',
    'third_party/plugins/dshmarket/package-lock.json',
  ])('preserves the fixed upstream file %s', (file) => {
    expect(isRescopeExcluded(file)).toBe(true)
    const text = "const upstream = 'cordis'\n"
    expect(rescopeText(text, file)).toEqual({ text, lines: 0 })
  })

  it.each([
    'scripts/dependency-catalog/package.json',
    'scripts/dependency-catalog/source.ts',
    'scripts/other/package-lock.json',
    'packages/example/src/index.ts',
    'packages/example/package.json',
    'third_party/plugins/dsh-bridge/package.json',
    'third_party/plugins/dsh-im/package.json',
    'third_party/plugins/compatibility/im-desktop.mjs',
    'third_party/plugins/dshmarket/src/index.ts',
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
    const actual = rescopeText(text, file)
    expect(actual.text).toContain(reference.replace("'cordis", "'@deepseek-ai/cordis"))
    expect(actual.text).toContain("const preset = 'cordis'")
    expect(actual.lines).toBe(1)
  })

  it('keeps wire topics and reverses only the framework import', () => {
    const text = "import { Context } from '@deepseek-ai/cordis'\nctx.on('cordis/inspect-query', listener)\n"
    expect(rescopeText(text, 'snapshots/session/cordis-inspect-liveness/client-fixture.mjs', true).text)
      .toBe("import { Context } from 'cordis'\nctx.on('cordis/inspect-query', listener)\n")
  })

  it('retains escaped subpath characters as valid JavaScript after renaming', () => {
    const text = "const framework = require('cordis/a\\u0027b')\nconst preset = 'cordis'\n"
    expect(rescopeText(text, file).text)
      .toBe("const framework = require('@deepseek-ai/cordis/a\\'b')\nconst preset = 'cordis'\n")
  })

  it('keeps documented preset ids while renaming module references in fences', () => {
    const text = "The `cordis` preset.\n\n```ts\nimport { Context } from 'cordis'\nconst preset = 'cordis'\n```\n"
    expect(rescopeText(text, 'docs/subsystems/schedule.md').text)
      .toBe(text.replace("from 'cordis'", "from '@deepseek-ai/cordis'"))
  })

  it('keeps YAML preset ids while renaming plugin module names', () => {
    const text = '# The `cordis` preset\n- id: cordis\n  name: cordis\n'
    expect(rescopeText(text, 'apps/desktop-host/presets/cordis/agent.cordis.yml').text)
      .toBe('# The `cordis` preset\n- id: cordis\n  name: @deepseek-ai/cordis\n')
  })

  it.each(['packages/preset/agent-preset-registry/tests/display.spec.ts', 'apps/web/tests/muse-drama-modes.e2e.ts'])
  ('preserves %s preset ids while checking its module imports', (path) => {
    const text = "import 'cordis'\nconst preset = 'cordis'\n"
    expect(rescopeText(text, path).text)
      .toBe("import '@deepseek-ai/cordis'\nconst preset = 'cordis'\n")
  })

  it('preserves hidden Muse mode ids while still rewriting framework imports', () => {
    const text = "import { Context } from 'cordis'\nconst modes = ['short-drama', 'editing', 'cordis']\n"
    expect(rescopeText(text, 'apps/web/tests/muse-drama-modes.e2e.ts').text)
      .toBe(text.replace("from 'cordis'", "from '@deepseek-ai/cordis'"))
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
    ['--import', pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm')).href, join(directory, 'scripts/rescope-vendor.ts'), '--check'],
    { cwd: directory, encoding: 'utf8', timeout: 30_000 })
  expect(outcome.error).toBeUndefined()
  expect(outcome.signal).toBeNull()
  return outcome
}

describe('executed rescope check', () => {
  it('checks the final source file after a tracked manifest larger than one MiB', () => {
    const directory = fixtureTree()
    const options = { cwd: directory, encoding: 'utf8' as const }
    const padding = Array.from({ length: 6000 }, (_value, index) =>
      `.agents/notes/archived/padding/${String(index).padStart(5, '0')}-${'x'.repeat(180)}.md`)
    const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { ...options, input: '' }).trim()
    execFileSync('git', ['update-index', '--index-info'], {
      ...options, input: padding.map(file => `100644 ${blob}\t${file}\n`).join(''),
    })
    const file = 'zz-rescope-tail.ts'
    const path = join(directory, file)
    writeFileSync(path, "import '@deepseek-ai/cordis'\n")
    execFileSync('git', ['add', '--', file], options)
    const manifest = execFileSync('git', ['ls-files', '-z'], { ...options, maxBuffer: 32 * 1024 * 1024 })
    expect(Buffer.byteLength(manifest.slice(0, manifest.indexOf(file)))).toBeGreaterThan(1024 * 1024)

    const accepted = runCheck(directory)
    expect(accepted.status).toBe(0)
    expect(accepted.stdout).toContain('post-state verified')

    writeFileSync(path, "import 'cordis'\n")
    const rejected = runCheck(directory)
    expect(rejected.status).toBe(1)
    expect(rejected.stderr).toContain(`residue: ${file}`)
    expect(readFileSync(path, 'utf8')).toBe("import 'cordis'\n")
  })

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
    'apps/desktop-host/tests/compaction-presets.spec.ts',
    'apps/web/tests/muse-drama-modes.e2e.ts',
    'packages/preset/agent-preset-registry/tests/display.spec.ts',
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

describe('product identifiers', () => {
  it.each([
    'snapshots/session/cordis-inspect-overlay-owner/client-fixture.mjs',
    'apps/cli/tests/optional-bundle-transitions.e2e.ts',
    'apps/web/tests/agent-preset-selection.e2e.ts',
    'apps/web/tests/developer-tools-settings.e2e.ts',
    'docs/subsystems/extensions.md',
    'docs/subsystems/extensions.zh.md',
    'docs/upgrade-guide/v0.2.0-rc.2/schedule-bundle-retired/guide.md',
    'docs/upgrade-guide/v0.2.0-rc.2/schedule-bundle-retired/guide.zh.md',
    'docs/upgrade-guide/v0.2.1-alpha.1/subagent-preset-composition/guide.md',
    'docs/upgrade-guide/v0.2.1-alpha.1/subagent-preset-composition/guide.zh.md',
    'docs/user/guide/schedule.md',
    'docs/user/guide/schedule.zh.md',
    'packages/bundle/web-app/cordis.patch.yml',
    'packages/client/ui-agent-preset/src/client/CreatePluginMenuItem.tsx',
    'packages/client/ui-agent-preset/src/client/analytics.ts',
    'packages/client/ui-agent-preset/tests/analytics.client.spec.ts',
    'packages/client/ui-agent-preset/tests/components.client.spec.tsx',
    'packages/client/ui-agent-preset/tests/create-plugin-menu-item.client.spec.tsx',
    'packages/client/ui-agent-preset/tests/section-store.client.spec.ts',
    'packages/client/ui-conversation/src/client/input/submission-analytics.ts',
    'packages/client/ui-conversation/tests/service-orchestration.client.spec.ts',
    'packages/client/ui-entry-customization/src/client/index.ts',
    'packages/client/ui-entry-customization/tests/menu.client.spec.tsx',
    'packages/client/ui-workspace/tests/workspaces-service.client.spec.ts',
    'packages/extensions/cordis-host-runner/tests/inspect-registry.spec.ts',
    'snapshots/session/cordis-inspect-liveness/client-fixture.mjs',
    'snapshots/session/cordis-inspect-timeout/client-fixture.mjs',
  ])('preserves the product values in %s', (file) => {
    const text = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
    expect(text).toMatch(/(['"`])cordis(?:\/inspect-query(?:-resolved)?)?\1/)
    expect(isRescopeExcluded(file)).toBe(false)
    expect(rescopeText(text, file)).toEqual({ text, lines: 0 })
  })

  it('still renames other libraries in a preset consumer and reverses them', () => {
    const file = 'packages/client/ui-agent-preset/src/client/CreatePluginMenuItem.tsx'
    const text = "const preset = 'cordis'\nimport utils from 'cosmokit'\nimport Schema from 'schemastery'\n"
    const scoped = "const preset = 'cordis'\nimport utils from '@deepseek-ai/cosmokit'\nimport Schema from '@deepseek-ai/schemastery'\n"
    expect(rescopeText(text, file)).toEqual({ text: scoped, lines: 2 })
    expect(rescopeText(scoped, file)).toEqual({ text: scoped, lines: 0 })
    expect(rescopeText(scoped, file, true)).toEqual({ text, lines: 2 })
  })

  it.each([
    'snapshots/session/cordis-inspect-overlay-owner/client-fixture.mjs',
  ])('still rejects an unscoped module import beside resolver or event literals in %s', (file) => {
    const product = "const fixtureName = 'cordis'\nctx.emit('cordis/inspect-query')\n"
    expectRoundTrip(file, `${product}import 'cordis'\n`, `${product}import '@deepseek-ai/cordis'\n`, 1)
  })

  it('keeps unlisted package references subject to residue detection', () => {
    const file = 'packages/example/src/index.ts'
    const text = "import { Context } from 'cordis'\nimport type Schema from 'schemastery'\n"
    const scoped = "import { Context } from '@deepseek-ai/cordis'\nimport type Schema from '@deepseek-ai/schemastery'\n"
    expect(rescopeText(text, file)).toEqual({ text: scoped, lines: 2 })
    expect(rescopeText(scoped, file)).toEqual({ text: scoped, lines: 0 })
    expect(rescopeText(scoped, file, true)).toEqual({ text, lines: 2 })
    expect(rescopeText("ctx.emit('cordis/inspect-query')", file).text).toBe("ctx.emit('@deepseek-ai/cordis/inspect-query')")
  })

  it.each([
    ['import', "import { Context } from 'cordis'", "import { Context } from '@deepseek-ai/cordis'"],
    ['multiline import', "import {\n  Context,\n} from 'cordis'", "import {\n  Context,\n} from '@deepseek-ai/cordis'"],
    ['side-effect import', "import 'cordis'", "import '@deepseek-ai/cordis'"],
    ['export', "export { Context } from 'cordis/subpath'", "export { Context } from '@deepseek-ai/cordis/subpath'"],
    ['import equals', "import Cordis = require('cordis')", "import Cordis = require('@deepseek-ai/cordis')"],
    ['dynamic import', 'const cordis = import(`cordis`)', 'const cordis = import(`@deepseek-ai/cordis`)'],
    ['require', 'const cordis = require("cordis/subpath")', 'const cordis = require("@deepseek-ai/cordis/subpath")'],
    ['import type', "type Context = import('cordis').Context", "type Context = import('@deepseek-ai/cordis').Context"],
    ['module declaration', "declare module 'cordis' {}", "declare module '@deepseek-ai/cordis' {}"],
    ['JSDoc type', "/** @param {import('cordis').Context} ctx */\nfunction apply(ctx) {}", "/** @param {import('@deepseek-ai/cordis').Context} ctx */\nfunction apply(ctx) {}"],
    ['JSDoc import', "/** @import { Context } from 'cordis' */\nfunction apply(ctx) {}", "/** @import { Context } from '@deepseek-ai/cordis' */\nfunction apply(ctx) {}"],
    ['same-line imports', "import 'cordis'; import 'cordis/subpath'", "import '@deepseek-ai/cordis'; import '@deepseek-ai/cordis/subpath'"],
  ])('rewrites %s without changing same-file product data', (_label, source, target) => {
    const file = 'packages/client/ui-agent-preset/src/client/CreatePluginMenuItem.tsx'
    const product = "const preset = 'cordis'\nctx.emit('cordis/inspect-query')\nconst fixture = \"import 'cordis'\"\n"
    const text = `${product}${source}\n`
    const scoped = `${product}${target}\n`
    expectRoundTrip(file, text, scoped, 1)
  })

  it.each([
    ['apps/cli/tests/optional-bundle-transitions.e2e.ts', 1],
    ['packages/client/ui-conversation/src/client/input/submission-analytics.ts', 1],
    ['packages/client/ui-conversation/tests/service-orchestration.client.spec.ts', 1],
    ['packages/client/ui-entry-customization/src/client/index.ts', 1],
    ['packages/client/ui-entry-customization/tests/menu.client.spec.tsx', 1],
    ['packages/client/ui-workspace/tests/workspaces-service.client.spec.ts', 1],
    ['packages/extensions/cordis-host-runner/tests/inspect-registry.spec.ts', 2],
    ['snapshots/session/cordis-inspect-liveness/client-fixture.mjs', 1],
    ['snapshots/session/cordis-inspect-timeout/client-fixture.mjs', 2],
  ] as const)('reverses real package references in %s and restores them', (file, lines) => {
    const scoped = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
    const text = scoped.replaceAll("'@deepseek-ai/cordis'", "'cordis'")
    expect(text).not.toBe(scoped)
    expectRoundTrip(file, text, scoped, lines)
    expect(rescopeText(text, file, true)).toEqual({ text, lines: 0 })
  })

  it.each([
    'apps/desktop-host/tests/preset-executors.spec.ts',
    'apps/desktop-host/tests/qimao-presets.spec.ts',
    'apps/desktop-host/tests/source-research-presets.spec.ts',
    'scripts/gen-tool-catalog.ts',
    'third_party/plugins/dsh-skill-mcp-panel/test-tool-filter.mjs',
  ])('retains preset and scoped-directory identifiers while rescoping imports in %s', (file) => {
    const text = "const preset = 'cordis'\nimport { Context } from 'cordis'\n"
    const scoped = "const preset = 'cordis'\nimport { Context } from '@deepseek-ai/cordis'\n"
    expectRoundTrip(file, text, scoped, 1)
  })

  it('rewrites multiline fenced imports while preserving prose and fenced product data', () => {
    const file = 'docs/subsystems/extensions.md'
    const text = "The `cordis` preset.\n```ts\nconst preset = 'cordis'\nimport {\n  Context,\n} from 'cordis'\n```\n"
    const scoped = "The `cordis` preset.\n```ts\nconst preset = 'cordis'\nimport {\n  Context,\n} from '@deepseek-ai/cordis'\n```\n"
    expectRoundTrip(file, text, scoped, 1)
  })

  it.each(['cordis', "'cordis'", '"cordis/subpath"'])('rewrites the YAML name %s without changing product comments', (name) => {
    const text = `# The 'cordis' preset.\n- name: ${name} # 'cordis' stays product data\n`
    const scoped = `# The 'cordis' preset.\n- name: ${name.replace('cordis', '@deepseek-ai/cordis')} # 'cordis' stays product data\n`
    for (const [file, wrap] of [
      ['packages/bundle/web-app/cordis.patch.yml', (value: string) => value],
      ['docs/subsystems/extensions.md', (value: string) => `The \`cordis\` preset.\n\`\`\`yaml\n${value}\`\`\`\n`],
    ] as const) {
      expectRoundTrip(file, wrap(text), wrap(scoped), 1)
    }
  })

  it.each(['scripts/rescope-vendor.spec.ts', 'scripts/gen-third-party-notices.spec.ts'])('keeps both package spellings in the fixture owner %s', (file) => {
    const text = "import 'cordis'\nimport '@deepseek-ai/cordis'\nconst fixture = \"import 'cosmokit'\"\n"
    expect(rescopeText(text, file)).toEqual({ text, lines: 0 })
    expect(rescopeText(text, file, true)).toEqual({ text, lines: 0 })
  })

  it('keeps schema runtime identifiers while rewriting their same-file import', () => {
    const file = 'vendor/loader/src/config/diff.ts'
    const text = "const key = Symbol.for('schemastery')\nconst metadata = { vendor: 'schemastery' }\nimport Schema from 'schemastery'\n"
    const scoped = "const key = Symbol.for('schemastery')\nconst metadata = { vendor: 'schemastery' }\nimport Schema from '@deepseek-ai/schemastery'\n"
    expectRoundTrip(file, text, scoped, 1)
  })

  it('rewrites declarations in an older event-name exception', () => {
    const file = 'packages/extensions/cordis-host-runner/src/index.ts'
    const text = "ctx.emit('cordis/inspect-query')\nimport { Context } from 'cordis'\ndeclare module 'cordis' {}\n"
    const scoped = "ctx.emit('cordis/inspect-query')\nimport { Context } from '@deepseek-ai/cordis'\ndeclare module '@deepseek-ai/cordis' {}\n"
    expectRoundTrip(file, text, scoped, 2)
  })

  it.each(['```ts\n```\n', "```ts\nimport 'cordis'\n"])('keeps fence line counts without requiring a closing fence', (text) => {
    const file = 'docs/subsystems/extensions.md'
    const scoped = text.replace("import 'cordis'", "import '@deepseek-ai/cordis'")
    expectRoundTrip(file, text, scoped, scoped === text ? 0 : 1)
  })
})
