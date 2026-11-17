import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { packageAssetRevision, packageAssetRevisionedPath } from '../modules/src/assets.ts'
import { clientBundle } from '../tsdown.client.ts'

const bundle = clientBundle(import.meta.dirname, ['lib/types/index.js'])
const atlas = join(import.meta.dirname, 'src/client/assets/breach-atlas.webp')

export default (options: Parameters<typeof bundle>[0]) => bundle(options).map(config =>
  config.platform === 'browser'
    ? {
        ...config,
        copy: [{
          from: atlas,
          to: join(import.meta.dirname, 'lib/assets'),
          rename: packageAssetRevisionedPath('breach-atlas.webp', packageAssetRevision(readFileSync(atlas))),
        }],
      }
    : config,
)
