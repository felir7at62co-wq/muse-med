import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { load } from 'js-yaml'
import { stageRuntimeDependencyPatches, verifyRuntimeDependencyPatches } from '../scripts/runtime-dependency-patches.ts'

const roots: string[] = []
const original = 'export const original = true;\n'
const patched = [
  'const tokenValues = [chunk.usage?.prompt_tokens, chunk.usage?.completion_tokens];',
  'const hasTokenUsage = tokenValues.some(value => value !== undefined) && tokenValues.every(value => value === undefined || (typeof value === "number" && Number.isFinite(value) && value >= 0));',
  'if (hasTokenUsage) {}',
  'const choiceTokenValues = [choice.usage?.prompt_tokens, choice.usage?.completion_tokens];',
  'const hasChoiceTokenUsage = choiceTokenValues.some(value => value !== undefined) && choiceTokenValues.every(value => value === undefined || (typeof value === "number" && Number.isFinite(value) && value >= 0));',
  'if (!hasTokenUsage && hasChoiceTokenUsage) {}',
].join('\n') + '\n'
const patch = `diff --git a/dist/api/openai-completions.js b/dist/api/openai-completions.js\n--- a/dist/api/openai-completions.js\n+++ b/dist/api/openai-completions.js\n@@ -1 +1,${patched.trimEnd().split('\n').length} @@\n-${original.trimEnd()}\n+${patched.trimEnd().replaceAll('\n', '\n+')}\n`
const selector = '@earendil-works/pi-ai@1.3.0'

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
  write(join(repository, 'packages/llm/llm-pi-ai/node_modules/@earendil-works/pi-ai/package.json'), '{"name":"@earendil-works/pi-ai","version":"1.3.0"}\n')
  write(join(repository, 'packages/llm/llm-pi-ai/node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js'), patched)
  write(join(project, 'node_modules/@earendil-works/pi-ai/package.json'), '{"name":"@earendil-works/pi-ai","version":"1.3.0"}\n')
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
  writeFileSync(join(repository, 'pnpm-workspace.yaml'), `patchedDependencies:\n  'build-only@1.0.0': patches/build-only.patch\n  '${selector}': patches/pi-ai.patch\n`)
  stageRuntimeDependencyPatches(repository, project)
  expect(readFileSync(join(project, 'pnpm-workspace.yaml'), 'utf8')).toBe(first)
  writeFileSync(join(repository, 'patches/pi-ai.patch'), patch + '\n')
  stageRuntimeDependencyPatches(repository, project)
  expect(readFileSync(join(project, 'pnpm-workspace.yaml'), 'utf8')).not.toBe(first)
})

it('accepts the installed reviewed workspace patch and rejects equal but unguarded copies', () => {
  const { repository, project } = fixture()
  const entry = 'dist/api/openai-completions.js'
  const active = readFileSync(resolve('packages/llm/llm-pi-ai/node_modules/@earendil-works/pi-ai', entry), 'utf8')
  const reference = join(repository, 'packages/llm/llm-pi-ai/node_modules/@earendil-works/pi-ai', entry)
  const installed = join(project, 'node_modules/@earendil-works/pi-ai', entry)
  write(reference, active)
  write(installed, active)
  expect(() => { verifyRuntimeDependencyPatches(repository, project) }).not.toThrow()
  const unsafe = active.replaceAll('Number.isFinite(value)', 'true')
  expect(unsafe).not.toBe(active)
  write(reference, unsafe)
  write(installed, unsafe)
  expect(() => { verifyRuntimeDependencyPatches(repository, project) }).toThrow('reference lacks the reviewed token-usage patch')
})

it('applies the patch during a real offline pnpm production install and refuses stale frozen locks', () => {
  const { root, repository, project } = fixture()
  const packageRoot = join(root, 'fixture-package')
  write(join(packageRoot, 'package/package.json'), '{"name":"@earendil-works/pi-ai","version":"1.3.0"}\n')
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
  for (const declaration of ['[]\n', 'patchedDependencies: null\n', 'patchedDependencies: []\n',
    'patchedDependencies:\n  invalid: ../outside.patch\n', 'patchedDependencies:\n  invalid: /outside.patch\n',
    'patchedDependencies:\n  invalid: 42\n', "patchedDependencies:\n  '': patches/pi-ai.patch\n", "patchedDependencies:\n  invalid: ''\n"]) {
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

it('accepts the actual locked PI-AI reference instead of the retired function-shaped patch', () => {
  const { project } = fixture()
  const repository = resolve(import.meta.dirname, '../../..')
  const reference = join(repository, 'packages/llm/llm-pi-ai/node_modules/@earendil-works/pi-ai')
  const entry = join(project, 'node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js')
  write(entry, readFileSync(join(reference, 'dist/api/openai-completions.js'), 'utf8'))
  expect(() => { verifyRuntimeDependencyPatches(repository, project) }).not.toThrow()
  writeFileSync(entry, readFileSync(entry, 'utf8') + '\n')
  expect(() => { verifyRuntimeDependencyPatches(repository, project) }).toThrow('differ from the reviewed patched dependency')
})

it.each([0, 1, 2, 3, 4, 5])('rejects a missing token predicate or branch at statement %i even when both copies agree', (index) => {
  const { repository, project } = fixture()
  const changed = patched.split('\n').filter((_line, offset) => offset !== index).join('\n')
  write(join(repository, 'packages/llm/llm-pi-ai/node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js'), changed)
  write(join(project, 'node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js'), changed)
  expect(() => { verifyRuntimeDependencyPatches(repository, project) }).toThrow('reference lacks the reviewed token-usage patch')
})

it.each(['tokenValues', 'choiceTokenValues'])('rejects a changed %s validity rule rather than accepting a similar marker', (values) => {
  const { repository, project } = fixture()
  const changed = patched.replace(`${values}.every(value => value === undefined || (typeof value === "number" && Number.isFinite(value) && value >= 0))`, 'true')
  write(join(repository, 'packages/llm/llm-pi-ai/node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js'), changed)
  write(join(project, 'node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js'), changed)
  expect(() => { verifyRuntimeDependencyPatches(repository, project) }).toThrow('reference lacks the reviewed token-usage patch')
})

it.each(['workspace', 'installed'])('rejects an unreviewed %s PI-AI version with otherwise identical module bytes', (location) => {
  const { repository, project } = fixture()
  write(join(project, 'node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js'), patched)
  const root = location === 'workspace' ? join(repository, 'packages/llm/llm-pi-ai') : project
  write(join(root, 'node_modules/@earendil-works/pi-ai/package.json'), '{"name":"@earendil-works/pi-ai","version":"0.87.1"}\n')
  expect(() => { verifyRuntimeDependencyPatches(repository, project) }).toThrow(location === 'workspace'
    ? 'workspace PI-AI reference version is not reviewed' : 'installed PI-AI version differs from the reviewed reference')
})
