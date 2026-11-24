// Lay out the NEXT cloud Muse profile exactly as Desktop lays out its runtime project; starts no application.
// Env: RELEASE (release dir), ARCHIVES (plugin archive dir), PROJECT_DIR (must end in /profiles/muse-cloud-next).
// prepareDevelopmentProject removes PROJECT_DIR first, so the live profile name is refused here.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const release = process.env.RELEASE ?? ''
const archives = process.env.ARCHIVES ?? ''
const projectDir = process.env.PROJECT_DIR ?? ''
if (!release.startsWith('/opt/muse/cloud/releases/') || !archives.startsWith('/opt/muse/cloud/plugin-archives/')) {
  throw new Error('prepare-profile: RELEASE and ARCHIVES must be under /opt/muse/cloud')
}
if (projectDir !== '/var/lib/muse-cloud/home/profiles/muse-cloud-next') {
  throw new Error('prepare-profile: PROJECT_DIR must be the -next profile, never the live one')
}
const version = (JSON.parse(readFileSync(join(release, 'apps/cli/package.json'), 'utf8')) as { version: string }).version
const { prepareDevelopmentProject } = await import(join(release, 'apps/desktop/scripts/development-project.ts'))
const { DESKTOP_HOST_PROTOCOL_VERSION } = await import(join(release, 'apps/desktop/src/host-protocol.ts'))
prepareDevelopmentProject({
  repositoryRoot: release,
  communityArtifactsDir: archives,
  projectDir,
  cliDir: join(release, 'apps/cli'),
  hostDir: join(release, 'apps/desktop-host'),
  dependencyDir: join(release, 'node_modules/.pnpm/node_modules'),
  release: { schemaVersion: 1, version, hostProtocolVersion: DESKTOP_HOST_PROTOCOL_VERSION, nodeVersion: '24.21.0', pnpmVersion: '11.28.5' },
  // Only desktop-runtime.json's platform fields depend on the target; the dsh CLI does not read that file.
  target: 'mac-x64',
})
console.log('next profile prepared at', projectDir, 'version', version)
