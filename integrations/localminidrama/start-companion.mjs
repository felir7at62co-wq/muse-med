/** Start the container studio with persistent SQLite/media and an explicitly configured public URL. */
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
const require = createRequire('/opt/upstream/backend-node/package.json')
const yaml = require('js-yaml')
const config = yaml.load(readFileSync('/opt/muse/config.yaml', 'utf8'))
const url = new URL(process.env.LOCALMINIDRAMA_PUBLIC_URL || 'http://127.0.0.1:5679')
if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
  throw new Error('LOCALMINIDRAMA_PUBLIC_URL must be an HTTP(S) studio address without credentials, query or fragment.')
}
config.server.host = '0.0.0.0'
config.storage.base_url = `${url.href.replace(/\/$/, '')}/static`
writeFileSync('/opt/upstream/backend-node/configs/config.yaml', yaml.dump(config), { mode: 0o600 })
await import('/opt/upstream/backend-node/src/server.js')
