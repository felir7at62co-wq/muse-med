/** Child exits without disposal after a native result, retaining an actual v1 downloading key. */
import { taskFixture } from './task-harness.mjs'

const [directory, ownerId] = process.argv.slice(2)
const fixture = await taskFixture(undefined, { directory, ownerId, keepDirectory: true,
  afterAcquisition: async ({ params }) => {
    if (params.episodeNo !== 2) return
    process.send({ phase: 'native-result-before-local-copy', key: params.idempotencyKey })
    await new Promise(() => {})
  },
})
process.once('message', message => { if (message === 'crash') process.exit(0) })
const accepted = await fixture.download()
process.send({ phase: 'accepted', accepted })
await new Promise(() => {})
