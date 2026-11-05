/**
 * Enforce DSH license declarations and the exact tool-discovery attribution exception.
 * @module scripts/verify-dsh-package-licenses
 */

import { existsSync, globSync, lstatSync, readFileSync } from 'node:fs'
import { dirname, resolve, sep } from 'node:path'
import { isDramaSkillsResourcePackage } from './drama-skills-resource-package.ts'

const ROOT = resolve(import.meta.dirname, '..')
const DSH_PACKAGE_NAME = /^@deepseek-ai\/dsh(?:-|$)/

/** Result of checking every DSH package reachable through the root workspace list. */
export interface DshPackageLicenseReport {
  /** Number of DSH package manifests checked. */
  packageCount: number
  /** Repository-relative diagnostics for disallowed declarations or incomplete license resources. */
  failures: string[]
}

function readManifest(root: string, file: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(resolve(root, file), 'utf8'))
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`verify-dsh-package-licenses: ${file} must contain a JSON object.`)
  }
  return parsed as Record<string, unknown>
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry: unknown) => typeof entry === 'string')
}

function workspaceManifestPaths(root: string): string[] {
  const rootManifest = readManifest(root, 'package.json')
  const workspaces = rootManifest.workspaces
  if (!isStringArray(workspaces)) {
    throw new Error('verify-dsh-package-licenses: package.json workspaces must be a string array.')
  }

  const files = new Set(['package.json'])
  for (const pattern of workspaces) {
    for (const file of globSync(`${pattern}/package.json`, { cwd: root })) {
      files.add(file)
    }
  }
  return [...files].sort()
}

function printable(value: unknown): string {
  return value === undefined ? 'undefined' : JSON.stringify(value)
}

/**
 * Check every DSH npm package declared by the repository workspace.
 * @param root - absolute repository root containing the workspace package.json.
 * @returns the checked package count and every license declaration that violates this policy.
 */
export function inspectDshPackageLicenses(root: string): DshPackageLicenseReport {
  let packageCount = 0
  const failures: string[] = []

  for (const file of workspaceManifestPaths(root)) {
    const manifest = readManifest(root, file)
    const name = manifest.name
    if (typeof name !== 'string' || !DSH_PACKAGE_NAME.test(name)) continue

    packageCount++
    const normalizedFile = file.split(sep).join('/')
    const adaptedToolGuidance = normalizedFile === 'packages/core/tool-discovery/package.json'
      && name === '@deepseek-ai/dsh-tool-discovery'
    if (adaptedToolGuidance) {
      if (manifest.license !== 'MIT AND Apache-2.0') {
        failures.push(`${normalizedFile}: ${name} must declare "license": "MIT AND Apache-2.0" for its Codex-derived guidance.`)
        continue
      }
      let resourcesReady = true
      for (const resource of ['LICENSE', 'NOTICE', 'LICENSE-Codex']) {
        const path = resolve(root, dirname(file), resource)
        if (!isStringArray(manifest.files) || !manifest.files.includes(resource)
          || !existsSync(path) || !lstatSync(path).isFile() || lstatSync(path).size === 0) {
          failures.push(`${normalizedFile}: ${name} must publish existing non-empty ${resource} for its Apache-2.0 guidance.`)
          resourcesReady = false
        }
      }
      if (resourcesReady) {
        const directory = resolve(root, dirname(file))
        if (readFileSync(resolve(directory, 'LICENSE'), 'utf8') !== readFileSync(resolve(root, 'LICENSE'), 'utf8')) {
          failures.push(`${normalizedFile}: ${name} must publish LICENSE matching the repository MIT license.`)
        }
        if (!/Apache License\r?\n\s+Version 2\.0/u.test(readFileSync(resolve(directory, 'LICENSE-Codex'), 'utf8'))) {
          failures.push(`${normalizedFile}: ${name} must publish the Apache-2.0 license in LICENSE-Codex.`)
        }
        const notice = readFileSync(resolve(directory, 'NOTICE'), 'utf8')
        if (!notice.includes('The tool discovery instructions are adapted from OpenAI Codex under Apache-2.0.')
          || !notice.includes('The Apache-2.0 license is reproduced in LICENSE-Codex.')) {
          failures.push(`${normalizedFile}: ${name} must publish Codex attribution and its license reference in NOTICE.`)
        }
      }
      continue
    }
    const privateResource = isDramaSkillsResourcePackage(dirname(file).split(sep).join('/'), name)
      && manifest.private === true && manifest.license === 'UNLICENSED'
    if (manifest.license !== 'MIT' && !privateResource) {
      failures.push(
        `${normalizedFile}: ${name} must declare "license": "MIT"; found ${printable(manifest.license)}.`,
      )
    }
  }

  return { packageCount, failures }
}

if (process.argv[1] && import.meta.filename === resolve(process.argv[1])) {
  const report = inspectDshPackageLicenses(ROOT)
  if (report.failures.length > 0) {
    process.stderr.write('verify-dsh-package-licenses: disallowed DSH package license declarations found:\n')
    for (const failure of report.failures) process.stderr.write(`  ${failure}\n`)
    process.exitCode = 1
  } else {
    process.stdout.write(
      `verify-dsh-package-licenses: ${String(report.packageCount)} DSH package(s) checked; all satisfy the license policy.\n`,
    )
  }
}
