/** Build pinned community source in private staging; never read a live Harness profile. */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { applyMcpDesktopCompatibility, mcpDesktopCompatibility } from './compatibility/mcp-desktop.mjs'
import { applyBridgeDesktopCompatibility, bridgeDesktopCompatibility } from './compatibility/bridge-desktop.mjs'

import { applyCodexModelVisibility } from './compatibility/codex-model-visibility.mjs'
import { applyCodexPiAiCompatibility, codexPiAiVersion } from './compatibility/codex-pi-ai.mjs'
import { applyHongguoHostCompatibility, hongguoHostCompatibility } from './compatibility/hongguo-host.mjs'
import { hostRuntimeCompatibility, qualifyCommunityManifest, reviewedHostVersion, reviewedVendorVersions } from './compatibility/host-runtime.mjs'

const sourceRoot = import.meta.dirname
const repository = resolve(sourceRoot, '../..')
const toolchain = join(sourceRoot, 'toolchain')
const pins = JSON.parse(readFileSync(join(sourceRoot, 'sources.json'), 'utf8'))
const tools = JSON.parse(readFileSync(join(toolchain, 'package.json'), 'utf8'))
const { values } = parseArgs({ options: { out: { type: 'string' }, only: { type: 'string' } } })
if (!values.out) throw new Error('community plugins: --out is required')
if (values.only && !Object.hasOwn(pins, values.only)) throw new Error(`community plugins: unknown source ${values.only}`)
const pnpm = process.env.npm_execpath
if (!pnpm) throw new Error('community plugins: invoke through pnpm --dir third_party/plugins/toolchain run build')
const output = resolve(values.out)
mkdirSync(output, { recursive: true })

function run(args, cwd, environment = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/KEY|SECRET|TOKEN|PASSWORD|^NODE_TEST_/iu.test(key)))
  Object.assign(env, environment)
  if (cwd !== toolchain) {
    env.DSH_HOME = join(dirname(cwd), 'test-home')
    env.CODEX_HOME = join(env.DSH_HOME, 'codex')
  }
  const result = spawnSync(process.execPath, args, { cwd, env, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`community plugins: ${args.join(' ')} failed (${result.status ?? result.signal})`)
}

function linkPackage(modules, name, directory, links) {
  const destination = join(modules, name)
  mkdirSync(dirname(destination), { recursive: true })
  symlinkSync(directory, destination, process.platform === 'win32' ? 'junction' : 'dir')
  links.push(destination)
}

function linkDependencies(modules, links) {
  for (const name of Object.keys(tools.dependencies)) {
    linkPackage(modules, name, name === '@earendil-works/pi-ai' ? hostPiAi : join(toolchain, 'node_modules', name), links)
  }
  for (const group of readdirSync(join(repository, 'packages'), { withFileTypes: true }).filter(entry => entry.isDirectory())) {
    for (const entry of readdirSync(join(repository, 'packages', group.name), { withFileTypes: true }).filter(entry => entry.isDirectory())) {
      const directory = join(repository, 'packages', group.name, entry.name)
      const manifest = join(directory, 'package.json')
      if (existsSync(manifest)) linkPackage(modules, JSON.parse(readFileSync(manifest, 'utf8')).name, directory, links)
    }
  }
  for (const entry of readdirSync(join(repository, 'vendor'), { withFileTypes: true }).filter(entry => entry.isDirectory())) {
    const directory = join(repository, 'vendor', entry.name)
    const manifest = join(directory, 'package.json')
    if (existsSync(manifest)) linkPackage(modules, JSON.parse(readFileSync(manifest, 'utf8')).name, directory, links)
  }
}

const hostVersion = JSON.parse(readFileSync(join(repository, 'package.json'), 'utf8')).version
if (hostVersion !== reviewedHostVersion) throw new Error(`community plugins: host ${hostVersion} needs a new compatibility review`)
for (const entry of readdirSync(join(repository, 'vendor'), { withFileTypes: true }).filter(entry => entry.isDirectory())) {
  const manifestPath = join(repository, 'vendor', entry.name, 'package.json')
  if (!existsSync(manifestPath)) continue
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (reviewedVendorVersions[manifest.name] !== manifest.version) throw new Error(`community plugins: vendor ${manifest.name} ${manifest.version} needs a new compatibility review`)
}
const hostPiAi = realpathSync(join(repository, 'packages/llm/llm-pi-ai/node_modules/@earendil-works/pi-ai'))
const hostPiAiVersion = JSON.parse(readFileSync(join(hostPiAi, 'package.json'), 'utf8')).version
if (hostPiAiVersion !== codexPiAiVersion) throw new Error(`community plugins: pi-ai ${hostPiAiVersion} needs a new compatibility review`)
run([pnpm, 'install', '--ignore-workspace', '--frozen-lockfile', '--ignore-scripts'], toolchain)

for (const name of values.only ? [values.only] : Object.keys(pins)) {
  const staging = mkdtempSync(join(output, '.source-build-'))
  const links = []
  try {
    const directory = join(staging, 'package')
    cpSync(join(sourceRoot, name), directory, { recursive: true, filter: path => !(name === 'dsh-bridge' ? /(?:^|[\\/])(?:node_modules|\.git)(?:[\\/]|$)/u : /(?:^|[\\/])(?:node_modules|lib|\.git)(?:[\\/]|$)/u).test(path) })
    const manifestPath = join(directory, 'package.json')
    let manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    if (manifest.version !== pins[name].version || manifest.license !== pins[name].license) throw new Error(`community plugins: ${name} disagrees with sources.json`)
    if (!readFileSync(join(directory, 'LICENSE'), 'utf8').trim()) throw new Error(`community plugins: ${name} has no license`)
    const modules = join(directory, 'node_modules')
    linkDependencies(modules, links)
    if (name === 'dsh-bridge') {
      applyBridgeDesktopCompatibility(directory)
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    }
    if (name === 'dsh-skill-mcp-panel') applyMcpDesktopCompatibility(directory)
    if (name === 'muse-hongguo-search') {
      applyHongguoHostCompatibility(directory)
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    }
    const tsc = join(toolchain, 'node_modules/typescript/bin/tsc')
    const tsdown = join(toolchain, 'node_modules/tsdown/dist/run.mjs')
    if (name === 'dsh-codex-subscription') {
      applyCodexPiAiCompatibility(directory)
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
      applyCodexModelVisibility(directory)
      const runtimePath = join(directory, 'src/subagent-runtime.js')
      let runtime = readFileSync(runtimePath, 'utf8')
      for (const [before, after] of [
        ["export const SUBAGENT_RUNTIME_VERSION = '0.1.5-rc.3'", `export const SUBAGENT_RUNTIME_VERSION = '${hostVersion}'`],
        ["const SUPPORTED_RUNTIME_VERSIONS = new Set(['0.1.5-rc.2', SUBAGENT_RUNTIME_VERSION])", 'const SUPPORTED_RUNTIME_VERSIONS = new Set([SUBAGENT_RUNTIME_VERSION])'],
        ["const codexManifestPath = providerRequire.resolve('@openai/codex/package.json')", "const codexManifestPath = codexFilesystemPath(providerRequire.resolve('@openai/codex/package.json'))"],
      ]) {
        if (runtime.split(before).length !== 2) throw new Error('community plugins: Codex runtime overlay needs source review')
        runtime = runtime.replace(before, after)
      }
      writeFileSync(runtimePath, runtime + String.raw`
// Native CLI files are unpacked together; resolve the manifest before its bin.
export function codexFilesystemPath(value) {
  return value.replace(/([\\/])app\.asar([\\/])/u, '$1app.asar.unpacked$2')
}
`)
      for (const index of [1, 2, 0]) {
        writeFileSync(join(directory, '.muse-tsdown.mjs'), `import configs from './tsdown.config.mjs'\nexport default { ...configs[${index}], clean: false, sourcemap: false, tsconfig: false }\n`)
        run([tsdown, '--config-loader', 'native', '--config', '.muse-tsdown.mjs'], directory)
      }
      cpSync(join(sourceRoot, 'checks/codex-subagent.mjs'), join(directory, '.muse-subagent.test.mjs'))
      cpSync(join(sourceRoot, 'checks/codex-pi-ai.mjs'), join(directory, '.muse-pi-ai.test.mjs'))
      run(['--test', '--test-concurrency=1', '.muse-pi-ai.test.mjs', '.muse-subagent.test.mjs', 'tests/pi-ai-runtime.test.mjs', 'tests/plugin-integration.test.mjs', 'tests/subscription-transport.test.mjs'], directory)
    } else if (name !== 'dsh-bridge' && name !== 'muse-hongguo-search') {
      if (name === 'dsh-ponytail') {
        writeFileSync(join(directory, 'tsconfig.json'), JSON.stringify({ compilerOptions: {
          target: 'ES2024', module: 'NodeNext', moduleResolution: 'NodeNext', rootDir: 'src', outDir: 'lib/types',
          declaration: true, rewriteRelativeImportExtensions: true, strict: true, skipLibCheck: true,
        }, include: ['src/index.ts'] }))
      }
      run([tsc, '-p', 'tsconfig.json', '--types', 'node'], directory)
      if (name === 'dsh-skill-mcp-panel') run(['scripts/strip-client-export.mjs'], directory)
      if (name === 'dsh-ponytail') {
        writeFileSync(join(directory, '.muse-tsdown.mjs'), `export default { entry: { index: 'src/index.ts' }, outDir: 'lib', format: 'esm', platform: 'node', target: 'es2024', fixedExtension: false, dts: false, clean: false, deps: { neverBundle: Object.keys(${JSON.stringify(manifest.peerDependencies)}) } }\n`)
        run([tsdown, '--config-loader', 'native', '--config', '.muse-tsdown.mjs'], directory)
      } else if (name !== 'dsh-ffmpeg' && name !== 'dsh-skill-mcp-panel') {
        run([tsdown, '--config-loader', 'native', '--config', 'tsdown.config.ts'], directory)
        if (name === 'dshmarket') run(['scripts/normalize-client-banner.mjs'], directory)
      }
    }
    run(['--input-type=module', '-e', `await import(${JSON.stringify(`./${manifest.main.replace(/^\.\//u, '')}`)})`], directory)
    if (name === 'muse-hongguo-search') {
      cpSync(join(sourceRoot, 'checks/hongguo-host-runtime.mjs'), join(directory, '.muse-hongguo.test.mjs'))
      run(['--test', '--test-concurrency=1', 'tests/recovery.test.js', '.muse-hongguo.test.mjs'], directory)
    }
    if (name === 'dsh-ffmpeg') {
      run(['--test', '--test-concurrency=1', ...['args', 'config', 'exec', 'ffprobe', 'paths', 'register', 'subprocess-context', 'tools', 'frames-probe', 'adjust', 'health'].map(test => `test/${test}.test.mjs`)], directory)
    }
    if (name === 'dshmarket') {
      manifest.exports['./catalog'] = { types: './lib/types/registry.d.ts', default: './lib/registry.js' }
    }
    if (name === 'dsh-bridge') {
      cpSync(join(sourceRoot, 'checks/bridge-desktop-runtime.mjs'), join(directory, '.muse-bridge.test.mjs'))
      run(['--test', '--test-concurrency=1', '.muse-bridge.test.mjs'], directory)
    }
    if (name === 'dsh-skill-mcp-panel') {
      cpSync(join(sourceRoot, 'checks/mcp-desktop-runtime.mjs'), join(directory, '.muse-mcp.test.mjs'))
      run(['--test', '.muse-mcp.test.mjs'], directory)
      cpSync(join(sourceRoot, 'checks/mcp-host-icons.mjs'), join(directory, '.muse-host-icons.test.mjs'))
      run(['--test', '--test-concurrency=1', 'test-panel-slots.mjs', 'test-mcp-model.mjs', 'test-mcp-gateway.mjs', '.muse-host-icons.test.mjs'], directory,
        { DSH_UI_PRIMITIVES: join(repository, 'packages/client/ui-primitives') })
    }
    manifest = qualifyCommunityManifest(manifest)
    manifest.scripts = {}
    if (name === 'dsh-skill-mcp-panel') delete manifest.bin
    manifest.packageManager = tools.packageManager
    for (const dependency of Object.keys(manifest.dependencies ?? {})) {
      if (tools.dependencies[dependency]) manifest.dependencies[dependency] = tools.dependencies[dependency]
    }
    if (name === 'dsh-codex-subscription') {
      writeFileSync(join(directory, 'BUNDLED_LICENSES.md'), `# Bundled dependency licenses\n\n## @heroicons/react ${tools.dependencies['@heroicons/react']}\n\n${readFileSync(join(toolchain, 'node_modules/@heroicons/react/LICENSE'), 'utf8')}`)
    }
    rmSync(join(directory, 'lib/tsconfig.tsbuildinfo'), { force: true })
    writeFileSync(join(directory, 'SOURCE.json'), `${JSON.stringify({
      upstream: pins[name], hostVersion, hostRuntimeCompatibility,
      compatibilityOverlay: name === 'dsh-codex-subscription'
        ? { subagentRuntimeVersion: hostVersion, piAiVersion: codexPiAiVersion, piAiCatalogFixtures: true, codexCliVersion: '0.153.4', codexAsarUnpack: true, authenticatedModelList: true }
        : name === 'dshmarket' ? { catalogExport: './catalog' }
          : name === 'dsh-bridge' ? bridgeDesktopCompatibility
            : name === 'dsh-skill-mcp-panel' ? mcpDesktopCompatibility
              : name === 'muse-hongguo-search' ? hongguoHostCompatibility : undefined,
      toolchainLockSha256: createHash('sha256').update(readFileSync(join(toolchain, 'pnpm-lock.yaml'))).digest('hex'),
    }, null, 2)}\n`)
    manifest.files = [...new Set([...(manifest.files ?? []), 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'BUNDLED_LICENSES.md', 'SOURCE.json'])]
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    if (name === 'dshmarket') {
      run(['--input-type=module', '-e', "const catalog = await import('dshmarket/catalog'); if (typeof catalog.loadRegistry !== 'function') throw new Error('missing catalog export')"], directory)
    }
    run([pnpm, '--ignore-workspace', 'pack', '--pack-destination', output], directory)
  } finally {
    for (const link of links.reverse()) unlinkSync(link)
    rmSync(staging, { recursive: true, force: true })
  }
}
