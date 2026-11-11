/** Offline page result for the real Desktop Douyin tool. */
import assert from 'node:assert/strict'
import { Service } from '@deepseek-ai/cordis'

export const name = 'snapshot-douyin-local-discovery'

class OfflineDouyinBrowser extends Service {
  version = 4
  supportsDataAggregation = true
  constructor(ctx) { super(ctx, 'douyinBrowser') }
  async data(_agent, selection) {
    assert.equal(selection.url, 'https://www.douyin.com/video/7660900818614324490')
    return { status: 'blocked', code: 'PUBLIC_DATA_UNAVAILABLE' }
  }
}

/** Mount the offline browser and check the real preset instructions.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Snapshot composition.
 */
export async function apply(ctx) {
  await ctx.plugin(OfflineDouyinBrowser).await()
  ctx.on('llm/stream', async function* (options, next) {
    const system = options.messages.filter(message => message.role === 'system')
      .flatMap(message => message.content.filter(block => block.type === 'text').map(block => block.text)).join('\n')
    assert.ok(system.includes('先用 tool_search 按名称查找本地 douyin_data'), 'local discovery instruction reaches the model')
    yield* next()
  })
}
