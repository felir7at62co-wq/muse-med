import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { load } from 'js-yaml'
import { stageRuntimeDependencyPatches, verifyRuntimeDependencyPatches } from '../scripts/runtime-dependency-patches.ts'

const roots: string[] = []
const original = 'export const original = true;\n'
const patched = 'function hasTokenUsage(usage) { return true; }\nif (hasTokenUsage(chunk.usage)) {}\nif (!hasTokenUsage(chunk.usage) && hasTokenUsage(choice.usage)) {}\n'
const patch = `diff --git a/dist/api/openai-completions.js b/dist/api/openai-completions.js\n--- a/dist/api/openai-completions.js\n+++ b/dist/api/openai-completions.js\n@@ -1 +1,3 @@\n-${original.trimEnd()}\n+${patched.trimEnd().replaceAll('\n', '\n+')}\n`
const selector = '@earendil-works/pi-ai@0.87.1'

afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function write(path: string, bytes: string): void { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, bytes) }
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'desktop-dependency-patches-'))
  roots.push(root)
  const repository = join(root, 'repository'), project = join(root, 'project')
  write(join(repository, 'pnpm-workspace.yaml'), `patchedDependencies:\n  '${selector}': patches/pi-ai.patch\n  'build-only@1.0.0': patches/build-only.patch\n`)
  write(join(repository, 'patches/pi-ai.patch'), patch)
  write(join(repository, 'patches/build-only.patch'), 'build-only patch not used by the production closure\n')
  write(join(repository, 'packages/llm/llm-pi-ai/package.json'), '{}\n')
  write(join(repository, 'packages/llm/llm-pi-ai/node_modules/@earendil-works/pi-ai/package.json'), '{"name":"@earendil-works/pi-ai","version":"0.87.1"}\n')
  write(join(repository, 'packages/llm/llm-pi-ai/node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js'), patched)
  write(join(project, 'pnpm-workspace.yaml'), 'packages:\n  - .\nallowBuilds: {}\n')
  return { root, repository, project }
}

it('carries exact patch bytes and changes the workspace identity when a patch changes', () => {
  const { repository, project } = fixture()
  stageRuntimeDependencyPatches(repository, project)
  const first = readFileSync(join(project, 'pnpm-workspace.yaml'), 'utf8')
  const data = load(first) as { patchedDependencies: Record<string, string>; allowUnusedPatches: boolean }
  expect(data.allowUnusedPatches).toBe(true)
  expect(Object.keys(data.patchedDependencies)).toHaveLength(2)
  expect(readFileSync(join(project, data.patchedDependencies[selector]!), 'utf8')).toBe(patch)
  writeFileSync(join(repository, 'patches/pi-ai.patch'), patch + '\n')
  stageRuntimeDependencyPatches(repository, project)
  expect(readFileSync(join(project, 'pnpm-workspace.yaml'), 'utf8')).not.toBe(first)
})

it('applies the patch during a real offline pnpm production install and refuses stale frozen locks', () => {
  const { root, repository, project } = fixture()
  const packageRoot = join(root, 'fixture-package')
  write(join(packageRoot, 'package/package.json'), '{"name":"@earendil-works/pi-ai","version":"0.87.1"}\n')
  write(join(packageRoot, 'package/dist/api/openai-completions.js'), original)
  const archive = join(root, 'pi-ai.tgz')
  execFileSync('tar', ['-czf', archive, '-C', packageRoot, 'package'])
  write(join(project, 'package.json'), JSON.stringify({ private: true, dependencies: { '@earendil-works/pi-ai': `file:${archive.replaceAll('\\', '/')}` } }))
  stageRuntimeDependencyPatches(repository, project)
  const pnpm = resolve('node_modules/pnpm/bin/pnpm.mjs')
  const args = [pnpm, 'install', '--offline', '--prod', '--ignore-scripts', '--config.registry=http://127.0.0.1:1', `--config.store-dir=${join(root, 'store')}`]
  execFileSync(process.execPath, args, { cwd: project, env: { ...process.env, CI: 'true', COREPACK_ENABLE_NETWORK: '0' }, timeout: 60_000, stdio: 'pipe' })
  expect(() => { verifyRuntimeDependencyPatches(repository, project) }).not.toThrow()
  expect(readFileSync(join(project, 'node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js'), 'utf8')).toBe(patched)
  writeFileSync(join(repository, 'patches/pi-ai.patch'), patch + '\n')
  stageRuntimeDependencyPatches(repository, project)
  const stale = spawnSync(process.execPath, [...args, '--frozen-lockfile'], { cwd: project, env: { ...process.env, CI: 'true', COREPACK_ENABLE_NETWORK: '0' }, timeout: 60_000, encoding: 'utf8' })
  expect(stale.status).not.toBe(0)
  expect(stale.stdout + stale.stderr).toContain('ERR_PNPM_LOCKFILE_CONFIG_MISMATCH')
}, 120_000)

it('rejects missing patch files and an unpatched or changed active runtime implementation', () => {
  const { repository, project } = fixture()
  rmSync(join(repository, 'patches/pi-ai.patch'))
  expect(() => { stageRuntimeDependencyPatches(repository, project) }).toThrow()
  const entry = join(project, 'node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js')
  write(entry, original)
  expect(() => { verifyRuntimeDependencyPatches(repository, project) }).toThrow('differ from the reviewed patched dependency')
  write(entry, patched)
  expect(() => { verifyRuntimeDependencyPatches(repository, project) }).not.toThrow()
  write(entry, patched + '\n')
  expect(() => { verifyRuntimeDependencyPatches(repository, project) }).toThrow('differ from the reviewed patched dependency')
  expect(existsSync(entry)).toBe(true)
})

it('rejects invalid patch declarations and an unpatched workspace reference', () => {
  const { repository, project } = fixture()
  for (const declaration of ['patchedDependencies: []\n', 'patchedDependencies:\n  invalid: ../outside.patch\n', 'patchedDependencies:\n  invalid: 42\n']) {
    writeFileSync(join(repository, 'pnpm-workspace.yaml'), declaration)
    expect(() => { stageRuntimeDependencyPatches(repository, project) }).toThrow()
  }
  const reference = join(repository, 'packages/llm/llm-pi-ai/node_modules/@earendil-works/pi-ai')
  writeFileSync(join(reference, 'dist/api/openai-completions.js'), original)
  expect(() => { verifyRuntimeDependencyPatches(repository, project) }).toThrow('reference lacks the reviewed token-usage patch')
  rmSync(reference, { recursive: true })
  write(join(repository, 'node_modules/@earendil-works/pi-ai/package.json'), '{}\n')
  write(join(repository, 'node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js'), patched)
  expect(() => { verifyRuntimeDependencyPatches(repository, project) }).toThrow('reference dependency is missing')
  write(join(reference, 'package.json'), '{}\n')
  expect(() => { verifyRuntimeDependencyPatches(repository, project) }).toThrow('reference dependency is missing')
})
