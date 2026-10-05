/** Host package validation when an npm dependency shares a Node built-in name. */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { validateDesktopPluginGraph } from '../src/profile-packages.ts'
import { runtimeFixture, writePackage } from './runtime-fixture.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

it.each(['shared', 'different'] as const)('validates a %s npm buffer package instance', (instance) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-desktop-built-in-package-')))
  roots.push(root)
  const runtimeRoot = join(root, 'runtime')
  const runtime = runtimeFixture(runtimeRoot)
  const buffer = writePackage(join(runtimeRoot, 'node_modules'), 'buffer')
  const profile = join(root, 'profile')
  mkdirSync(join(profile, 'node_modules'), { recursive: true })
  const target = instance === 'shared' ? buffer : writePackage(join(root, 'other'), 'buffer')
  symlinkSync(target, join(profile, 'node_modules', 'buffer'), process.platform === 'win32' ? 'junction' : 'dir')
  const validate = () => {
    validateDesktopPluginGraph(profile, runtimeRoot, {
      ...runtime,
      sharedPackages: [{ name: 'buffer', version: '1.0.0', path: 'node_modules/buffer' }],
    }, [])
  }

  if (instance === 'shared') expect(validate).not.toThrow()
  else expect(validate).toThrow('missing or incorrect host link buffer')
})
