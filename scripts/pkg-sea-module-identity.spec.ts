/** Windows virtual aliases use one module URL in source, main and worker hooks. */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { expect, it } from 'vitest'

const packageRoot = dirname(createRequire(import.meta.url).resolve('@yao-pkg/pkg/package.json'))
const source = readFileSync(join(packageRoot, 'prelude/sea-vfs-setup.js'), 'utf8')
const bootstrap = readFileSync(join(packageRoot, 'prelude/sea-bootstrap.bundle.js'), 'utf8')

interface Resolution {
  url: string
  format?: string
  shortCircuit?: boolean
}
type ResolveContext = { parentURL: string }
type ResolveHook = (
  specifier: string, context: ResolveContext,
  nextResolve: (specifier: string, context: ResolveContext) => Resolution,
) => Resolution

function parse(source: string): ts.SourceFile {
  return ts.createSourceFile('sea-bootstrap.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
}

function workerSource(): string {
  const candidates: string[] = []
  function visit(node: ts.Node): void {
    if (ts.isStringLiteral(node) && node.text.includes('function insideSnapshot(f)')) candidates.push(node.text)
    ts.forEachChild(node, visit)
  }
  visit(parse(bootstrap))
  expect(candidates).toHaveLength(1)
  return candidates[0]!
}

function resolveHook(source: string, platform: string): ResolveHook | undefined {
  const parsed = parse(source)
  const helpers: string[] = []
  const registrations: string[] = []
  function visit(node: ts.Node): void {
    if (ts.isFunctionDeclaration(node)
      && (node.name?.text === 'canonicalSnapshotModuleURL' || node.name?.text === 'toPlatformPath')) helpers.push(node.getText(parsed))
    if (ts.isIfStatement(node) && node.expression.getText(parsed).includes('process.platform')
      && node.thenStatement.getText(parsed).includes('canonicalSnapshotModuleURL')) registrations.push(node.getText(parsed))
    ts.forEachChild(node, visit)
  }
  visit(parsed)
  expect(helpers).toHaveLength(2)
  expect(registrations).toHaveLength(1)
  let hook: ResolveHook | undefined
  runInNewContext(helpers.join('\n') + '\n' + registrations[0]!, {
    URL, process: { platform }, SNAPSHOT_PREFIX: '/snapshot',
    require: (name: string) => {
      if (name === 'url') return { pathToFileURL: (value: string) => pathToFileURL(value, { windows: true }) }
      if (name === 'module') return { registerHooks: (hooks: { resolve: ResolveHook }) => { hook = hooks.resolve } }
      throw new Error(`unexpected pkg fixture dependency: ${name}`)
    },
  })
  return hook
}

it.each([
  ['source', source],
  ['main bootstrap', bootstrap],
  ['worker bootstrap', workerSource()],
])('preserves virtual identity and external URLs in the %s', (_name, source) => {
  const resolve = resolveHook(source, 'win32')
  expect(resolve).toBeDefined()
  if (resolve === undefined) throw new Error('Windows virtual URL hook is absent')
  const context = { parentURL: 'file:///E:/plugins/addon/index.js' }
  const expected = 'file:///C:/snapshot/node/node_modules/@deepseek-ai/cordis/index.js'
  for (const drive of ['C', 'D', 'E', 'V', 'z']) {
    const result = { url: `file:///${drive}:/snapshot/node/node_modules/@deepseek-ai/cordis/index.js`, format: 'module', shortCircuit: true }
    const resolved = resolve('@deepseek-ai/cordis', context, (specifier, passedContext) => {
      expect(specifier).toBe('@deepseek-ai/cordis')
      expect(passedContext).toBe(context)
      return result
    })
    expect(resolved).toEqual({ ...result, url: expected })
    expect(result.url).toBe(`file:///${drive}:/snapshot/node/node_modules/@deepseek-ai/cordis/index.js`)
    if (drive === 'C') expect(resolved).toBe(result)
  }
  const queried = { url: 'file:///E:/snapshot/node/a%20b.js?variant=one#member', format: 'module' }
  expect(resolve('./a b.js', context, () => queried).url)
    .toBe('file:///C:/snapshot/node/a%20b.js?variant=one#member')
  for (const url of ['file:///E:/plugins/cordis/index.js', 'file:///E:/snapshot-other/index.js',
    'file://server/share/snapshot/index.js', 'node:fs', 'data:text/javascript,export{}']) {
    const result = { url, format: 'module' }
    expect(resolve('unchanged', context, () => result)).toBe(result)
  }
  expect(resolveHook(source, 'linux')).toBeUndefined()
  expect(resolveHook(source, 'darwin')).toBeUndefined()
})

it('loads one actual Node ESM instance for matching virtual URLs across drives', () => {
  const result = spawnSync(process.execPath, [join(import.meta.dirname, 'fixtures/pkg-sea-module-identity.mjs'), packageRoot], {
    encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' },
  })
  expect(result.error).toBeUndefined()
  expect(result.signal).toBeNull()
  expect(result.status, result.stderr).toBe(0)
  const proof = JSON.parse(result.stdout) as { faces: Record<string, { namespaces: number; baseLoads: number; distinctQueries: boolean }> }
  expect(Object.keys(proof.faces).sort()).toEqual(['main', 'source', 'worker'])
  for (const face of Object.values(proof.faces)) expect(face).toEqual({ namespaces: 1, baseLoads: 1, distinctQueries: true })
})
