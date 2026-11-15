import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { countUnknownCasts, findUnknownCasts, scanUnknownCasts, verifyNoUnknownCasts } from './verify-no-unknown-casts.ts'
import { retainedPluginSourcePrefixes } from './retained-plugin-sources.ts'

const roots: string[] = []
const baselinePath = 'scripts/no-unknown-casts.baseline.json'
const sourcePath = 'packages/example/src/index.ts'
const assertion = 'const result = value as unknown\n'
const retainedPath = 'third_party/plugins/example-retained/src/index.ts'
const originalPath = 'scripts/fixtures/retained-plugin-origins/example-retained/src/index.ts.upstream.txt'
const retainedOriginal = 'const ctx = {\n  home: home,\n} as unknown as Context\n'

function hash(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function retainedFixture(current = retainedOriginal, maintained = false): string {
  const root = fixture()
  write(root, retainedPath, current)
  write(root, originalPath, retainedOriginal)
  write(root, 'third_party/plugins/example-retained/LICENSE', 'MIT fixture\n')
  write(root, 'third_party/plugins/sources.json', JSON.stringify({ 'example-retained': {
    repository: 'https://example.com/upstream', commit: 'a'.repeat(40), license: 'MIT',
    ...maintained ? { localModifications: { files: { 'src/index.ts': { upstreamSha256: hash(retainedOriginal), sha256: hash(current) } } } } : {},
  } }))
  write(root, 'scripts/retained-plugin-origins.json', JSON.stringify({ version: 1, files: [{
    path: retainedPath, repository: 'https://example.com/upstream', commit: 'a'.repeat(40), license: 'MIT', sha256: hash(retainedOriginal),
    upstreamText: originalPath, licenseFile: 'third_party/plugins/example-retained/LICENSE',
  }] }))
  git(root, 'add', '.')
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function write(root: string, file: string, contents: string): void {
  const path = join(root, file)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, contents)
}

function git(root: string, ...args: string[]): void {
  execFileSync('git', args, { cwd: root, stdio: 'pipe' })
}

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-unknown-casts-'))
  roots.push(root)
  git(root, 'init', '--quiet')
  for (const area of ['packages', 'apps', 'scripts', 'website']) {
    write(root, `${area}/seed.ts`, 'export {}\n')
  }
  write(root, baselinePath, '{}\n')
  git(root, 'add', '.')
  return root
}

function recordBaseline(root: string): string {
  const text = `${JSON.stringify(countUnknownCasts(scanUnknownCasts(root)), null, 2)}\n`
  write(root, baselinePath, text)
  return text
}

describe('unknown assertion syntax', () => {
  it.each([
    ['standalone', 'input.ts', 'value as unknown', 1],
    ['double assertion', 'input.ts', 'value as unknown as Result', 1],
    ['nested assertions', 'input.ts', '(value as unknown) as unknown', 2],
    ['multiline', 'input.ts', 'value as\nunknown', 1],
    ['comment-separated', 'input.ts', 'value as /* explanation */ unknown', 1],
    ['parenthesized type', 'input.ts', 'value as ((unknown))', 1],
    ['angle assertion', 'input.ts', '<unknown>value', 1],
    ['parenthesized angle type', 'input.ts', '<(unknown)>value', 1],
    ['union', 'input.ts', 'value as unknown | string', 1],
    ['union with trailing unknown', 'input.ts', 'value as string | unknown', 1],
    ['parenthesized union', 'input.ts', 'value as (unknown | never)', 1],
    ['nested union', 'input.ts', 'value as string | (unknown | number)', 1],
    ['angle union assertion', 'input.ts', '<unknown | string>value', 1],
    ['escaped keyword', 'input.ts', String.raw`value as \u0075nknown`, 1],
    ['TSX expression', 'input.tsx', '<View value={input as unknown} />', 1],
    ['template interpolation', 'input.ts', '`text ${value as unknown}`', 1],
  ])('finds %s', (_name, file, text, count) => {
    expect(findUnknownCasts(file, text)).toHaveLength(count)
  })

  it.each([
    '// value as unknown\n/* <unknown>value */',
    'const text = "value as unknown"',
    'const text = `value as unknown`',
    'const result = value as unknown[]',
    'const result = value as Record<string, unknown>',
    'const result = value as unknown[] | string',
    'const result = value as unknown & { id: string }',
    'const result = value as string | (unknown & { id: string })',
    'const result = <unknown[]>value',
    'const result: unknown = value',
    'type Input = unknown; const result = value as Input',
    'type Input = unknown; const result = value as Input | string',
  ])('accepts source without a direct assertion: %s', (text) => {
    expect(findUnknownCasts('input.ts', text)).toEqual([])
  })

  it('accepts JSX text without ignoring assertions in expressions', () => {
    expect(findUnknownCasts('input.tsx', '<View>as unknown</View>')).toEqual([])
    expect(findUnknownCasts('input.tsx', '<View>{value as unknown}</View>')).toHaveLength(1)
  })

  it('excludes JavaScript JSDoc assertions', () => {
    expect(findUnknownCasts('input.js', 'const result = /** @type {unknown} */ (value)')).toEqual([])
  })

  it('reports normalized paths and the asserted type line', () => {
    const casts = findUnknownCasts('packages\\example\\index.ts', '\nvalue as\nunknown')
    expect(casts).toHaveLength(1)
    expect(casts[0]).toMatchObject({ file: 'packages/example/index.ts', line: 3 })
    expect(casts[0]?.fingerprint).toMatch(/^[a-f0-9]{64}$/u)
  })

  it('keeps syntax fingerprints through whitespace and comment edits', () => {
    const original = findUnknownCasts('input.ts', 'call(value, "text") as unknown')
    const formatted = findUnknownCasts('input.ts', '\ncall /* call */ (value,\n "text") as /* type */ unknown')
    expect(formatted.map(cast => cast.fingerprint)).toEqual(original.map(cast => cast.fingerprint))
    expect(findUnknownCasts('input.ts', 'call(value, "other") as unknown').map(cast => cast.fingerprint))
      .not.toEqual(original.map(cast => cast.fingerprint))
  })

  it.each([
    ['value as unknown', '6fe9024d30e0d4757a348b83d246925b3f5aeaf2e79a0eff4bf12f3c9fb5826b'],
    ['call() as unknown', '49f7ac9934e1a7fc08876cdf6f900bd05c74d7d25801b6ec2d4eed02c3221f8d'],
  ])('preserves the recorded fingerprint for %s', (text, fingerprint) => {
    expect(findUnknownCasts('input.ts', text)[0]?.fingerprint).toBe(fingerprint)
  })
})

describe('retained unknown assertion source mapping', () => {
  it('rejects an owned source ancestor junction before deciding whether the tracked leaf still exists', () => {
    const root = fixture()
    write(root, sourcePath, assertion)
    git(root, 'add', '.')
    const outside = mkdtempSync(join(tmpdir(), 'unknown-casts-owned-target-'))
    roots.push(outside)
    const original = join(root, 'packages/example/src'), target = join(outside, 'source')
    renameSync(original, target)
    symlinkSync(target, original, process.platform === 'win32' ? 'junction' : 'dir')
    try {
      expect(() => scanUnknownCasts(root)).toThrow(/Repository source link is unsupported/u)
      unlinkSync(join(target, 'index.ts'))
      expect(() => scanUnknownCasts(root)).toThrow(/Repository source link is unsupported/u)
    } finally {
      unlinkSync(original)
    }
  })

  it.each([
    ['source', 'third_party/plugins/example-retained/src'],
    ['pins', 'third_party/plugins'],
    ['lock', 'scripts'],
    ['original', 'scripts/fixtures'],
    ['license', 'third_party/plugins/example-retained'],
  ])('rejects a %s reached through an ancestor junction with unchanged content hashes', (_name, directory) => {
    const root = retainedFixture(retainedOriginal.replace('home: home', 'home: options.homeDirectory ?? home'), true)
    const outside = mkdtempSync(join(tmpdir(), 'unknown-casts-link-target-'))
    roots.push(outside)
    const original = join(root, directory), target = join(outside, 'original')
    renameSync(original, target)
    symlinkSync(target, original, process.platform === 'win32' ? 'junction' : 'dir')
    try {
      expect(() => verifyNoUnknownCasts(root)).toThrow(/Repository source link is unsupported/u)
    } finally {
      unlinkSync(original)
    }
  })

  it('accepts exact immutable bytes and maintained non-operator edits without a cast baseline', () => {
    expect(verifyNoUnknownCasts(retainedFixture())).toBe(0)
    const changed = `const prefix = true\n${retainedOriginal.replace('home: home', 'home: options.homeDirectory ?? home')}`
    const original = findUnknownCasts(retainedPath, retainedOriginal)[0]?.fingerprint
    expect(findUnknownCasts(retainedPath, changed)[0]?.fingerprint).not.toBe(original)
    expect(verifyNoUnknownCasts(retainedFixture(changed, true))).toBe(0)
  })

  it.each([
    ['added line', `${retainedOriginal}const added = value as unknown\n`],
    ['same-line extra cast', retainedOriginal.replace('as unknown as Context', 'as unknown as Context as unknown')],
    ['duplicated upstream cast', `${retainedOriginal}\n${retainedOriginal}`],
    ['changed operator line', retainedOriginal.replace('} as unknown', '} satisfies object as unknown')],
    ['new angle assertion', `${retainedOriginal}const added = <unknown>value\n`],
    ['new multiline assertion', `${retainedOriginal}const added = value as\nunknown\n`],
  ])('rejects a %s even with an updated maintained-content SHA', (_name, text) => {
    const root = retainedFixture(text, true)
    expect(() => verifyNoUnknownCasts(root)).toThrow(/new assertions to unknown/u)
  })

  it('rejects added files, owned neighbors and compatibility/check adapters beside exact retained source', () => {
    const root = retainedFixture()
    const owned = ['third_party/plugins/example-retained/src/new.ts', 'third_party/plugins/example-retained-owned/src/index.ts',
      'third_party/plugins/compatibility/example-retained.ts', 'third_party/plugins/checks/example-retained.ts']
    for (const path of owned) write(root, path, assertion)
    expect(scanUnknownCasts(root).map(cast => cast.file)).toEqual(owned.toSorted())
    expect(() => verifyNoUnknownCasts(root)).toThrow(/new assertions to unknown/u)
  })

  it.each(['pin', 'original', 'maintained-sha', 'missing-ledger', 'missing-lock'] as const)(
    'fails closed on invalid retained source records: %s', (failure) => {
      const current = retainedOriginal.replace('home: home', 'home: options.homeDirectory ?? home')
      const root = retainedFixture(current, true)
      if (failure === 'original') write(root, originalPath, `${retainedOriginal}// changed origin\n`)
      if (failure === 'maintained-sha') write(root, retainedPath, `${current}// unrecorded edit\n`)
      if (failure === 'missing-lock') unlinkSync(join(root, 'scripts/retained-plugin-origins.json'))
      if (failure === 'pin' || failure === 'missing-ledger') {
        write(root, 'third_party/plugins/sources.json', JSON.stringify({ 'example-retained': {
          repository: 'https://example.com/upstream', commit: (failure === 'pin' ? 'b' : 'a').repeat(40), license: 'MIT',
          ...failure === 'pin' ? { localModifications: { files: { 'src/index.ts': { upstreamSha256: hash(retainedOriginal), sha256: hash(current) } } } } : {},
        } }))
      }
      expect(() => verifyNoUnknownCasts(root)).toThrow(/Retained|retained|Maintained/u)
    },
  )
})

describe('unknown assertion inventory', () => {
  it('accepts recorded assertions after formatting without rewriting the baseline', () => {
    const root = fixture()
    write(root, sourcePath, assertion)
    const baseline = recordBaseline(root)
    write(root, sourcePath, 'const result = value as\n /* reason */ unknown\n')
    expect(verifyNoUnknownCasts(root)).toBe(1)
    expect(verifyNoUnknownCasts(root, true)).toBe(1)
    expect(readFileSync(join(root, baselinePath), 'utf8')).toBe(baseline)
  })

  it.each([
    ['additional assertion', `${assertion}const other = input as unknown\n`],
    ['duplicate assertion', `${assertion}${assertion}`],
    ['replacement assertion', 'const result = other as unknown\n'],
    ['union assertion', 'const result = value as unknown | string\n'],
  ])('rejects an %s without changing the baseline', (_name, text) => {
    const root = fixture()
    write(root, sourcePath, assertion)
    const baseline = recordBaseline(root)
    write(root, sourcePath, text)
    expect(() => verifyNoUnknownCasts(root)).toThrow(/new assertions to unknown/u)
    expect(() => verifyNoUnknownCasts(root, true)).toThrow(/new assertions to unknown/u)
    expect(readFileSync(join(root, baselinePath), 'utf8')).toBe(baseline)
  })

  it.each([
    assertion,
    'const result = value as (unknown | never)\n',
    'const result = value as string | (unknown | number)\n',
    String.raw`const result = value as \u0075nknown`,
  ])('rejects a new assertion when the inventory is empty: %s', (text) => {
    const root = fixture()
    write(root, sourcePath, text)
    expect(() => verifyNoUnknownCasts(root)).toThrow(`${sourcePath}:1`)
  })

  it('requires pruning retired counts while preserving the remaining assertion', () => {
    const root = fixture()
    write(root, sourcePath, `${assertion}${assertion}`)
    write(root, 'apps/retired.ts', 'const retired = input as unknown\n')
    recordBaseline(root)
    write(root, sourcePath, assertion)
    unlinkSync(join(root, 'apps/retired.ts'))
    expect(() => verifyNoUnknownCasts(root)).toThrow(/remove retired baseline entries/u)
    expect(verifyNoUnknownCasts(root, true)).toBe(1)
    expect(JSON.parse(readFileSync(join(root, baselinePath), 'utf8'))).toEqual(
      countUnknownCasts(findUnknownCasts(sourcePath, assertion)),
    )
    expect(verifyNoUnknownCasts(root)).toBe(1)
  })

  it('prunes a deleted tracked file without treating it as a discovery failure', () => {
    const root = fixture()
    write(root, sourcePath, assertion)
    git(root, 'add', sourcePath)
    recordBaseline(root)
    unlinkSync(join(root, sourcePath))
    expect(() => verifyNoUnknownCasts(root)).toThrow(/remove retired baseline entries/u)
    expect(verifyNoUnknownCasts(root, true)).toBe(0)
    expect(readFileSync(join(root, baselinePath), 'utf8')).toBe('{}\n')
  })

  it.each([
    ['not an object', '[]'],
    ['null', 'null'],
    ['invalid JSON', '{'],
    ['non-source path', '{"input.json":{"HASH":1}}'],
    ['absolute path', '{"/input.ts":{"HASH":1}}'],
    ['parent path', '{"../input.ts":{"HASH":1}}'],
    ['backslash path', JSON.stringify({ 'packages\\input.ts': { HASH: 1 } })],
    ['excluded path', '{"vendor/input.ts":{"HASH":1}}'],
    ['empty file counts', '{"input.ts":{}}'],
    ['array counts', '{"input.ts":[]}'],
    ['invalid fingerprint', '{"input.ts":{"invalid":1}}'],
    ['zero count', '{"input.ts":{"HASH":0}}'],
    ['negative count', '{"input.ts":{"HASH":-1}}'],
    ['fractional count', '{"input.ts":{"HASH":1.5}}'],
    ['unsafe count', '{"input.ts":{"HASH":9007199254740992}}'],
    ['string count', '{"input.ts":{"HASH":"1"}}'],
  ])('rejects a malformed baseline: %s', (_name, text) => {
    const root = fixture()
    const contents = text.replaceAll('HASH', 'a'.repeat(64))
    write(root, baselinePath, contents)
    expect(() => verifyNoUnknownCasts(root, true)).toThrow()
    expect(readFileSync(join(root, baselinePath), 'utf8')).toBe(contents)
  })
})

describe('unknown assertion source discovery', () => {
  it('checks tracked source across areas, extensions, tests and root configuration', () => {
    const root = fixture()
    const files = [
      'packages/example/src/input.ts',
      'apps/example/input.tsx',
      'scripts/input.mts',
      'website/input.cts',
      'packages/example/tests/input.js',
      'apps/example/input.jsx',
      'scripts/input.mjs',
      'website/input.cjs',
      'config.ts',
    ]
    for (const file of files) write(root, file, assertion)
    git(root, 'add', '.')
    expect(scanUnknownCasts(root).map(cast => cast.file)).toEqual(files.toSorted())
    expect(() => verifyNoUnknownCasts(root)).toThrow(/new assertions to unknown/u)
  })

  it('includes untracked source while excluding ignored files, vendor, archives and other extensions', () => {
    const root = fixture()
    write(root, '.gitignore', 'ignored/\n')
    for (const file of ['ignored/input.ts', 'vendor/input.ts', '.agents/notes/archived/input.ts', 'docs/input.md']) {
      write(root, file, assertion)
    }
    git(root, 'add', '.')
    write(root, 'scripts/new.ts', assertion)
    expect(scanUnknownCasts(root).map(cast => cast.file)).toEqual(['scripts/new.ts'])
    expect(() => verifyNoUnknownCasts(root)).toThrow('scripts/new.ts:1')
    unlinkSync(join(root, 'scripts/new.ts'))
    expect(verifyNoUnknownCasts(root)).toBe(0)
  })

  it.each(retainedPluginSourcePrefixes)('excludes only pinned %s while checking owned adapters and neighboring plugins', (prefix) => {
    const root = fixture()
    write(root, `${prefix}src/index.ts`, assertion)
    write(root, `${prefix}tests/bridge.spec.ts`, assertion)
    git(root, 'add', '.')
    expect(scanUnknownCasts(root)).toEqual([])
    expect(verifyNoUnknownCasts(root)).toBe(0)
    const owned = [
      `${prefix.slice(0, -1)}-owned/src/index.ts`,
      `${prefix.slice(0, -1)}.ts`,
      'third_party/plugins/compatibility/owned.ts',
      'third_party/plugins/checks/owned.mts',
    ]
    for (const file of owned) write(root, file, assertion)
    expect(scanUnknownCasts(root).map(cast => cast.file)).toEqual(owned.toSorted())
    expect(() => verifyNoUnknownCasts(root)).toThrow(/new assertions to unknown/u)
  })

  it.each(['packages', 'apps', 'scripts', 'website'])('rejects discovery missing %s', (area) => {
    const root = fixture()
    unlinkSync(join(root, `${area}/seed.ts`))
    expect(() => verifyNoUnknownCasts(root)).toThrow(`source discovery omitted ${area}/`)
  })

  it('rejects an empty source corpus', () => {
    const root = fixture()
    for (const area of ['packages', 'apps', 'scripts', 'website']) unlinkSync(join(root, `${area}/seed.ts`))
    expect(() => verifyNoUnknownCasts(root)).toThrow(/source discovery omitted/u)
  })

  // Creating file symlinks requires privileges that Windows CI does not guarantee.
  it.skipIf(process.platform === 'win32')('rejects a source symlink', () => {
    const root = fixture()
    write(root, 'target.txt', assertion)
    const link = join(root, 'scripts/linked.ts')
    symlinkSync(join(root, 'target.txt'), link)
    try {
      expect(() => verifyNoUnknownCasts(root)).toThrow('Repository source link is unsupported: scripts/linked.ts')
    } finally {
      unlinkSync(link)
    }
  })
})
