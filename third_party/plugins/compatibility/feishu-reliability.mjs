/** Reviewed reply-delivery fixes applied only to the pinned private Feishu staging copy. */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

function replaceOnce(path, before, after) {
  const original = readFileSync(path, 'utf8')
  if (original.split(before).length !== 2) throw new Error(`Muse Feishu reliability patch needs review: ${path} near ${before.slice(0, 100)}`)
  writeFileSync(path, original.replace(before, after))
}

/**
 * Await in-flight final patches and return final delivery status for text fallback.
 * @param {string} directory Private PGZXB source staging directory.
 * @returns {void}
 */
export function applyFeishuReliability(directory) {
  const manager = join(directory, 'src/cards/streaming.ts')
  replaceOnce(manager, '  flushing: boolean;', '  flushing: Promise<void> | null;\n  delivered: boolean;')
  replaceOnce(manager, '      flushing: false,', '      flushing: null,\n      delivered: false,')
  replaceOnce(manager, "  async finalize(chatId: string, status: 'done' | 'error' | 'stopped'): Promise<void> {\n    const card = this.active.get(chatId);\n    if (card === undefined || card.closed) return;", "  async finalize(chatId: string, status: 'done' | 'error' | 'stopped'): Promise<boolean> {\n    const card = this.active.get(chatId);\n    if (card === undefined || card.closed) return false;")
  replaceOnce(manager, "    this.active.delete(chatId);\n  }\n\n  /** Discard", "    await this.flush(card);\n    this.active.delete(chatId);\n    return card.delivered;\n  }\n\n  /** Discard")
  replaceOnce(manager, '    if (card.flushing) return;\n    card.flushing = true;\n    try {', '    if (card.flushing) return card.flushing;\n    const operation = Promise.resolve().then(async () => {\n    try {')
  replaceOnce(manager, '          await this.transport.updateCard(card.messageId, buildCard(snapshot) as CardJson);', "          await this.transport.updateCard(card.messageId, buildCard(snapshot) as CardJson);\n          card.delivered = snapshot.status !== 'working';")
  replaceOnce(manager, '          this.logger.warn(`streaming card patch failed (continuing): ${String(error)}`);', '          card.delivered = false;\n          this.logger.warn(`streaming card patch failed (continuing): ${String(error)}`);')
  replaceOnce(manager, '      card.flushing = false;\n    }\n  }', '      card.flushing = null;\n    }\n    });\n    card.flushing = operation;\n    return operation;\n  }')
  const controller = join(directory, 'src/cards/StreamingCardController.ts')
  replaceOnce(controller, '\n        await this.host.cards.finalize(chatId, status);', '\n        const delivered = await this.host.cards.finalize(chatId, status);')
  replaceOnce(controller, "\n        if (finalText !== '') this.lastOutputs.set(chatId, finalText);", "\n        if (finalText !== '') this.lastOutputs.set(chatId, finalText);\n        if (!delivered && finalText !== '') {\n          await this.host.transport.sendText(chatId, finalText);\n        }")
  replaceOnce(controller, '            this.host.sessionMap.remint(chatId);', '')
  replaceOnce(controller, 'corrupt; rebinding a fresh session', 'corrupt; existing binding retained for explicit recovery')
  replaceOnce(controller, '          // A corrupt persisted log breaks every turn that resumes it; rebind\n          // the chat to a fresh session so the next message starts clean.',
    '          // Preserve the original identity when its persisted log needs repair.')
  const bridge = join(directory, 'src/bridge.ts')
  replaceOnce(bridge, '    this.options.sessionMap.set(chatId, sessionId);', '    this.options.sessionMap.set(chatId, sessionId);\n    this.options.sessionMap.persist();')
}
