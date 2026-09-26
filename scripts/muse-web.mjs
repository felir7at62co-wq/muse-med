/**
 * Start the Web GUI against the muse product home instead of the official dsh home.
 *
 * The launcher owns four things: `MUSE_HOME`, the Web port, the Feishu bridge gate, and the
 * product's Feishu setup row in that home's Web profile. `dsh-home-paths` already prefers
 * `MUSE_HOME` over `DSH_HOME`, so the CLI, the profile directory, settings, credentials,
 * skills, and the session store all resolve under one home without a second application or a
 * change to any composed default. The port defaults to 327, because the official 3080 is
 * where a plain `dsh web` binds and the two must not collide; an explicit `--port` wins.
 * Before the Web app starts, the launcher ensures the profile's own patch layer disables the
 * market Feishu bridge row whenever that profile lists the bundle: the market package has no
 * plugin-level activation control, so the Loader's entry-level `disabled` is the only switch
 * that keeps its code from running. It then ensures the same patch mounts
 * `@deepseek-ai/dsh-feishu-settings`, that the profile declares that dependency, and that the
 * profile links the repository package, so one `pnpm muse:web` carries the Settings page on a
 * fresh checkout; a missing client bundle is reported with the command to run, never built
 * here. Every append copies the previous file under `.local/`.
 * One line reports the resolved home, port, and URL, so it is visible which data the GUI
 * serves. Extra arguments are forwarded verbatim to the web app; `--dry-run` performs the
 * home preparation and exits without starting the app.
 *
 * @example
 * pnpm muse:web
 * pnpm muse:web -- --port 3399
 * pnpm muse:web -- --dry-run
 */

import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const home = process.env.MUSE_HOME ?? join(homedir(), '.muse')

/** Port this launcher serves on unless the invocation asks for another one. */
const MUSE_WEB_PORT = '327'

/** Bundle that contributes the Feishu bridge row to a profile listing it. */
const FEISHU_BUNDLE = '@moyu-good/dsh-lark-bridge'

/** Row id that bundle inserts, and the id this launcher's gate patches. */
const FEISHU_ROW_ID = 'feishu-channel'

/** Package whose row mounts the product's own Feishu switch and Settings page. */
const FEISHU_SETTINGS_PACKAGE = '@deepseek-ai/dsh-feishu-settings'

/** Repository directory that package builds from. */
const FEISHU_SETTINGS_DIR = join(ROOT, 'packages', 'host', 'feishu-settings')

/** Row the profile patch gains when it carries no setup page yet. */
const FEISHU_SETTINGS_ENTRY = `# ── 飞书设置分区：本产品自有的开关 + 扫码注册页（host + client 同挂）──────
# 由 scripts/muse-web.mjs 幂等维护：缺则追加，已有则原样跳过。
- insert:
    - id: feishu-settings
      name: '@deepseek-ai/dsh-feishu-settings'
`

/**
 * Gate appended to the Web profile's patch layer.
 *
 * The market package's `Config` carries no `enabled`, and its runtime registers its
 * settings section and starts the sync layer and QR onboarding as soon as the row runs,
 * so no plugin-level value can keep it off. This layer is applied after every bundle
 * layer, which is what lets the entry-level `disabled` reach the row the bundle inserts.
 */
const FEISHU_GATE = `# ── 飞书桥接：muse Web 侧默认不启动 ──────────────────────────────────────────
# 由 scripts/muse-web.mjs 幂等维护：本 profile 的 bundles 若含
# @moyu-good/dsh-lark-bridge（市场原版，Config 里没有 enabled /
# autoRegistration / crossInstanceSync，也没有任何插件级闸门），该行一旦启动就会
# 注册设置段、无条件开启跨实例同步层与控制服务，无凭据时还会走扫码注册；entry 级
# disabled 是唯一真正阻止其代码运行的开关。
# 要启用：把下面的 disabled 改成 false，并提供飞书凭据。桌面侧（muse-med）的闸门
# 在 apps/desktop-host 的组合层，覆盖不到本 profile。
- id: feishu-channel
  disabled: true
`

/**
 * Read the port the invocation asked for.
 * @param args - arguments after the pnpm `--` separator.
 * @returns the explicit value, `''` when the flag carries none, or `undefined` when the
 *   invocation has no port flag.
 */
function requestedPort(args) {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--port') return args[index + 1] ?? ''
    const inline = /^--port=(.*)$/su.exec(arg)
    if (inline !== null) return inline[1]
  }
  return undefined
}

/**
 * Read what the patch text already declares for the Feishu bridge row.
 * @param text - current patch file text.
 * @returns `undefined` when no entry targets the row, `null` when the entry omits
 *   `disabled`, otherwise the declared boolean.
 */
function gateValue(text) {
  const lines = text.split(/\r?\n/u)
  for (let start = 0; start < lines.length; start += 1) {
    const entry = /^(\s*)-\s*id:\s*["']?feishu-channel["']?\s*$/u.exec(lines[start])
    if (entry === null) continue
    const indent = entry[1].length
    for (let index = start + 1; index < lines.length; index += 1) {
      const next = /^(\s*)-\s/u.exec(lines[index])
      if (next !== null && next[1].length <= indent) return null
      const disabled = /^\s+disabled:\s*(true|false)\s*$/u.exec(lines[index])
      if (disabled !== null) return disabled[1] === 'true'
    }
    return null
  }
  return undefined
}

/**
 * Copy one profile file into the repository's `.local/` scratch area.
 * @param path - file to copy.
 * @param name - file name the backup keeps.
 * @returns the backup path.
 */
function backUp(path, name) {
  const backupDir = join(ROOT, '.local', 'muse-web-gate')
  mkdirSync(backupDir, { recursive: true })
  const stamp = new Date().toISOString().replaceAll(/[:.]/gu, '-')
  const backupPath = join(backupDir, `${name}.${stamp}.bak`)
  copyFileSync(path, backupPath)
  return backupPath
}

/**
 * Whether a parsed JSON value is a plain mapping.
 * @param value - candidate.
 * @returns true for a non-array object.
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Ensure this home's Web profile mounts the product's Feishu setup page.
 *
 * Idempotent by row id, dependency key, and link target, so the supported launch
 * path carries the page on any repository checkout after `git pull` and
 * `pnpm install`. Building stays out of the launcher: a missing client bundle is
 * reported as the command to run instead of being built here.
 * @param homeDir - resolved `MUSE_HOME`.
 * @returns one line per step, for the launcher log.
 */
function ensureFeishuSettings(homeDir) {
  const profileDir = join(homeDir, 'profiles', 'web')
  const patchPath = join(profileDir, 'cordis.patch.yml')
  const manifestPath = join(profileDir, 'package.json')
  const linkPath = join(profileDir, 'node_modules', '@deepseek-ai', 'dsh-feishu-settings')
  if (!existsSync(patchPath)) return [`feishu settings: ${patchPath} is absent; profile initialization owns it`]
  const lines = []

  const patch = readFileSync(patchPath, 'utf8')
  if (/^\s*-\s*id:\s*["']?feishu-settings["']?\s*$/mu.test(patch)) {
    lines.push('feishu settings: row already present; left untouched')
  } else {
    const backupPath = backUp(patchPath, 'cordis.patch.yml')
    const separated = patch.endsWith('\n') || patch.length === 0 ? patch : `${patch}\n`
    writeFileSync(patchPath, `${separated}\n${FEISHU_SETTINGS_ENTRY}`)
    lines.push(`feishu settings: row appended to ${patchPath} (backup ${backupPath})`)
  }

  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    if (!isRecord(manifest)) throw new TypeError('manifest is not an object')
    const dependencies = isRecord(manifest.dependencies) ? manifest.dependencies : {}
    if (dependencies[FEISHU_SETTINGS_PACKAGE] === undefined) {
      const backupPath = backUp(manifestPath, 'package.json')
      manifest.dependencies = { ...dependencies, [FEISHU_SETTINGS_PACKAGE]: 'workspace:^' }
      writeFileSync(manifestPath, `${JSON.stringify(manifest, undefined, 2)}\n`)
      lines.push(`feishu settings: dependency ${FEISHU_SETTINGS_PACKAGE} added (backup ${backupPath})`)
    } else {
      lines.push('feishu settings: dependency already declared; left untouched')
    }
  } catch (error) {
    lines.push(`feishu settings: cannot read ${manifestPath} (${error?.code ?? 'parse error'}); dependency left untouched`)
  }

  if (existsSync(linkPath)) {
    lines.push('feishu settings: package link already present; left untouched')
  } else {
    try {
      mkdirSync(dirname(linkPath), { recursive: true })
      symlinkSync(FEISHU_SETTINGS_DIR, linkPath, process.platform === 'win32' ? 'junction' : 'dir')
      lines.push(`feishu settings: linked ${linkPath} -> ${FEISHU_SETTINGS_DIR}`)
    } catch (error) {
      lines.push(`feishu settings: cannot link ${linkPath} (${error?.code ?? 'link error'}); create it yourself, e.g. run \`pnpm install\` in ${profileDir}, or \`mklink /J "${linkPath}" "${FEISHU_SETTINGS_DIR}"\` on Windows`)
    }
  }

  if (!existsSync(join(FEISHU_SETTINGS_DIR, 'lib', 'client.js'))) {
    lines.push('feishu settings: lib/client.js is missing, so the Settings section cannot appear yet; run `pnpm run build:lib:host` and `pnpm --filter @deepseek-ai/dsh-feishu-settings run bundle`, then restart')
  }
  return lines
}

/**
 * Ensure this home's Web profile patch keeps the Feishu bridge row off.
 *
 * A profile that does not list the bundle gets no entry: the Loader reports an
 * id-targeted patch with no matching row as `patch: entry "feishu-channel" not found`,
 * and there is no row to gate without the bundle. An entry that is already there is
 * never rewritten, so an operator who enabled the bridge keeps that choice.
 * @param homeDir - resolved `MUSE_HOME`.
 * @returns one log line describing the outcome, for the launcher log.
 */
function ensureFeishuGate(homeDir) {
  const profileDir = join(homeDir, 'profiles', 'web')
  const patchPath = join(profileDir, 'cordis.patch.yml')
  if (!existsSync(patchPath)) return `feishu gate: ${patchPath} is absent; profile initialization owns it`
  const text = readFileSync(patchPath, 'utf8')
  const declared = gateValue(text)
  const describe = declared === undefined ? 'absent' : declared === null ? 'declared without disabled' : `declared disabled: ${String(declared)}`
  let bundles = []
  try {
    const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
    if (Array.isArray(manifest?.dsh?.profile?.bundles)) bundles = manifest.dsh.profile.bundles
  } catch (error) {
    return `feishu gate: cannot read ${join(profileDir, 'package.json')} (${error?.code ?? 'parse error'}); row ${describe}, left untouched`
  }
  if (!bundles.includes(FEISHU_BUNDLE)) {
    return declared === undefined
      ? `feishu gate: profile does not list ${FEISHU_BUNDLE}; no entry needed`
      : `feishu gate: row ${describe} but profile no longer lists ${FEISHU_BUNDLE}; left untouched (the Loader reports the unmatched patch)`
  }
  if (declared !== undefined) return `feishu gate: row ${describe}; left untouched`
  const backupPath = backUp(patchPath, 'cordis.patch.yml')
  const separated = text.endsWith('\n') || text.length === 0 ? text : `${text}\n`
  writeFileSync(patchPath, `${separated}\n${FEISHU_GATE}`)
  return `feishu gate: appended to ${patchPath} (backup ${backupPath})`
}

// pnpm ≥11 forwards its own `--` separator verbatim; the web app must not receive it.
const args = process.argv.slice(2).filter((arg, index) => index > 0 || arg !== '--')
const dryRun = args.includes('--dry-run')
const forwarded = args.filter(arg => arg !== '--dry-run')
const requested = requestedPort(forwarded)
const port = requested === undefined ? MUSE_WEB_PORT : requested
process.stdout.write(`muse-web: home=${home}  port=${port === '' ? '(missing --port value)' : port}  url=http://127.0.0.1:${port}/\n`)
for (const line of ensureFeishuSettings(home)) process.stdout.write(`muse-web: ${line}\n`)
process.stdout.write(`muse-web: ${ensureFeishuGate(home)}\n`)
if (dryRun) {
  process.stdout.write('muse-web: --dry-run prepared the home; the Web app was not started\n')
  process.exit(0)
}
const child = spawn(
  process.execPath,
  [
    '--import', 'tsx/esm', join(ROOT, 'apps/cli/src/bin.ts'), 'web',
    ...(requested === undefined ? ['--port', MUSE_WEB_PORT] : []),
    ...forwarded,
  ],
  { cwd: ROOT, env: { ...process.env, MUSE_HOME: home }, stdio: 'inherit' },
)
child.on('exit', (code, signal) => {
  process.exit(code ?? (signal === null ? 1 : 0))
})
