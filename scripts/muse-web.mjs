/**
 * Start the Web GUI against the muse product home instead of the official dsh home.
 *
 * The launcher owns three things: `MUSE_HOME`, the Web port, and the Feishu bridge gate in
 * that home's Web profile. `dsh-home-paths` already prefers `MUSE_HOME` over `DSH_HOME`, so
 * the CLI, the profile directory, settings, credentials, skills, and the session store all
 * resolve under one home without a second application or a change to any composed default.
 * The port defaults to 327, because the official 3080 is where a plain `dsh web` binds and
 * the two must not collide; an explicit `--port` wins. Before the Web app starts, the
 * launcher ensures the profile's own patch layer disables the market Feishu bridge row
 * whenever that profile lists the bundle: the market package has no plugin-level activation
 * control, so the Loader's entry-level `disabled` is the only switch that keeps its code from
 * running. The append is idempotent and copies the previous patch file under `.local/`.
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
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const home = process.env.MUSE_HOME ?? join(homedir(), '.muse')

/** Port this launcher serves on unless the invocation asks for another one. */
const MUSE_WEB_PORT = '327'

/** Bundle that contributes the Feishu bridge row to a profile listing it. */
const FEISHU_BUNDLE = '@moyu-good/dsh-lark-bridge'

/** Row id that bundle inserts, and the id this launcher's gate patches. */
const FEISHU_ROW_ID = 'feishu-channel'

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
  const backupDir = join(ROOT, '.local', 'muse-web-gate')
  mkdirSync(backupDir, { recursive: true })
  const stamp = new Date().toISOString().replaceAll(/[:.]/gu, '-')
  const backupPath = join(backupDir, `cordis.patch.yml.${stamp}.bak`)
  copyFileSync(patchPath, backupPath)
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
