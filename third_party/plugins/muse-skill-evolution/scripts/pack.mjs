/** Package independent Skill learning with exact Host peers and retained source attribution. */
import { createHash } from 'node:crypto'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const args = process.argv.slice(2)
if (args[0] === '--') args.shift()
if (args.length && (args.length !== 2 || args[0] !== '--out' || !isAbsolute(args[1]))) throw new Error('Use node scripts/pack.mjs [--out <absolute-directory>]')
const output = args[1] ?? join(root, 'dist')
const host = JSON.parse(readFileSync(new URL('../../../../apps/desktop-host/package.json', import.meta.url), 'utf8'))
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
if (Object.entries(manifest.peerDependencies).some(([name, version]) => name.startsWith('@deepseek-ai/dsh-') && version !== host.version)) throw new Error('Skill learning peers must match the current Host version')
const bot = JSON.parse(readFileSync(new URL('../../sources.json', import.meta.url), 'utf8'))['ds-bot']
mkdirSync(output, { recursive: true })
const staging = mkdtempSync(join(tmpdir(), 'muse-skill-evolution-pack-'))
try {
  for (const file of ['package.json', 'src', 'cordis.patch.yml', 'README.md', 'README.zh.md', 'README.i18n.yaml', 'LICENSE', 'NOTICE']) cpSync(join(root, file), join(staging, file), { recursive: true })
  const sourceFiles = {}
  for (const file of readdirSync(join(root, 'src')).sort()) sourceFiles[`src/${file}`] = createHash('sha256').update(readFileSync(join(root, 'src', file))).digest('hex')
  writeFileSync(join(staging, 'SOURCE.json'), JSON.stringify({ name: manifest.name, hostVersion: host.version, sourceFiles,
    derivedFrom: { repository: bot.repository, commit: bot.commit, version: bot.version, license: bot.license,
      scope: 'Reusable-experience review criteria; independent Muse runtime and storage' } }, null, 2) + '\n')
  const cli = process.env.npm_execpath
  const packArgs = ['pack', '--json', '--pack-destination', output]
  const result = spawnSync(cli ? process.execPath : 'npm', cli ? [cli, ...packArgs] : packArgs, { cwd: staging, encoding: 'utf8', env: { ...process.env, npm_config_ignore_scripts: 'true' } })
  if (result.error) throw result.error
  if (result.status !== 0 || result.signal) throw new Error(`Skill learning package creation failed: ${result.stderr}`)
  const packed = JSON.parse(result.stdout), entry = Array.isArray(packed) ? packed[0] : packed
  const archive = join(output, `${manifest.name}-${manifest.version}.tgz`)
  if (typeof entry?.filename !== 'string' || resolve(output, entry.filename) !== archive) throw new Error('Unexpected Skill learning package filename')
  process.stdout.write(JSON.stringify({ package: archive, hostVersion: host.version }) + '\n')
} finally { rmSync(staging, { recursive: true, force: true }) }
