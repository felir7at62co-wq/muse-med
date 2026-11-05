/** Import the previous active ChatGPT account before the new subscription provider starts. */
import { randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'

// Both retained providers use this OAuth client; re-review before changing either pin.
const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const nonEmpty = value => typeof value === 'string' && value.trim().length > 0
const migrationError = detail => new Error(`Muse subscription sign-in migration: ${detail}. Sign in again in Settings > Subscriptions.`)

async function pathsFor(options) {
  let authPath = options.authPath
  if (authPath === undefined) {
    const { dshHomePath } = await import('@deepseek-ai/dsh-home-paths')
    authPath = dshHomePath('plugins', 'subscriptions', 'auth.json')
  }
  const markerPath = options.markerPath ?? join(dirname(authPath), 'muse-codex-migration-v1.json')
  if (!isAbsolute(authPath) || !isAbsolute(markerPath) || authPath === markerPath) {
    throw migrationError('store and marker paths must be distinct absolute paths')
  }
  return { authPath, markerPath }
}

async function identifiersFor(options) {
  if (options.identifiers !== undefined) return options.identifiers
  const { credentialKey, credentialRef } = await import('@deepseek-ai/dsh-credentials')
  return {
    record: credentialKey('codex-subscription', 'accounts'),
    refs: [credentialRef('OPENAI_CODEX_SUBSCRIPTION_OAUTH'), credentialRef('WSL043_OPENAI_CODEX_OAUTH')],
  }
}

async function readJson(file, subject) {
  let text
  try {
    const info = await lstat(file)
    if (!info.isFile() || info.isSymbolicLink()) throw migrationError(`${subject} must be a regular file`)
    text = await readFile(file, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return undefined
    throw error
  }
  let parsed
  try { parsed = JSON.parse(text) } catch (_error) {
    throw migrationError(`${subject} contains invalid JSON`)
  }
  if (!isObject(parsed)) throw migrationError(`${subject} must contain an object`)
  return parsed
}

async function writePrivateJson(file, value) {
  const directory = dirname(file)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const info = await lstat(directory)
  if (!info.isDirectory() || info.isSymbolicLink()) throw migrationError('destination directory must not be a link')
  await chmod(directory, 0o700)
  const temporary = `${file}.${randomUUID()}.tmp`
  let handle
  try {
    handle = await open(temporary, 'wx', 0o600)
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`)
    await handle.sync()
    await handle.close()
    handle = undefined
    await rename(temporary, file)
  } finally {
    await handle?.close()
    try { await unlink(temporary) } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
}

function sessionOf(credential) {
  if (!isObject(credential) || credential.type !== 'oauth'
    || !nonEmpty(credential.access) || !nonEmpty(credential.refresh)
    || !Number.isFinite(credential.expires) || credential.expires <= 0) {
    throw migrationError('previous active account has invalid OAuth fields')
  }
  let claims
  try {
    const parts = credential.access.split('.')
    if (parts.length !== 3 || !parts[1] || !/^[A-Za-z0-9_-]+$/u.test(parts[1])) throw new Error('invalid JWT')
    claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
  } catch (_error) {
    throw migrationError('previous active account has an unreadable access-token identity')
  }
  if (!isObject(claims)) throw migrationError('previous active account has an unreadable access-token identity')
  for (const client of [claims.client_id, claims.azp]) {
    if (client !== undefined && client !== CODEX_CLIENT_ID) throw migrationError('previous account uses a different OAuth client')
  }
  const accountId = claims['https://api.openai.com/auth']?.chatgpt_account_id
  if (!nonEmpty(accountId)) throw migrationError('previous access token has no ChatGPT account identity')
  if (credential.accountId !== undefined && credential.accountId !== accountId) {
    throw migrationError('previous account identity does not match its access token')
  }
  const profile = claims['https://api.openai.com/profile']
  const emailAddress = profile?.email ?? claims.email
  return {
    accessToken: credential.access,
    refreshToken: credential.refresh,
    expiresAt: credential.expires,
    accountId,
    ...(nonEmpty(emailAddress) ? { emailAddress: emailAddress.trim() } : {}),
  }
}

async function previousActiveAccount(credentials, identifiers) {
  let record
  try { record = await credentials.readRecord(identifiers.record) } catch (_error) {
    throw migrationError('previous account record could not be read')
  }
  if (record !== undefined) {
    const payload = record?.payload
    if (record?.kind !== 'grant' || !isObject(payload) || payload.version !== 1
      || !nonEmpty(payload.activeId) || !Array.isArray(payload.accounts) || payload.accounts.length === 0) {
      throw migrationError('previous account record is invalid')
    }
    const ids = new Set()
    for (const account of payload.accounts) {
      if (!isObject(account) || !nonEmpty(account.id) || ids.has(account.id)) {
        throw migrationError('previous account record has invalid account identities')
      }
      ids.add(account.id)
    }
    const active = payload.accounts.find(account => account.id === payload.activeId)
    if (active === undefined) throw migrationError('previous active account is missing')
    return { session: sessionOf(active.credential), remainingAccounts: payload.accounts.length - 1 }
  }
  for (const ref of identifiers.refs) {
    let hit
    try { hit = await credentials.resolve(ref) } catch (_error) {
      throw migrationError('previous OAuth credential could not be read')
    }
    if (hit === undefined || hit.value === '') continue
    if (typeof hit.value !== 'string') throw migrationError('previous OAuth credential is invalid')
    let credential
    try { credential = JSON.parse(hit.value) } catch (_error) {
      throw migrationError('previous OAuth credential contains invalid JSON')
    }
    return { session: sessionOf(credential), remainingAccounts: 0 }
  }
  return undefined
}

function validateMarker(marker) {
  if (marker.version !== 1 || !['imported-active-account', 'existing-codex-account', 'manual-login-required'].includes(marker.status)) {
    throw migrationError('migration marker is invalid')
  }
}

async function migrate(credentials, options, paths) {
  const marker = await readJson(paths.markerPath, 'migration marker')
  if (marker !== undefined) {
    validateMarker(marker)
    if (marker.status === 'manual-login-required') return { status: 'manual-login-required' }
    return { status: 'already-migrated' }
  }
  const store = await readJson(paths.authPath, 'subscription account store') ?? {}
  if (Object.hasOwn(store, 'codex')) {
    await writePrivateJson(paths.markerPath, { version: 1, status: 'existing-codex-account' })
    return { status: 'existing-codex-account' }
  }
  const previous = await previousActiveAccount(credentials, await identifiersFor(options))
  if (previous === undefined) return { status: 'no-previous-account' }
  // Startup owns the store until upstream.apply: no token refresh or login writer may run concurrently.
  const latest = await readJson(paths.authPath, 'subscription account store') ?? {}
  if (JSON.stringify(latest) !== JSON.stringify(store)) throw migrationError('subscription account store changed during migration')
  const session = previous.session
  const account = session.emailAddress === undefined ? session.accountId
    : JSON.stringify([session.accountId, 'email', session.emailAddress.toLowerCase()])
  await writePrivateJson(paths.authPath, {
    ...store,
    codex: { default: account, accounts: { [account]: session } },
  })
  await writePrivateJson(paths.markerPath, {
    version: 1, status: 'imported-active-account', remainingAccounts: previous.remainingAccounts,
  })
  return { status: 'imported-active-account', remainingAccounts: previous.remainingAccounts }
}

/**
 * Import only the former active account into an empty Codex provider before upstream.apply.
 * Existing new accounts and completed migration markers prevent reimport after logout.
 * Reads the old credential service without modifying it; never refreshes or sends credentials.
 * @param credentials - DSH credential service exposing readRecord and resolve.
 * @param options - Omit for managed home paths and branded credential identifiers; tests may provide isolated authPath, markerPath and identifiers.
 * @returns Non-secret migration status and, after an import, the number of other old accounts needing login.
 */
export async function migrateSubscriptionsCredentials(credentials, options = {}) {
  const paths = await pathsFor(options)
  return migrate(credentials, options, paths)
}

/**
 * Persist manual-login recovery so a later logout cannot resurrect an old account.
 * Existing valid markers remain unchanged; old credentials are never read or modified.
 * Called before the upstream provider starts under the same single-writer rule as import.
 * @param options - Omit for managed paths; tests may provide isolated authPath and markerPath.
 * @returns Non-secret persisted marker status; rejects if disabling import cannot be saved.
 */
export async function disableLegacyImport(options = {}) {
  const paths = await pathsFor(options)
  const marker = await readJson(paths.markerPath, 'migration marker')
  if (marker !== undefined) {
    validateMarker(marker)
    return { status: marker.status }
  }
  await writePrivateJson(paths.markerPath, { version: 1, status: 'manual-login-required' })
  return { status: 'manual-login-required' }
}
