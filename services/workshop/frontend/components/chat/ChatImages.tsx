'use client';
/**
 * 对话里发图片 —— 对话工坊与 v2 工作台对话栏**共用**的一套（2026-10-28）。
 *
 * 需求原话："用户希望对话工坊中能给AI发送图片。最好支持粘贴/拖动到浏览器页面中上传"
 *
 * ## 为什么抽成共享模块
 * 对话工坊（/chat-studio）与 v2 工作台的对话栏（ChatColumn）是两个页面，
 * 但"粘贴怎么取图、拖进来的是不是图、图怎么显示"必须一致 —— 分开写，
 * 迟早出现"工坊能粘、工作台不能粘"这种用户无法理解的差异。
 *
 * ## 为什么先传后发
 * 图片在**粘贴/拖入的那一刻**就开始上传（拿回 id），点发送时只带 id。
 * 把几 MB 的图塞进发消息的请求体，会让流式回复迟迟不开始，用户看到的是
 * "点了发送没反应"。先传可以和打字并行完成。
 *
 * ## 为什么不能直接 <img src="/jubengongfang/v1/agent/images/1">
 * 那个接口要 Bearer 鉴权（截图里常有隐私，不能做成公开静态文件），
 * 而 <img> 标签不会带 Authorization 头。所以用 authFetch 取成 blob，
 * 再给 <img> 一个 objectURL。见 AuthImage。
 */
import * as React from 'react';
import { Loader2, X, ImageOff } from 'lucide-react';
import { authFetch, getToken } from '@/lib/auth';

const BASE = process.env.NEXT_PUBLIC_ORCHESTRATOR_URL || '';

/** 单张原图上限，与后端 MAX_IMAGE_BYTES 一致 */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
/** 一条消息最多带几张图，与后端 SendMessageIn.image_ids max_length 一致 */
export const MAX_IMAGES_PER_MESSAGE = 10;

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif', 'image/bmp']);

/** 待发送的一张图（输入框上方的预览条用）。 */
export type PendingImage = {
  /** 本地 key（上传完成前还没有服务端 id） */
  key: string;
  /** 服务端 id；上传完成才有 */
  id?: number;
  filename: string;
  /** 本地预览（objectURL），上传期间也能立即看到缩略图 */
  localUrl: string;
  uploading: boolean;
  error?: string;
};

/** 已发出/历史消息上挂的图。 */
export type MessageImage = {
  id?: number;
  filename: string;
  /** 服务端地址（需鉴权，走 AuthImage） */
  url?: string;
  /** 刚发出去那一下用本地预览，免得再拉一次 */
  localUrl?: string;
};

export function isImageFile(f: File): boolean {
  if (IMAGE_TYPES.has((f.type || '').toLowerCase())) return true;
  // 少数浏览器拖入时 type 为空，看扩展名兜底
  return /\.(png|jpe?g|webp|gif|bmp)$/i.test(f.name || '');
}

/**
 * 从粘贴事件里取图片文件。
 *
 * ⚠️ 只在**剪贴板里有图且没有文字**时才应该 preventDefault（由调用方决定）：
 * 从 Word/网页复制一段带图的内容时，clipboardData 同时有 text/plain 和图片，
 * 吞掉默认行为会让用户的文字粘不进去。
 */
export function imagesFromClipboard(e: React.ClipboardEvent | ClipboardEvent): { files: File[]; hasText: boolean } {
  const dt = (e as ClipboardEvent).clipboardData;
  if (!dt) return { files: [], hasText: false };
  const files: File[] = [];
  for (const item of Array.from(dt.items || [])) {
    if (item.kind === 'file') {
      const f = item.getAsFile();
      if (f && isImageFile(f)) {
        // 截图粘贴的文件名统一叫 image.png，多张会撞名 —— 加时间戳区分
        const name = f.name && f.name !== 'image.png'
          ? f.name
          : `截图-${new Date().toLocaleTimeString('zh-CN', { hour12: false }).replace(/:/g, '')}.png`;
        files.push(new File([f], name, { type: f.type || 'image/png' }));
      }
    }
  }
  const hasText = !!(dt.getData && dt.getData('text/plain'));
  return { files, hasText };
}

/** 拖拽事件里是否带文件（dragover 阶段拿不到文件本身，只能看 types）。 */
export function dragHasFiles(e: React.DragEvent): boolean {
  return Array.from(e.dataTransfer?.types || []).includes('Files');
}

/** 上传一张图。返回服务端 id；失败抛出人话错误。 */
export async function uploadChatImage(file: File, conversationId?: number | null): Promise<{ id: number; filename: string }> {
  if (file.size > MAX_IMAGE_BYTES) {
    throw new Error(`「${file.name}」超过 ${MAX_IMAGE_BYTES / 1024 / 1024}MB`);
  }
  const fd = new FormData();
  fd.append('file', file);
  if (conversationId) fd.append('conversation_id', String(conversationId));
  const token = getToken();
  // ⚠️ 不能用 authFetch 的 JSON 默认头：multipart 的 boundary 必须由浏览器自己生成
  const r = await fetch(`${BASE}/v1/agent/images`, {
    method: 'POST',
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: fd,
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    let msg = `HTTP ${r.status}`;
    try { const j = JSON.parse(t); msg = j.detail || msg; } catch { if (t) msg = t.slice(0, 160); }
    throw new Error(msg);
  }
  const d = await r.json();
  return { id: Number(d.id), filename: d.filename || file.name };
}

/**
 * 待发图片的状态机：加入（立即预览 + 后台上传）、移除、清空、取已上传的 id。
 *
 * 两个页面都用它，所以"上传中不让发送""超过 10 张拒收"这些规则只写一次。
 */
export function usePendingImages(conversationId?: number | null, onError?: (msg: string) => void) {
  const [images, setImages] = React.useState<PendingImage[]>([]);
  const convRef = React.useRef(conversationId);
  convRef.current = conversationId;
  /** images 的最新值。add 要在 setState **之外**算出"这次收几张"——
   *  React 18 的 updater 不保证同步执行，在 updater 里给外部变量赋值，
   *  后面的上传循环可能读到空数组，结果是"预览出来了但永远在转圈"。 */
  const imagesRef = React.useRef<PendingImage[]>([]);
  imagesRef.current = images;

  const add = React.useCallback((files: File[]) => {
    const imgs = files.filter(isImageFile);
    if (!imgs.length) return 0;
    const room = MAX_IMAGES_PER_MESSAGE - imagesRef.current.length;
    if (room <= 0) {
      onError?.(`一条消息最多 ${MAX_IMAGES_PER_MESSAGE} 张图`);
      return 0;
    }
    if (imgs.length > room) onError?.(`一条消息最多 ${MAX_IMAGES_PER_MESSAGE} 张图，多出的 ${imgs.length - room} 张没有加入`);
    const take = imgs.slice(0, room);
    const accepted: PendingImage[] = take.map((f) => ({
      key: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      filename: f.name,
      localUrl: URL.createObjectURL(f),
      uploading: true,
    }));
    // 同一事件里连续两次 add（粘贴两次很快）时 ref 还没更新 —— 立刻推进它，防止超额
    imagesRef.current = [...imagesRef.current, ...accepted];
    setImages((prev) => [...prev, ...accepted]);
    accepted.forEach((p, i) => {
      uploadChatImage(take[i], convRef.current)
        .then(({ id }) => setImages((prev) => prev.map((x) => (x.key === p.key ? { ...x, id, uploading: false } : x))))
        .catch((err: any) => {
          const msg = err?.message || String(err);
          setImages((prev) => prev.map((x) => (x.key === p.key ? { ...x, uploading: false, error: msg } : x)));
          onError?.(`图片上传失败：${msg}`);
        });
    });
    return accepted.length;
  }, [onError]);

  const remove = React.useCallback((key: string) => {
    setImages((prev) => {
      const hit = prev.find((x) => x.key === key);
      // 只有**没发出去**的才回收 objectURL；发出去的那张气泡里还在用
      if (hit) URL.revokeObjectURL(hit.localUrl);
      return prev.filter((x) => x.key !== key);
    });
  }, []);

  /** 发送时调用：清空预览条，但**不**回收 objectURL —— 刚发出的气泡还要用它显示。 */
  const takeForSend = React.useCallback((): MessageImage[] => {
    const ready = images.filter((x) => x.id && !x.error);
    setImages([]);
    return ready.map((x) => ({ id: x.id, filename: x.filename, localUrl: x.localUrl }));
  }, [images]);

  const uploading = images.some((x) => x.uploading);
  const readyIds = images.filter((x) => x.id && !x.error).map((x) => x.id as number);
  return { images, add, remove, takeForSend, uploading, readyIds };
}

/** 带鉴权的图片：authFetch 取成 blob 再显示（见文件头"为什么不能直接 <img src>"）。 */
export function AuthImage({ src, localUrl, alt, className, onClick }: {
  src?: string; localUrl?: string; alt?: string; className?: string; onClick?: (url: string) => void;
}) {
  const [url, setUrl] = React.useState<string | null>(localUrl || null);
  const [failed, setFailed] = React.useState(false);

  React.useEffect(() => {
    if (localUrl || !src) return;
    let alive = true;
    let obj: string | null = null;
    authFetch(`${BASE}${src}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(String(r.status));
        const b = await r.blob();
        obj = URL.createObjectURL(b);
        if (alive) setUrl(obj);
      })
      .catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; if (obj) URL.revokeObjectURL(obj); };
  }, [src, localUrl]);

  if (failed) {
    return (
      <div className={`flex items-center justify-center gap-1 text-[10px] text-ink-muted bg-surface-overlay ${className || ''}`} title={alt}>
        <ImageOff className="w-3.5 h-3.5" />图片已不可用
      </div>
    );
  }
  if (!url) {
    return (
      <div className={`flex items-center justify-center bg-surface-overlay ${className || ''}`}>
        <Loader2 className="w-3.5 h-3.5 animate-spin text-ink-muted" />
      </div>
    );
  }
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={url} alt={alt || ''} className={`${className || ''} ${onClick ? 'cursor-zoom-in' : ''}`}
    onClick={() => onClick?.(url)} draggable={false} />;
}

/** 输入框上方的待发图片条。 */
export function PendingImageStrip({ images, onRemove }: { images: PendingImage[]; onRemove: (key: string) => void }) {
  if (!images.length) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {images.map((p) => (
        <div key={p.key} className="relative w-16 h-16 rounded-md overflow-hidden border border-line bg-surface-overlay group/img" title={p.error || p.filename}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={p.localUrl} alt={p.filename} className={`w-full h-full object-cover ${p.uploading || p.error ? 'opacity-50' : ''}`} />
          {p.uploading && (
            <div className="absolute inset-0 flex items-center justify-center">
              <Loader2 className="w-4 h-4 animate-spin text-white drop-shadow" />
            </div>
          )}
          {p.error && (
            <div className="absolute inset-x-0 bottom-0 bg-danger/80 text-white text-[9px] text-center leading-4">失败</div>
          )}
          {/* 删除按钮常显（半透明），不藏在 hover 里 —— 藏起来的按钮在用户眼里等于没有 */}
          <button
            type="button"
            onClick={() => onRemove(p.key)}
            className="absolute top-0.5 right-0.5 w-4 h-4 rounded-full bg-black/60 text-white flex items-center justify-center opacity-70 hover:opacity-100"
            title="移除"
          >
            <X className="w-2.5 h-2.5" />
          </button>
        </div>
      ))}
    </div>
  );
}

/** 消息气泡里的图片网格 + 点开看大图。 */
export function MessageImages({ images, align = 'end' }: { images?: MessageImage[]; align?: 'start' | 'end' }) {
  const [zoom, setZoom] = React.useState<string | null>(null);
  if (!images || !images.length) return null;
  return (
    <>
      <div className={`flex flex-wrap gap-1.5 ${align === 'end' ? 'justify-end' : 'justify-start'}`}>
        {images.map((im, i) => (
          <AuthImage
            key={im.id ?? `l${i}`}
            src={im.url}
            localUrl={im.localUrl}
            alt={im.filename}
            className="max-w-[220px] max-h-[220px] rounded-md border border-line object-contain bg-surface-overlay"
            onClick={setZoom}
          />
        ))}
      </div>
      {zoom && (
        <div className="fixed inset-0 z-[100] bg-black/80 flex items-center justify-center p-6 cursor-zoom-out" onClick={() => setZoom(null)}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={zoom} alt="" className="max-w-full max-h-full object-contain rounded" />
        </div>
      )}
    </>
  );
}

/** 拖拽到页面时盖在对话区上的提示层。 */
export function DropOverlay({ show }: { show: boolean }) {
  if (!show) return null;
  return (
    <div className="absolute inset-0 z-40 pointer-events-none flex items-center justify-center bg-primary/10 border-2 border-dashed border-primary rounded-lg">
      <div className="px-4 py-2 rounded-lg bg-surface-elevated border border-primary/50 text-sm text-primary shadow-lg">
        松开鼠标，把图片发给 AI
      </div>
    </div>
  );
}

/**
 * 拖拽状态：dragenter/leave 在子元素间穿梭会反复触发，直接用布尔会闪烁。
 * 用计数器：进一层 +1、出一层 −1，归零才算真的离开。
 */
export function useDropZone(onFiles: (files: File[]) => void) {
  const [over, setOver] = React.useState(false);
  const depth = React.useRef(0);
  const handlers = {
    onDragEnter: (e: React.DragEvent) => {
      if (!dragHasFiles(e)) return;
      e.preventDefault();
      depth.current += 1;
      setOver(true);
    },
    onDragOver: (e: React.DragEvent) => {
      if (!dragHasFiles(e)) return;
      // 不 preventDefault 的话浏览器会直接在新标签页里打开这张图
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    },
    onDragLeave: (e: React.DragEvent) => {
      if (!dragHasFiles(e)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setOver(false);
    },
    onDrop: (e: React.DragEvent) => {
      if (!dragHasFiles(e)) return;
      e.preventDefault();
      depth.current = 0;
      setOver(false);
      onFiles(Array.from(e.dataTransfer.files || []));
    },
  };
  return { over, handlers };
}
