/** Validate the private Deep View Host overlay while preserving its retained source pin. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { applyDeepViewHostCompatibility, deepViewHostCompatibility } from './deep-view-host.mjs'
import { evaluatePluginCompatibility } from '../../../packages/boot/app-boot/lib/index.js'

const source = join(import.meta.dirname, '../deep-view')
const pinsPath = join(import.meta.dirname, '../sources.json')
const inputFiles = ['package.json', 'src/host/install.js', 'test/fake-ctx.js', 'test/host.test.js']
const digest = bytes => createHash('sha256').update(bytes).digest('hex')

function staging(t) {
  const directory = mkdtempSync(join(tmpdir(), 'muse-deep-view-overlay-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  cpSync(source, directory, { recursive: true })
  return directory
}

test('adapts live root and answer ownership only in private staging', t => {
  const directory = staging(t)
  const pinBytes = readFileSync(pinsPath)
  const pin = JSON.parse(pinBytes.toString('utf8'))['deep-view']
  const originals = new Map(Object.keys(pin.localModifications.files).map(path => [path, readFileSync(join(source, path))]))
  assert.deepEqual(applyDeepViewHostCompatibility(directory), deepViewHostCompatibility)

  const host = readFileSync(join(directory, 'src/host/install.js'), 'utf8')
  assert.doesNotMatch(host, /\.roots\(/u)
  assert.match(host, /ctx\.agents\.get\(agent\.id\) !== agent/u)
  assert.match(host, /agent\.session\.header\.origin === 'subagent'/u)
  assert.match(host, /agent\.id !== id/u)
  assert.match(host, /agent\.session\.id !== id/u)
  const fixture = readFileSync(join(directory, 'test/fake-ctx.js'), 'utf8')
  const hostTests = readFileSync(join(directory, 'test/host.test.js'), 'utf8')
  assert.doesNotMatch(fixture, /roots\s*\(/u)
  assert.doesNotMatch(hostTests, /root: (?:true|false)/u)
  assert.match(hostTests, /origin: 'subagent'/u)
  assert.match(hostTests, /id: 's1'/u)
  const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
  assert.equal(manifest.engines.dsh, '0.2.2-rc.1 || 0.2.2-rc.2')
  assert.equal(manifest.engines.dsh, deepViewHostCompatibility.dshEngine)
  assert.equal(evaluatePluginCompatibility(manifest), undefined)

  assert.deepEqual(readFileSync(pinsPath), pinBytes)
  for (const [path, original] of originals) {
    assert.deepEqual(readFileSync(join(source, path)), original, `${path} retained bytes`)
    assert.equal(digest(original), pin.localModifications.files[path].sha256, `${path} retained pin`)
  }
})

for (const runtime of ['0.2.2-rc.0', '0.2.2-rc.3', '0.2.2', '0.3.0']) {
  test(`does not grant an engine qualification for unreviewed Host ${runtime}`, t => {
    const directory = staging(t)
    applyDeepViewHostCompatibility(directory)
    const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
    const issue = evaluatePluginCompatibility(manifest, {}, runtime)
    assert.equal(issue.exempted, false)
    assert.deepEqual(issue.requirements, { 'engines.dsh': deepViewHostCompatibility.dshEngine })
  })
}

for (const path of inputFiles) {
  test(`requires source review before adapting a changed ${path}`, t => {
    const directory = staging(t)
    const changed = join(directory, path)
    writeFileSync(changed, readFileSync(changed, 'utf8') + '\n// source drift\n')
    const before = new Map(inputFiles.map(file => [file, readFileSync(join(directory, file))]))
    assert.throws(() => applyDeepViewHostCompatibility(directory), error =>
      error instanceof Error && error.message.includes(path) && /review/u.test(error.message))
    for (const [file, bytes] of before) assert.deepEqual(readFileSync(join(directory, file)), bytes)
  })
}

test('requires fresh retained input instead of applying the overlay twice', t => {
  const directory = staging(t)
  applyDeepViewHostCompatibility(directory)
  const adapted = new Map(inputFiles.map(path => [path, readFileSync(join(directory, path))]))
  assert.throws(() => applyDeepViewHostCompatibility(directory), /review/u)
  for (const [path, bytes] of adapted) assert.deepEqual(readFileSync(join(directory, path)), bytes)
})
