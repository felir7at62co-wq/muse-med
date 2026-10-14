/** Normalize BGM rights metadata and report declared-use risks without granting rights. */

import z from '@deepseek-ai/schemastery'
import type { BgmUsage, LicenseInfo } from './types.ts'
export type { BgmLicenseRecord, BgmUsage, LicenseInfo } from './types.ts'

const UNKNOWN = 'unknown'
const TEXT_FIELDS = ['license', 'source', 'attribution', 'scope'] as const

function text(value: unknown, field: string): string {
  if (value === undefined || value === null) return UNKNOWN
  if (typeof value !== 'string') throw new Error(`Invalid license_info.${field}: expected a string`)
  return value.trim() || UNKNOWN
}

/**
 * Normalize a source declaration while making absent facts explicit.
 * @param value - Untrusted catalog or plan metadata; missing metadata is unknown.
 * @returns Supplied facts with recomputed completeness; true without license, source and scope becomes unknown.
 * @throws {Error} If metadata has invalid types or claims an unsupported approval status.
 */
export function normalizeLicenseInfo(value: unknown): LicenseInfo {
  if (value === undefined || value === null) value = {}
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid license_info: expected an object')
  const row = value as Record<string, unknown>
  if (row.status !== undefined && row.status !== 'declared' && row.status !== UNKNOWN) {
    throw new Error('Invalid license_info.status: declarations cannot assert approval')
  }
  const license = text(row.license, 'license')
  const source = text(row.source, 'source')
  const attribution = text(row.attribution, 'attribution')
  const scope = text(row.scope, 'scope')
  let commercialUse = row.commercial_use ?? UNKNOWN
  if (typeof commercialUse !== 'boolean' && commercialUse !== UNKNOWN) {
    throw new Error('Invalid license_info.commercial_use: expected boolean or unknown')
  }
  if (commercialUse === true && [license, source, scope].includes(UNKNOWN)) commercialUse = UNKNOWN
  const facts = { license, commercial_use: commercialUse as boolean | 'unknown', source, attribution, scope }
  const complete = TEXT_FIELDS.every(field => facts[field] !== UNKNOWN) && commercialUse !== UNKNOWN
  return { status: complete ? 'declared' : UNKNOWN, ...facts }
}

/**
 * Read a declared release purpose without defaulting to non-commercial use.
 * @param value - Optional catalog-tool or plan purpose.
 * @returns The explicit purpose, or unknown for absent input.
 * @throws {Error} If the purpose is unsupported.
 */
export function parseBgmUsage(value: unknown): BgmUsage {
  if (value === undefined || value === null || value === UNKNOWN) return UNKNOWN
  if (value === 'commercial' || value === 'non_commercial') return value
  throw new Error('Invalid intended_use: expected commercial, non_commercial or unknown')
}

/**
 * Report missing evidence and explicit commercial-use conflicts.
 * @param info - Normalized music-rights declaration, independent of any model license.
 * @param usage - Intended release purpose; unknown never grants use.
 * @returns Advisory findings; an empty list is not a legal verification or a rights grant.
 */
export function licenseRiskWarnings(info: LicenseInfo, usage: BgmUsage): string[] {
  const warnings: string[] = []
  if (info.status === UNKNOWN) warnings.push('音乐授权信息未知或不完整；不能据此认定已获使用授权。')
  if (usage === UNKNOWN) warnings.push('本次用途未指定，尚未核对音乐声明是否覆盖发行用途。')
  if (usage === 'commercial' && info.commercial_use === false) {
    warnings.push('曲目声明不允许商业使用，与本次商业用途不匹配。')
  }
  return warnings
}

/** Validate and normalize plan metadata; omitted declarations become explicitly unknown. */
export const LicenseInfoInputSchema = z.transform(z.any<unknown>(), normalizeLicenseInfo).default(normalizeLicenseInfo(undefined))

/** Canonical model-visible declaration fields; status never means verified or approved. */
export const LICENSE_INFO_TOOL_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    status: { type: 'string', required: true, enum: ['declared', 'unknown'],
      description: 'declared=来源声明完整，未自动核验使用权；unknown=缺失或不完整。' },
    license: { type: 'string', required: true },
    commercial_use: { required: true, oneOf: [{ type: 'boolean' }, { type: 'string', const: 'unknown' }] },
    source: { type: 'string', required: true, description: '权利依据来源，与音频路径不同。' },
    attribution: { type: 'string', required: true },
    scope: { type: 'string', required: true },
  },
} as const

/** Model-visible per-track declaration and risk record. */
export const BGM_LICENSE_RECORD_TOOL_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    track: { type: 'string', required: true },
    source: { type: 'string', required: true },
    track_id: { type: 'string' },
    source_sha256: { type: 'string' },
    license_info: { ...LICENSE_INFO_TOOL_SCHEMA, required: true },
    warnings: { type: 'array', required: true, items: { type: 'string' } },
  },
} as const
