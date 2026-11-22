'use client';
import * as React from 'react';
import { createPortal } from 'react-dom';
import { CheckCircle2, AlertCircle, AlertTriangle, Info, X } from 'lucide-react';
import { cn } from '@/lib/cn';
import { _registerToastBridge } from '@/lib/dialog';

export type ToastType = 'success' | 'error' | 'warning' | 'info';

export type ToastInput = {
  type?: ToastType;
  title?: string;
  description?: React.ReactNode;
  /** 持续时间 ms，默认 3500，error 默认 6000，0 表示永久 */
  duration?: number;
};

type ToastItem = ToastInput & {
  id: string;
  type: ToastType;
};

type ToastContextValue = {
  toast: (input: ToastInput | string) => string;
  success: (input: Omit<ToastInput, 'type'> | string) => string;
  error: (input: Omit<ToastInput, 'type'> | string) => string;
  warning: (input: Omit<ToastInput, 'type'> | string) => string;
  info: (input: Omit<ToastInput, 'type'> | string) => string;
  dismiss: (id: string) => void;
};

const ToastContext = React.createContext<ToastContextValue | null>(null);

const TYPE_CFG: Record<
  ToastType,
  { icon: React.ComponentType<{ className?: string }>; color: string; ring: string }
> = {
  success: { icon: CheckCircle2, color: 'text-success', ring: 'border-success/40' },
  error: { icon: AlertCircle, color: 'text-danger', ring: 'border-danger/40' },
  warning: { icon: AlertTriangle, color: 'text-warning', ring: 'border-warning/40' },
  info: { icon: Info, color: 'text-info', ring: 'border-info/40' },
};

function normalize(input: ToastInput | string, fallbackType: ToastType): ToastItem {
  if (typeof input === 'string') {
    return { id: cryptoRandom(), type: fallbackType, title: input };
  }
  return { id: cryptoRandom(), type: input.type ?? fallbackType, ...input };
}

function cryptoRandom(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return Math.random().toString(36).slice(2);
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = React.useState<ToastItem[]>([]);
  const [mounted, setMounted] = React.useState(false);

  React.useEffect(() => setMounted(true), []);

  const dismiss = React.useCallback((id: string) => {
    setItems((prev) => prev.filter((it) => it.id !== id));
  }, []);

  const push = React.useCallback(
    (item: ToastItem) => {
      setItems((prev) => [...prev, item]);
      const dur =
        item.duration ??
        (item.type === 'error' ? 6000 : item.type === 'warning' ? 5000 : 3500);
      if (dur > 0) {
        window.setTimeout(() => dismiss(item.id), dur);
      }
      return item.id;
    },
    [dismiss],
  );

  const ctx: ToastContextValue = React.useMemo(
    () => ({
      toast: (i) => push(normalize(i, 'info')),
      success: (i) => push(normalize(i as ToastInput, 'success')),
      error: (i) => push(normalize(i as ToastInput, 'error')),
      warning: (i) => push(normalize(i as ToastInput, 'warning')),
      info: (i) => push(normalize(i as ToastInput, 'info')),
      dismiss,
    }),
    [push, dismiss],
  );

  // 注册命令式桥（lib/dialog.ts），让旧代码用 notify/notifyError 等也能弹 toast
  React.useEffect(() => {
    _registerToastBridge({
      show: ctx.toast,
      success: ctx.success,
      error: ctx.error,
      warning: ctx.warning,
      info: ctx.info,
    });
    return () => _registerToastBridge(null);
  }, [ctx]);

  return (
    <ToastContext.Provider value={ctx}>
      {children}
      {mounted &&
        createPortal(
          <div
            className="fixed top-4 right-4 kit-z-toast flex flex-col gap-2 pointer-events-none"
            role="region"
            aria-label="通知"
          >
            {items.map((it) => (
              <ToastView key={it.id} item={it} onDismiss={() => dismiss(it.id)} />
            ))}
          </div>,
          document.body,
        )}
    </ToastContext.Provider>
  );
}

function ToastView({ item, onDismiss }: { item: ToastItem; onDismiss: () => void }) {
  const { icon: Icon, color, ring } = TYPE_CFG[item.type];
  return (
    <div
      role="status"
      className={cn(
        'pointer-events-auto min-w-[280px] max-w-[420px]',
        'flex items-start gap-3 px-4 py-3 rounded-lg',
        'bg-surface-elevated border shadow-overlay backdrop-blur-md',
        'animate-slide-in-right',
        ring,
      )}
    >
      <Icon className={cn('w-5 h-5 flex-shrink-0 mt-0.5', color)} />
      <div className="flex-1 min-w-0">
        {item.title && (
          <div className="text-body font-medium text-ink-primary leading-snug">
            {item.title}
          </div>
        )}
        {item.description && (
          <div className="text-caption text-ink-secondary mt-0.5 leading-snug">
            {item.description}
          </div>
        )}
      </div>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="关闭"
        className="flex-shrink-0 p-1 -m-1 text-ink-muted hover:text-ink-primary transition-colors"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}

export function useToast(): ToastContextValue {
  const ctx = React.useContext(ToastContext);
  if (!ctx) {
    // 兜底 — 防止脱离 Provider 时崩溃
    return {
      toast: () => {
        if (typeof window !== 'undefined')
          console.warn('[Toast] called without ToastProvider');
        return '';
      },
      success: () => '',
      error: () => '',
      warning: () => '',
      info: () => '',
      dismiss: () => {},
    };
  }
  return ctx;
}
