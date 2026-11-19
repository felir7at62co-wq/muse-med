import net from 'node:net'
import tls from 'node:tls'
import { syncBuiltinESMExports } from 'node:module'

const state = { denied: 0 }
globalThis[Symbol.for('muse-session-roundtrip-network')] = state
const loopback = host => host == null || /^(?:localhost|127\.0\.0\.1|::1|\[::1\])$/iu.test(host)
function requireLoopback(host) {
  if (loopback(host)) return
  ++state.denied
  throw new Error('ROUNDTRIP_OUTBOUND_NETWORK_DENIED')
}

function connectionHost(args) {
  const first = args[0]
  if (Array.isArray(first)) return connectionHost(first)
  if (first !== null && typeof first === 'object') {
    if (typeof first.path === 'string') return 'external-pipe'
    return first.host
  }
  if (typeof first === 'number') return typeof args[1] === 'string' ? args[1] : undefined
  return typeof first === 'string' ? 'external-pipe' : undefined
}
const connect = net.Socket.prototype.connect
net.Socket.prototype.connect = function (...args) {
  requireLoopback(connectionHost(args))
  return connect.apply(this, args)
}
const tlsConnect = tls.connect
tls.connect = function (...args) {
  requireLoopback(connectionHost(args))
  return tlsConnect.apply(this, args)
}
syncBuiltinESMExports()

const performFetch = globalThis.fetch
globalThis.fetch = (request, init) => {
  const url = new URL(request?.url ?? request)
  requireLoopback(url.hostname)
  return performFetch(request, { ...init, redirect: 'error' })
}
