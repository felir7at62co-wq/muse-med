/** Linux process identity parsing runs independently of the host platform. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readProcessStart } from '../src/index.ts'

const { procRead } = vi.hoisted(() => ({ procRead: vi.fn<(path: string) => string>() }))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    readFileSync(...args: Parameters<typeof actual.readFileSync>) {
      if (args[0] === '/proc/123/stat' && args[1] === 'utf8') return procRead(args[0])
      return actual.readFileSync(...args)
    },
  }
})

const platform = Object.getOwnPropertyDescriptor(process, 'platform')

afterEach(() => {
  if (platform === undefined) Reflect.deleteProperty(process, 'platform')
  else Object.defineProperty(process, 'platform', platform)
  vi.resetAllMocks()
})

describe('Linux process start identity', () => {
  it('reads field 22 after the final closing parenthesis in the process name', () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    const fields = Array.from({ length: 21 }, (_value, index) => `field-${String(index + 3)}`)
    fields[19] = '987654321'
    procRead.mockReturnValue(`123 (worker (with) parentheses) ${fields.join(' ')}\n`)
    expect(readProcessStart(123)).toBe('987654321')
    expect(procRead).toHaveBeenCalledExactlyOnceWith('/proc/123/stat')
  })

  it('returns no identity when the leader has already been reaped', () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    procRead.mockImplementation(() => {
      throw Object.assign(new Error('process no longer exists'), { code: 'ENOENT' })
    })
    expect(readProcessStart(123)).toBeUndefined()
  })

  it('does not read Linux process files on a host without procfs', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    expect(readProcessStart(123)).toBeUndefined()
    expect(procRead).not.toHaveBeenCalled()
  })
})
