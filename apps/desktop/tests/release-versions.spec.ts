/**
 * The two version facts this product carries: its own version, and the pinned DSH release its
 * runtime trees were built from.
 *
 * The cases below are written to fail when one is used where the other belongs, using two valid but
 * different semantic versions, so passing them cannot be an accident of the two values being equal.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { RELEASE_PIN_FILE, parseDesktopRelease, readReleasePin } from '../src/release.ts'

const PRODUCT_VERSION = '0.1.6-alpha.1'
const OTHER_DSH_VERSION = '0.1.6-alpha.2'

const roots: string[] = []

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'desktop-release-'))
  roots.push(root)
  return root
}

function writePin(root: string, pinnedVersion: string, pinnedCommit = 'a'.repeat(40)): void {
  writeFileSync(join(root, RELEASE_PIN_FILE), `${JSON.stringify({
    repository: 'https://example.invalid/upstream.git',
    pinnedCommit,
    pinnedVersion,
    derivedFrom: 'git merge-base HEAD origin/master',
  }, undefined, 2)}\n`)
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('parseDesktopRelease', () => {
  const base = { schemaVersion: 1, version: PRODUCT_VERSION, hostProtocolVersion: 3, nodeVersion: '24.17.0', pnpmVersion: '11.7.0' }

  it('carries the product version and the pinned DSH version as separate facts', () => {
    const release = parseDesktopRelease({ ...base, dshVersion: OTHER_DSH_VERSION })
    expect(release.version).toBe(PRODUCT_VERSION)
    expect(release.dshVersion).toBe(OTHER_DSH_VERSION)
  })

  it('accepts a descriptor written before the DSH pin existed by reading the version as the pin', () => {
    // A descriptor sealed by the previous build has no dshVersion; refusing it would break every
    // installed application on upgrade, so the field is additive and this is its only fallback.
    expect(parseDesktopRelease(base).dshVersion).toBe(PRODUCT_VERSION)
  })

  it('rejects a DSH pin that is not a valid version', () => {
    expect(() => parseDesktopRelease({ ...base, dshVersion: 'latest' }))
      .toThrow(/invalid desktop release metadata/u)
    expect(() => parseDesktopRelease({ ...base, dshVersion: '' }))
      .toThrow(/invalid desktop release metadata/u)
  })

  it('keeps rejecting a product version that is not a valid version', () => {
    expect(() => parseDesktopRelease({ ...base, version: 'latest' }))
      .toThrow(/invalid desktop release metadata/u)
  })
})

describe('readReleasePin', () => {
  it('validates a pin record whose project version agrees and refuses one that disagrees', () => {
    // Two cases over two distinct records prove the function reads the file rather than returning its
    // input: the agreeing record passes, and the record that names another release fails on its own
    // contents — the same product version is rejected, so the file decided the outcome.
    const agreeing = fixtureRoot()
    writePin(agreeing, PRODUCT_VERSION, 'b'.repeat(40))
    expect(readReleasePin(agreeing, PRODUCT_VERSION)).toBe(PRODUCT_VERSION)

    const disagreeing = fixtureRoot()
    writePin(disagreeing, OTHER_DSH_VERSION, 'c'.repeat(40))
    expect(() => readReleasePin(disagreeing, PRODUCT_VERSION)).toThrow(new RegExp(`pin ${OTHER_DSH_VERSION}`, 'u'))
  })

  it('rejects a pin whose version disagrees with the product version, naming both', () => {
    const root = fixtureRoot()
    writePin(root, PRODUCT_VERSION)
    expect(() => readReleasePin(root, OTHER_DSH_VERSION)).toThrow(/must move with the DSH pin/u)
    expect(() => readReleasePin(root, OTHER_DSH_VERSION)).toThrow(new RegExp(`${OTHER_DSH_VERSION}.*${PRODUCT_VERSION}`, 'su'))
  })

  it('falls back to the product version where no pin record is delivered', () => {
    // A checkout without the pin record still builds; the fallback keeps the two facts equal rather
    // than inventing a DSH version nobody pinned.
    expect(readReleasePin(fixtureRoot(), PRODUCT_VERSION)).toBe(PRODUCT_VERSION)
  })

  it('fails loud on a pin record that is unreadable or lacks a version', () => {
    const malformed = fixtureRoot()
    writeFileSync(join(malformed, RELEASE_PIN_FILE), '{ not json')
    expect(() => readReleasePin(malformed, PRODUCT_VERSION)).toThrow(/not valid JSON/u)
    const missing = fixtureRoot()
    writeFileSync(join(missing, RELEASE_PIN_FILE), '{ "pinnedCommit": "x" }\n')
    expect(() => readReleasePin(missing, PRODUCT_VERSION)).toThrow(/non-empty string pinnedVersion/u)
  })

  it('rejects a pin that is not a valid version even when it matches the product version', () => {
    const root = fixtureRoot()
    writePin(root, 'latest')
    expect(() => readReleasePin(root, 'latest')).toThrow(/not a valid version/u)
  })
})

describe('RELEASE_PIN_FILE', () => {
  it('names the pin record at the repository root that the rehearsal reads', () => {
    expect(RELEASE_PIN_FILE).toBe('upstream.json')
  })
})
