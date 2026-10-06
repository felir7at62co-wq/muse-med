/** Record the exact checked-out source and verified files after unsigned packaging. */
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { desktopTargetBuildPaths } from './desktop-build-paths.mjs'
import { readDesktopProductVersion } from './desktop-build-version.mjs'
import { recordMuseUnsignedBuild } from './muse-release-mirror.mjs'

const target = process.env.MUSE_RELEASE_TARGET
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: resolve(import.meta.dirname, '../../..'), encoding: 'utf8' }).trim()
if (process.env.GITHUB_SHA !== commit) throw new Error('Muse unsigned build: checkout differs from the workflow source commit')
execFileSync('git', ['diff', '--exit-code', 'HEAD', '--', '.', ':(exclude)apps/desktop/.env.*'], {
  cwd: resolve(import.meta.dirname, '../../..'), stdio: 'ignore',
})
await recordMuseUnsignedBuild({ target, version: readDesktopProductVersion(), sourceCommit: commit,
  artifactsRoot: desktopTargetBuildPaths(target).unsignedArtifacts })
console.log(`Muse unsigned build: ${target} ${commit} hashes recorded`)
