/** Resolve the authenticated bot and match structured Feishu mentions. */

/**
 * Fetch the bot identity through the maintained SDK's authenticated request API.
 * @param {object} client Configured Feishu SDK client.
 * @returns {Promise<object>} Successful bot response with a nonempty open ID.
 */
export async function requestFeishuBotInfo(client) {
  const response = await client.request({ url: '/open-apis/bot/v3/info', method: 'GET' })
  if (response?.code !== 0 || typeof response.bot?.open_id !== 'string' || !response.bot.open_id.trim()) {
    throw new Error('Feishu bot identity lookup did not return a valid bot open ID')
  }
  return response
}

/**
 * Require a structured mention of the authenticated bot; unknown identities never match.
 * @param {object} event Parsed gateway message retaining the original Feishu event.
 * @param {string | undefined} openId Authenticated bot open ID.
 * @returns {boolean} Whether the raw message mentions this bot.
 */
export function isFeishuBotMentioned(event, openId) {
  if (typeof openId !== 'string' || !openId.trim()) return false
  const mentions = event.raw?.message?.mentions
  return Array.isArray(mentions) && mentions.some(mention => mention?.id?.open_id === openId)
}
