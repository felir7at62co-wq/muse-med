/** Cold-start launcher preserves workspace paths without evaluating shell syntax. */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { developmentLauncher } from '../scripts/development-app.ts'

it.skipIf(process.platform === 'win32')('passes literal workspace paths and cold-start settings to Electron', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-development-app-'))
  onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  const bundle = join(root, "Harness ' $(false).app")
  const binary = join(bundle, 'Contents', 'MacOS', 'Electron')
  mkdirSync(join(bundle, 'Contents', 'MacOS'), { recursive: true })
  writeFileSync(binary, '#!/bin/sh\nprintf "%s\\n" "$DSH_HOME" "$DSH_DESKTOP_DEV_APP" "$DSH_DESKTOP_OPEN_DEVTOOLS" "$DSH_DESKTOP_PRIMARY_RUNTIME_DIR" "$MUSE_BASE_URL" "$@"\n', { mode: 0o755 })
  const launcher = join(root, 'launcher')
  const home = join(root, "home ' $(false)")
  writeFileSync(launcher, developmentLauncher({ electron: binary, appRoot: root, directory: root,
    home, userData: join(root, 'browser data'), primaryRuntime: join(root, 'primary runtime'),
    mainPort: 9229, rendererPort: 9222, hostPort: 9230, openDevtools: '0', museBaseUrl: 'http://127.0.0.1:29388' }, bundle))
  const result = execFileSync('/bin/sh', [launcher, '--test-launch-argument'], { encoding: 'utf8' })
  expect(result.trimEnd().split('\n')).toEqual([home, '1', '0', join(root, 'primary runtime'), 'http://127.0.0.1:29388', '--inspect=127.0.0.1:9229',
    '--remote-debugging-port=9222', `--user-data-dir=${join(root, 'browser data')}`, root, '--test-launch-argument'])
})

const options = { electron: '/electron', appRoot: '/app', directory: '/development', home: '/home', userData: '/browser',
  primaryRuntime: '/runtime', mainPort: 9229, rendererPort: 9222, hostPort: 9230, openDevtools: '0' }

it('keeps an unspecified Muse origin out of the persisted launcher', () => {
  expect(developmentLauncher(options, '/bundle')).not.toContain('MUSE_BASE_URL')
})

it.each(['https://muse.example.com', 'http://localhost:8080', 'http://[::1]:8080'])('retains the configured service origin %s', (museBaseUrl) => {
  expect(developmentLauncher({ ...options, museBaseUrl }, '/bundle')).toContain(`export MUSE_BASE_URL='${museBaseUrl}'`)
})

it.each(['', ' https://muse.example.com', 'http://muse.example.com', 'https://user:secret@muse.example.com',
  'https://muse.example.com/path', 'https://muse.example.com/?secret=value', 'https://muse.example.com/#secret', 'file:///tmp/server'])
('rejects an invalid persisted service origin without echoing its contents', (museBaseUrl) => {
  expect(() => developmentLauncher({ ...options, museBaseUrl }, '/bundle')).toThrow(
    /^desktop development: MUSE_BASE_URL must be an HTTPS or loopback HTTP origin without credentials, path, query, or fragment$/,
  )
})
