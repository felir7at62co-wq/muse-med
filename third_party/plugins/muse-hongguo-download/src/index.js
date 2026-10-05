/** Cordis tools use the initiating Muse session's workspace and persist source-free result metadata. */
import { HongguoDownloadClient } from './client.js';
import { resolveConfig } from './config.js';

export const name = 'muse-hongguo-download';
export const inject = ['tools', 'agents', 'subprocess'];
export { HongguoDownloadClient, resolveConfig } from './client.js';

const common = {
  seriesIds: { type: 'array', items: { type: 'string' }, description: '一部或多部系列 ID；红果 ID 保持十进制字符串，默认最多10部' },
  sourceMode: { type: 'string', enum: ['legacy', 'manifest', 'public'], description: '默认legacy使用用户提供源码的原接口。manifest仅用于已配置的授权直链目录。public必须明确指定，仅使用官网开放集，试看不是全剧' },
};
const schema = { type: 'object', additionalProperties: true, properties: { ok: { type: 'boolean' }, complete: { type: 'boolean' },
  sourceMode: { type: 'string' }, code: { type: 'string' }, message: { type: 'string' }, items: { type: 'array', items: { type: 'object', additionalProperties: true } } }, required: ['ok'] };

/** Register source inspection and atomic multi-series download; unload waits for owned cleanup. */
export function apply(ctx, config = {}) {
  const settings = resolveConfig(config);
  const client = new HongguoDownloadClient(settings, { subprocess: ctx.subprocess });
  ctx.effect(() => () => client.dispose(), 'hongguo-download: abort and await cleanup');
  const definitions = [
    { name: 'hongguo_download_info', title: '检查红果全剧下载来源', method: 'info', kind: 'read', properties: common,
      description: '先检查一部或多部红果的声明总集数与连续集号。默认使用用户提供 Hongguo source 的原接口及本机原源/签名器配置；缺原config.json、devices.json或签名器明确失败。配置成功不等于下载验收；不返回Cookie、设备值、签名或媒体直链。公开播放器仅开放的试看集不能充作全剧。' },
    { name: 'hongguo_download', title: '下载红果全剧或多部剧', method: 'download', kind: 'write', properties: { ...common,
      episodes: { type: 'array', items: { type: 'integer' }, description: '省略下载完整全集；若提供，对每部剧只下载这些集号，complete可能false。不能将试看当全剧' },
      outputDir: { type: 'string', description: '默认当前会话工作区的downloads目录；可指定工作区内相对目录或绝对路径，拒绝越界或符号链接' } },
      description: '按 seriesIds 下载一部或多部完整剧集，默认用户提供源码的原红果接口。累积每5集源请求，检查声明总集数、连续集号、每集媒体长度；加密集使用本机原版离线解密模块，所有视频经MP4、ffprobe、完整ffmpeg解码及SHA256检查，全批完成才返回成功与真实文件路径。失败或取消清理新建文件。省略episodes下载全集。默认写当前会话工作区downloads。public只能显式选择；官网未开放的集明确拒绝。缺少原源、签名器或视频运行时明确失败。' },
  ];
  for (const definition of definitions) {
    ctx.effect(() => ctx.tools.register({
      name: definition.name, description: definition.description,
      parameters: { type: 'object', additionalProperties: false, properties: definition.properties, required: ['seriesIds'] },
      output: { schema, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
      timeoutMs: client.config.callTimeoutMs,
      async execute(args, exec) {
        if (definition.method === 'info') return client.info(args, exec.signal);
        const workspace = ctx.agents.requireInitiator().session.header.cwd;
        return client.download(args, exec.signal, workspace);
      },
      presentCall() { return { card: 'generic', title: definition.title, kind: definition.kind }; },
      presentResult(_args, result) { return { card: 'generic', title: definition.title, content: result.content }; },
    }), `hongguo-download: ${definition.name}`);
  }
}
