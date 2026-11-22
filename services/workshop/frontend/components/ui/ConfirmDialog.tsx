'use client';
import * as React from 'react';
import { AlertTriangle, AlertCircle, Info, HelpCircle } from 'lucide-react';
import { cn } from '@/lib/cn';
import { Modal } from './Modal';
import { Button } from './Button';
import { _registerConfirmBridge } from '@/lib/dialog';

export type ConfirmTone = 'default' | 'danger' | 'warning' | 'info';

export type ConfirmOptions = {
  title: React.ReactNode;
  description?: React.ReactNode;
  /** 主按钮文案 */
  confirmText?: string;
  /** 取消按钮文案 */
  cancelText?: string;
  /** 主按钮 tone，danger 用红色 */
  tone?: ConfirmTone;
  /** 强保护：要求倒计时 N 秒后才允许点确认（PLAN §16.5 一键清空） */
  countdownSec?: number;
  /** 强保护：要求输入指定字符串才允许确认（PLAN §15.4 / §16.5） */
  requireText?: string;
};

type ConfirmContextValue = {
  confirm: (opts: ConfirmOptions) => Promise<boolean>;
};

const ConfirmContext = React.createContext<ConfirmContextValue | null>(null);

const TONE_CFG: Record<
  ConfirmTone,
  { icon: React.ComponentType<{ className?: string }>; color: string; ring: string }
> = {
  default: { icon: HelpCircle, color: 'text-primary', ring: 'bg-primary-subtle' },
  danger: { icon: AlertCircle, color: 'text-danger', ring: 'bg-danger-subtle' },
  warning: { icon: AlertTriangle, color: 'text-warning', ring: 'bg-warning-subtle' },
  info: { icon: Info, color: 'text-info', ring: 'bg-info-subtle' },
};

type Internal = ConfirmOptions & {
  resolve: (v: boolean) => void;
};

export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [pending, setPending] = React.useState<Internal | null>(null);
  const [inputValue, setInputValue] = React.useState('');
  const [secondsLeft, setSecondsLeft] = React.useState(0);

  // 倒计时
  React.useEffect(() => {
    if (!pending || !pending.countdownSec) return;
    setSecondsLeft(pending.countdownSec);
    const tick = setInterval(() => {
      setSecondsLeft((s) => {
        if (s <= 1) {
          clearInterval(tick);
          return 0;
        }
        return s - 1;
      });
    }, 1000);
    return () => clearInterval(tick);
  }, [pending]);

  const close = React.useCallback(
    (result: boolean) => {
      pending?.resolve(result);
      setPending(null);
      setInputValue('');
      setSecondsLeft(0);
    },
    [pending],
  );

  const confirm = React.useCallback(
    (opts: ConfirmOptions) =>
      new Promise<boolean>((resolve) => {
        setPending({ ...opts, resolve });
      }),
    [],
  );

  const ctx = React.useMemo(() => ({ confirm }), [confirm]);

  // 注册命令式桥（lib/dialog.ts），让旧代码用 confirmAsync(opts) 也能弹标准 Modal
  React.useEffect(() => {
    _registerConfirmBridge(confirm);
    return () => _registerConfirmBridge(null);
  }, [confirm]);

  const tone = pending?.tone ?? 'default';
  const cfg = TONE_CFG[tone];
  const Icon = cfg.icon;

  const requireTextOk = !pending?.requireText || inputValue.trim() === pending.requireText;
  const countdownOk = secondsLeft <= 0;
  const canConfirm = requireTextOk && countdownOk;

  return (
    <ConfirmContext.Provider value={ctx}>
      {children}
      <Modal
        open={!!pending}
        onClose={() => close(false)}
        size="sm"
        hideCloseButton
        closeOnOverlay={false}
        footer={
          <>
            <Button variant="ghost" onClick={() => close(false)}>
              {pending?.cancelText ?? '取消'}
            </Button>
            <Button
              variant={tone === 'danger' ? 'danger' : 'primary'}
              disabled={!canConfirm}
              onClick={() => close(true)}
            >
              {pending?.confirmText ?? '确认'}
              {secondsLeft > 0 && ` (${secondsLeft}s)`}
            </Button>
          </>
        }
      >
        {pending && (
          <div className="flex gap-3">
            <div
              className={cn(
                'flex-shrink-0 w-10 h-10 rounded-full flex items-center justify-center',
                cfg.ring,
              )}
            >
              <Icon className={cn('w-5 h-5', cfg.color)} />
            </div>
            <div className="flex-1 min-w-0">
              <h3 className="text-card-title text-ink-primary leading-snug">
                {pending.title}
              </h3>
              {pending.description && (
                <p className="mt-1 text-body text-ink-secondary leading-relaxed">
                  {pending.description}
                </p>
              )}
              {pending.requireText && (
                <div className="mt-3">
                  <label className="text-caption text-ink-muted block mb-1">
                    请输入「{pending.requireText}」以确认：
                  </label>
                  <input
                    autoFocus
                    type="text"
                    value={inputValue}
                    onChange={(e) => setInputValue(e.target.value)}
                    className="w-full h-9 px-3 bg-surface-input border border-line rounded-md text-ink-primary text-body outline-none focus:border-line-active"
                  />
                </div>
              )}
            </div>
          </div>
        )}
      </Modal>
    </ConfirmContext.Provider>
  );
}

export function useConfirm(): (opts: ConfirmOptions) => Promise<boolean> {
  const ctx = React.useContext(ConfirmContext);
  if (!ctx) {
    return async (opts) => {
      // 兜底
      if (typeof window !== 'undefined') {
        return window.confirm(
          (typeof opts.title === 'string' ? opts.title : '确认') +
            (opts.description && typeof opts.description === 'string'
              ? '\n' + opts.description
              : ''),
        );
      }
      return false;
    };
  }
  return ctx.confirm;
}
