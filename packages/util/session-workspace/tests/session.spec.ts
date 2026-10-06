/** Session metadata resolves explicitly without substituting the process working directory. */
import { expect, it } from 'vitest'
import { DomainRecordError, unknownFailureMessage, sessionDirectory, sessionLookup, trySessionDirectory } from '../src/index.ts'

it('retains the domain code, revision, and bounded original cause', () => {
  const error = new DomainRecordError('REVISION_CONFLICT', 'record changed', 4)
  expect(error).toMatchObject({ name: 'DomainRecordError', code: 'REVISION_CONFLICT', currentRevision: 4,
    message: 'REVISION_CONFLICT: record changed' })
  expect(unknownFailureMessage(new TypeError('x'.repeat(301)), 'lookup failed')).toBe('lookup failed [TypeError: ' + 'x'.repeat(300) + ']')
  expect(unknownFailureMessage('closed', 'lookup failed')).toBe('lookup failed [string: closed]')
  expect(unknownFailureMessage(null, 'lookup failed')).toBe('lookup failed [object: null]')
})

it('finds a callable session lookup only when the optional Host service is present', () => {
  expect(sessionLookup({})).toBeUndefined()
  expect(sessionLookup({ get: () => undefined })).toBeUndefined()
  expect(sessionLookup({ get: () => null })).toBeUndefined()
  expect(sessionLookup({ get: () => ({ get: 4 }) })).toBeUndefined()
  const sessions = { get: (id: string) => id === 'known' ? { header: { cwd: '/session-project' } } : undefined }
  expect(sessionLookup({ get: (name, strict) => { expect([name, strict]).toEqual(['sessions', false]); return sessions } })).toBe(sessions)
})

it('distinguishes missing identity, missing service, unknown session, and a session with no directory', () => {
  const sessions = { get: (id: string) => id === 'known' ? { header: { cwd: '/session-project' } }
    : id === 'no-cwd' ? { header: {} } : undefined }
  for (const id of ['', '  ']) expect(() => sessionDirectory(sessions, id)).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }))
  expect(() => sessionDirectory(undefined, 'known')).toThrow(expect.objectContaining({ code: 'DEPENDENCY_MISSING' }))
  expect(() => sessionDirectory(sessions, 'missing')).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }))
  expect(sessionDirectory(sessions, 'known')).toEqual({ sessionId: 'known', cwd: '/session-project' })
  expect(sessionDirectory(sessions, 'no-cwd')).toEqual({ sessionId: 'no-cwd', cwd: undefined })
})

it('returns an optional directory when identity or the service lookup cannot resolve it', () => {
  const sessions = { get: (id: string) => id === 'known' ? { header: { cwd: '/session-project' } } : undefined }
  for (const id of [undefined, null, 3, '', '  ', 'missing']) expect(trySessionDirectory(sessions, id)).toBeUndefined()
  expect(trySessionDirectory(undefined, 'known')).toBeUndefined()
  expect(trySessionDirectory({ get: () => { throw new Error('service unloaded') } }, 'known')).toBeUndefined()
  expect(trySessionDirectory(sessions, 'known')).toBe('/session-project')
})
