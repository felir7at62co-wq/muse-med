/** Verify sealed release bytes and discovery with isolated metadata and download responses. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { parseXml } from 'builder-util-runtime'
import { readbackSealedReleases } from './readback.mjs'

const repository = 'felir7at62co-wq/muse-med'
const sourceCommit = 'a'.repeat(40)
const token = 'synthetic-readback-token'
const names = [
  'muse-med-1.0.5-mac-arm64.dmg', 'muse-med-1.0.5-mac-arm64.zip',
  'muse-med-1.0.5-mac-arm64.zip.blockmap', 'muse-med-1.0.5-win-x64.exe',
  'muse-med-1.0.5-win-x64.exe.blockmap', 'latest-mac.yml', 'rc-mac.yml',
  'latest.yml', 'rc.yml', 'muse-desktop-builds.json', 'muse-desktop-SHA256SUMS.txt',
]
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const publicURL = (tag, name) => `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`
const apiURL = id => `https://api.github.com/repos/${repository}/releases/assets/${id}`
const draftTag = index => `untagged-${(index === 0 ? 'a' : 'b').repeat(20)}`
const responseBody = (bytes, headers = {}) => new Response(new ReadableStream({ start(controller) {
  const split = Math.max(1, Math.floor(bytes.length / 2))
  controller.enqueue(bytes.subarray(0, split))
  controller.enqueue(bytes.subarray(split))
  controller.close()
} }), { status: 200, headers })

function fixture(mode = 'draft') {
  const bodies = new Map(names.map(name => [name, Buffer.from(`original release bytes for ${name}\n`)]))
  const seal = { schemaVersion: 1, repository, version: '1.0.5', sourceCommit, sourceRun: 123456,
    releases: [{ id: 101, tag: 'v1.0.5', prerelease: false },
      { id: 102, tag: 'v1.0.5-rc.muse-stable', prerelease: true }],
    files: names.map(filename => ({ filename, size: bodies.get(filename).length, sha256: sha256(bodies.get(filename)) })),
  }
  const releases = seal.releases.map((expected, index) => ({ id: expected.id, tag_name: expected.tag,
    prerelease: expected.prerelease, draft: mode === 'draft', target_commitish: sourceCommit,
    assets: seal.files.map((file, assetIndex) => ({ id: 1000 + index * 100 + assetIndex,
      name: file.filename, size: file.size, digest: `sha256:${file.sha256}`, state: 'uploaded',
      url: apiURL(1000 + index * 100 + assetIndex), browser_download_url: publicURL(expected.tag, file.filename),
      download_count: 0 })) }))
  const refs = new Map(seal.releases.map(release => [release.tag,
    { ref: `refs/tags/${release.tag}`, object: { type: 'commit', sha: sourceCommit } }]))
  const annotations = new Map(), metadataCalls = [], fetchCalls = [], events = []
  const controls = { latestTag: seal.releases[0].tag, atomTags: [seal.releases[1].tag, seal.releases[0].tag],
    redirectStatus: 302, redirectLocation: undefined, cdnHost: 'release-assets.githubusercontent.com',
    publicRedirect: false, atomResponse: undefined, response: undefined, afterBody: undefined }
  let verifiedBodies = 0
  const adapter = { async json(route) {
    metadataCalls.push(route)
    if (route === 'releases/latest') return structuredClone(releases.find(release => release.tag_name === controls.latestTag)
      ?? { tag_name: controls.latestTag })
    if (route.startsWith('releases/')) return structuredClone(releases.find(release => release.id === Number(route.slice('releases/'.length))))
    if (route.startsWith('git/ref/tags/')) return structuredClone(refs.get(decodeURIComponent(route.slice('git/ref/tags/'.length))))
    if (route.startsWith('git/tags/')) return structuredClone(annotations.get(route.slice('git/tags/'.length)))
    assert.fail(`Unexpected metadata operation: ${route}`)
  } }
  const fakeFetch = async (input, options = {}) => {
    const url = String(input)
    const headers = new Headers(options.headers)
    fetchCalls.push({ url, options: { ...options, headers } })
    if (url === `https://github.com/${repository}/releases.atom`) {
      assert.equal(headers.has('authorization'), false)
      assert.equal(options.redirect, 'error')
      if (controls.atomResponse) return await controls.atomResponse()
      const entries = controls.atomTags.map(tag => `<entry><id>fixture:${tag}</id><link href="https://github.com/${repository}/releases/tag/${tag}"/></entry>`)
      return new Response(`<feed xmlns="http://www.w3.org/2005/Atom">${entries.join('')}</feed>`, { status: 200 })
    }
    const asset = releases.flatMap(release => release.assets).find(value =>
      value.url === url || value.browser_download_url === url || url === `https://${controls.cdnHost}/download/${value.id}?signature=synthetic-signed-url`)
    assert.ok(asset, `Unexpected download destination: ${url}`)
    if (url === asset.url) {
      assert.equal(mode, 'draft')
      assert.equal(headers.get('authorization'), `Bearer ${token}`)
      assert.equal(options.redirect, 'manual')
      assert.equal(headers.get('accept'), 'application/octet-stream')
      return new Response(null, { status: controls.redirectStatus,
        headers: controls.redirectLocation === null ? {} : {
          location: controls.redirectLocation ?? `https://release-assets.githubusercontent.com/download/${asset.id}?signature=synthetic-signed-url`,
        } })
    }
    assert.equal(headers.has('authorization'), false, 'Downloads must be anonymous after the authenticated API hop')
    if (controls.publicRedirect && url === asset.browser_download_url) {
      assert.equal(options.redirect, 'manual')
      return new Response(null, { status: controls.redirectStatus,
        headers: { location: `https://${controls.cdnHost}/download/${asset.id}?signature=synthetic-signed-url` } })
    }
    asset.download_count += 1
    const file = seal.files.find(value => value.filename === asset.name)
    const result = controls.response ? await controls.response(asset, file, url) : responseBody(bodies.get(asset.name), { 'content-length': String(file.size) })
    verifiedBodies += 1
    if (controls.afterBody) await controls.afterBody({ asset, file, verifiedBodies })
    return result
  }
  const options = { mode, fetch: fakeFetch, token, parseXml, onEvent: event => { events.push(event) } }
  return { seal, releases, refs, annotations, bodies, adapter, options, controls, metadataCalls, fetchCalls, events }
}

function useUntaggedAddresses(f, indexes = [0, 1]) {
  for (const index of indexes) for (const asset of f.releases[index].assets) {
    asset.browser_download_url = publicURL(draftTag(index), asset.name)
  }
}

test('reads all eleven original files from each draft without forwarding the API credential', async () => {
  const f = fixture()
  const receipt = await readbackSealedReleases(f.seal, f.adapter, f.options)
  assert.equal(receipt.schemaVersion, 1)
  assert.equal(receipt.operation, 'draft-readback')
  assert.equal(receipt.version, f.seal.version)
  assert.equal(receipt.sourceCommit, sourceCommit)
  assert.equal(receipt.sourceRun, f.seal.sourceRun)
  assert.equal(receipt.success, true)
  assert.equal(receipt.releases.length, 2)
  assert.equal(f.fetchCalls.length, 44)
  assert.equal(f.events.length, 22)
  for (const release of receipt.releases) {
    assert.equal(release.draft, true)
    assert.equal(release.verifiedFiles.length, 11)
    assert.deepEqual(release.verifiedFiles.map(file => file.filename).sort(), [...names].sort())
  }
  const serialized = JSON.stringify(receipt)
  assert.equal(serialized.includes(token), false)
  assert.equal(serialized.includes('synthetic-signed-url'), false)
  assert.equal(serialized.includes('https://'), false)
})

for (const [label, indexes] of [
  ['both drafts', [0, 1]], ['only the stable draft', [0]], ['only the compatibility draft', [1]],
]) test(`reads all sealed bytes with canonical twenty-hex untagged browser addresses on ${label}`, async () => {
  const f = fixture()
  useUntaggedAddresses(f, indexes)
  const receipt = await readbackSealedReleases(f.seal, f.adapter, f.options)
  assert.equal(receipt.success, true)
  assert.equal(receipt.releases.length, 2)
  assert.ok(receipt.releases.every(release => release.draft && release.verifiedFiles.length === 11))
  assert.equal(f.events.length, 22)
  assert.equal(f.fetchCalls.length, 44)
  const authenticated = f.fetchCalls.filter(call => call.options.headers.has('authorization'))
  assert.deepEqual(authenticated.map(call => call.url).sort(), f.releases.flatMap(release => release.assets.map(asset => asset.url)).sort())
  assert.ok(authenticated.every(call => call.options.headers.get('authorization') === `Bearer ${token}`))
  assert.ok(f.fetchCalls.filter(call => !call.options.headers.has('authorization'))
    .every(call => call.url.startsWith('https://release-assets.githubusercontent.com/')))
  assert.ok(f.fetchCalls.every(call => !call.url.includes('/untagged-')))
  for (const release of receipt.releases) for (const verified of release.verifiedFiles) {
    assert.deepEqual({ size: verified.size, sha256: verified.sha256 },
      { size: f.bodies.get(verified.filename).length, sha256: sha256(f.bodies.get(verified.filename)) })
  }
  const serialized = JSON.stringify(receipt)
  assert.equal(serialized.includes('untagged-'), false)
  assert.equal(serialized.includes(token), false)
  assert.equal(serialized.includes('synthetic-signed-url'), false)
})

const untaggedAddressFailures = [
  ['another browser host', asset => { asset.browser_download_url = asset.browser_download_url.replace('github.com', 'other.example') }],
  ['a lookalike browser host', asset => { asset.browser_download_url = asset.browser_download_url.replace('github.com', 'github.com.other.example') }],
  ['another repository', asset => { asset.browser_download_url = asset.browser_download_url.replace(repository, 'someone/another-repository') }],
  ['plain HTTP', asset => { asset.browser_download_url = asset.browser_download_url.replace('https:', 'http:') }],
  ['embedded credentials', asset => { asset.browser_download_url = asset.browser_download_url.replace('github.com', 'user:password@github.com') }],
  ['a port', asset => { asset.browser_download_url = asset.browser_download_url.replace('github.com', 'github.com:443') }],
  ['a short untagged identifier', asset => { asset.browser_download_url = publicURL(`untagged-${'a'.repeat(19)}`, asset.name) }],
  ['a long untagged identifier', asset => { asset.browser_download_url = publicURL(`untagged-${'a'.repeat(21)}`, asset.name) }],
  ['an uppercase untagged identifier', asset => { asset.browser_download_url = publicURL(`untagged-${'A'.repeat(20)}`, asset.name) }],
  ['a nonhexadecimal untagged identifier', asset => { asset.browser_download_url = publicURL(`untagged-${'g'.repeat(20)}`, asset.name) }],
  ['an encoded untagged prefix', asset => { asset.browser_download_url = asset.browser_download_url.replace('untagged-', 'untagged%2D') }],
  ['a different filename', asset => { asset.browser_download_url = publicURL(draftTag(0), 'another-file.dmg') }],
  ['a noncanonical filename encoding', asset => { asset.browser_download_url = asset.browser_download_url.replace('/muse-med-', '/%6Duse-med-') }],
  ['an extra path component', asset => { asset.browser_download_url = `${asset.browser_download_url}/another-file` }],
  ['a query string', asset => { asset.browser_download_url += '?download=1' }],
  ['a fragment', asset => { asset.browser_download_url += '#download' }],
  ['a different API asset ID', asset => { asset.url = apiURL(asset.id + 1) }],
  ['an API address in another repository', asset => { asset.url = asset.url.replace(repository, 'someone/another-repository') }],
]
for (const [label, change] of untaggedAddressFailures) test(`refuses a draft untagged address with ${label} before any bytes`, async () => {
  const f = fixture()
  useUntaggedAddresses(f)
  change(f.releases[0].assets[0])
  await assert.rejects(readbackSealedReleases(f.seal, f.adapter, f.options))
  assert.equal(f.fetchCalls.length, 0)
  assert.equal(f.events.length, 0)
})

for (const [label, tag] of [['two untagged identifiers', `untagged-${'c'.repeat(20)}`], ['tagged and untagged addresses', 'v1.0.5']]) {
  test(`refuses mixed ${label} within one draft`, async () => {
    const f = fixture()
    useUntaggedAddresses(f)
    const asset = f.releases[0].assets[1]
    asset.browser_download_url = publicURL(tag, asset.name)
    await assert.rejects(readbackSealedReleases(f.seal, f.adapter, f.options), /inconsistent browser address prefixes/u)
    assert.equal(f.fetchCalls.length, 0)
    assert.equal(f.events.length, 0)
  })
}

test('refuses a consistent draft browser prefix change after the first original byte stream', async () => {
  const f = fixture()
  useUntaggedAddresses(f)
  f.controls.afterBody = async ({ verifiedBodies }) => {
    if (verifiedBodies === 1) for (const asset of f.releases[0].assets) {
      asset.browser_download_url = publicURL(`untagged-${'c'.repeat(20)}`, asset.name)
    }
  }
  await assert.rejects(readbackSealedReleases(f.seal, f.adapter, f.options), /metadata or asset IDs changed/u)
  assert.equal(f.fetchCalls.length, 2)
  assert.equal(f.events.length, 0)
})

for (const index of [0, 1]) test(`refuses untagged browser addresses on public release ${index + 1} before discovery or bytes`, async () => {
  const f = fixture('public')
  useUntaggedAddresses(f, [index])
  await assert.rejects(readbackSealedReleases(f.seal, f.adapter, f.options))
  assert.equal(f.fetchCalls.length, 0)
  assert.equal(f.events.length, 0)
})

for (const firstTag of ['v1.0.5', 'v1.0.5-rc.muse-stable']) test(`anonymous public readback accepts ${firstTag} as the actual first Atom app entry`, async () => {
  const f = fixture('public')
  f.controls.atomTags = [firstTag, ...f.controls.atomTags.filter(tag => tag !== firstTag)]
  const receipt = await readbackSealedReleases(f.seal, f.adapter, f.options)
  assert.equal(receipt.operation, 'public-readback')
  assert.equal(receipt.success, true)
  assert.equal(receipt.stableLatestTag, 'v1.0.5')
  assert.equal(receipt.atomFirstTag, firstTag)
  assert.equal(receipt.legacyRcSelectedTag, 'v1.0.5-rc.muse-stable')
  assert.ok(receipt.releases.every(release => !release.draft && release.verifiedFiles.length === 11))
  assert.ok(f.fetchCalls.every(call => !call.options.headers.has('authorization')))
  assert.equal(f.fetchCalls.filter(call => call.url.includes('/releases/download/')).length, 22)
  assert.ok(f.metadataCalls.includes('releases/latest'))
})

const initialFailures = [
  ['different source tag', f => { f.refs.get(f.seal.releases[0].tag).object.sha = 'b'.repeat(40) }],
  ['different release identity', f => { f.releases[0].id += 1 }],
  ['different release tag', f => { f.releases[0].tag_name = 'v1.0.4' }],
  ['wrong stable visibility', f => { f.releases[0].draft = false }],
  ['wrong prerelease flag', f => { f.releases[1].prerelease = false }],
  ['missing original file', f => { f.releases[0].assets.pop() }],
  ['unexpected file inventory', f => { f.releases[0].assets[0].name = 'unexpected.txt' }],
  ['duplicate file inventory', f => { f.releases[0].assets[1] = structuredClone(f.releases[0].assets[0]) }],
  ['wrong asset byte count', f => { f.releases[0].assets[0].size += 1 }],
  ['wrong asset digest', f => { f.releases[0].assets[0].digest = `sha256:${'b'.repeat(64)}` }],
  ['unfinished asset upload', f => { f.releases[0].assets[0].state = 'new' }],
  ['invalid asset identity', f => { f.releases[0].assets[0].id = 0 }],
]
for (const [label, change] of initialFailures) test(`refuses ${label} before downloading any bytes`, async () => {
  const f = fixture()
  change(f)
  await assert.rejects(readbackSealedReleases(f.seal, f.adapter, f.options))
  assert.equal(f.fetchCalls.length, 0)
})

test('refuses an invalid mode before metadata or download requests', async () => {
  const f = fixture()
  await assert.rejects(readbackSealedReleases(f.seal, f.adapter, { ...f.options, mode: 'upload' }))
  assert.equal(f.metadataCalls.length, 0)
  assert.equal(f.fetchCalls.length, 0)
})

test('requires a draft credential before requesting private bytes', async () => {
  const f = fixture()
  await assert.rejects(readbackSealedReleases(f.seal, f.adapter, { ...f.options, token: '' }))
  assert.equal(f.fetchCalls.length, 0)
})

test('requires the real updater parser for public discovery before downloading bytes', async () => {
  const f = fixture('public')
  await assert.rejects(readbackSealedReleases(f.seal, f.adapter, { ...f.options, parseXml: undefined }))
  assert.equal(f.fetchCalls.length, 0)
})

const redirectFailures = [
  ['missing redirect location', null],
  ['plain HTTP', 'http://release-assets.githubusercontent.com/download/1000'],
  ['untrusted host', 'https://other.example/download/1000'],
  ['GitHub API host', 'https://api.github.com/repos/someone/else/releases/assets/1'],
  ['lookalike CDN suffix', 'https://release-assets.githubusercontent.com.attacker.example/download/1000'],
  ['embedded user', 'https://user@release-assets.githubusercontent.com/download/1000'],
  ['embedded password', 'https://user:password@release-assets.githubusercontent.com/download/1000'],
  ['nonstandard port', 'https://release-assets.githubusercontent.com:8443/download/1000'],
  ['fragment', 'https://release-assets.githubusercontent.com/download/1000#secret'],
]
for (const [label, location] of redirectFailures) test(`refuses a draft redirect with ${label} before making a second request`, async () => {
  const f = fixture()
  f.controls.redirectLocation = location
  await assert.rejects(readbackSealedReleases(f.seal, f.adapter, f.options))
  assert.equal(f.fetchCalls.length, 1)
})

test('refuses a forged API asset address without sending the credential there', async () => {
  const f = fixture()
  f.releases[0].assets[0].url = 'https://other.example/releases/assets/1000'
  await assert.rejects(readbackSealedReleases(f.seal, f.adapter, f.options))
  assert.equal(f.fetchCalls.length, 0)
})

const bodyFailures = [
  ['a missing response body', async () => new Response(null, { status: 200 })],
  ['a non-success status', async () => new Response('not the original file', { status: 500 })],
  ['a mismatched content length', async (asset, file) => responseBody(Buffer.alloc(file.size), { 'content-length': String(file.size + 1) })],
  ['a short stream', async (asset, file) => responseBody(Buffer.alloc(file.size - 1))],
  ['an oversized stream', async (asset, file) => responseBody(Buffer.alloc(file.size + 1))],
  ['different same-size bytes', async (asset, file) => responseBody(Buffer.alloc(file.size))],
]
for (const [label, response] of bodyFailures) test(`rejects ${label} without issuing a success receipt`, async () => {
  const f = fixture()
  f.controls.response = response
  await assert.rejects(readbackSealedReleases(f.seal, f.adapter, f.options))
  assert.equal(f.events.length, 0)
})

const stateChanges = [
  ['tag source', f => { f.refs.get(f.seal.releases[0].tag).object.sha = 'b'.repeat(40) }],
  ['release identity', f => { f.releases[0].id += 1 }],
  ['draft visibility', f => { f.releases[0].draft = false }],
  ['prerelease flag', f => { f.releases[0].prerelease = true }],
  ['asset identity', f => { f.releases[0].assets[0].id = 9999; f.releases[0].assets[0].url = apiURL(9999) }],
  ['asset URL', f => { f.releases[0].assets[0].url = apiURL(9999) }],
  ['asset size', f => { f.releases[0].assets[0].size += 1 }],
  ['asset digest', f => { f.releases[0].assets[0].digest = `sha256:${'b'.repeat(64)}` }],
  ['uploaded state', f => { f.releases[0].assets[0].state = 'new' }],
]
for (const [label, change] of stateChanges) test(`rejects ${label} changes after bytes are fetched`, async () => {
  const f = fixture()
  f.controls.afterBody = async ({ verifiedBodies }) => { if (verifiedBodies === 1) change(f) }
  await assert.rejects(readbackSealedReleases(f.seal, f.adapter, f.options))
})

test('ignores download_count changes caused by successful readback', async () => {
  const f = fixture()
  await readbackSealedReleases(f.seal, f.adapter, f.options)
  assert.ok(f.releases.every(release => release.assets.every(asset => asset.download_count === 1)))
})

for (const firstTag of ['v1.0.4', 'ffmpeg-corresponding-source', 'muse-bgm-source']) test(`does not skip first Atom entry ${firstTag} to find a later compatible app`, async () => {
  const f = fixture('public')
  f.controls.atomTags = [firstTag, 'v1.0.5']
  await assert.rejects(readbackSealedReleases(f.seal, f.adapter, f.options))
})

test('rejects GitHub Latest selecting the RC instead of the stable release', async () => {
  const f = fixture('public')
  f.controls.latestTag = 'v1.0.5-rc.muse-stable'
  await assert.rejects(readbackSealedReleases(f.seal, f.adapter, f.options))
})

test('projects network failures without the draft token or signed download address', async () => {
  const f = fixture()
  f.options.fetch = async () => { throw new Error(`transport failed ${token} https://release-assets.githubusercontent.com/?signature=synthetic-signed-url`) }
  await assert.rejects(readbackSealedReleases(f.seal, f.adapter, f.options), error => {
    assert.equal(error.message.includes(token), false)
    assert.equal(error.message.includes('synthetic-signed-url'), false)
    assert.equal(error.message.includes('https://'), false)
    return true
  })
})

for (const status of [301, 302, 303, 307, 308]) test(`handles a ${status} draft redirect without forwarding authorization`, async () => {
  const f = fixture()
  f.controls.redirectStatus = status
  const receipt = await readbackSealedReleases(f.seal, f.adapter, f.options)
  assert.equal(receipt.success, true)
  const authenticated = f.fetchCalls.filter(call => call.options.headers.has('authorization'))
  assert.equal(authenticated.length, 22)
  assert.ok(authenticated.every(call => call.url.startsWith(`https://api.github.com/repos/${repository}/releases/assets/`)))
  assert.ok(f.fetchCalls.every(call => call.options.redirect === 'manual'))
})

test('accepts trusted objects CDN redirects without forwarding authorization', async () => {
  const f = fixture()
  f.controls.cdnHost = 'objects.githubusercontent.com'
  const original = f.options.fetch
  f.options.fetch = async (url, options) => {
    if (String(url).startsWith('https://api.github.com/')) {
      const response = await original(url, options)
      return new Response(null, { status: response.status, headers: {
        location: response.headers.get('location').replace('release-assets.githubusercontent.com', 'objects.githubusercontent.com'),
      } })
    }
    return await original(url, options)
  }
  assert.equal((await readbackSealedReleases(f.seal, f.adapter, f.options)).success, true)
  assert.equal(f.fetchCalls.filter(call => call.url.startsWith('https://objects.githubusercontent.com/')).length, 22)
})

test('uses only anonymous requests for public GitHub and CDN download hops', async () => {
  const f = fixture('public')
  f.controls.publicRedirect = true
  const receipt = await readbackSealedReleases(f.seal, f.adapter, f.options)
  assert.equal(receipt.success, true)
  assert.equal(f.fetchCalls.filter(call => call.url.includes('/releases/download/')).length, 22)
  assert.equal(f.fetchCalls.filter(call => call.url.startsWith('https://release-assets.githubusercontent.com/')).length, 22)
  assert.ok(f.fetchCalls.every(call => !call.options.headers.has('authorization')))
})

test('accepts complete draft bytes directly from the authenticated API without a redirect', async () => {
  const f = fixture()
  f.options.fetch = async (input, options) => {
    const url = String(input)
    const asset = f.releases.flatMap(release => release.assets).find(value => value.url === url)
    assert.ok(asset)
    const headers = new Headers(options.headers)
    assert.equal(headers.get('authorization'), `Bearer ${token}`)
    assert.equal(options.redirect, 'manual')
    f.fetchCalls.push({ url, options: { ...options, headers } })
    asset.download_count += 1
    return responseBody(f.bodies.get(asset.name), { 'content-length': String(asset.size) })
  }
  const receipt = await readbackSealedReleases(f.seal, f.adapter, f.options)
  assert.equal(receipt.success, true)
  assert.equal(f.fetchCalls.length, 22)
})

test('refuses a trusted redirect loop at the fixed hop bound', async () => {
  const f = fixture()
  f.options.fetch = async (input, options) => {
    const url = String(input), headers = new Headers(options.headers)
    f.fetchCalls.push({ url, options: { ...options, headers } })
    assert.equal(options.redirect, 'manual')
    if (f.fetchCalls.length > 1) assert.equal(headers.has('authorization'), false)
    return new Response(null, { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/loop' } })
  }
  await assert.rejects(readbackSealedReleases(f.seal, f.adapter, f.options))
  assert.equal(f.fetchCalls.length, 5)
})

test('rejects an untrusted second redirect before any credentials or request reach that host', async () => {
  const f = fixture()
  const original = f.options.fetch
  f.options.fetch = async (input, options) => {
    if (String(input).startsWith('https://release-assets.githubusercontent.com/')) {
      const headers = new Headers(options.headers)
      assert.equal(headers.has('authorization'), false)
      f.fetchCalls.push({ url: String(input), options: { ...options, headers } })
      return new Response(null, { status: 302, headers: { location: 'https://untrusted.example/private' } })
    }
    return await original(input, options)
  }
  await assert.rejects(readbackSealedReleases(f.seal, f.adapter, f.options))
  assert.equal(f.fetchCalls.length, 2)
  assert.ok(f.fetchCalls.every(call => !call.url.includes('untrusted.example')))
})

test('rejects a duplicate asset ID across releases before downloading', async () => {
  const f = fixture()
  f.releases[1].assets[0].id = f.releases[0].assets[0].id
  f.releases[1].assets[0].url = apiURL(f.releases[0].assets[0].id)
  await assert.rejects(readbackSealedReleases(f.seal, f.adapter, f.options))
  assert.equal(f.fetchCalls.length, 0)
})

test('rejects a forged public download address before requesting private bytes', async () => {
  const f = fixture()
  f.releases[0].assets[0].browser_download_url = 'https://other.example/download.exe'
  await assert.rejects(readbackSealedReleases(f.seal, f.adapter, f.options))
  assert.equal(f.fetchCalls.length, 0)
})

for (const length of ['invalid', '-1', '1.5', String(Number.MAX_SAFE_INTEGER + 1)]) test(`rejects malformed Content-Length ${length}`, async () => {
  const f = fixture()
  f.controls.response = async asset => responseBody(f.bodies.get(asset.name), { 'content-length': length })
  await assert.rejects(readbackSealedReleases(f.seal, f.adapter, f.options))
  assert.equal(f.events.length, 0)
})

test('does not depend on Content-Length when complete bytes match the seal', async () => {
  const f = fixture()
  f.controls.response = async asset => responseBody(f.bodies.get(asset.name))
  assert.equal((await readbackSealedReleases(f.seal, f.adapter, f.options)).success, true)
})

test('rejects nonbyte stream chunks without issuing a success event', async () => {
  const f = fixture()
  f.controls.response = async () => new Response(new ReadableStream({ start(controller) {
    controller.enqueue('invalid text chunk')
    controller.close()
  } }))
  await assert.rejects(readbackSealedReleases(f.seal, f.adapter, f.options))
  assert.equal(f.events.length, 0)
})

test('projects stream exceptions without private credential or signed URL in output', async () => {
  const f = fixture()
  f.controls.response = async () => new Response(new ReadableStream({ start(controller) {
    controller.error(new Error(`${token} https://release-assets.githubusercontent.com/?signature=synthetic-signed-url`))
  } }))
  await assert.rejects(readbackSealedReleases(f.seal, f.adapter, f.options), error => {
    assert.equal(error.message.includes(token), false)
    assert.equal(error.message.includes('synthetic-signed-url'), false)
    assert.equal(error.message.includes('https://'), false)
    return true
  })
  assert.equal(f.events.length, 0)
})

test('projects updater parser exceptions without wire details in output', async () => {
  const f = fixture('public')
  f.options.parseXml = () => { throw new Error(`${token} https://release-assets.githubusercontent.com/?signature=synthetic-signed-url`) }
  await assert.rejects(readbackSealedReleases(f.seal, f.adapter, f.options), error => {
    assert.equal(error.message.includes(token), false)
    assert.equal(error.message.includes('synthetic-signed-url'), false)
    assert.equal(error.message.includes('https://'), false)
    return true
  })
  assert.equal(f.events.length, 0)
})

test('does not include request secrets in successful progress events before a later failure', async () => {
  const f = fixture()
  f.controls.response = async asset => {
    if (asset.name === names[1]) throw new Error(`${token} synthetic-signed-url`)
    return responseBody(f.bodies.get(asset.name))
  }
  await assert.rejects(readbackSealedReleases(f.seal, f.adapter, f.options))
  assert.equal(f.events.length, 1)
  const output = JSON.stringify(f.events)
  assert.equal(output.includes(token), false)
  assert.equal(output.includes('synthetic-signed-url'), false)
  assert.equal(output.includes('https://'), false)
})

test('rejects changes to unrelated immutable asset fields after downloading', async () => {
  const f = fixture()
  f.releases[0].assets[0].content_type = 'application/octet-stream'
  f.controls.afterBody = async ({ verifiedBodies }) => { if (verifiedBodies === 1) f.releases[0].assets[0].content_type = 'text/plain' }
  await assert.rejects(readbackSealedReleases(f.seal, f.adapter, f.options))
})

test('checks GitHub Latest again after complete public byte verification', async () => {
  const f = fixture('public')
  f.controls.afterBody = async ({ verifiedBodies }) => { if (verifiedBodies === 22) f.controls.latestTag = 'v1.0.4' }
  await assert.rejects(readbackSealedReleases(f.seal, f.adapter, f.options))
  assert.equal(f.events.length, 22)
})

test('requires actual Atom first-entry discovery to stay unchanged through readback', async () => {
  const f = fixture('public')
  f.controls.atomTags = ['v1.0.5', 'v1.0.5-rc.muse-stable']
  f.controls.afterBody = async ({ verifiedBodies }) => { if (verifiedBodies === 22) f.controls.atomTags.reverse() }
  await assert.rejects(readbackSealedReleases(f.seal, f.adapter, f.options))
  assert.equal(f.events.length, 22)
})

for (const [label, atomResponse] of [
  ['unavailable', async () => new Response('unavailable', { status: 503 })],
  ['empty entries', async () => new Response('<feed xmlns="http://www.w3.org/2005/Atom"/>')],
  ['malformed XML', async () => new Response('<feed><entry>')],
  ['oversized body', async () => responseBody(Buffer.alloc(2 * 1024 ** 2 + 1, 0x20))],
]) test(`rejects ${label} Atom feed with the actual updater parser`, async () => {
  const f = fixture('public')
  f.controls.atomResponse = atomResponse
  await assert.rejects(readbackSealedReleases(f.seal, f.adapter, f.options))
  assert.equal(f.fetchCalls.filter(call => call.url.includes('/releases/download/')).length, 0)
})

for (const kind of ['HTTP status', 'Content-Length']) test(`closes an unread ${kind} rejection body before returning`, async () => {
  const f = fixture()
  let response, cancelled = 0
  f.controls.response = async (asset, file) => {
    response = new Response(new ReadableStream({ start(controller) { controller.enqueue(Uint8Array.of(1)) },
      cancel() { cancelled += 1 } }), {
      status: kind === 'HTTP status' ? 500 : 200,
      headers: kind === 'Content-Length' ? { 'content-length': String(file.size + 1) } : {},
    })
    return response
  }
  try {
    await assert.rejects(readbackSealedReleases(f.seal, f.adapter, f.options))
    assert.equal(cancelled, 1)
  } finally {
    if (response?.body) await response.body.cancel()
  }
})

for (const kind of ['unsafe destination', 'missing location', 'hop bound']) test(`closes every redirect response body when rejecting ${kind}`, async () => {
  const f = fixture()
  const responses = []
  let cancelled = 0
  f.options.fetch = async () => {
    const response = new Response(new ReadableStream({ start(controller) { controller.enqueue(Uint8Array.of(1)) },
      cancel() { cancelled += 1 } }), { status: 302, headers: kind === 'missing location' ? {} : {
        location: kind === 'unsafe destination' ? 'https://other.example/download' : 'https://release-assets.githubusercontent.com/loop',
      } })
    responses.push(response)
    return response
  }
  try {
    await assert.rejects(readbackSealedReleases(f.seal, f.adapter, f.options))
    assert.equal(responses.length, kind === 'hop bound' ? 5 : 1)
    assert.equal(cancelled, responses.length)
  } finally {
    for (const response of responses) await response.body.cancel()
  }
})

test('rejects an older RC selected before the sealed current RC even when stable is the first Atom app', async () => {
  const f = fixture('public')
  f.controls.atomTags = ['v1.0.5', 'v1.0.4-rc.muse-stable', 'v1.0.5-rc.muse-stable']
  await assert.rejects(readbackSealedReleases(f.seal, f.adapter, f.options))
  assert.equal(f.fetchCalls.filter(call => call.url.includes('/releases/download/')).length, 0)
})

test('does not treat alpha or beta entries as the legacy updater RC channel', async () => {
  const f = fixture('public')
  f.controls.atomTags = ['v1.0.5', 'v1.0.5-alpha.1', 'v1.0.5-beta.1', 'v1.0.5-rc.muse-stable']
  const receipt = await readbackSealedReleases(f.seal, f.adapter, f.options)
  assert.equal(receipt.success, true)
  assert.equal(receipt.atomFirstTag, 'v1.0.5')
  assert.equal(receipt.legacyRcSelectedTag, 'v1.0.5-rc.muse-stable')
})

test('refuses public discovery without a compatible legacy RC entry', async () => {
  const f = fixture('public')
  f.controls.atomTags = ['v1.0.5', 'v1.0.5-alpha.1', 'v1.0.5-beta.1']
  await assert.rejects(readbackSealedReleases(f.seal, f.adapter, f.options))
  assert.equal(f.fetchCalls.filter(call => call.url.includes('/releases/download/')).length, 0)
})

test('rejects a change to the selected legacy RC after public byte verification', async () => {
  const f = fixture('public')
  f.controls.atomTags = ['v1.0.5', 'v1.0.5-rc.muse-stable']
  f.controls.afterBody = async ({ verifiedBodies }) => {
    if (verifiedBodies === 22) f.controls.atomTags.splice(1, 0, 'v1.0.4-rc.muse-stable')
  }
  await assert.rejects(readbackSealedReleases(f.seal, f.adapter, f.options))
  assert.equal(f.events.length, 22)
})
