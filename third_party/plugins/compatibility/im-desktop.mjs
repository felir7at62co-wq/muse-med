/** Build the pinned IM implementation without changing retained upstream files. */
import { createHash } from 'node:crypto'
import { cpSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const imDesktopCompatibility = {
  upstreamCommit: 'ca949ee276cc8cfb5a60b4ebd8e2fb616959e136',
  channel: 'native dsh-im Host, management UI and streaming cards',
  credentials: 'one-time import through the Host credential service',
  sessions: 'existing group bindings and verified direct-message bindings',
  sessionServices: 'declared live Session and persistence dependencies for workspace verification',
  groupResponse: 'explicit bot mentions only',
  newGroups: 'saved native access settings authorize messages and card actions without legacy sender or chat gates',
  workspace: 'one selected workspace per Feishu bot with independent conversation histories',
  remoteProvider: 'retained at @wenbin_wb/dsh-bridge/remote',
  teamRouting: 'registered app and chat bind one Muse Bot named from available Feishu metadata; native Sessions and workspace fences remain authoritative',
  updates: 'supplied only by Muse application updates',
}

function edit(directory, path, expected, edits) {
  const file = join(directory, path)
  let text = readFileSync(file, 'utf8')
  if (createHash('sha256').update(text).digest('hex') !== expected) throw new Error(`community plugins: IM ${path} requires source review`)
  for (const [before, after] of edits) {
    if (text.split(before).length !== 2) throw new Error(`community plugins: IM overlay could not locate ${path}: ${before.slice(0, 70)}`)
    text = text.replace(before, after)
  }
  writeFileSync(file, text)
}

/** Add Muse admission callbacks and use the build's reviewed proxy library. */
export function applyImDesktopCompatibility(directory) {
  mkdirSync(join(directory, 'lib'), { recursive: true })
  edit(directory, 'plugin-src/host/channels/feishu/index.mjs', '2b200d739173b2790dbc999f187e8488d0251006bd8d6fe9592a9115cd740c20', [
    ["export const inject = ['connection', 'credentials', 'typertGateway'];", "export const inject = ['connection', 'credentials', 'typertGateway', 'sessions', 'sessionPersistence'];"],
  ])
  edit(directory, 'plugin-src/host/channels/feishu/production.mjs', 'a847f72a21ed1585c2c40fe2b790562e63157b545a34f5fdad90ec0e783a0d3d', [
    ["import HttpsProxyAgent from 'https-proxy-agent';", "import { HttpsProxyAgent } from 'https-proxy-agent';"],
    ['  createBotWorkspaceScope,\n', ''],
    ["import { prepareBotWorkspace }", "import { createMuseImWorkspaceScope } from '../../../../lib/muse-im-workspace.mjs';\nimport { prepareBotWorkspace }"],
    ['      const workspaceScope = createBotWorkspaceScope(harness, {\n        botId: id, workspaces, state, agentPresetCatalog,\n      });', `      const workspaceScope = await createMuseImWorkspaceScope(harness, {
        botId: id, workspaces, state, agentPresetCatalog,
        readSessionWorkspace: async sessionId => ctx.sessions.get(sessionId)?.header.cwd
          ?? (await ctx.sessionPersistence.stat(sessionId))?.header.cwd,
      });
      const teamScope = config.museTeam?.forBot(id, botConfig.appId, workspaceScope, workspaces) ?? workspaceScope;`],
    ['        harness: workspaceScope.harness,\n        state: workspaceScope.state,', '        harness: teamScope.harness,\n        state: teamScope.state,'],
    ['      return new Runtime({', '      const runtime = new Runtime({'],
    ['      });\n    },\n    deleteState:', '      });\n      teamScope.setRuntime?.(runtime);\n      return runtime;\n    },\n    deleteState:'],
    ['        accessPolicy: accessPolicyProvider(workspaces, id, {', '        museAdmission: teamScope.admission ?? config.museAdmission?.forBot(id, workspaces),\n        accessPolicy: accessPolicyProvider(workspaces, id, {'],
  ])
  edit(directory, 'plugin-src/client/channels/feishu/index.js', '4dfa9310756bd0ca6d0d570b1cbde24f18175a1c18997f077a47d2c526e492bc', [
    ['          onSave: onWorkspaceSave,\n        }),', '          onSave: onWorkspaceSave,\n        }),\n      h("p", { className: "dim-help" }, "同一机器人的私聊和群聊共用此工作区，聊天记录各自独立。"),'],
  ])
  edit(directory, 'plugin-src/client/i18n.js', '1b785ceca110674f02b3d0ccb56684216e6c2fc8b1a8b267d46db96a02243200', [
    ["  '当前工作区': 'Current workspace',", "  '当前工作区': 'Current workspace',\n  '同一机器人的私聊和群聊共用此工作区，聊天记录各自独立。': 'This bot’s direct and group chats share this workspace; each chat keeps its own history.',"],
  ])
  edit(directory, 'src/channels/shared/workspace-command.mjs', 'f0418bb8cfe3066decb8cbb34f9a36979b3ad385c08cf7cb7d1fc02c322a6994', [
    ['function sessionBindErrorMessage(error) {', `function sessionBindErrorMessage(error) {
  if (['muse-workspace-session-foreign', 'muse-workspace-session-in-use', 'muse-workspace-session-unavailable'].includes(error?.code)) {
    return safeDisplayText(error.message);
  }`],
    ["      lines.push(bound\n        ?", "      lines.push(harness.workspaceScope === 'bot'\n        ? harness.sharedWorkspaceMessage('status', current)\n        : bound\n        ?"],
    ["      return commandResult(t('已清除对话专属工作区，当前使用 bot 默认工作区：{workspace}（之后默认工作区的变化会同步到本对话）', { workspace: current }));", "      return commandResult(harness.workspaceScope === 'bot'\n        ? harness.sharedWorkspaceMessage('clear', current)\n        : t('已清除对话专属工作区，当前使用 bot 默认工作区：{workspace}（之后默认工作区的变化会同步到本对话）', { workspace: current }));"],
    ["    return commandResult(t('当前对话工作区已切换为：{workspace}', { workspace: current }));", "    return commandResult(harness.workspaceScope === 'bot'\n      ? harness.sharedWorkspaceMessage('switched', current)\n      : t('当前对话工作区已切换为：{workspace}', { workspace: current }));"],
  ])
  edit(directory, 'src/channels/feishu/feishu-runtime.mjs', 'b601d7730c7eef4d26681f3240366a489cb5d45236f1b1ce62726cfc69c2d92b', [
    ["import { createConnectionDiagnostics, atConnectionStage } from '../shared/connection-error.mjs';", "import { closeMuseImSocket } from '../../../lib/muse-im-socket.mjs';\nimport { createConnectionDiagnostics, atConnectionStage } from '../shared/connection-error.mjs';"],
    ['  #botOpenId;', '  #botOpenId;\n  #museAdmission;'],
    ['    botOpenId,', '    botOpenId,\n    museAdmission,'],
    ['    this.#botOpenId = nonEmptyString(botOpenId);', '    this.#botOpenId = nonEmptyString(botOpenId);\n    this.#museAdmission = museAdmission;'],
    ['        botOpenId: this.#botOpenId,', '        botOpenId: this.#botOpenId,\n        museAdmission: this.#museAdmission,'],
    ['          if (isCurrentStart()) void bridge.accept(event);', `          if (isCurrentStart()) void bridge.accept(event).catch(error => {
            this.#logger.error?.('Muse IM incoming message was not dispatched', error);
          });`],
    ['    wsClient?.close({ force: true });\n    const bridge = this.#bridge;\n    this.#bridge = null;\n    if (bridge) await bridge.waitForIdle();', `    const bridge = this.#bridge;
    this.#bridge = null;
    const outcomes = await Promise.allSettled([
      Promise.resolve().then(() => closeMuseImSocket(wsClient)),
      Promise.resolve().then(() => bridge?.waitForIdle()),
      this.#slashSyncQueue,
    ]);`],
    ['    if (!preserveError) this.#diagnostics.clear();\n    return this.status;', `    if (!preserveError) this.#diagnostics.clear();
    const failures = outcomes.filter(result => result.status === 'rejected').map(result => result.reason);
    if (failures.length) throw new AggregateError(failures, 'Muse IM shutdown failed after draining admitted work');
    return this.status;`],
  ])
  edit(directory, 'src/channels/feishu/bridge.mjs', '2bf5173d6b6e9a92659b05c8443f2fedb392ea43e6ac869545121c2214f65e1c', [
    ['  #resolveKey(event) {', '  #resolveKey(event) {\n    const canonical = this.#museAdmission?.conversationKey?.(event);\n    if (canonical !== undefined) return canonical;'],
    ['  #rememberTopicReply(messageId, key) {', '  #rememberTopicReply(messageId, key, threaded = false) {'],
    ['    this.#anchorTopicReply.set(messageId, isTopicKey(key));', `    const inThread = threaded || isTopicKey(key) || this.#anchorTopicReply.get(messageId) === true
      || this.#museAdmission?.replyInThreadFor?.(messageId) === true;
    this.#anchorTopicReply.set(messageId, inThread);`],
    ['    this.#rememberTopicReply(messageId, key);\n\n    const commandMessage', `    this.#rememberTopicReply(messageId, key, Boolean(nonEmptyString(event?.message?.thread_id))
      || (this.#mentionTopicReply && this.#isMentioned(event) && !isBareMentionMessage(event)));

    const commandMessage`],
    ['  #rememberCardRoute(messageId, chatId, options) {', `  #rememberCardRoute(messageId, chatId, options) {
    if (messageId && this.#replyInThreadFor(options.replyTo)) {
      this.#anchorTopicReply.set(messageId, true);
      try { this.#museAdmission?.rememberReply?.(messageId, true); }
      catch (error) { this.#logger.warn?.('[muse-im] sent card thread receipt could not be saved:', error?.message); }
    }`],
    ['  #botOpenId;', '  #botOpenId;\n  #museAdmission;'],
    ['    botOpenId,', '    botOpenId,\n    museAdmission,'],
    ['    this.#botOpenId = nonEmptyString(botOpenId);', '    this.#botOpenId = nonEmptyString(botOpenId);\n    this.#museAdmission = museAdmission;'],
    ['  #acceptedMessageIds = new Map();', '  #acceptedMessageIds = new Map();\n  /** Message admission and dispatch promises that shutdown must drain. */\n  #acceptTasks = new Set();'],
    ['  accept(event) {', `  accept(event) {
    const task = Promise.resolve().then(() => this.#acceptWithHistory(event));
    this.#acceptTasks.add(task);
    void task.then(
      () => { this.#acceptTasks.delete(task); },
      () => { this.#acceptTasks.delete(task); },
    );
    return task;
  }

  async #acceptWithHistory(event) {`],
    ['  #accept(event) {', '  async #accept(event) {'],
    ['    // Register a managed-topic root only after access is allowed, so a', `    try {
      if (this.#museAdmission && !await this.#museAdmission.message(event, this.#state, {
        replyInThread: this.#anchorTopicReply.get(messageId) === true,
        client: this.#client, signal: this.#signal,
      })) return;
      if (this.#signal?.aborted) return;
    } catch (error) {
      await this.#sendFailure(event.message.chat_id, error, { logLabel: 'Muse Bot routing', replyTo: messageId });
      return;
    }
    // Register a managed-topic root only after access is allowed, so a`],
    ['      const tasks = [\n        ...this.#queues.values(),', '      const tasks = [\n        ...this.#acceptTasks,\n        ...this.#queues.values(),'],
    ['      if (this.#queues.size === 0\n', '      if (this.#acceptTasks.size === 0\n        && this.#queues.size === 0\n'],
    ["      || resolvedAction.startsWith('answer:');", "      || resolvedAction.startsWith('answer:')\n      || resolvedAction.startsWith('answerCustom:');"],
    ["        } else {\n          // issue #162：pending 已清除时区分", "        } else if (pending && pending.actor !== actor) {\n          await reply(t('请由当前任务发起人回答这个问题。')).catch(() => undefined);\n        } else {\n          // issue #162：pending 已清除时区分"],
    ["        } else if (!pending && this.#isAnsweredInteraction(interactionId)) {", "        } else if (pending && pending.actor !== actor) {\n          await reply(t('请由当前任务发起人回答这个问题。')).catch(() => undefined);\n        } else if (!pending && this.#isAnsweredInteraction(interactionId)) {"],
  ])
  edit(directory, 'src/channels/shared/i18n-en/feishu.mjs', '834d21b7aa856ec656ada206b488ac55ee062828160fa8ce233ec28a7914c58f', [
    ['export default {', "export default {\n  '请由当前任务发起人回答这个问题。': 'Only the person who started this task can answer this question.',"],
  ])
  edit(directory, 'plugin-src/host/channels/shared/access-policy-production.mjs', '73177cf116e079045659a285ab3a9800188197734ec2c6af9b07f006dcdb4ba0', [
    ["  if (key === 'feishu' || key === 'qq') {", "  if (key === 'feishu') return initialAccessPolicyFor(channel, config);\n  if (key === 'qq') {"],
  ])
  edit(directory, 'plugin-src/host/index.mjs', 'd0ae0ef86e4db327391f057226178564338ef2f7e2c20f0ddd687a399ad86170', [
    ["import { installOutboundArtifactTool } from '../../src/channels/shared/semantic/artifact.mjs';", "import { createOutboundArtifactTool, outboundArtifactRegistry } from '../../src/channels/shared/semantic/artifact.mjs';\nimport { installMuseImFiles } from '../../lib/muse-im-files.mjs';"],
    ['        installOutboundArtifactTool(artifactCtx);', '        installMuseImFiles(artifactCtx, { registry: outboundArtifactRegistry, createTool: createOutboundArtifactTool, maxFileBytes: config.feishu.maxFileBytes });'],
    ['      installOutboundArtifactTool(ctx);', '      installMuseImFiles(ctx, { registry: outboundArtifactRegistry, createTool: createOutboundArtifactTool, maxFileBytes: config.feishu.maxFileBytes });'],
  ])
  for (const file of ['muse-im-channel.mjs', 'muse-im-admission.mjs', 'muse-im-migration.mjs', 'muse-feishu-reliability.mjs', 'muse-im-socket.mjs', 'muse-im-files.mjs', 'muse-im-workspace.mjs', 'muse-im-team.mjs']) {
    cpSync(join(import.meta.dirname, file), join(directory, 'lib', file === 'muse-im-channel.mjs' ? 'index.js' : file))
  }
  const manifestPath = join(directory, 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  delete manifest.bin
  delete manifest.optionalDependencies
  manifest.dependencies['@deepseek-ai/schemastery'] = '3.18.5-alpha.1'
  manifest.dependencies['@deepseek-ai/dsh-home-paths'] = '0.2.1-alpha.1'
  manifest.dependencies['@larksuiteoapi/node-sdk'] = '1.73.0'
  manifest.dependencies.semver = '7.8.5'
  // These dynamic imports remain external in the retained Host builder.
  manifest.dependencies['@whiskeysockets/baileys'] = '7.0.0-rc14'
  manifest.files = [...new Set([...manifest.files.filter(path => path !== 'bin'), 'SOURCE.json'])]
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  writeFileSync(join(directory, 'cordis.patch.yml'), '[]\n')
}

/** Keep the native Host behind the legacy row and the native Client at its public entry. */
export function finishImDesktopCompatibility(directory) {
  renameSync(join(directory, 'lib/index.js'), join(directory, 'lib/upstream.js'))
  cpSync(join(import.meta.dirname, 'muse-im-channel.mjs'), join(directory, 'lib/index.js'))
}
