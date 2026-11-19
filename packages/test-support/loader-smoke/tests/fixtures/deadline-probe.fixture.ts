/** Record effective deadlines without launching an application or waiting for a timeout. */
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { it } from 'vitest'
import { loaderSmokeProcessTimeout } from '../../src/deadline.ts'

it('records its project deadline', async ({ task }) => {
  const directory = process.env.LOADER_SMOKE_DEADLINE_RECEIPTS
  const project = task.file.projectName
  if (directory === undefined || project === undefined) throw new Error('Deadline probe requires an owned receipt directory and a named project')
  await writeFile(join(directory, `${project}.json`), JSON.stringify({
    testTimeoutMs: task.timeout,
    processTimeoutMs: project === 'headless' ? loaderSmokeProcessTimeout(task.timeout) : null,
  }))
})
