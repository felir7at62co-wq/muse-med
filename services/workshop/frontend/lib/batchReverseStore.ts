/**
 * 批量文件夹反推 — 批次进度持久化 (localStorage)
 *
 * ⚠ 这里有一条无法绕开的浏览器限制: **`File` 对象存不进 localStorage**。
 * 所以「刷新后自动接着传」是做不到的 —— 我们能保住的是**已经花掉的代价**:
 * 哪些文件已经传上 OSS 了(upload_id)、哪些剧已经建成草稿了(draft_id)。
 * 用户刷新后重新选一次同一个根文件夹, 我们按 (relPath, size) 把这些认回去,
 * 已完成的部分就不用重来。
 *
 * 存的是「结果」不是「进度」: 传到一半的分片续传由 ossUpload 自己的
 * resumeScope 机制负责, 与本文件无关。
 */

const LS_KEY = "drama-batch-reverse-v1";

export type DramaStatus =
  | "pending"      // 还没开始
  | "uploading"    // 正在传这个剧的文件
  | "uploaded"     // 文件全传完, 等着提交
  | "submitting"   // 正在调 /video/from-oss
  | "submitted"    // 草稿已建成, 反推在后台跑
  | "failed"       // 上传或提交失败, 可重试
  | "skipped";     // 用户主动跳过

export type StoredFile = {
  relPath: string;
  size: number;
  epNo: number;
  uploadId?: string;
};

export type StoredDrama = {
  title: string;
  status: DramaStatus;
  draftId?: number;
  error?: string;
  files: StoredFile[];
};

export type StoredBatch = {
  batchId: string;
  createdAt: number;
  /** 用户当初选的根文件夹名, 用来提示「重新选这个文件夹」 */
  rootName: string;
  dramas: StoredDrama[];
};

export function loadBatch(): StoredBatch | null {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (typeof obj?.batchId !== "string" || !Array.isArray(obj?.dramas)) return null;
    return obj as StoredBatch;
  } catch {
    return null;
  }
}

export function saveBatch(batch: StoredBatch) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(batch));
  } catch {
    // localStorage 满或被禁用。批次照跑, 只是刷新后接不上 —— 不该因此中断上传。
  }
}

export function clearBatch() {
  try { localStorage.removeItem(LS_KEY); } catch { /* ignore */ }
}

/** 批次里还有没有没跑完的剧 */
export function hasUnfinished(batch: StoredBatch | null): boolean {
  if (!batch) return false;
  return batch.dramas.some(
    (d) => d.status !== "submitted" && d.status !== "skipped",
  );
}

/**
 * 把存下来的批次和「用户这次重新选的文件夹」对上号。
 *
 * 匹配键是 `relPath + size` —— 只有路径和大小都一样才认, 避免用户选了个
 * 名字碰巧相同的别的文件夹, 结果把 upload_id 错配到不相干的视频上。
 *
 * 返回 relPath|size → { uploadId, dramaStatus, draftId } 的查表结果。
 */
export function buildRecoveryIndex(batch: StoredBatch | null): {
  fileUploadIds: Map<string, string>;
  dramaByTitle: Map<string, StoredDrama>;
} {
  const fileUploadIds = new Map<string, string>();
  const dramaByTitle = new Map<string, StoredDrama>();
  if (!batch) return { fileUploadIds, dramaByTitle };

  for (const d of batch.dramas) {
    dramaByTitle.set(d.title, d);
    for (const f of d.files) {
      if (f.uploadId) fileUploadIds.set(recoveryKey(f.relPath, f.size), f.uploadId);
    }
  }
  return { fileUploadIds, dramaByTitle };
}

export function recoveryKey(relPath: string, size: number): string {
  return `${relPath}|${size}`;
}
