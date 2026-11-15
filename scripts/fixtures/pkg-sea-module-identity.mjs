/** Execute the shipped Windows virtual-URL hooks with an isolated actual Node ESM cache. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

const packageRoot = process.argv[2]
if (!packageRoot) throw new Error('Expected the installed pkg package directory')
const main = readFileSync(join(packageRoot, 'prelude/sea-bootstrap.bundle.js'), 'utf8')
const source = readFileSync(join(packageRoot, 'prelude/sea-vfs-setup.js'), 'utf8')

function find(source, predicate) {
  const parsed = ts.createSourceFile('prelude.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const result = []
  function visit(node) { if (predicate(node, parsed)) result.push(node); ts.forEachChild(node, visit) }
  visit(parsed)
  return { parsed, nodes: result }
}

const worker = find(main, node => ts.isStringLiteral(node) && node.text.includes('function insideSnapshot(f)'))
assert.equal(worker.nodes.length, 1)
const faces = {}
for (const [name, text] of Object.entries({ source, main, worker: worker.nodes[0].text })) {
  const helpers = find(text, node => ts.isFunctionDeclaration(node)
    && (node.name?.text === 'canonicalSnapshotModuleURL' || node.name?.text === 'toPlatformPath'))
  const registrations = find(text, node => ts.isIfStatement(node) && node.expression.getText().includes('process.platform')
    && node.thenStatement.getText().includes('canonicalSnapshotModuleURL'))
  assert.equal(helpers.nodes.length, 2)
  assert.equal(registrations.nodes.length, 1)
  let loads = 0
  const handles = []
  const prefix = `dsh-pkg-instance-${name}:`
  handles.push(registerHooks({
    resolve(specifier, context, nextResolve) {
      if (!specifier.startsWith(prefix)) return nextResolve(specifier, context)
      const alias = new URL(specifier)
      return { url: `file:///${alias.pathname}:/snapshot/node/module-${name}.mjs${alias.search}${alias.hash}`, shortCircuit: true }
    },
    load(url, context, nextLoad) {
      if (!url.includes(`/snapshot/node/module-${name}.mjs`)) return nextLoad(url, context)
      loads++
      return { format: 'module', source: 'export const instance = Symbol("packaged virtual module");', shortCircuit: true }
    },
  }))
  const statements = helpers.nodes.map(node => node.getText(helpers.parsed)).join('\n')
    + '\n' + registrations.nodes[0].getText(registrations.parsed)
  runInNewContext(statements, {
    URL, process: { platform: 'win32' }, SNAPSHOT_PREFIX: '/snapshot',
    require: name => {
      if (name === 'url') return { pathToFileURL: value => pathToFileURL(value, { windows: true }) }
      if (name === 'module') return { registerHooks: hooks => { const handle = registerHooks(hooks); handles.push(handle); return handle } }
      throw new Error(`Unexpected virtual module dependency: ${name}`)
    },
  })
  try {
    const modules = []
    for (const drive of ['C', 'E', 'V', 'z']) modules.push(await import(prefix + drive))
    const namespaces = new Set(modules).size
    assert.equal(namespaces, 1)
    const baseLoads = loads
    assert.equal(baseLoads, 1)
    const first = await import(prefix + 'E?variant=one#member')
    const sameQuery = await import(prefix + 'z?variant=one#member')
    const differentQuery = await import(prefix + 'E?variant=two#member')
    assert.equal(first, sameQuery)
    assert.notEqual(first, differentQuery)
    faces[name] = { namespaces, baseLoads, distinctQueries: true }
  } finally {
    for (const handle of handles.reverse()) handle.deregister()
  }
}
process.stdout.write(JSON.stringify({ faces }) + '\n')
