import assert from 'node:assert/strict'
import { constants, createReadStream } from 'node:fs'
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { createMuseMirrorPlan } from '../../apps/desktop/scripts/muse-release-mirror.mjs'
const root = resolve(process.env.MUSE_ARTIFACT_ROOT ?? '.release')
const version = '1.1.1'
const sourceCommit = '63421116448b136b7bd66fb90e22f0fe704dbe80'
const targets = ['mac-arm64', 'win-x64']
const artifactDirectories = Object.fromEntries(targets.map(target => [target, join(root, target)]))
const plan = await createMuseMirrorPlan({ version, sourceCommit, artifactDirectories, legacyRcDiscovery: true })
const publish = join(root, 'publish')
await mkdir(publish, { recursive: true })
for (const file of plan.artifacts) await copyFile(file.path, join(publish, file.filename), constants.COPYFILE_FICLONE)
for (const file of plan.githubMetadata) await writeFile(join(publish, file.filename), file.contents)
async function findReports(directory) {
  const reports = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) reports.push(...await findReports(path))
    else if (entry.name === 'acceptance.json') reports.push(path)
  }
  return reports
}
const builds = [], acceptance = []
for (const target of targets) {
  const build = JSON.parse(await readFile(join(artifactDirectories[target], 'unsigned-build.json'), 'utf8'))
  const files = await findReports(join(root, 'acceptance', target))
  assert.equal(files.length, 1, `${target}: expected one installer acceptance report`)
  const report = JSON.parse(await readFile(files[0], 'utf8'))
  assert.equal(report.target, target)
  assert.equal(report.sourceCommit, sourceCommit)
  assert.equal(report.version, version)
  assert.equal(report.success, true)
  const recordedInstaller = Object.entries(build.artifacts).find(([name]) => /\.(dmg|exe)$/.test(name))
  assert.ok(recordedInstaller)
  assert.equal(report.installerSha256, recordedInstaller[1].sha256)
  builds.push(build)
  acceptance.push(report)
}
await writeFile(join(publish, 'muse-desktop-builds.json'), JSON.stringify({ version, sourceCommit, builds }, null, 2) + '\n')
await writeFile(join(publish, 'muse-installer-acceptance.json'), JSON.stringify({ version, sourceCommit, acceptance }, null, 2) + '\n')
const lines = []
for (const filename of (await readdir(publish)).filter(name => name !== 'muse-desktop-SHA256SUMS.txt').sort()) {
  const hash = createHash('sha256')
  for await (const bytes of createReadStream(join(publish, filename))) hash.update(bytes)
  lines.push(`${hash.digest('hex')}  ${filename}`)
}
await writeFile(join(publish, 'muse-desktop-SHA256SUMS.txt'), lines.join('\n') + '\n')
console.log(JSON.stringify({ version, sourceCommit, files: lines.length + 1, acceptance: acceptance.map(({ target, success, guiLaunch, paidProviderCalls, installedFiles }) => ({ target, success, guiLaunch, paidProviderCalls, installedFiles })) }))
