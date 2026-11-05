/** Windows SEA modules share one cache URL across source, main, and worker resolver hooks. */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { expect, it } from 'vitest'

const packageRoot = dirname(createRequire(import.meta.url).resolve('@yao-pkg/pkg/package.json'))
const source = readFileSync(join(packageRoot, 'prelude', 'sea-vfs-setup.js'), 'utf8')
const bootstrap = readFileSync(join(packageRoot, 'prelude', 'sea-bootstrap.bundle.js'), 'utf8')

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
  const strings: string[] = []
  function visit(node: ts.Node): void {
    if (ts.isStringLiteral(node) && node.text.includes('function insideSnapshot(f)')) strings.push(node.text)
    ts.forEachChild(node, visit)
  }
  visit(parse(bootstrap))
  expect(strings).toHaveLength(1)
  return strings[0]!
}

function resolveHook(source: string): ResolveHook {
  const parsed = parse(source)
  const helpers: string[] = []
  const registrations: string[] = []
  function visit(node: ts.Node): void {
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'canonicalSnapshotModuleURL') helpers.push(node.getText(parsed))
    if (ts.isIfStatement(node) && node.expression.getText(parsed).includes('process.platform')
      && node.thenStatement.getText(parsed).includes('canonicalSnapshotModuleURL')) registrations.push(node.getText(parsed))
    ts.forEachChild(node, visit)
  }
  visit(parsed)
  expect(helpers).toHaveLength(1)
  expect(registrations).toHaveLength(1)
  let hook: ResolveHook | undefined
  runInNewContext(helpers[0]! + '\n' + registrations[0]!, {
    URL, process: { platform: 'win32' }, SNAPSHOT_PREFIX: '/snapshot',
    toPlatformPath: () => String.raw`C:\snapshot`,
    require: (name: string) => name === 'url'
      ? { pathToFileURL: () => new URL('file:///C:/snapshot') }
      : { registerHooks: (hooks: { resolve: ResolveHook }) => { hook = hooks.resolve } },
  })
  expect(hook).toBeDefined()
  return hook!
}

it.each([
  ['source', source],
  ['main bootstrap', bootstrap],
  ['worker bootstrap', workerSource()],
])('preserves one Windows virtual module identity in the %s', (_name, source) => {
  const resolve = resolveHook(source)
  const context = { parentURL: 'file:///E:/plugins/addon/index.js' }
  const expected = 'file:///C:/snapshot/node/node_modules/cordis/index.js'
  for (const drive of ['C', 'E', 'V', 'z']) {
    const result = { url: `file:///${drive}:/snapshot/node/node_modules/cordis/index.js`, format: 'module', shortCircuit: true }
    const resolved = resolve('cordis', context, (specifier, passedContext) => {
      expect(specifier).toBe('cordis')
      expect(passedContext).toBe(context)
      return result
    })
    expect(resolved).toEqual({ ...result, url: expected })
  }
  const queried = { url: 'file:///E:/snapshot/node/a%20b.js?variant=one#member', format: 'module' }
  expect(resolve('./a b.js', context, () => queried).url)
    .toBe('file:///C:/snapshot/node/a%20b.js?variant=one#member')
  for (const url of ['file:///E:/plugins/cordis/index.js', 'file:///E:/snapshot-other/index.js',
    'file://server/share/snapshot/index.js', 'node:fs', 'data:text/javascript,export{}']) {
    const result = { url, format: 'module' }
    expect(resolve('unchanged', context, () => result)).toBe(result)
  }
})
