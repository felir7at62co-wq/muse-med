/** Qualify the private CI transfer without credentials, public feeds or external HTTP requests. */
import { createDecipheriv, createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { extract } from 'tar'
import { afterEach, expect, it } from 'vitest'
import { readDesktopProductConfig } from '../scripts/desktop-build-version.mjs'
import { exportMuseCiCandidate } from '../scripts/export-muse-ci-candidate.mjs'
import { recordMuseUnsignedBuild } from '../scripts/muse-release-mirror.mjs'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), 'muse-ci-export-test-'))
  roots.push(base)
  const root = join(base, 'checkout'), runner = join(base, 'runner')
  const app = join(root, 'apps', 'desktop'), build = join(app, '.desktop-build')
  const artifacts = join(build, 'targets', 'win-x64', 'unsigned-artifacts')
  await mkdir(artifacts, { recursive: true })
  await mkdir(runner)
  const version = readDesktopProductConfig().version, commit = 'c'.repeat(40), exportId = 'a'.repeat(32)
  await writeFile(join(app, 'muse-product.json'), JSON.stringify({ version }))
  const payload = Buffer.from('fake executable for encrypted export')
  const name = `muse-med-${version}-win-x64.exe`, sha512 = createHash('sha512').update(payload).digest('base64')
  await writeFile(join(artifacts, name), payload)
  await writeFile(join(artifacts, `${name}.blockmap`), 'fake blockmap')
  await writeFile(join(artifacts, 'latest.yml'), JSON.stringify({ version, path: name, sha512,
    files: [{ url: name, size: payload.length, sha512 }] }))
  await recordMuseUnsignedBuild({ target: 'win-x64', version, sourceCommit: commit, artifactsRoot: artifacts })
  const report = { success: true, target: 'win-x64', version, sourceCommit: commit }
  const installed = join(runner, 'muse-installer-acceptance-fake')
  await mkdir(join(installed, 'processes'), { recursive: true })
  await writeFile(join(installed, 'acceptance.json'), JSON.stringify(report))
  await writeFile(join(installed, 'processes', 'events.jsonl'), '{"passed":true}\n')
  for (const fromVersion of ['1.2.2', '1.2.5', '1.2.6']) {
    const path = join(runner, `muse-candidate-update-${fromVersion}`)
    await mkdir(path)
    await writeFile(join(path, 'result.json'), JSON.stringify({ ...report, fromVersion }))
    await writeFile(join(path, 'private-key.pem'), 'excluded fixture')
  }
  for (const path of ['installer-tests/run-fixture', 'packaging-runs/build-fixture', 'qualification/local-updater-fixture']) {
    await mkdir(join(build, path), { recursive: true })
    await writeFile(join(build, path, 'result.json'), '{"success":true}')
  }
  await mkdir(join(build, 'installer-tests/run-fixture/payload'), { recursive: true })
  await writeFile(join(build, 'installer-tests/run-fixture/payload', 'ordinary-config.json'), 'must not export')
  await writeFile(join(build, 'installer-tests/run-fixture', 'fixture.exe'), 'must not export')
  const prefix = `ci-candidates/${version}/${exportId}/win-x64`
  const object = (filename: string, contentType: string) => ({ key: `${prefix}/${filename}`, method: 'PUT',
    url: `https://muse.tos-s3-cn-beijing.volces.com/${prefix}/${filename}?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=FAKE&X-Amz-Date=20300101T000000Z&X-Amz-Expires=7200&X-Amz-SignedHeaders=content-type%3Bif-none-match%3Bx-amz-acl&X-Amz-Signature=${'b'.repeat(64)}`,
    headers: { 'content-type': contentType, 'if-none-match': '*', 'x-amz-acl': 'private' } })
  const config = { schemaVersion: 1, version, target: 'win-x64', expectedCommit: commit, exportId, prefix,
    expiresAtUtc: '2030-01-01T02:00:00.000Z', encryptionKeyHex: '1e'.repeat(32),
    objects: { candidate: object('candidate.tar.enc', 'application/octet-stream'), transfer: object('transfer.json', 'application/json') } }
  const environment = { GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REPOSITORY: 'felir7at62co-wq/muse-med',
    GITHUB_SHA: commit, GITHUB_RUN_ID: '123456', MUSE_RELEASE_TARGET: 'win-x64', RUNNER_TEMP: runner,
    MUSE_CI_TOS_CANDIDATE_UPLOAD: JSON.stringify(config) }
  return { base, root, runner, build, artifacts, installed, config, environment,
    options: { root, environment, platform: 'win32' as const, now: () => Date.parse('2030-01-01T00:00:00.000Z') } }
}

it('round-trips exact candidate bytes and bounded evidence through authenticated encryption before publishing transfer metadata', async () => {
  const f = await fixture(), uploads: Array<{ url: string; body: Buffer; headers: HeadersInit | undefined }> = []
  const fetchImpl: typeof fetch = async (url, init) => {
    const address = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url
    uploads.push({ url: address, body: Buffer.from(await new Response(init?.body).arrayBuffer()), headers: init?.headers })
    expect(init?.redirect).toBe('error')
    return new Response(null, { status: 200 })
  }
  const transfer = await exportMuseCiCandidate({ ...f.options, fetchImpl })
  expect(uploads).toHaveLength(2)
  const [candidateUpload, transferUpload] = uploads
  if (!candidateUpload || !transferUpload) throw new Error('Expected candidate and transfer uploads')
  const encryptedBody = candidateUpload.body
  expect(candidateUpload.headers).toEqual(f.config.objects.candidate.headers)
  expect(JSON.parse(transferUpload.body.toString())).toEqual(transfer)
  expect(Object.keys(transfer).sort()).toEqual(['version', 'target', 'commit', 'runId', 'exportId', 'encryptedBytes', 'encryptedSha256', 'ivHex', 'authTagHex'].sort())
  expect(transfer).toMatchObject({ version: f.config.version, commit: f.config.expectedCommit, runId: '123456' })
  expect(transfer.encryptedSha256).toBe(createHash('sha256').update(encryptedBody).digest('hex'))
  expect(transfer.encryptedBytes).toBe(encryptedBody.length)
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(f.config.encryptionKeyHex, 'hex'), Buffer.from(transfer.ivHex, 'hex'))
  decipher.setAuthTag(Buffer.from(transfer.authTagHex, 'hex'))
  const archive = join(f.base, 'decrypted.tar'), restored = join(f.base, 'restored')
  await writeFile(archive, Buffer.concat([decipher.update(encryptedBody), decipher.final()]))
  await mkdir(restored)
  await extract({ file: archive, cwd: restored })
  expect((await readdir(join(restored, 'candidate'))).sort()).toEqual((await readdir(f.artifacts)).sort())
  for (const name of await readdir(f.artifacts)) expect(await readFile(join(restored, 'candidate', name))).toEqual(await readFile(join(f.artifacts, name)))
  expect(await readFile(join(restored, 'evidence', 'runner', 'muse-installer-acceptance-fake', 'acceptance.json'), 'utf8')).toContain('"success":true')
  await expect(readFile(join(restored, 'evidence', 'desktop', 'installer-tests/run-fixture/payload/ordinary-config.json'))).rejects.toThrow()
  await expect(readFile(join(restored, 'evidence', 'desktop', 'installer-tests/run-fixture/fixture.exe'))).rejects.toThrow()
  expect((await readdir(f.runner)).filter(name => name.startsWith('muse-ci-export-'))).toEqual([])
})

it('rejects unauthorized CI identity, destinations, signed headers and expired authorization without uploading', async () => {
  const f = await fixture()
  const changes = [
    { environment: { ...f.environment, GITHUB_EVENT_NAME: 'pull_request' } },
    { environment: { ...f.environment, GITHUB_REPOSITORY: 'attacker/fork' } },
    { environment: { ...f.environment, GITHUB_SHA: 'd'.repeat(40) } },
    { platform: 'darwin' as const },
    ...[
      { ...f.config, version: '0.0.1' }, { ...f.config, prefix: '../releases/latest' },
      { ...f.config, expiresAtUtc: '2000-01-01T00:00:00.000Z' },
      { ...f.config, objects: { ...f.config.objects, candidate: { ...f.config.objects.candidate, url: f.config.objects.candidate.url.replace('muse.tos-s3-cn-beijing.volces.com', 'example.com') } } },
      { ...f.config, objects: { ...f.config.objects, candidate: { ...f.config.objects.candidate, headers: { ...f.config.objects.candidate.headers, 'x-amz-acl': 'public-read' } } } },
      { ...f.config, objects: { ...f.config.objects, candidate: { ...f.config.objects.candidate, url: f.config.objects.candidate.url.replace('candidate.tar.enc?', 'another.tar.enc?') } } },
    ].map(config => ({ environment: { ...f.environment, MUSE_CI_TOS_CANDIDATE_UPLOAD: JSON.stringify(config) } })),
  ]
  let calls = 0
  const fetchImpl: typeof fetch = async () => { calls++; return new Response() }
  for (const change of changes) await expect(exportMuseCiCandidate({ ...f.options, ...change, fetchImpl })).rejects.toThrow('Muse candidate export:')
  expect(calls).toBe(0)
})

it('refuses changed build bytes, unsuccessful receipts, environment files and directory links', async () => {
  for (const invalid of ['digest', 'receipt', 'legacy-version', 'environment', 'link']) {
    const f = await fixture()
    if (invalid === 'digest') await writeFile(join(f.artifacts, `muse-med-${f.config.version}-win-x64.exe`), 'changed')
    if (invalid === 'receipt') await writeFile(join(f.installed, 'acceptance.json'), '{"success":false}')
    if (invalid === 'legacy-version') {
      const path = join(f.runner, 'muse-candidate-update-1.2.2', 'result.json')
      await writeFile(path, JSON.stringify({ success: true, target: 'win-x64', version: f.config.version,
        sourceCommit: f.config.expectedCommit, fromVersion: '1.2.4' }))
    }
    if (invalid === 'environment') await writeFile(join(f.build, 'installer-tests/run-fixture/.env.windows'), 'FAKE_SECRET=never-export')
    if (invalid === 'link') {
      const original = join(f.build, 'installer-tests/run-fixture'), moved = join(f.base, 'linked-evidence')
      await rename(original, moved)
      await symlink(moved, original, process.platform === 'win32' ? 'junction' : 'dir')
    }
    let calls = 0
    const fetchImpl: typeof fetch = async () => { calls++; return new Response() }
    await expect(exportMuseCiCandidate({ ...f.options, fetchImpl })).rejects.toThrow('Muse candidate export:')
    expect(calls).toBe(0)
    expect((await readdir(f.runner)).filter(name => name.startsWith('muse-ci-export-'))).toEqual([])
  }
})

it('redacts network and HTTP failure details, stops before transfer and removes temporary data', async () => {
  for (const kind of ['network', 'http']) {
    const f = await fixture()
    let calls = 0
    const fetchImpl: typeof fetch = async () => {
      calls++
      if (kind === 'network') throw new Error(`${f.config.objects.candidate.url} ${f.config.encryptionKeyHex}`)
      return new Response(`FAKE_SECRET ${f.config.encryptionKeyHex}`, { status: 403 })
    }
    await expect(exportMuseCiCandidate({ ...f.options, fetchImpl })).rejects.toThrow(kind === 'network'
      ? /^Muse candidate export: upload transport failed$/u : /^Muse candidate export: upload failed \(HTTP 403\)$/u)
    expect(calls).toBe(1)
    expect((await readdir(f.runner)).filter(name => name.startsWith('muse-ci-export-'))).toEqual([])
  }
})
