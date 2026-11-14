import { getSystemErrorMessage, getSystemErrorName } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Windows has no O_NONBLOCK constant: this owner explicitly simulates Linux libc flags.
const linuxNonblock = 0x800
beforeEach(() => {
  vi.doMock('node:fs', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs')>()
    return { ...actual, constants: { ...actual.constants, O_NONBLOCK: linuxNonblock } }
  })
})

afterEach(() => {
  vi.doUnmock('@deepseek-ai/dsh-lazy-require')
  vi.doUnmock('node:fs')
  vi.resetModules()
})

// The mocked libc bindings exercise descriptor handling without replacing the test process on any host.
describe('Linux libc execve binding', () => {
  it.each([undefined, 'pipe'] as const)('restores blocking stdio without changing other status flags or control %s', async (control) => {
    const statusFlags = new Map([[0, linuxNonblock | 0x400], [1, linuxNonblock | 1], [2, 2], [7, linuxNonblock | 2]])
    const nativeExecve = vi.fn(() => -1)
    const nativeFcntl = vi.fn((fd: number, command: number, argument: number) => {
      if (command === 1) return 0
      if (command === 3) return statusFlags.get(fd) ?? -1
      if (command === 4) { statusFlags.set(fd, argument); return 0 }
      throw Error(`Unexpected fcntl command ${command}`)
    })
    vi.doMock('@deepseek-ai/dsh-lazy-require', () => ({
      createLazyRequire: () => () => ({ errno: () => 2, load: () => ({
        func: (declaration: string) => declaration.includes('execve') ? nativeExecve : nativeFcntl,
      }) }),
    }))
    const { loadLinuxExecve } = await import('../src/linux-execve.ts')
    expect(() => loadLinuxExecve()('/missing/tool', ['tool'], {}, control)).toThrow()
    expect([...statusFlags]).toEqual([[0, 0x400], [1, 1], [2, 2], [7, linuxNonblock | 2]])
    expect(nativeFcntl.mock.calls.filter(call => call[1] === 4)).toEqual([[0, 4, 0x400], [1, 4, 1]])
    expect(nativeFcntl.mock.calls.filter(call => call[0] === 7)).toEqual(control === 'pipe' ? [[7, 1, 0]] : [])
    expect(nativeExecve).toHaveBeenCalledOnce()
  })

  it.each([undefined, 'pipe'] as const)('preserves inherited stdio with control %s and reports execve errno', async (control) => {
    const nativeExecve = vi.fn(() => -1)
    const nativeFcntl = vi.fn((fd: number, command: number) => {
      if (command === 2 || command === 4) return 0
      if (command === 3) return linuxNonblock | fd
      return fd === 7 ? 1 : [1, 0, 5][fd]
    })
    const func = vi.fn((declaration: string) => declaration.includes('execve')
      ? nativeExecve
      : nativeFcntl)
    const load = vi.fn(() => ({ func }))
    const errno = vi.fn(() => 2)
    vi.doMock('@deepseek-ai/dsh-lazy-require', () => ({
      createLazyRequire: () => () => ({ errno, load }),
    }))

    const { loadLinuxExecve } = await import('../src/linux-execve.ts')
    const execve = loadLinuxExecve()
    expect(loadLinuxExecve()).toBe(execve)
    expect(load).toHaveBeenCalledExactlyOnceWith(null)
    expect(func.mock.calls).toEqual([
      ['int execve(const char *pathname, const char **argv, const char **envp)'],
      ['int fcntl(int fd, int cmd, int arg)'],
    ])

    let failure: unknown
    try {
      execve('/missing/tool', ['tool', 'literal arg'], { A: '1', EMPTY: '' }, control)
    } catch (error) {
      failure = error
    }
    expect(nativeFcntl.mock.calls).toEqual([
      [0, 1, 0],
      [0, 2, 0],
      [0, 3, 0],
      [0, 4, 0],
      [1, 1, 0],
      [1, 3, 0],
      [1, 4, 1],
      [2, 1, 0],
      [2, 2, 4],
      [2, 3, 0],
      [2, 4, 2],
      ...control === 'pipe' ? [[7, 1, 0], [7, 2, 0]] : [],
    ])
    expect(nativeExecve).toHaveBeenCalledExactlyOnceWith(
      '/missing/tool',
      ['tool', 'literal arg', null],
      ['A=1', 'EMPTY=', null],
    )
    expect(errno).toHaveBeenCalledOnce()
    expect(failure).toMatchObject({
      code: getSystemErrorName(-2),
      errno: -2,
      syscall: 'execve',
      path: '/missing/tool',
    })
    expect(failure).toBeInstanceOf(Error)
    // Node maps numeric system errors with the test host's libuv table, including Windows.
    expect((failure as Error).message).toBe(`${getSystemErrorName(-2)}: ${getSystemErrorMessage(-2)}, execve '/missing/tool'`)
  })

  it('reports failure to read descriptor flags before replacing the process', async () => {
    const nativeExecve = vi.fn()
    const nativeFcntl = vi.fn(() => -1)
    const func = vi.fn((declaration: string) => declaration.includes('execve')
      ? nativeExecve
      : nativeFcntl)
    const errno = vi.fn(() => 9)
    vi.doMock('@deepseek-ai/dsh-lazy-require', () => ({
      createLazyRequire: () => () => ({ errno, load: () => ({ func }) }),
    }))

    const { loadLinuxExecve } = await import('../src/linux-execve.ts')
    expect(() => loadLinuxExecve()('/bin/tool', ['tool'], {})).toThrow(expect.objectContaining({
      code: getSystemErrorName(-9),
      errno: -9,
      syscall: 'fcntl',
    }))
    expect(nativeFcntl).toHaveBeenCalledExactlyOnceWith(0, 1, 0)
    expect(nativeExecve).not.toHaveBeenCalled()
    expect(errno).toHaveBeenCalledOnce()
  })

  it('reports failure to clear close-on-exec before replacing the process', async () => {
    const nativeExecve = vi.fn()
    const nativeFcntl = vi.fn()
      .mockReturnValueOnce(1)
      .mockReturnValueOnce(-1)
    const func = vi.fn((declaration: string) => declaration.includes('execve')
      ? nativeExecve
      : nativeFcntl)
    const errno = vi.fn(() => 5)
    vi.doMock('@deepseek-ai/dsh-lazy-require', () => ({
      createLazyRequire: () => () => ({ errno, load: () => ({ func }) }),
    }))

    const { loadLinuxExecve } = await import('../src/linux-execve.ts')
    expect(() => loadLinuxExecve()('/bin/tool', ['tool'], {})).toThrow(expect.objectContaining({
      code: getSystemErrorName(-5),
      errno: -5,
      syscall: 'fcntl',
    }))
    expect(nativeFcntl.mock.calls).toEqual([
      [0, 1, 0],
      [0, 2, 0],
    ])
    expect(nativeExecve).not.toHaveBeenCalled()
    expect(errno).toHaveBeenCalledOnce()
  })

  it.each([3, 4])('rejects failed status operation %s before executing the target', async (operation) => {
    const nativeExecve = vi.fn()
    const nativeFcntl = vi.fn((_fd: number, command: number) => {
      if (command === 1) return 0
      if (command === operation) return -1
      if (command === 3) return linuxNonblock | 0x400
      return 0
    })
    const errno = vi.fn(() => 5)
    vi.doMock('@deepseek-ai/dsh-lazy-require', () => ({
      createLazyRequire: () => () => ({ errno, load: () => ({
        func: (declaration: string) => declaration.includes('execve') ? nativeExecve : nativeFcntl,
      }) }),
    }))
    const { loadLinuxExecve } = await import('../src/linux-execve.ts')
    expect(() => loadLinuxExecve()('/bin/tool', ['tool'], {})).toThrow(expect.objectContaining({
      code: getSystemErrorName(-5), errno: -5, syscall: 'fcntl',
    }))
    expect(nativeFcntl.mock.calls).toEqual([
      [0, 1, 0], [0, 3, 0], ...operation === 4 ? [[0, 4, 0x400]] : [],
    ])
    expect(nativeExecve).not.toHaveBeenCalled()
    expect(errno).toHaveBeenCalledOnce()
  })
})
