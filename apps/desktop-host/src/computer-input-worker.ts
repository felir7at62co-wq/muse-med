/** Content-free physical-input observation on a dedicated Windows message thread. */
import { parentPort, workerData } from 'node:worker_threads'
import koffi from 'koffi'
import { isEscapeKeyDown, isPhysicalInput } from './computer-input-flags.ts'

/** Observe hook flags and compare physical Escape; key values, text and pointer positions never leave this thread. */
function observe(): void {
  if (!(workerData instanceof SharedArrayBuffer) || workerData.byteLength !== 20 || parentPort === null) {
    throw new Error('Invalid computer input monitor initialization')
  }
  const port = parentPort
  const state = new Int32Array(workerData)
  const user32 = koffi.load('user32.dll')
  const kernel32 = koffi.load('kernel32.dll')
  const hookType = koffi.proto('intptr_t __stdcall MuseInputHook(int code, uintptr_t message, void *data)')
  const install = user32.func('__stdcall', 'SetWindowsHookExW', 'void *', ['int', koffi.pointer(hookType), 'void *', 'uint32'])
  const remove = user32.func('int __stdcall UnhookWindowsHookEx(void *hook)')
  const next: (hook: unknown, code: number, event: number | bigint, data: unknown) => number | bigint = user32.func('intptr_t __stdcall CallNextHookEx(void *hook, int code, uintptr_t message, void *data)')
  const peek = user32.func('int __stdcall PeekMessageW(void *message, void *window, uint32 min, uint32 max, uint32 flags)')
  const dispatch = user32.func('intptr_t __stdcall DispatchMessageW(void *message)')
  const module = kernel32.func('void * __stdcall GetModuleHandleW(str16 name)')
  const message = Buffer.alloc(64)
  const callbacks: bigint[] = []
  const hooks: unknown[] = []
  let timer: ReturnType<typeof setInterval> | undefined
  let stopped = false
  const tick = (): number => Date.now() & 0x7fffffff
  const stop = (): void => {
    if (stopped) return
    stopped = true
    clearInterval(timer)
    Atomics.store(state, 1, 0)
    for (const hook of hooks) remove(hook)
    for (const callback of callbacks) koffi.unregister(callback)
    port.close()
  }
  try {
    // Ensure the installing thread owns a message queue before registering hooks.
    peek(message, null, 0, 0, 0)
    for (const [kind, flagsOffset] of [[13, 8], [14, 12]] as const) {
      const callback = koffi.register((code: number, event: number | bigint, data: unknown) => {
        if (code >= 0 && isPhysicalInput(kind === 13 ? 'keyboard' : 'mouse', koffi.decode(data, flagsOffset, 'uint32') as number)) {
          if (kind === 13 && isEscapeKeyDown(event, koffi.decode(data, 0, 'uint32') as number)) {
            Atomics.add(state, 4, 1)
          }
          Atomics.store(state, 2, tick())
          Atomics.add(state, 0, 1)
          port.postMessage('physical-input')
        }
        // Never swallow, delay for approval, or synthesize any user input.
        return next(null, code, event, data)
      }, koffi.pointer(hookType))
      callbacks.push(callback)
      const hook: unknown = install(kind, callback, module(null), 0)
      if (hook === null) throw new Error('Windows input observation could not be installed')
      hooks.push(hook)
    }
    Atomics.store(state, 2, tick())
    Atomics.store(state, 3, tick())
    Atomics.store(state, 1, 1)
    timer = setInterval(() => {
      while (peek(message, null, 0, 0, 1)) dispatch(message)
      Atomics.store(state, 3, tick())
    }, 8)
    port.on('message', (value: unknown) => { if (value === 'stop') stop() })
    port.on('close', stop)
    port.postMessage('ready')
  } catch (error) {
    stop()
    Atomics.store(state, 1, -1)
    throw error
  }
}

if (parentPort !== null) observe()
