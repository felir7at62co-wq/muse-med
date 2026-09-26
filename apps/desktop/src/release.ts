/** Immutable version identity shared by one Electron shell and its bundled dsh runtime. */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { valid } from 'semver'
import { DESKTOP_HOST_PROTOCOL_VERSION } from './host-protocol.ts'

/** Repository-root record naming the upstream commit and DSH release this fork is pinned to. */
export const RELEASE_PIN_FILE = 'upstream.json'

/** Release facts embedded in the bundled runtime descriptor. */
export interface DesktopRelease {
  readonly schemaVersion: 1
  /** This product's own version: what the shell, its artifacts, and its update metadata carry. */
  readonly version: string
  /**
   * Pinned `@deepseek-ai/dsh` release whose packages fill the runtime trees.
   *
   * The product version must move with this pin, so that an artifact name always identifies one build
   * and two DSH builds cannot claim one name.
   */
  readonly dshVersion: string
  readonly hostProtocolVersion: typeof DESKTOP_HOST_PROTOCOL_VERSION
  readonly nodeVersion: string
  readonly pnpmVersion: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * Validate release data read from an installed or packaged filesystem resource.
 *
 * A descriptor sealed before the DSH pin existed carries no `dshVersion`; the product version is then
 * the pin, because that release bound the two together. Refusing it would make every installed
 * application unreadable by its successor.
 * @param value - Parsed descriptor release object.
 * @returns The validated release.
 */
export function parseDesktopRelease(value: unknown): DesktopRelease {
  if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.version !== 'string'
    || valid(value.version) === null || value.hostProtocolVersion !== DESKTOP_HOST_PROTOCOL_VERSION
    || typeof value.nodeVersion !== 'string' || valid(value.nodeVersion) === null
    || typeof value.pnpmVersion !== 'string' || valid(value.pnpmVersion) === null) {
    throw new Error('dsh desktop: invalid desktop release metadata')
  }
  const dshVersion = value.dshVersion ?? value.version
  if (typeof dshVersion !== 'string' || valid(dshVersion) === null) {
    throw new Error('dsh desktop: invalid desktop release metadata')
  }
  return {
    schemaVersion: 1,
    version: value.version,
    dshVersion,
    hostProtocolVersion: DESKTOP_HOST_PROTOCOL_VERSION,
    nodeVersion: value.nodeVersion,
    pnpmVersion: value.pnpmVersion,
  }
}

/**
 * Read the pinned DSH release from the repository pin record and require it to match the product.
 *
 * The record is the one the upstream-sync rehearsal reads, so the product cannot claim a pin that
 * rehearsal would reject. A checkout without the record falls back to the product version rather than
 * inventing a pin nobody recorded.
 * @param repositoryRoot - Repository root holding the pin record.
 * @param productVersion - This product's version, which must move with the pin.
 * @returns The pinned DSH release.
 * @throws When the record exists but is unreadable, lacks a version, holds an invalid version, or disagrees with `productVersion`.
 */
export function readReleasePin(repositoryRoot: string, productVersion: string): string {
  let text: string
  try {
    text = readFileSync(join(repositoryRoot, RELEASE_PIN_FILE), 'utf8').replace(/^\uFEFF/u, '')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return validatePin(productVersion, productVersion)
    throw new Error(`desktop release: cannot read ${RELEASE_PIN_FILE}: ${String(error)}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(`desktop release: ${RELEASE_PIN_FILE} is not valid JSON: ${String(error)}`)
  }
  const pinnedVersion = isRecord(parsed) ? parsed.pinnedVersion : undefined
  if (typeof pinnedVersion !== 'string' || pinnedVersion === '') {
    throw new Error(`desktop release: ${RELEASE_PIN_FILE} needs a non-empty string pinnedVersion`)
  }
  return validatePin(productVersion, pinnedVersion)
}

function validatePin(productVersion: string, dshVersion: string): string {
  if (valid(dshVersion) === null) {
    throw new Error(`desktop release: DSH pin ${JSON.stringify(dshVersion)} is not a valid version`)
  }
  if (dshVersion !== productVersion) {
    throw new Error(
      `desktop release: product version ${productVersion} must move with the DSH pin, found pin ${dshVersion};`
      + ' bump both in the same change so an artifact name identifies one build',
    )
  }
  return dshVersion
}
