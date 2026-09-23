import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { verifyCodexRuntime } from '../scripts/verify-codex-runtime.ts'

const provider = JSON.parse(readFileSync(new URL('../../../packages/subagent/subagent-codex/package.json', import.meta.url), 'utf8')) as { dependencies: Record<string, string> }
const version = provider.dependencies['@openai/codex']!
const target = { platform: process.platform, arch: process.arch }
const platformName = `@openai/codex-${target.platform}-${target.arch}`
const platformVersion = `${version}-${process.platform}-${process.arch}`

function put(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

function fixture() {
  const temporary = mkdtempSync(join(tmpdir(), 'dsh-codex-payload-'))
  onTestFinished(() => { rmSync(temporary, { recursive: true, force: true }) })
  const root = join(temporary, 'runtime')
  const modules = join(root, 'node_modules')
  const providerManifest = join(modules, '@deepseek-ai/dsh-subagent-codex/package.json')
  const cliManifest = join(modules, '@openai/codex/package.json')
  const platformManifest = join(modules, platformName, 'package.json')
  const wrapper = join(modules, '@openai/codex/bin/codex.mjs')
  put(join(root, 'package.json'), '{}')
  put(providerManifest, JSON.stringify({ dependencies: { '@openai/codex': version } }))
  put(cliManifest, JSON.stringify({ version, bin: { codex: 'bin/codex.mjs' }, optionalDependencies: { [platformName]: `npm:@openai/codex@${platformVersion}` } }))
  put(platformManifest, JSON.stringify({ name: '@openai/codex', version: platformVersion }))
  put(wrapper, `if(process.argv[2] !== '--version' || process.env.CODEX_HOME === undefined) process.exit(2); console.log('codex-cli ${version}')\n`)
  return { temporary, root, providerManifest, cliManifest, platformManifest, wrapper }
}

it('executes the payload wrapper with the supplied Node and the source provider pin', async () => {
  await expect(verifyCodexRuntime(fixture().root, process.execPath, version, target)).resolves.toBeUndefined()
})

it('requires the selected target rather than accepting the build host platform', async () => {
  const value = fixture()
  await expect(verifyCodexRuntime(value.root, process.execPath, version, { ...target, arch: 'uninstalled-target' })).rejects.toThrow()
})

it('does not replace an unavailable bundled Node with a host executable', async () => {
  const value = fixture()
  await expect(verifyCodexRuntime(value.root, join(value.temporary, 'missing-node'), version, target)).rejects.toThrow()
})

it('rejects an omitted optional platform dependency', async () => {
  const value = fixture()
  rmSync(dirname(value.platformManifest), { recursive: true })
  await expect(verifyCodexRuntime(value.root, process.execPath, version, target)).rejects.toThrow()
})

it('cannot borrow an omitted platform dependency from an ancestor installation', async () => {
  const value = fixture()
  rmSync(dirname(value.platformManifest), { recursive: true })
  put(join(value.temporary, 'node_modules', platformName, 'package.json'), JSON.stringify({ name: '@openai/codex', version: platformVersion }))
  await expect(verifyCodexRuntime(value.root, process.execPath, version, target)).rejects.toThrow(/outside.*runtime/u)
})

it('rejects a wrapper whose native executable is unavailable', async () => {
  const value = fixture()
  put(value.wrapper, "process.stderr.write('native executable missing'); process.exit(1)\n")
  await expect(verifyCodexRuntime(value.root, process.execPath, version, target)).rejects.toThrow()
})

it('rejects a successful wrapper that reports another CLI version', async () => {
  const value = fixture()
  put(value.wrapper, "console.log('codex-cli 0.0.0')\n")
  await expect(verifyCodexRuntime(value.root, process.execPath, version, target)).rejects.toThrow(/version/u)
})

it('rejects provider pin drift before executing a wrapper', async () => {
  const value = fixture()
  put(value.providerManifest, JSON.stringify({ dependencies: { '@openai/codex': '0.0.0' } }))
  await expect(verifyCodexRuntime(value.root, process.execPath, version, target)).rejects.toThrow(/provider/u)
})

it('requires the exact platform alias declared by the CLI manifest', async () => {
  const value = fixture()
  put(value.platformManifest, JSON.stringify({ name: '@openai/codex', version: '0.0.0' }))
  await expect(verifyCodexRuntime(value.root, process.execPath, version, target)).rejects.toThrow(/platform/u)
})
