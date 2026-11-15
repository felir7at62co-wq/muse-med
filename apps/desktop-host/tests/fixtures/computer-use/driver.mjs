/** External stdio fixture; it never reads or controls the host desktop. */
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

const root = process.argv[2]
const mode = process.argv[3]
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWNgZGIGAAAOAAeCcsnOAAAAAElFTkSuQmCC'
const record = (event, data = {}) => appendFileSync(join(root, 'driver.ndjson'), JSON.stringify({ event, pid: process.pid, ...data }) + '\n')
const windowProperties = { pid: { type: 'integer' }, window_id: { type: 'integer' }, session: { type: 'string' } }
const inputProperties = {
  ...windowProperties,
  target: { oneOf: [
    { type: 'object', properties: { kind: { const: 'window' }, pid: { type: 'integer' }, window_id: { type: 'integer' } }, required: ['kind', 'pid', 'window_id'], additionalProperties: false },
    { type: 'object', properties: { kind: { const: 'desktop' }, display_id: { type: 'string' } }, required: ['kind', 'display_id'], additionalProperties: false },
  ] },
  element_token: { type: 'string' },
  snapshot_id: { type: 'string' },
  element_index: { type: 'integer' },
  scope: { type: 'string', enum: ['window', 'desktop'] },
  delivery_mode: { type: 'string', enum: ['background', 'foreground'] },
  x: { type: 'number' },
  y: { type: 'number' },
}
const tool = (name, description, properties, required = []) => ({
  name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false },
})
const tools = [
  tool('screenshot', 'Capture the selected display.', { display: { type: 'integer', minimum: 0 } }, ['display']),
  tool('disconnect', 'Disconnect the fixture.', {}),
  tool('list_windows', 'List windows with their owning app, process and exact native window ID.', { pid: { type: 'integer' }, on_screen_only: { type: 'boolean' } }),
  tool('launch_app', 'Launch an app and return its process and windows.', { name: { type: 'string' }, path: { type: 'string' } }),
  tool('get_window_state', 'Return the exact window tree, structured snapshot and element tokens, and screenshot.', {
    ...windowProperties,
    include_accessibility_tree: { type: 'boolean' },
    include_screenshot: { type: 'boolean' },
  }, ['pid', 'window_id']),
  tool('click', 'Click a snapshot element or screenshot-local point in the exact target window.', inputProperties),
  tool('type_text', 'Type into a snapshot element or screenshot-local point. Desktop scope addresses the current foreground.', {
    ...inputProperties, text: { type: 'string' },
  }, ['text']),
  tool('press_key', 'Send one key to the exact target window.', { ...inputProperties, key: { type: 'string' } }, ['key']),
  tool('verify_state', 'Verify a bounded postcondition against the exact window.', {
    ...windowProperties, expect: { type: 'array', items: { type: 'object' } },
  }, ['pid', 'window_id', 'expect']),
  tool('end_session', 'Release the selected lifecycle session.', { session: { type: 'string' } }),
]
const windows = [
  { pid: 4400, window_id: 5500, app_name: 'Notepad', title: 'Untitled - Notepad', is_on_screen: true },
  { pid: 6600, window_id: 7700, app_name: 'Muse', title: 'Muse Bot', is_on_screen: true },
]
const state = {
  pid: 4400,
  window_id: 5500,
  app_name: 'Notepad',
  window_title: 'Untitled - Notepad',
  snapshot_id: 's00000001',
  elements: [{ element_index: 3, element_token: 'notepad-document-s00000001-3', role: 'Edit', label: 'Document', value: '', depth: 1 }],
}
function call(name, args) {
  if (args.display === 99) return { isError: true, content: [{ type: 'text', text: 'The selected window is unavailable.' }] }
  switch (name) {
    case 'screenshot':
      return { content: [{ type: 'text', text: `Display ${args.display}` }, { type: 'image', mimeType: 'image/png', data: png }], structuredContent: { display: args.display } }
    case 'disconnect':
      return { content: [{ type: 'text', text: 'Disconnected.' }] }
    case 'list_windows':
      return { content: [{ type: 'text', text: 'Two visible windows: Notepad and Muse.' }], structuredContent: { windows } }
    case 'launch_app':
      return { content: [{ type: 'text', text: 'App launch settled.' }], structuredContent: { pid: 4400, windows: [windows[0]] } }
    case 'get_window_state':
      return { content: [{ type: 'text', text: '[element_index 3] Edit: Document' }, { type: 'image', mimeType: 'image/png', data: png }], structuredContent: state }
    case 'click':
    case 'type_text':
    case 'press_key':
      return { content: [{ type: 'text', text: 'Fixture accepted the action arguments.' }], structuredContent: { effect: 'unverifiable', route: 'fixture' } }
    case 'verify_state':
      return { content: [{ type: 'text', text: 'Fixture postcondition checked.' }], structuredContent: { status: 'satisfied', stable: true } }
    case 'end_session':
      return { content: [{ type: 'text', text: 'Session ended.' }], structuredContent: { session: args.session, active: false } }
    default:
      throw new Error(`Unexpected fixture tool ${name}`)
  }
}
record('start', { permissionMode: process.env.CUA_DRIVER_PERMISSION_MODE, telemetryEnabled: process.env.CUA_DRIVER_RS_TELEMETRY_ENABLED })
process.once('exit', () => record('exit'))
const lines = createInterface({ input: process.stdin })
lines.once('close', () => process.exit(0))
lines.on('line', (line) => {
  const request = JSON.parse(line)
  if (request.id === undefined) {
    if (request.method === 'notifications/cancelled') record('cancelled', request.params)
    return
  }
  let result
  switch (request.method) {
    case 'server/discover':
      record('discover')
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } }) + '\n')
      return
    case 'initialize':
      record('initialize')
      if (mode === 'fail') process.exit(1)
      result = { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'cua-driver-fixture', version: '1.0.0' } }
      break
    case 'tools/list':
      result = { tools }
      break
    case 'tools/call':
      record('call', { name: request.params.name, arguments: request.params.arguments })
      result = call(request.params.name, request.params.arguments)
      break
    default:
      throw new Error(`Unexpected fixture method ${request.method}`)
  }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n', () => {
    if (request.method === 'tools/call' && request.params.name === 'disconnect') process.exit(0)
  })
})
