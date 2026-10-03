/** Qualify the JavaScript-only source and its actual packed entry from two isolated builds. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { applyHongguoHostCompatibility } from './compatibility/hongguo-host.mjs'
import { hostRuntimeCompatibility, reviewedHostVersion } from './compatibility/host-runtime.mjs'

const repository = resolve(import.meta.dirname, '../..')
test('packs recovered Hongguo source deterministically with current Host qualification', () => {
  const outputs = ['first', 'second'].map(label => mkdtempSync(join(tmpdir(), `muse-hongguo-${label}-`)))
  try {
    for (const output of outputs) {
      const result = spawnSync(process.execPath, [join(import.meta.dirname, 'build.mjs'), '--only', 'muse-hongguo-search', '--out', output], { cwd: repository, stdio: 'inherit' })
      assert.equal(result.status, 0, 'source build must pass its real Host runtime checks')
      assert.deepEqual(readdirSync(output), ['muse-hongguo-search-0.1.0.tgz'])
    }
    const archives = outputs.map(output => readFileSync(join(output, 'muse-hongguo-search-0.1.0.tgz')))
    const sha256 = value => createHash('sha256').update(value).digest('hex')
    assert.equal(sha256(archives[0]), sha256(archives[1]))
    const archive = join(outputs[0], 'muse-hongguo-search-0.1.0.tgz')
    const entry = path => {
      const result = spawnSync('tar', ['-xOzf', archive, `package/${path}`], { encoding: 'utf8' })
      assert.equal(result.status, 0)
      return result.stdout
    }
    const manifest = JSON.parse(entry('package.json'))
    assert.equal(manifest.main, './src/index.js')
    assert.deepEqual(manifest.scripts, {})
    assert.equal(manifest.peerDependencies['@deepseek-ai/dsh-tools'], reviewedHostVersion)
    const source = JSON.parse(entry('SOURCE.json'))
    assert.equal(source.upstream.archiveSha256, '9133f9aa523ef86d7abbf0d9ec8fcdf644c93f2c8f1c70bb3ad0f4a8d7f31dda')
    assert.equal(source.upstream.commit, undefined)
    assert.equal(source.hostVersion, reviewedHostVersion)
    assert.deepEqual(source.hostRuntimeCompatibility, hostRuntimeCompatibility)
    assert.match(entry('cordis.patch.yml'), /disabled: true/u)
    assert.match(entry('LICENSE'), /MIT License/u)
    assert.match(entry('RECOVERY.md'), /20/u)
    assert.equal(entry('src/index.js'), readFileSync(join(import.meta.dirname, 'muse-hongguo-search/src/index.js'), 'utf8'))
    const listing = spawnSync('tar', ['-tzf', archive], { encoding: 'utf8' })
    assert.equal(listing.status, 0)
    assert.doesNotMatch(listing.stdout, /node_modules|\.env|\.git\/|\.muse-hongguo\.test/u)
  } finally {
    for (const output of outputs) rmSync(output, { recursive: true, force: true })
  }
})

test('rejects tampered retained source before adapting the package', () => {
  const staging = mkdtempSync(join(tmpdir(), 'muse-hongguo-tampered-'))
  try {
    cpSync(join(import.meta.dirname, 'muse-hongguo-search'), staging, { recursive: true })
    const manifest = readFileSync(join(staging, 'package.json'))
    writeFileSync(join(staging, 'src/index.js'), '// changed recovered source\n')
    assert.throws(() => applyHongguoHostCompatibility(staging), /src\/index\.js requires source review/u)
    assert.deepEqual(readFileSync(join(staging, 'package.json')), manifest)
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
})
