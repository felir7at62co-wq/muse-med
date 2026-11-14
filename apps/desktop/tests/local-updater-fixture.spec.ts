/** Offline capture dispatch for the actual Electron qualification statements. */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { expect, it } from 'vitest'

function captureStatements() {
  const source = readFileSync(new URL('./fixtures/local-updater.mjs', import.meta.url), 'utf8')
  const file = ts.createSourceFile('local-updater.mjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  let optional: ts.VariableStatement | undefined
  let selection: ts.VariableStatement | undefined
  const captures: ts.CallExpression[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      if (node.name.text === 'capture' && ts.isVariableStatement(node.parent.parent)) optional = node.parent.parent
      if (node.name.text === 'captureContents' && ts.isVariableStatement(node.parent.parent)) selection = node.parent.parent
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === 'capturePage') captures.push(node)
    ts.forEachChild(node, visit)
  }
  visit(file)
  if (optional === undefined || !ts.isBlock(optional.parent) || captures.length !== 2) {
    throw new Error('Expected the optional and required screenshot statements in the qualification fixture')
  }
  const index = optional.parent.statements.indexOf(optional)
  const optionalStatements = optional.parent.statements.slice(index, index + 3)
  if (!ts.isTryStatement(optionalStatements[1]!) || !ts.isIfStatement(optionalStatements[2]!)) {
    throw new Error('Expected the original optional screenshot result handling')
  }
  let required: ts.Node = captures[1]!
  while (!ts.isExpressionStatement(required)) required = required.parent
  if (!ts.isBlock(required.parent)) throw new Error('Expected required screenshot block')
  const requiredIndex = required.parent.statements.indexOf(required)
  return {
    selection: selection?.getText(file) ?? '',
    optional: optionalStatements.map(node => node.getText(file)).join('\n'),
    required: required.parent.statements.slice(requiredIndex, requiredIndex + 2).map(node => node.getText(file)).join('\n'),
  }
}

function captureFixture(platform: 'win32' | 'darwin', failure?: Error) {
  const calls: string[] = []
  const writes: Array<{ path: string; bytes: Buffer }> = []
  const surface = (label: string) => ({
    async capturePage() {
      calls.push(label)
      if (failure) throw failure
      return { toPNG: () => Buffer.from(label) }
    },
  })
  const owner = surface('owner-web-contents'), overlay = surface('overlay-web-contents')
  const frame = { detached: false, executeJavaScript: async () => 'frame content' }
  const pieces = captureStatements()
  const run = (kind: 'optional' | 'required') => runInNewContext(`(async () => {
    let screenshot = { captured: false, reason: 'not attempted' };
    const dialogScreenshots = [];
    ${pieces.selection}
    ${pieces[kind]}
    return { screenshot, dialogScreenshots };
  })()`, {
    process: { platform }, parent: { webContents: owner }, contents: platform === 'win32' ? frame : overlay,
    root: 'qualification-root', name: 'mandatory-error-expanded.png', join,
    writeFile: async (path: string, bytes: Buffer) => { writes.push({ path, bytes }) },
  }) as Promise<{ screenshot: { captured: boolean; reason?: string }; dialogScreenshots: string[] }>
  return { calls, writes, run }
}

it.each(['win32', 'darwin'] as const)('captures the optional %s screenshot without hiding a missing frame method', async (platform) => {
  const f = captureFixture(platform)
  expect((await f.run('optional')).screenshot).toEqual({ captured: true })
  const label = platform === 'win32' ? 'owner-web-contents' : 'overlay-web-contents'
  expect(f.calls).toEqual([label])
  expect(f.writes).toEqual([{ path: join('qualification-root', 'mandatory-update.png'), bytes: Buffer.from(label) }])
})

it.each(['win32', 'darwin'] as const)('captures required %s evidence through the native WebContents', async (platform) => {
  const f = captureFixture(platform)
  expect((await f.run('required')).dialogScreenshots).toEqual(['mandatory-error-expanded.png'])
  const label = platform === 'win32' ? 'owner-web-contents' : 'overlay-web-contents'
  expect(f.calls).toEqual([label])
  expect(f.writes).toEqual([{ path: join('qualification-root', 'mandatory-error-expanded.png'), bytes: Buffer.from(label) }])
})

it('propagates a native screenshot failure without recording required evidence', async () => {
  const failure = new Error('native screenshot failed')
  const f = captureFixture('win32', failure)
  await expect(f.run('required')).rejects.toBe(failure)
  expect(f.calls).toEqual(['owner-web-contents'])
  expect(f.writes).toEqual([])
})
