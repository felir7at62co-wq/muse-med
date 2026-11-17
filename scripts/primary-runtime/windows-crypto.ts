/** Normalize the pinned PyCryptodome loader's parent segments for extended-length Windows paths. */

import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import Papa from 'papaparse'
import lock from './lock.json' with { type: 'json' }

const SOURCE_PATH = 'Crypto/Util/_file_system.py'
const SOURCE_SHA256 = 'b8ff883aa293f99710ea591a58aa8d0d03feeedd5aa49c560b60a05fd3d413e1'

/**
 * Patch the locked Windows wheel's loader and update its installed-file digest.
 * @param sitePackages - Private staged site-packages directory after wheel extraction.
 * @throws When the pinned source or its wheel record differs; no files change before validation.
 */
export function patchPrimaryRuntimeWindowsCrypto(sitePackages: string): void {
  const path = join(sitePackages, SOURCE_PATH)
  const bytes = readFileSync(path)
  if (createHash('sha256').update(bytes).digest('hex') !== SOURCE_SHA256) {
    throw new Error('primary runtime: unexpected Windows PyCryptodome path loader')
  }
  const record = join(sitePackages, `pycryptodome-${lock.pythonPackages.pycryptodome}.dist-info`, 'RECORD')
  const { data, errors } = Papa.parse<string[]>(readFileSync(record, 'utf8'), { delimiter: ',', skipEmptyLines: true })
  if (errors.length > 0 || data.length === 0
    || !data.every((row): row is [string, string, string] => row.length === 3 && Boolean(row[0]))) {
    throw new Error('primary runtime: invalid Windows PyCryptodome wheel record')
  }
  const [entry, ...duplicates] = data.filter(([name]) => name === SOURCE_PATH)
  const digest = (value: Buffer): string => `sha256=${createHash('sha256').update(value).digest('base64url')}`
  if (entry === undefined || duplicates.length !== 0 || entry[1] !== digest(bytes) || entry[2] !== String(bytes.length)) {
    throw new Error('primary runtime: unexpected Windows PyCryptodome loader record')
  }
  const patched = Buffer.from(bytes.toString('utf8').replace(
    'return os.path.join(root_lib, *dir_comps)', 'return os.path.normpath(os.path.join(root_lib, *dir_comps))',
  ))
  entry[1] = digest(patched)
  entry[2] = String(patched.length)
  writeFileSync(path, patched)
  writeFileSync(record, `${Papa.unparse(data, { newline: '\n' })}\n`)
}
