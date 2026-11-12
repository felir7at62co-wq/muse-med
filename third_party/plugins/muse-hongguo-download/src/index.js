/** Cordis tools retain session permissions, recovery and source-free download receipts. */
import { HongguoDownloadClient } from './client.js';
import { resolveConfig } from './config.js';
import { HongguoTasks } from './tasks.js';
export const name = 'muse-hongguo-download';
export const inject = ['tools', 'agents', 'subprocess'];
export { HongguoDownloadClient, resolveConfig } from './client.js';

/** Register the pinned open-source engine in the initiating session's scope. */
export function apply(ctx, config = {}) {
  const client = new HongguoDownloadClient(resolveConfig(config), { subprocess: ctx.subprocess });
  const tasks = new HongguoTasks(config, { client, jobs: ctx.get('jobs'), agents: ctx.agents,
    resolvePolicy: agent => ctx.get('sandboxPolicy')?.resolve({ session: agent.session }) });
  ctx.effect(() => async () => { await tasks.dispose(); await client.dispose(); }, 'hongguo-download: abort and await cleanup');
  for (const method of ['info', 'download']) {
    const title = method === 'info' ? '检查红果剧集目录' : '下载红果短剧';
    ctx.effect(() => ctx.tools.register({
      name: method === 'info' ? 'hongguo_download_info' : 'hongguo_download',
      description: method === 'info'
        ? '通过 jackotom/hongguo-drama 开源引擎读取红果系列的真实分集目录。不返回签名地址或密钥；目录完整不表示视频已下载。'
        : '使用 jackotom/hongguo-drama 引擎下载红果短剧。quality 可选1080p、720p、auto；省略采用插件默认画质（通常1080p），固定画质不可用时停止，不自动降级；auto沿来源兼容优先规则选源。回执分别记录requestedQuality和实际尺寸、画质；更高分辨率保留原样，不放大冒充高清。seriesIds 为十进制字符串；省略 episodes 下载全集，指定则仅下这些集。下载经过容器、尺寸、完整解码和SHA256校验。已验证文件及进度保留，重复同一请求及画质可续下。只读权限拒绝写入，工作区权限仅写工作区，完全权限可写显式外部绝对目录。遇到来源拒绝停止，不盲目重试；ByteVC2 通过内置组件转换为 H.264/AAC 后完整校验；缺少解码组件时停止。不返回媒体直链、签名、设备信息或解密密钥。部分完成不可称为全集。',
      parameters: { type: 'object', additionalProperties: false, required: ['seriesIds'], properties: {
        seriesIds: { type: 'array', items: { type: 'string', pattern: '^[0-9]+$' }, minItems: 1, maxItems: client.config.maxSeries },
        ...(method === 'download' ? { episodes: { type: 'array', items: { type: 'integer', minimum: 1 }, uniqueItems: true, minItems: 1 },
          quality: { type: 'string', enum: ['1080p', '720p', 'auto'], description: '本次下载画质；省略采用插件默认值。固定画质不自动降级，auto兼容优先' },
          mode: { type: 'string', enum: ['wait', 'background'], description: 'wait等待验证完成（默认）；background返回持久taskId，通过hongguo_download_task管理' },
          outputDir: { type: 'string', description: '默认当前会话 downloads；完全权限可指定外部绝对路径' } } : {}),
      } },
      output: { schema: { type: 'object', additionalProperties: true, required: ['ok'], properties: { ok: { type: 'boolean' } } },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
      timeoutMs: client.config.callTimeoutMs,
      async execute(args, exec) {
        if (method === 'info') return client.info(args, exec.signal);
        const agent = ctx.agents.requireInitiator();
        return tasks.download(args, { kind: 'session', agent }, exec);
      },
      presentCall() { return { card: 'generic', title, kind: method === 'info' ? 'read' : 'write' }; },
      presentResult(_args, result) { return { card: 'generic', title, content: result.content }; },
    }), `hongguo-download: ${method}`);
  }
  ctx.effect(() => ctx.tools.register({
    name: 'hongguo_download_task',
    description: '管理当前会话和工作区中的红果下载任务。list/status查询；pause暂停，resume继续，cancel取消，retry按原清晰度重试；remove仅移除已结束的任务记录，保留视频和原下载进度。暂停/取消须带status返回的expectedRunId，只有控制确认acknowledged才表示已停止。重启不自动下载；清理未知的任务保持blocked，不得强行恢复。taskId不同于Jobs的jobId。',
    parameters: { type: 'object', additionalProperties: false, required: ['action'], properties: {
      action: { type: 'string', enum: ['list', 'status', 'pause', 'resume', 'cancel', 'retry', 'remove'] },
      taskId: { type: 'string', pattern: '^hgt-[a-f0-9]{32}$' },
      expectedRunId: { type: 'string', pattern: '^hgr-[a-f0-9]{32}$' },
      requestId: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,160}$' },
      mode: { type: 'string', enum: ['wait', 'background'] },
    } },
    output: { schema: { type: 'object', additionalProperties: true, required: ['ok'], properties: { ok: { type: 'boolean' } } },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
    timeoutMs: client.config.callTimeoutMs,
    execute: (args, exec) => tasks.control(args, { kind: 'session', agent: ctx.agents.requireInitiator() }, exec.signal, exec),
    presentCall(args) { return { card: 'generic', title: '管理红果下载任务', kind: ['list', 'status'].includes(args.action) ? 'read' : 'write' }; },
    presentResult(_args, result) { return { card: 'generic', title: '管理红果下载任务', content: result.content }; },
  }), 'hongguo-download: task controls');
}
