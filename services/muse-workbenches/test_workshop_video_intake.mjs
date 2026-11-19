import assert from 'node:assert/strict'
import { test } from 'node:test'
import { submitWorkshopVideo } from './workshop_video_intake.ts'

test('the cloud upload choice selects one intake and preserves episode order', async t => {
  const files = [new File(['first'], '01.mp4'), new File(['second'], '02.mp4')]
  let transport = 'server', direct = 0, viaStudio = 0
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url.endsWith('/intake-options')) {
      assert.equal(options.headers.Authorization, 'Bearer test')
      return Response.json({ upload: transport })
    }
    assert.equal(url, '/jubengongfang/v1/video/upload')
    assert.equal(options.body.get('concurrency'), '2')
    assert.deepEqual(options.body.getAll('files').map(file => file.name), ['01.mp4', '02.mp4'])
    viaStudio++
    return Response.json({ draft_id: 17 })
  })
  const post = () => submitWorkshopVideo('/jubengongfang', 'test', files, '示例', 2, new AbortController().signal,
    async () => { direct++; return Response.json({ draft_id: 19 }) })
  assert.deepEqual(await (await post()).json(), { draft_id: 17 })
  transport = 'tos'
  assert.deepEqual(await (await post()).json(), { draft_id: 19 })
  transport = 'invalid'
  await assert.rejects(post, /未知/)
  assert.equal(viaStudio, 1)
  assert.equal(direct, 1)
})
