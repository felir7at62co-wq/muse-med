/** Safe diagnostics never contain source URLs, device/session fields or signer output. */
export class DownloadError extends Error {
  constructor(code, message) { super(message); this.name = 'DownloadError'; this.code = code; }
}

/** Normalize unexpected filesystem/network errors before returning model-visible diagnostics. */
export function safeError(error) {
  if (error instanceof DownloadError) return { code: error.code, message: error.message };
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError') return { code: 'cancelled', message: '下载已取消或超过时限；未完成文件已清理' };
  return { code: 'operation_failed', message: '红果下载操作失败；请检查本地源配置、输出目录权限和网络' };
}
