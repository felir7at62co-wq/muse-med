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
  sourceMode: { type: 'string' }, code: { type: 'string' }, message: { type: 'string' }, upstreamCode: { type: 'integer' },
  sourceStage: { type: 'string', enum: ['catalog', 'video_model', 'source_api'] }, retryable: { type: 'boolean' },
  httpStatus: { type: 'integer' }, responseBytes: { type: 'integer' },
  items: { type: 'array', items: { type: 'object', additionalProperties: true } } }, required: ['ok'] };

/** Register source inspection and atomic multi-series download; unload waits for owned cleanup. */
export function apply(ctx, config = {}) {
  const settings = resolveConfig(config);
  const client = new HongguoDownloadClient(settings, { subprocess: ctx.subprocess });
  ctx.effect(() => () => client.dispose(), 'hongguo-download: abort and await cleanup');
  const definitions = [
    { name: 'hongguo_download_info', title: '检查红果全剧下载来源', method: 'info', kind: 'read', properties: common,
      description: '先检查一部或多部红果的声明总集数与连续集号。此工具只查询目录，不查询媒体地址；completeCatalog不代表可下载，mediaUrlsVerified为false，fullSeriesAvailable为null表示尚未验证，不得据此宣称全集可用。默认使用 Hongguo source 的原接口；全集范围按原源真实总集数确定，不另设集数上限。Muse 安装包内置本地运行环境，首次使用初始化本机设备并自动启动原签名器；独立配置缺少原源或运行时明确失败。不返回Cookie、设备值、签名或媒体直链。公开播放器仅开放的试看集不能充作全剧。' },
    { name: 'hongguo_download', title: '下载红果全剧或多部剧', method: 'download', kind: 'write', properties: { ...common,
      episodes: { type: 'array', items: { type: 'integer' }, description: '省略下载完整全集；若提供，对每部剧只下载这些集号，complete可能false。不能将试看当全剧' },
      outputDir: { type: 'string', description: '默认当前会话工作区的downloads目录；相对路径位于工作区内。完全权限下可直接指定工作区外绝对目录，文件和收据都写入该目录，无需先下载再搬运。只读或工作区权限不放宽；拒绝子目录链接' } },
      description: '按 seriesIds 下载一部或多部完整剧集，默认用户提供源码的原红果接口。按新版原源接口逐集请求媒体模型，每5集组织下载并累积全部结果。逐集取流按配置间隔等待，媒体下载仍并发。已成功解析媒体后遇到偶发空正文，同一查询可保留原设备配置等待接口恢复后最多重试一次，默认等待120秒；这不是电脑降温，也不能据此断定提供方限流；可取消，等待期间不要重复提交相同任务。检查声明总集数、连续集号、每集媒体长度；加密集使用本机原版离线解密模块，所有视频经MP4、ffprobe、完整ffmpeg解码及SHA256检查，全批完成才返回成功与真实文件路径。失败或取消清理新建文件。省略episodes按原源真实总集数下载全集，不另设集数上限。默认写当前会话工作区downloads；完全权限下按用户指定的绝对outputDir直接落盘，收据记录最终路径。public只能显式选择；官网未开放的集明确拒绝。Muse 安装包内置原源、Java、Python 和视频运行时，首次使用自动启动本机原签名器；独立配置缺少所需运行时明确失败。失败结果包含sourceStage与upstreamCode时按实际阶段和错误码诊断；retryable为false时不要立即重复相同请求。empty_source_response表示HTTP成功但正文为空，不能据此判断全平台停服或自动重建设备。不能仅凭目录成功或文件齐全断言本地无问题、提供方临时故障。' },
  ];
  for (const definition of definitions) {
    ctx.effect(() => ctx.tools.register({
      name: definition.name, description: definition.description,
      parameters: { type: 'object', additionalProperties: false, properties: definition.properties, required: ['seriesIds'] },
      output: { schema, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
      timeoutMs: client.config.callTimeoutMs,
      async execute(args, exec) {
        if (definition.method === 'info') return client.info(args, exec.signal);
        const { session } = ctx.agents.requireInitiator();
        const policy = ctx.get('sandboxPolicy')?.resolve({ session });
        return client.download(args, exec.signal, session.header.cwd, policy);
      },
      presentCall() { return { card: 'generic', title: definition.title, kind: definition.kind }; },
      presentResult(_args, result) { return { card: 'generic', title: definition.title, content: result.content }; },
    }), `hongguo-download: ${definition.name}`);
  }
}
