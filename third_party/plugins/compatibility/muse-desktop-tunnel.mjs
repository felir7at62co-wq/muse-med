/** Authenticated Muse transport using the pinned upstream CustomTunnelClient. */
import { request } from 'node:http'
import { WebSocket } from 'ws'
import { CustomTunnelClient } from './upstream/tunnel-client.mjs'

const forbiddenHeaders = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'cookie', 'authorization', 'origin', 'host', 'x-dsh-internal-tunnel'])

function headersForHost(headers, cookie, port, websocket = false) {
  const result = {}
  for (const [name, value] of Object.entries(headers ?? {})) {
    const lower = name.toLowerCase()
    if ((!forbiddenHeaders.has(lower) || (websocket && ['connection', 'upgrade'].includes(lower))) && (typeof value === 'string' || typeof value === 'number' || Array.isArray(value))) result[lower] = value
  }
  result.host = `127.0.0.1:${port}`
  result.cookie = cookie
  result.origin = `http://127.0.0.1:${port}`
  return result
}

function responseHeaders(headers) {
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !forbiddenHeaders.has(name.toLowerCase()) && name.toLowerCase() !== 'set-cookie'))
}

function validPath(path) {
  return typeof path === 'string' && path.startsWith('/') && !path.startsWith('//') && !/[\r\n]/u.test(path)
}

class MuseTunnelClient extends CustomTunnelClient {
  constructor(options) {
    const controller = new AbortController()
    let previousState
    const reportState = state => {
      if (state === previousState) return
      previousState = state
      try { options.onState?.(state) } catch (error) { console.error('Desktop connection observer failed') }
    }
    super({ serverUrl: options.serverUrl, localPort: options.localPort, signal: controller.signal, onStateChange: state => reportState(state.phase === 'ready' ? 'online' : ['connecting', 'reconnecting'].includes(state.phase) ? 'connecting' : previousState === 'rejected' ? 'rejected' : 'offline') })
    this.options = options
    this.controller = controller
    this.reportState = reportState
    this.authenticationRejected = false
    this.requests = new Map()
    this.work = new Set()
    this.localClose = new Set()
    this.wsAcks = new Map()
    this.wsSequences = new Map()
    this.wsUploadSequences = new Map()
    this.stopPromise = null
    this.startPromise = null
  }

  _track(promise) {
    this.work.add(promise)
    promise.catch(() => {}).finally(() => this.work.delete(promise))
    return promise
  }

  _scheduleReconnect() {
    if (this.signal.aborted || this.disconnecting || this.authenticationRejected || this.reconnectTimer) return
    this.reportState('offline')
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this._track(this.connect().catch(() => {}))
    }, this.options.reconnectMaxIntervalMs)
  }

  _connectWebSocket() {
    return new Promise((resolve, reject) => {
      if (this.signal.aborted) { reject(new Error('Desktop tunnel stopped')); return }
      const ws = new WebSocket(this.serverUrl, { headers: this.options.headers, handshakeTimeout: this.options.ackTimeoutMs, maxPayload: 2 * 1024 * 1024, perMessageDeflate: false })
      this.ws = ws
      let ready = false
      const deadline = setTimeout(() => { ws.terminate(); reject(new Error('Desktop tunnel handshake timed out')) }, this.options.ackTimeoutMs)
      const abort = () => { ws.terminate(); reject(new Error('Desktop tunnel stopped')) }
      this.signal.addEventListener('abort', abort, { once: true })
      const close = new Promise(done => ws.once('close', done))
      this.controlClose = close
      ws.on('open', () => this._sendMessage({ type: 'connect', version: 1, deviceId: this.options.deviceId }))
      ws.on('message', data => {
        let message
        try { message = JSON.parse(data.toString()) } catch (error) { ws.close(1008, 'Invalid control JSON'); return }
        if (!message || typeof message !== 'object' || Array.isArray(message)) { ws.close(1008, 'Invalid control message'); return }
        if (message.type === 'ready') {
          if (ready || this.signal.aborted) return
          ready = true
          clearTimeout(deadline)
          this.connected = true
          this.publicUrl = message.publicUrl ?? null
          resolve()
          return
        }
        if (message.type === 'rejected') {
          this.authenticationRejected = true
          this.reportState('rejected')
          ws.close(1008, 'Muse authorization rejected')
          return
        }
        if (ready && !this.signal.aborted) this._handleMessage(message)
      })
      ws.on('error', error => { if (!ready) reject(error) })
      ws.on('close', code => {
        clearTimeout(deadline)
        this.signal.removeEventListener('abort', abort)
        this.connected = false
        this._stopHeartbeat()
        this._cleanupLocalWs()
        for (const id of [...this.requests.keys()]) this._cancel(id)
        for (const ack of this.wsAcks.values()) ack.reject(new Error('Desktop tunnel disconnected'))
        this.wsAcks.clear()
        if (code === 1008) { this.authenticationRejected = true; this.reportState('rejected') }
        if (!ready) reject(new Error('Desktop tunnel disconnected before ready'))
        if (!this.signal.aborted && !this.disconnecting && !this.authenticationRejected) this._scheduleReconnect()
      })
    })
  }

  _handleMessage(message) {
    switch (message.type) {
      case 'request-start': this._requestStart(message); break
      case 'request-chunk': this._requestChunk(message); break
      case 'request-end': {
        const state = this.requests.get(message.id)
        if (state) this._track(state.upload.then(() => { if (!state.cancelled) state.req.end() }).catch(() => this._cancel(message.id)))
        break
      }
      case 'request-cancel': this._cancel(message.id); break
      case 'response-ack': this.requests.get(message.id)?.acks.get(message.seq)?.resolve(); break
      case 'ws-open': this._openWs(message); break
      case 'ws-frame': this._writeWs(message); break
      case 'ws-close': this._handleWsClose(message); break
      case 'ws-ack': this.wsAcks.get(`${message.wsId}:${message.seq}`)?.resolve(); break
      case 'pong': break
      default: this.ws?.close(1008, 'Unknown control message')
    }
  }

  _requestStart(message) {
    if (typeof message.id !== 'string' || this.requests.has(message.id) || !validPath(message.url) || typeof message.method !== 'string') { this.ws?.close(1008, 'Invalid HTTP request'); return }
    const state = { req: null, res: null, cancelled: false, upload: Promise.resolve(), nextUploadSeq: 0, acks: new Map() }
    this.requests.set(message.id, state)
    try {
      state.req = request({ hostname: '127.0.0.1', port: this.localPort, method: message.method, path: message.url, headers: headersForHost(message.headers, this.options.loopbackCookie, this.localPort) }, res => {
        state.res = res
        this._track(this._streamResponse(message.id, state, res).catch(() => {
          if (!state.cancelled) this._sendMessage({ type: 'response-error', id: message.id, error: 'host-unavailable' })
          this._cancel(message.id)
        }))
      })
      state.req.on('error', () => {
        if (!state.cancelled) this._sendMessage({ type: 'response-error', id: message.id, error: 'host-unavailable' })
        this._cancel(message.id)
      })
      const closed = new Promise(resolve => state.req.once('close', resolve))
      this.localClose.add(closed)
      closed.finally(() => this.localClose.delete(closed))
    } catch (error) {
      this._sendMessage({ type: 'response-error', id: message.id, error: 'invalid-request' })
      this._cancel(message.id)
    }
  }

  _requestChunk(message) {
    const state = this.requests.get(message.id)
    if (!state || state.cancelled) return
    if (!Number.isSafeInteger(message.seq) || message.seq !== state.nextUploadSeq++ || typeof message.data !== 'string') { this._cancel(message.id); return }
    const bytes = Buffer.from(message.data, 'base64')
    if (bytes.length > this.options.chunkBytes) { this._cancel(message.id); return }
    state.upload = state.upload.then(async () => {
      if (state.cancelled) return
      await new Promise((resolve, reject) => state.req.write(bytes, error => error ? reject(error) : resolve()))
      if (!state.cancelled) await this._send({ type: 'request-ack', id: message.id, seq: message.seq })
    })
    this._track(state.upload.catch(() => this._cancel(message.id)))
  }

  async _streamResponse(id, state, res) {
    await this._send({ type: 'response-start', id, status: res.statusCode, headers: responseHeaders(res.headers) })
    let seq = 0
    for await (const chunk of res) {
      for (let offset = 0; offset < chunk.length; offset += this.options.chunkBytes) {
        if (state.cancelled) return
        const ack = this._ack(state.acks, seq)
        await this._send({ type: 'response-chunk', id, seq, data: chunk.subarray(offset, offset + this.options.chunkBytes).toString('base64') })
        await ack
        seq++
      }
    }
    if (!state.cancelled) await this._send({ type: 'response-end', id })
    this.requests.delete(id)
  }

  _ack(map, key) {
    const pending = new Promise((resolve, reject) => {
      const settle = callback => {
        clearTimeout(timer)
        map.delete(key)
        callback()
      }
      const timer = setTimeout(() => settle(() => reject(new Error('Desktop tunnel acknowledgement timed out'))), this.options.ackTimeoutMs)
      map.set(key, { resolve: () => settle(resolve), reject: error => settle(() => reject(error)) })
    })
    pending.catch(() => {})
    return pending
  }

  _cancel(id) {
    const state = this.requests.get(id)
    if (!state) return
    state.cancelled = true
    this.requests.delete(id)
    for (const ack of [...state.acks.values()]) ack.reject(new Error('Desktop request cancelled'))
    state.res?.destroy()
    state.req?.destroy()
  }

  _openWs(message) {
    if (typeof message.wsId !== 'string' || this.localWsSockets.has(message.wsId) || !validPath(message.path)) { this.ws?.close(1008, 'Invalid WebSocket request'); return }
    this.wsSequences.set(message.wsId, 0)
    this.wsUploadSequences.set(message.wsId, 0)
    const mapped = { ...message, headers: headersForHost(message.headers, this.options.loopbackCookie, this.localPort, true) }
    super._handleWsOpen(mapped)
    const socket = this.localWsSockets.get(message.wsId)
    const closed = new Promise(resolve => socket.once('close', resolve))
    this.localClose.add(closed)
    closed.finally(() => { this.localClose.delete(closed); this.wsSequences.delete(message.wsId); this.wsUploadSequences.delete(message.wsId) })
    socket.on('end', () => socket.destroy())
  }

  // Stream raw native bytes so frame size cannot grow a parser buffer, and Host Ping reaches the browser.
  _processWsFrames(wsId, bytes) {
    if (bytes.length) this._sendMessage({ type: 'ws-frame', wsId, data: bytes.toString('base64') })
    return Buffer.alloc(0)
  }

  _writeWs(message) {
    const socket = this.localWsSockets.get(message.wsId)
    if (!socket || socket.destroyed) return
    if (!Number.isSafeInteger(message.seq) || message.seq !== this.wsUploadSequences.get(message.wsId) || typeof message.data !== 'string') { socket.destroy(); return }
    const bytes = Buffer.from(message.data, 'base64')
    if (bytes.length > this.options.chunkBytes) { socket.destroy(); return }
    this.wsUploadSequences.set(message.wsId, message.seq + 1)
    socket.write(bytes, error => {
      if (error) socket.destroy()
      else this._sendMessage({ type: 'ws-ack', wsId: message.wsId, seq: message.seq })
    })
  }

  _sendMessage(message) {
    if (message.type === 'ws-frame') {
      const socket = this.localWsSockets.get(message.wsId)
      socket?.pause()
      const bytes = Buffer.from(message.data, 'base64')
      const prior = this.wsSending?.get(message.wsId) ?? Promise.resolve()
      this.wsSending ??= new Map()
      const sending = prior.then(async () => {
        for (let offset = 0; offset < bytes.length; offset += this.options.chunkBytes) {
          if (this.signal.aborted || !socket || socket.destroyed) return
          const seq = this.wsSequences.get(message.wsId)
          this.wsSequences.set(message.wsId, seq + 1)
          const ack = this._ack(this.wsAcks, `${message.wsId}:${seq}`)
          await this._send({ type: 'ws-frame', wsId: message.wsId, seq, data: bytes.subarray(offset, offset + this.options.chunkBytes).toString('base64') })
          await ack
        }
      }).catch(() => socket?.destroy()).finally(() => {
        if (this.wsSending.get(message.wsId) === sending) { this.wsSending.delete(message.wsId); socket?.resume() }
      })
      this.wsSending.set(message.wsId, sending)
      this._track(sending)
      return
    }
    this._track(this._send(message).catch(() => this.ws?.terminate()))
  }

  _send(message) {
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN || this.signal.aborted) return Promise.reject(new Error('Desktop tunnel is disconnected'))
    return new Promise((resolve, reject) => ws.send(JSON.stringify(message), error => error ? reject(error) : resolve()))
  }

  start() {
    this.startPromise ??= this.connect()
    return this.startPromise
  }

  stop() {
    this.stopPromise ??= this._stop()
    return this.stopPromise
  }

  async _stop() {
    this.disconnecting = true
    this.controller.abort()
    this._stopHeartbeat()
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    for (const id of [...this.requests.keys()]) this._cancel(id)
    for (const ack of [...this.wsAcks.values()]) ack.reject(new Error('Desktop tunnel stopped'))
    this._cleanupLocalWs()
    this.ws?.terminate()
    await this.controlClose
    await Promise.allSettled([...this.localClose, ...this.work, ...(this.startPromise ? [this.startPromise] : [])])
    this.ws = null
    this.connected = false
    this.publicUrl = null
    this.reportState('offline')
  }
}

/**
 * Create one outbound account-authenticated connection to the Muse desktop relay.
 * @param {object} options Muse credentials, loopback browser cookie and transport limits.
 * @returns {{ start(): Promise<void>, stop(): Promise<void> }} Transport whose stop waits for owned work.
 */
export function createMuseDesktopTunnel(options) {
  const url = new URL(options.serverUrl)
  if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Desktop relay requires a credential-free WebSocket URL')
  if (!Number.isSafeInteger(options.localPort) || options.localPort < 1 || options.localPort > 65535) throw new Error('Desktop relay requires a loopback Host port')
  if (!Number.isSafeInteger(options.chunkBytes) || options.chunkBytes < 1 || options.chunkBytes > 32768 || !Number.isSafeInteger(options.ackTimeoutMs) || options.ackTimeoutMs < 1) throw new Error('Desktop relay requires validated transfer limits')
  if (!Number.isSafeInteger(options.reconnectMaxIntervalMs) || options.reconnectMaxIntervalMs < 1) throw new Error('Desktop relay requires a configured reconnect interval')
  if (!options.loopbackCookie || !options.deviceId || !options.headers?.cookie) throw new Error('Desktop relay requires Muse and Host credentials')
  return new MuseTunnelClient(options)
}
