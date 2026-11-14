/** Pure market actions preserve archive bytes and map structured refusals to localized outcomes. */
import { expect, it } from 'vitest'
import { archiveBase64, defaultFor, marketFailureOutcome } from '../src/client/market-actions.ts'
import { installation } from './market-fixtures.client.ts'

it('finds defaults by the installed skill name and tolerates a release without a skill entry', () => {
  const selected = { skillName: 'writer', releaseId: installation.release.id }
  expect(defaultFor(installation, { revision: 1, defaults: [selected] })).toBe(selected)
  expect(defaultFor(installation, { revision: 1, defaults: [] })).toBeUndefined()
  expect(defaultFor({ ...installation, release: { ...installation.release,
    manifest: { ...installation.release.manifest, skills: [] } } }, { revision: 1, defaults: [selected] })).toBeUndefined()
})

it.each([0, 1, 16384, 16385, 40000])('encodes all %i selected archive bytes without changing them', async (length) => {
  const bytes = Uint8Array.from({ length }, (_, index) => index % 256)
  expect(await archiveBase64(new File([bytes], 'writer.zip'))).toBe(Buffer.from(bytes).toString('base64'))
})

const failures: readonly (readonly [unknown, ReturnType<typeof marketFailureOutcome>])[] = [
  [null, 'failed'], [undefined, 'failed'], ['failed', 'failed'], [4, 'failed'],
  [{ code: 'muse-market/access-changed' }, 'signInRequired'],
  [{}, 'cloudUnavailable'], [{ code: 'other' }, 'cloudUnavailable'],
  [{ details: null }, 'cloudUnavailable'], [{ details: 42 }, 'cloudUnavailable'],
  [{ details: { status: 401 } }, 'signInRequired'], [{ details: { status: 403 } }, 'permissionDenied'],
  [{ details: {} }, 'failed'], [{ details: { code: 'default-conflict' } }, 'defaultConflict'],
  [{ details: { code: 'release-in-use' } }, 'releaseInUse'], [{ details: { code: 'default-in-use' } }, 'releaseInUse'],
  [{ details: { code: 'account-changed' } }, 'signInRequired'],
  ...['invalid-archive', 'invalid-manifest', 'archive-mismatch', 'catalog-changed', 'digest-mismatch']
    .map(code => [{ details: { code } }, 'invalidPackage'] as const),
  [{ details: { code: 'upstream', status: 503 } }, 'cloudUnavailable'],
  [{ details: { code: 'other', status: 400 } }, 'failed'],
  [{ details: { code: 'other', status: '503' } }, 'failed'],
  [{ details: { code: 'other' } }, 'failed'],
]
it.each(failures)('reports only the localized outcome for refusal %#', (error, expected) => {
  expect(marketFailureOutcome(error)).toBe(expected)
})
