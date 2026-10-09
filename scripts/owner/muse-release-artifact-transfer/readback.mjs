/** Read every sealed release asset without publishing or forwarding a private API credential to a CDN. */
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { prerelease, valid } from 'semver'
import { validateTransferSeal, verifySealedReleaseState } from './transfer.mjs'

const REPOSITORY = 'felir7at62co-wq/muse-med'
const API = `https://api.github.com/repos/${REPOSITORY}/releases/assets/`
const CDN_HOSTS = new Set(['release-assets.githubusercontent.com', 'objects.githubusercontent.com'])
const REDIRECTS = new Set([301, 302, 303, 307, 308])

function publicAssetUrl(tag, filename) {
  return `https://github.com/${REPOSITORY}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(filename)}`
}

function checkedRedirect(location, initialUrl) {
  let url
  try { url = new URL(location) }
  catch (error) { throw new Error('Asset redirect is not an absolute URL', { cause: error }) }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash
    || !(CDN_HOSTS.has(url.hostname) || url.href === initialUrl)) throw new Error('Unsafe asset redirect')
  return url.href
}

function snapshot(releases) {
  return releases.map(release => {
    const result = structuredClone(release)
    result.assets = result.assets.map(asset => { delete asset.download_count; return asset }).sort((a, b) => a.name.localeCompare(b.name))
    return result
  })
}

async function safeRequest(fetch, url, options) {
  try { return await fetch(url, options) }
  catch (error) { throw new Error('Release readback request failed', { cause: error }) }
}

async function closeBody(response) {
  if (response.body === null) return
  try { await response.body.cancel() }
  catch (error) { throw new Error('Release response body could not be closed', { cause: error }) }
}

async function refuseResponse(response, message) {
  await closeBody(response)
  throw new Error(message)
}

async function readBytes(response, expected, collect = false) {
  if (response.status !== 200 || response.body === null) return refuseResponse(response, 'Release readback requires HTTP 200 and a body')
  const length = response.headers.get('content-length')
  if (length !== null && (!/^[0-9]+$/u.test(length) || !Number.isSafeInteger(Number(length))
    || (collect ? Number(length) > expected.size : Number(length) !== expected.size))) {
    return refuseResponse(response, 'Release content length differs from its bound')
  }
  const hash = createHash('sha256'), parts = []
  let size = 0
  try {
    for await (const part of response.body) {
      if (!(part instanceof Uint8Array)) throw new Error('Invalid release byte chunk')
      size += part.length
      if (size > expected.size) throw new Error('Release body exceeds sealed size')
      hash.update(part)
      if (collect) parts.push(part)
    }
  } catch (error) {
    throw new Error('Release byte stream failed or exceeded its bound', { cause: error })
  }
  if (collect) return Buffer.concat(parts).toString('utf8')
  if (size !== expected.size || hash.digest('hex') !== expected.sha256) throw new Error('Release size or SHA256 mismatch')
  return { size, sha256: expected.sha256 }
}

async function assetResponse(fetch, asset, file, tag, mode, token) {
  const initialUrl = publicAssetUrl(tag, file.filename)
  let url = mode === 'draft' ? `${API}${asset.id}` : initialUrl
  for (let redirects = 0; ; redirects++) {
    const headers = { Accept: 'application/octet-stream' }
    if (mode === 'draft' && redirects === 0) {
      headers.Authorization = `Bearer ${token}`
      headers['X-GitHub-Api-Version'] = '2022-11-28'
    }
    const response = await safeRequest(fetch, url, { headers, redirect: 'manual', cache: 'no-store', signal: AbortSignal.timeout(1800000) })
    if (!REDIRECTS.has(response.status)) return response
    if (redirects >= 4) return refuseResponse(response, 'Release asset exceeded its redirect bound')
    const location = response.headers.get('location')
    if (!location) return refuseResponse(response, 'Release asset redirect is missing')
    let download
    try { download = checkedRedirect(location, initialUrl) }
    catch (error) { await closeBody(response); throw error }
    await closeBody(response)
    url = download
  }
}

function checkedAssets(releases, seal, mode) {
  const ids = new Set()
  for (const release of releases) {
    let browserTag
    for (const asset of release.assets) {
      if (!Number.isSafeInteger(asset.id) || asset.id < 1 || ids.has(asset.id)) throw new Error('Invalid or duplicate sealed asset ID')
      ids.add(asset.id)
      const address = asset.browser_download_url, prefix = `https://github.com/${REPOSITORY}/releases/download/`
      const candidate = typeof address === 'string' && address.startsWith(prefix) ? address.slice(prefix.length).split('/')[0] : ''
      const selected = address === publicAssetUrl(release.tag_name, asset.name) ? release.tag_name
        : mode === 'draft' && /^untagged-[a-f0-9]{20}$/u.test(candidate)
          && address === publicAssetUrl(candidate, asset.name) ? candidate : undefined
      if (asset.url !== `${API}${asset.id}` || selected === undefined) throw new Error('Sealed asset has another API or public address')
      if (browserTag !== undefined && browserTag !== selected) throw new Error('Sealed release has inconsistent browser address prefixes')
      browserTag = selected
    }
  }
  if (ids.size !== seal.files.length * 2) throw new Error('Release asset IDs are incomplete')
}

async function checkedState(seal, adapter, mode, before) {
  let releases
  try { releases = await verifySealedReleaseState(seal, adapter, { draft: mode === 'draft' }) }
  catch (error) { throw new Error('Sealed release source, visibility or metadata check failed', { cause: error }) }
  checkedAssets(releases, seal, mode)
  const actual = snapshot(releases)
  if (before && !isDeepStrictEqual(actual, before)) throw new Error('Release metadata or asset IDs changed during readback')
  return releases
}

async function publicDiscovery(seal, adapter, fetch, parseXml, releases) {
  const latest = await adapter.json('releases/latest')
  if (!isDeepStrictEqual(snapshot([latest]), snapshot([releases[0]]))) throw new Error('GitHub Latest differs from the sealed stable release')
  const response = await safeRequest(fetch, `https://github.com/${REPOSITORY}/releases.atom`, {
    redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(30000), headers: { Accept: 'application/atom+xml' },
  })
  const text = await readBytes(response, { size: 2 * 1024 ** 2 }, true)
  let first, feed
  try { feed = parseXml(text); first = feed.element('entry').element('link').attribute('href') }
  catch (error) { throw new Error('Legacy Atom feed could not be parsed by the updater parser', { cause: error }) }
  const selected = releases.find(release => first === `https://github.com/${REPOSITORY}/releases/tag/${release.tag_name}`)
  if (!selected) throw new Error('Legacy Atom selected another app version or an ancillary release')
  let legacyRcSelectedTag
  try {
    // GitHubProvider with current channel rc skips stable/alpha/beta and selects the first valid rc tag.
    for (const entry of feed.getElements('entry')) {
      const href = entry.element('link').attribute('href'), match = /\/tag\/([^/]+)$/u.exec(href)
      if (!match || valid(match[1]) === null || prerelease(match[1])?.[0] !== 'rc') continue
      if (href !== `https://github.com/${REPOSITORY}/releases/tag/${seal.releases[1].tag}`) {
        throw new Error('Legacy rc discovery selected another app version or source')
      }
      legacyRcSelectedTag = seal.releases[1].tag
      break
    }
  } catch (error) { throw new Error('Legacy rc channel selection failed', { cause: error }) }
  if (!legacyRcSelectedTag) throw new Error('Legacy Atom feed has no sealed rc compatibility entry')
  // Both selected entries have already passed exact source, public visibility and eleven-file checks.
  return { stableLatestTag: releases[0].tag_name, atomFirstTag: selected.tag_name, legacyRcSelectedTag }
}

/**
 * Verify all eleven remote byte streams in unchanged releases; each draft may use one exact GitHub untagged browser prefix, while downloads use API IDs.
 * @param seal - Strict approved source, release IDs and eleven-file inventory.
 * @param adapter - Repository-scoped JSON reader; no upload method is called.
 * @param options - Mode, byte fetcher, RAM-only private token, updater XML parser and safe progress observer.
 * @returns A public receipt of exact file sizes, SHA256 values and asset IDs, without URLs or credentials.
 */
export async function readbackSealedReleases(seal, adapter, { mode, fetch = globalThis.fetch, token, parseXml, onEvent = () => {} }) {
  validateTransferSeal(seal)
  if (!['draft', 'public'].includes(mode)) throw new Error('Declare draft or public readback mode')
  if (mode === 'draft' && (typeof token !== 'string' || token.length === 0)) throw new Error('Private readback requires a RAM-only workflow token')
  if (mode === 'public' && typeof parseXml !== 'function') throw new Error('Public readback requires the actual updater XML parser')
  const initial = await checkedState(seal, adapter, mode)
  const baseline = snapshot(initial)
  let discovery
  if (mode === 'public') discovery = await publicDiscovery(seal, adapter, fetch, parseXml, initial)
  const verifiedReleases = []
  for (const expected of seal.releases) {
    const verifiedFiles = []
    for (const file of seal.files) {
      const before = await checkedState(seal, adapter, mode, baseline)
      const release = before.find(item => item.id === expected.id)
      const asset = release.assets.find(item => item.name === file.filename)
      const bytes = await readBytes(await assetResponse(fetch, asset, file, expected.tag, mode, token), file)
      await checkedState(seal, adapter, mode, baseline)
      const verified = { filename: file.filename, ...bytes, assetId: asset.id }
      verifiedFiles.push(verified)
      onEvent({ status: 'remote-complete-byte-verified', releaseId: expected.id, tag: expected.tag, ...verified })
    }
    verifiedReleases.push({ ...expected, draft: mode === 'draft', verifiedFiles })
  }
  const after = await checkedState(seal, adapter, mode, baseline)
  if (mode === 'public') {
    const finalDiscovery = await publicDiscovery(seal, adapter, fetch, parseXml, after)
    if (!isDeepStrictEqual(finalDiscovery, discovery)) throw new Error('Public release discovery changed during readback')
  }
  return { schemaVersion: 1, operation: `${mode}-readback`, version: seal.version, sourceCommit: seal.sourceCommit,
    sourceRun: seal.sourceRun, success: true, releases: verifiedReleases, ...discovery }
}
