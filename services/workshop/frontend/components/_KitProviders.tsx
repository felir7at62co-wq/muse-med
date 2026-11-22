'use client';
import * as React from 'react';
import { ToastProvider, ConfirmProvider } from '@/components/ui';
import { notify, notifyError, notifyWarning } from '@/lib/dialog';

/**
 * KitProviders — 把 Kit v2 的所有 Provider 装进同一个 client 边界,
 * 这样 layout.tsx (server component) 只需引入这一个 client component.
 *
 * 顺序: Toast -> Confirm (ConfirmDialog 内部可能用 useToast, 所以 Toast 在外)
 *
 * 同时启动 AlertHijacker, 把全站的 window.alert(...) 自动转换成 Kit Toast,
 * 这样 100+ 处旧 alert 调用无需逐处改写即可获得新的视觉.
 *
 * window.confirm 因 same-origin 同步阻塞特性, **不**做拦截,
 * 旧代码继续生效, 后续按需逐文件改成 confirmAsync().
 */
export function KitProviders({ children }: { children: React.ReactNode }) {
  return (
    <ToastProvider>
      <ConfirmProvider>
        <AlertHijacker />
        {children}
      </ConfirmProvider>
    </ToastProvider>
  );
}

function AlertHijacker() {
  React.useEffect(() => {
    if (typeof window === 'undefined') return;
    const orig = window.alert;
    if ((window as any).__kitAlertHijacked) return;
    (window as any).__kitAlertHijacked = true;

    window.alert = (msg?: any) => {
      const text = msg == null ? '' : String(msg);
      // 关键词归类：失败/错误/异常 → error, 警告/未/请先 → warning, 其余 info
      const lower = text.toLowerCase();
      if (
        text.includes('失败') ||
        text.includes('错误') ||
        text.includes('异常') ||
        text.includes('出错') ||
        lower.includes('error') ||
        lower.includes('failed')
      ) {
        notifyError(text || '操作失败');
      } else if (
        text.includes('请先') ||
        text.includes('请输入') ||
        text.includes('未') ||
        text.includes('警告')
      ) {
        notifyWarning(text);
      } else {
        notify(text);
      }
    };

    return () => {
      window.alert = orig;
      (window as any).__kitAlertHijacked = false;
    };
  }, []);
  return null;
}
