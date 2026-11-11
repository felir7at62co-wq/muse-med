/** Skill/MCP recovery fixtures load retained source or the actual packaged plugin explicitly. */
import { isAbsolute, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { importSnapshotModule } from './muse-fixture-import.mjs'

const sourceRoot = new URL('../../third_party/plugins/dsh-skill-mcp-panel/', import.meta.url)
const artifactDirectory = process.env.MUSE_SKILL_PANEL_ARTIFACT_DIR
  ?? fileURLToPath(new URL('../../.artifacts/skill-panel-snapshot-artifact/package', import.meta.url))
if (!isAbsolute(artifactDirectory)) throw new Error('Skill panel snapshot artifact directory must be absolute')

/**
 * @param {'index' | 'skill-import' | 'mcp/gateway' | 'oauth'} entry - Entry exercised by an owned recovery fixture.
 * @returns Module exports from the selected source or artifact plane.
 */
export function importSkillPanelSnapshot(entry) {
  if (!['index', 'skill-import', 'mcp/gateway', 'oauth'].includes(entry)) throw new Error('Unexpected Skill panel snapshot entry')
  return importSnapshotModule(new URL(`src/${entry}.ts`, sourceRoot),
    pathToFileURL(join(artifactDirectory, 'lib', `${entry}.js`)))
}
