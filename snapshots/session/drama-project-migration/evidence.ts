/** Path-dependent migration fingerprints derived from this scenario's independent file oracles. */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const canonicalFingerprint = '0'.repeat(64)
const digest = (value: string): string => createHash('sha256').update(value).digest('hex')

/**
 * Calculate the approved migration fingerprint from source bytes and the expected target file.
 * @param cwd - Atomically allocated scenario workspace.
 * @param scenarioDir - Owner of the independent input and output files.
 * @returns Fingerprint expected from the real migration preview in this workspace.
 */
export async function expectedMigrationFingerprint(cwd: string, scenarioDir: string): Promise<string> {
  const source = await readFile(join(scenarioDir, 'workspace/source/project_config.json'), 'utf8')
  const config: object = JSON.parse(await readFile(join(scenarioDir, 'workspace.expected/target/project_config.json'), 'utf8')) as object
  return digest(JSON.stringify({ root: join(cwd, 'target'), revision: 'missing', config, migration: {
    source_project_dir: join(cwd, 'source'), source_script_id: 6292, source_revision: digest(source),
    target_script_id: 6750, inherited_fields: ['title', 'style', 'visual_medium', 'aspect_ratio', 'delivery', 'characters'],
    reset_fields: ['remote_asset_and_audio_references', 'package_bindings', 'completed_tasks', 'history', 'budget_authorization'],
  } }))
}

interface Dispatch {
  type: string
  data?: {
    name?: string
    arguments?: { action?: string }
    content?: { type: string; text?: string }[]
  }
}

/**
 * Canonicalize only the migration approval token and its two known directory names.
 * The runtime token is checked against independently calculated inputs before replacement.
 * @param log - Complete actual or expected session.
 * @param expected - Independently derived token; omitted only while storing a freshly recorded writer.
 * @returns Session retaining all non-path-dependent fields and the token's reference relationships.
 */
export function migrationSnapshot(log: string, expected?: string): string {
  const rows = log.split('\n').filter(Boolean).map(line => JSON.parse(line) as Dispatch)
  const previews = rows.filter(row => row.type === 'tool/ptc-dispatch' && row.data?.name === 'drama_project'
    && row.data.arguments?.action === 'preview')
  if (previews.length !== 1) throw new Error('Migration snapshot requires one real project preview')
  const block = previews[0]?.data?.content?.[0]
  if (block?.type !== 'text' || block.text === undefined) throw new Error('Missing real migration preview')
  const preview = JSON.parse(block.text) as { preview_fingerprint?: string }
  const fingerprint = preview.preview_fingerprint
  if (typeof fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(fingerprint)) throw new Error('Invalid migration fingerprint')
  if (expected !== undefined && fingerprint !== expected) {
    throw new Error('Migration fingerprint differs from independently derived project files')
  }
  let normalized = log.replaceAll(fingerprint, canonicalFingerprint)
  for (const directory of ['source', 'target']) {
    for (const count of [16, 8, 4, 2, 1]) {
      normalized = normalized.replaceAll(`{{cwd}}${'\\'.repeat(count)}${directory}`, `{{cwd}}/${directory}`)
    }
  }
  return normalized
}
