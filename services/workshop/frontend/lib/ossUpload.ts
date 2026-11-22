/**
 * OSS 大文件直传客户端 (浏览器端)
 *
 * 功能:
 *  - single 模式 (< 50MB): 一次 PUT 整个文件到 OSS
 *  - multipart 模式 (>= 50MB): 分片并发上传 (默认 4 并发) + localStorage 续传
 *  - 暴露暂停/恢复/取消接口, 给 UI 显示进度 + 速率 + ETA
 *
 * 用法:
 *    const ctrl = uploadToOss({
 *        file,
 *        token,
 *        namespace: 'video',
 *        onProgress: ({ loaded, total, speed, etaSeconds }) => { ... },
 *        onLog: (msg) => { ... },
 *    });
 *    const result = await ctrl.promise;   // { upload_id, oss_key, size }
 *    ctrl.pause();   // 暂停
 *    ctrl.resume();
 *    ctrl.abort();
 */
import { authFetch } from "./auth";

const BASE = process.env.NEXT_PUBLIC_ORCHESTRATOR_URL || "";

export type UploadProgress = {
  loaded: number;
  total: number;
  speed: number;        // 字节/秒
  etaSeconds: number;   // 剩余秒数, -1 表示未知
  parts_done: number;   // multipart 模式: 已完成分片数
  parts_total: number;  // multipart 模式: 总分片数
};

export type UploadResult = {
  upload_id: string;
  oss_key: string;
  size: number;
  filename: string;
};

export type UploadController = {
  promise: Promise<UploadResult>;
  pause: () => void;
  resume: () => void;
  abort: () => Promise<void>;
};

type Options = {
  file: File;
  token: string;
  /** OSS 命名空间, 默认 'uploads'; 视频反推用 'video' */
  namespace?: string;
  /** 本会话业务元数据, 比如 {episode_index: 1} */
  extra?: Record<string, unknown>;
  /** kind=auto: < 50MB single, 否则 multipart (默认) */
  kind?: "single" | "multipart" | "auto";
  /** multipart 并发分片数, 默认 4 */
  concurrency?: number;
  /**
   * 续传指纹的额外作用域, 默认空 = 与历史行为完全一致。
   *
   * ⚠ 批量文件夹反推场景**必须**传: 那里每个剧的子文件夹里都有一个 `01.mp4`,
   * 只靠「文件名+大小」做指纹的话, 两个剧的 `01.mp4` 一旦大小恰好相同,
   * 续传状态就会串到另一个剧上 —— 传上去的是**别的剧的内容**, 而且毫无提示。
   * 传相对路径即可把它们区分开。
   */
  resumeScope?: string;
  onProgress?: (p: UploadProgress) => void;
  onLog?: (msg: string) => void;
};

const LS_PREFIX = "drama-oss-upload-";

function lsKey(filename: string, size: number, scope = "") {
  // 用 filename + size 做指纹, 同样的文件刷新页面后能找到上次进度。
  // scope 为空时键值与历史完全一致, 老的续传记录不会失效。
  const base = `${LS_PREFIX}${size}-${encodeURIComponent(filename)}`;
  return scope ? `${base}@${encodeURIComponent(scope)}` : base;
}

function loadResumeState(filename: string, size: number, scope = ""): {
  upload_id: string;
  parts: { number: number; etag: string; size?: number }[];
} | null {
  try {
    const raw = localStorage.getItem(lsKey(filename, size, scope));
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (typeof obj?.upload_id !== "string" || !Array.isArray(obj?.parts)) return null;
    return obj;
  } catch {
    return null;
  }
}

function saveResumeState(filename: string, size: number, scope: string, state: {
  upload_id: string;
  parts: { number: number; etag: string; size?: number }[];
}) {
  try {
    localStorage.setItem(lsKey(filename, size, scope), JSON.stringify(state));
  } catch { /* localStorage 满或被禁用就放弃, 不影响主流程 */ }
}

function clearResumeState(filename: string, size: number, scope = "") {
  try { localStorage.removeItem(lsKey(filename, size, scope)); } catch { /* ignore */ }
}

async function apiPost<T>(path: string, token: string, body: unknown): Promise<T> {
  const r = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`${path} -> HTTP ${r.status}: ${text.slice(0, 300)}`);
  }
  return r.json();
}

/** 用 XHR PUT 一片或整文件到 OSS, 支持取消和分片字节进度回调 */
function putToOss(
  url: string,
  body: Blob,
  contentType: string,
  signal: AbortSignal,
  onPartProgress?: (loaded: number) => void,
): Promise<{ etag: string }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url, true);
    xhr.setRequestHeader("Content-Type", contentType);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onPartProgress) onPartProgress(e.loaded);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        const etag = (xhr.getResponseHeader("ETag") || "").replace(/"/g, "");
        resolve({ etag });
      } else {
        reject(new Error(`OSS PUT 失败: HTTP ${xhr.status} ${xhr.responseText.slice(0, 200)}`));
      }
    };
    xhr.onerror = () => reject(new Error("OSS PUT 网络错误"));
    xhr.onabort = () => reject(new DOMException("aborted", "AbortError"));
    signal.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.send(body);
  });
}

/** 从 fetch GET 拉一个 PART 签名 URL */
async function signPart(
  uploadId: string,
  partNumber: number,
  token: string,
): Promise<string> {
  const r = await apiPost<{ url: string }>(
    `/v1/oss/${uploadId}/sign-part`,
    token,
    { part_number: partNumber },
  );
  return r.url;
}

/**
 * 主入口
 */
export function uploadToOss(opts: Options): UploadController {
  const { file, token, onProgress, onLog } = opts;
  const namespace = opts.namespace || "uploads";
  const concurrency = Math.max(1, Math.min(8, opts.concurrency || 4));
  const resumeScope = opts.resumeScope || "";
  const kind = opts.kind || "auto";
  const ac = new AbortController();
  let paused = false;
  let pauseResolve: (() => void) | null = null;

  const log = (msg: string) => {
    onLog?.(msg);
    // 可选: 也打到 console 方便排错
    if (process.env.NODE_ENV !== "production") {
      console.log(`[ossUpload] ${msg}`);
    }
  };

  const waitIfPaused = () => new Promise<void>((resolve) => {
    if (!paused) return resolve();
    pauseResolve = resolve;
  });

  const promise = (async (): Promise<UploadResult> => {
    if (!file.size) throw new Error("文件为空");

    const startTime = Date.now();

    // ============================================================
    // Step 1: 看本地是否有续传记录, 如果有, 先尝试恢复
    // ============================================================
    let upload_id: string | null = null;
    let oss_key: string = "";
    let actualKind: "single" | "multipart" = "single";
    let chunkSize = 8 * 1024 * 1024;
    let totalParts = 1;
    let resumedParts: { number: number; etag: string; size?: number }[] = [];

    const resume = loadResumeState(file.name, file.size, resumeScope);
    if (resume) {
      log(`检测到上次未完成的上传, 尝试续传 (已传 ${resume.parts.length} 片)`);
      try {
        const status = await fetch(`${BASE}/v1/oss/${resume.upload_id}`, {
          headers: { Authorization: `Bearer ${token}` },
        }).then(r => r.ok ? r.json() : null);
        if (status && status.status === "pending" && status.kind === "multipart") {
          upload_id = resume.upload_id;
          oss_key = status.oss_key;
          actualKind = "multipart";
          chunkSize = 8 * 1024 * 1024;  // 服务端固定
          totalParts = Math.ceil(file.size / chunkSize);
          resumedParts = resume.parts;
          log(`续传成功, 还需上传 ${totalParts - resumedParts.length} 片`);
        } else {
          log("上次会话已过期或不可续传, 重新发起");
          clearResumeState(file.name, file.size, resumeScope);
        }
      } catch (e) {
        log(`续传查询失败, 重新发起: ${e}`);
        clearResumeState(file.name, file.size, resumeScope);
      }
    }

    // ============================================================
    // Step 2: 没有续传 → 新建会话
    // ============================================================
    if (!upload_id) {
      const init = await apiPost<{
        upload_id: string;
        oss_key: string;
        kind: "single" | "multipart";
        put_url?: string;
        oss_upload_id?: string;
        chunk_size?: number;
        total_parts?: number;
      }>("/v1/oss/init", token, {
        filename: file.name,
        total_size: file.size,
        kind,
        content_type: file.type || "application/octet-stream",
        namespace,
        extra: opts.extra || {},
      });
      upload_id = init.upload_id;
      oss_key = init.oss_key;
      actualKind = init.kind;
      log(`已创建上传会话 [${actualKind}] upload_id=${upload_id.slice(0, 8)}…`);

      if (actualKind === "single") {
        // ----- 直接 PUT 整个文件 -----
        if (!init.put_url) throw new Error("init 未返回 put_url");
        await putToOss(
          init.put_url,
          file,
          file.type || "application/octet-stream",
          ac.signal,
          (loaded) => {
            const elapsed = (Date.now() - startTime) / 1000;
            const speed = elapsed > 0 ? loaded / elapsed : 0;
            const etaSeconds = speed > 0 ? Math.max(0, (file.size - loaded) / speed) : -1;
            onProgress?.({
              loaded, total: file.size, speed, etaSeconds,
              parts_done: 0, parts_total: 1,
            });
          },
        );
        log(`整文件上传完成 (${(file.size / 1024 / 1024).toFixed(1)} MB)`);
      } else {
        chunkSize = init.chunk_size || 8 * 1024 * 1024;
        totalParts = init.total_parts || Math.ceil(file.size / chunkSize);
      }
    }

    // ============================================================
    // Step 3: multipart 模式 - 并发上传剩余分片
    // ============================================================
    if (actualKind === "multipart") {
      const completedNumbers = new Set(resumedParts.map(p => p.number));
      const todo: number[] = [];
      for (let i = 1; i <= totalParts; i++) {
        if (!completedNumbers.has(i)) todo.push(i);
      }

      const allParts: { number: number; etag: string; size?: number }[] = [...resumedParts];
      const partProgress = new Map<number, number>();   // 当前进行中的分片字节数
      // 续传开始时已经传完的字节数, 用来算"本次会话"的速率
      const resumedBytesAtStart = resumedParts.reduce((s, p) => s + (p.size || 0), 0);
      // 节流: 同一帧内多次 tick 合并 (减少 React rerender 次数)
      let tickPending = false;
      let lastSpeedLoaded = resumedBytesAtStart;
      let lastSpeedTime = Date.now();
      let lastSpeed = 0;

      const tickProgress = () => {
        // 重要: 每次都基于最新的 allParts + partProgress 重新算, 不能用闭包常量
        const completedBytes = allParts.reduce((s, p) => s + (p.size || 0), 0);
        const inFlight = Array.from(partProgress.values()).reduce((s, n) => s + n, 0);
        const loaded = completedBytes + inFlight;

        // 速率: 滑动窗口式 (用最近 ~1s 的增量算, 避免被启动初的 0 拉低)
        const now = Date.now();
        const dt = (now - lastSpeedTime) / 1000;
        if (dt >= 0.5) {  // 每 0.5s 重新采样一次
          const dBytes = loaded - lastSpeedLoaded;
          if (dBytes >= 0 && dt > 0) {
            lastSpeed = dBytes / dt;
          }
          lastSpeedLoaded = loaded;
          lastSpeedTime = now;
        }
        const speed = lastSpeed;
        const etaSeconds = speed > 0 ? Math.max(0, (file.size - loaded) / speed) : -1;

        onProgress?.({
          loaded, total: file.size, speed, etaSeconds,
          parts_done: allParts.length, parts_total: totalParts,
        });
      };

      // rAF 节流 (浏览器主线程繁忙时合并多次 progress 事件)
      const requestTick = () => {
        if (tickPending) return;
        tickPending = true;
        const fn = () => { tickPending = false; tickProgress(); };
        if (typeof requestAnimationFrame !== "undefined") {
          requestAnimationFrame(fn);
        } else {
          setTimeout(fn, 50);
        }
      };
      tickProgress();

      // 并发池
      const queue = [...todo];
      const workers: Promise<void>[] = [];
      let firstError: Error | null = null;

      for (let w = 0; w < concurrency; w++) {
        workers.push((async () => {
          while (queue.length > 0 && !firstError) {
            await waitIfPaused();
            if (ac.signal.aborted) throw new DOMException("aborted", "AbortError");

            const partNumber = queue.shift();
            if (partNumber === undefined) break;

            const start = (partNumber - 1) * chunkSize;
            const end = Math.min(start + chunkSize, file.size);
            const blob = file.slice(start, end);
            const partSize = blob.size;
            partProgress.set(partNumber, 0);

            try {
              const url = await signPart(upload_id!, partNumber, token);
              const { etag } = await putToOss(
                url, blob, "application/octet-stream", ac.signal,
                (loaded) => {
                  partProgress.set(partNumber, loaded);
                  requestTick();
                },
              );
              partProgress.delete(partNumber);
              allParts.push({ number: partNumber, etag, size: partSize });
              // 每完成一片就保存续传点
              saveResumeState(file.name, file.size, resumeScope, {
                upload_id: upload_id!,
                parts: allParts,
              });
              tickProgress();
            } catch (e) {
              if ((e as Error).name === "AbortError") throw e;
              partProgress.delete(partNumber);
              if (!firstError) firstError = e as Error;
              throw e;
            }
          }
        })());
      }

      try {
        await Promise.all(workers);
      } catch (e) {
        if ((e as Error).name === "AbortError") throw e;
        // 如果某片重试失败, 抛出
        throw firstError || e;
      }

      log(`所有 ${totalParts} 片上传完成`);
    }

    // ============================================================
    // Step 4: complete
    // ============================================================
    const completeBody = actualKind === "single"
      ? {}
      : {
          parts: resumedParts.length > 0
            ? loadResumeState(file.name, file.size, resumeScope)?.parts.map(p => ({
                number: p.number, etag: p.etag, size: p.size,
              }))
            : (await fetch(`${BASE}/v1/oss/${upload_id}`, {
                headers: { Authorization: `Bearer ${token}` },
              }).then(r => r.json()))?.parts_completed,
        };

    // 重新从 localStorage 取最新 parts (在 complete 前一刻)
    if (actualKind === "multipart") {
      const fresh = loadResumeState(file.name, file.size, resumeScope);
      if (fresh?.parts) {
        (completeBody as any).parts = fresh.parts.map(p => ({
          number: p.number, etag: p.etag, size: p.size,
        }));
      }
    }

    log("正在拼接...");
    const final = await apiPost<{
      ok: boolean;
      upload_id: string;
      oss_key: string;
      size: number;
      filename: string;
    }>(`/v1/oss/${upload_id}/complete`, token, completeBody);

    clearResumeState(file.name, file.size, resumeScope);

    log(`✓ 上传完成 (${(final.size / 1024 / 1024).toFixed(1)} MB, ${((Date.now() - startTime) / 1000).toFixed(1)}s)`);
    onProgress?.({
      loaded: final.size, total: file.size,
      speed: file.size / Math.max(1, (Date.now() - startTime) / 1000),
      etaSeconds: 0, parts_done: totalParts, parts_total: totalParts,
    });

    return {
      upload_id: final.upload_id,
      oss_key: final.oss_key,
      size: final.size,
      filename: final.filename,
    };
  })();

  return {
    promise,
    pause: () => {
      if (!paused) {
        paused = true;
        log("已暂停");
      }
    },
    resume: () => {
      if (paused) {
        paused = false;
        log("已恢复");
        if (pauseResolve) {
          const fn = pauseResolve;
          pauseResolve = null;
          fn();
        }
      }
    },
    abort: async () => {
      ac.abort();
      paused = false;
      if (pauseResolve) { const fn = pauseResolve; pauseResolve = null; fn(); }
      log("已取消");
      // 通知服务端 abort, 释放分片
      // 这里我们不知道 upload_id (可能还没拿到), 上层可以自己根据 promise reject 处理
    },
  };
}

/**
 * 工具: 友好显示字节
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + " MB";
  return (bytes / 1024 / 1024 / 1024).toFixed(2) + " GB";
}

/**
 * 工具: 友好显示秒数
 */
export function formatDuration(seconds: number): string {
  if (seconds < 0 || !isFinite(seconds)) return "—";
  if (seconds < 1) return "<1秒";
  if (seconds < 60) return `${Math.ceil(seconds)}秒`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}分${Math.ceil(seconds % 60)}秒`;
  return `${Math.floor(seconds / 3600)}时${Math.floor((seconds % 3600) / 60)}分`;
}

/**
 * 工具: 速率显示
 */
export function formatSpeed(bytesPerSec: number): string {
  return formatBytes(bytesPerSec) + "/s";
}
