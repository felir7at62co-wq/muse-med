'use client';

import React, { useEffect, useState, createContext, useContext, useCallback } from 'react';

// ── Lightbox 全屏看图 (context provider) ────────────────
type LightboxCtx = { open: (urls: string[], index: number) => void };
const Ctx = createContext<LightboxCtx | null>(null);

export function useLightbox() {
  const c = useContext(Ctx);
  return c || { open: () => {} };
}

export function LightboxProvider({ children }: { children: React.ReactNode }) {
  const [urls, setUrls] = useState<string[]>([]);
  const [idx, setIdx] = useState(0);
  const [visible, setVisible] = useState(false);

  const open = useCallback((u: string[], index: number) => {
    setUrls(u);
    setIdx(Math.max(0, Math.min(index, u.length - 1)));
    setVisible(true);
  }, []);

  const close = useCallback(() => setVisible(false), []);
  const prev = useCallback(() => setIdx((i) => (i - 1 + urls.length) % urls.length), [urls.length]);
  const next = useCallback(() => setIdx((i) => (i + 1) % urls.length), [urls.length]);

  useEffect(() => {
    if (!visible) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
      else if (e.key === 'ArrowLeft') prev();
      else if (e.key === 'ArrowRight') next();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [visible, close, prev, next]);

  return (
    <Ctx.Provider value={{ open }}>
      {children}
      {visible && urls.length > 0 && (
        <div
          className="fixed inset-0 z-[100] bg-black/85 flex items-center justify-center"
          onClick={close}
        >
          <button
            className="absolute top-4 right-4 text-white/80 hover:text-white text-3xl leading-none"
            onClick={close}
            aria-label="关闭"
          >×</button>
          {urls.length > 1 && (
            <>
              <button
                className="absolute left-4 top-1/2 -translate-y-1/2 text-white/70 hover:text-white text-4xl leading-none px-3 py-2"
                onClick={(e) => { e.stopPropagation(); prev(); }}
                aria-label="上一张"
              >‹</button>
              <button
                className="absolute right-4 top-1/2 -translate-y-1/2 text-white/70 hover:text-white text-4xl leading-none px-3 py-2"
                onClick={(e) => { e.stopPropagation(); next(); }}
                aria-label="下一张"
              >›</button>
            </>
          )}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={urls[idx]}
            alt={`lightbox-${idx}`}
            className="max-w-[92vw] max-h-[88vh] object-contain rounded shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          />
          {urls.length > 1 && (
            <span className="absolute bottom-4 left-1/2 -translate-x-1/2 text-white/70 text-caption">
              {idx + 1} / {urls.length}
            </span>
          )}
        </div>
      )}
    </Ctx.Provider>
  );
}

// ── 悬停放大缩略图 (放大镜效果) + 点击进 Lightbox ────────
// allUrls/index 用于 Lightbox 上下翻页; 不传则单图。
export function HoverZoomThumb({
  url, alt, size = 'h-12 w-12', allUrls, index, onClick,
}: {
  url: string; alt?: string; size?: string;
  allUrls?: string[]; index?: number; onClick?: () => void;
}) {
  const lb = useLightbox();
  const handle = () => {
    if (onClick) return onClick();
    lb.open(allUrls && allUrls.length ? allUrls : [url], index ?? 0);
  };
  return (
    <div className="relative group/hz shrink-0">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={url}
        alt={alt || 'thumb'}
        onClick={handle}
        className={`${size} object-cover rounded border border-line bg-black/20 cursor-zoom-in transition-transform`}
       loading="lazy" decoding="async" />
      <div className="pointer-events-none absolute z-30 left-1/2 -translate-x-1/2 bottom-full mb-2 hidden group-hover/hz:block">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={url}
          alt={`${alt || 'thumb'}-zoom`}
          className="max-w-[280px] max-h-[280px] object-contain rounded-lg border border-line shadow-2xl bg-black/80"
        />
      </div>
    </div>
  );
}