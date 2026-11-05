/** The patched SEA source, main bootstrap, and worker recognize the same Windows snapshot roots. */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { expect, it } from 'vitest'

const packageRoot = dirname(createRequire(import.meta.url).resolve('@yao-pkg/pkg/package.json'))
const source = readFileSync(join(packageRoot, 'prelude', 'sea-vfs-setup.js'), 'utf8')
const bootstrap = readFileSync(join(packageRoot, 'prelude', 'sea-bootstrap.bundle.js'), 'utf8')

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

function snapshotPredicate(source: string, platform: string): (path: string) => boolean {
  const parsed = parse(source)
  const candidates: ts.FunctionDeclaration[] = []
  const constants: string[] = []
  function visit(node: ts.Node): void {
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'insideSnapshot') candidates.push(node)
    if (ts.isVariableStatement(node) && node.declarationList.declarations.some(declaration =>
      ts.isIdentifier(declaration.name) && declaration.name.text.startsWith('SNAPSHOT_PREFIXES_'))) constants.push(node.getText(parsed))
    ts.forEachChild(node, visit)
  }
  visit(parsed)
  expect(candidates).toHaveLength(1)
  return runInNewContext(constants.join('\n') + '\n(' + candidates[0]!.getText(parsed) + ')',
    { process: { platform } }) as (path: string) => boolean
}

it.each([
  ['source', source],
  ['main bootstrap', bootstrap],
  ['worker bootstrap', workerSource()],
])('recognizes exact snapshot roots on every Windows drive in the %s', (_name, source) => {
  const windows = snapshotPredicate(source, 'win32')
  for (const path of [
    '/snapshot', '/snapshot/node/addon.node', 'C:\\snapshot', 'V:\\snapshot\\node\\addon.node',
    'D:\\snapshot\\node\\addon.node', 'E:/snapshot/node/addon.node', 'z:\\snapshot\\node\\addon.node',
  ]) expect(windows(path), path).toBe(true)
  for (const path of [
    '/snapshot-other/node', 'E:\\snapshots\\node', 'E:\\work\\snapshot\\node',
    'E:snapshot\\node', 'snapshot/node', 'E:\\snapshot-other\\node',
  ]) expect(windows(path), path).toBe(false)
  const posix = snapshotPredicate(source, 'linux')
  expect(posix('/snapshot/node/addon.node')).toBe(true)
  expect(posix('/snapshot-other/node')).toBe(false)
  expect(posix('E:\\snapshot\\node\\addon.node')).toBe(false)
})
