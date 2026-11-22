'use client';
/**
 * dialog.ts — 命令式桥接 Toast / ConfirmDialog
 *
 * 背景：useToast / useConfirm 是 hook，必须在组件内使用，
 * 但旧代码大量散落 `alert("...")` `confirm("...")` 在事件回调或异步函数里，
 * 一个个改 hook 调用太重。
 *
 * 方案：让 ToastProvider / ConfirmProvider 在 mount 时把句柄注册到本模块的单例，
 * 旧代码只需改成 `notify(msg)` / `notifyError(msg)` / `confirmAsync({...})`，
 * 即可获得全新的 toast / 确认弹层体验。
 *
 * 使用：
 *   import { notify, notifyError, confirmAsync } from '@/lib/dialog';
 *   notify('已保存');
 *   notifyError('保存失败');
 *   if (await confirmAsync('确定删除？')) { ... }
 */

import type { ToastInput, ToastType } from '@/components/ui/Toast';
import type { ConfirmOptions } from '@/components/ui/ConfirmDialog';

type ToastFn = (input: ToastInput | string) => string;
type ToastApi = {
  show: (input: ToastInput | string) => string;
  success: ToastFn;
  error: ToastFn;
  warning: ToastFn;
  info: ToastFn;
};
type ConfirmFn = (opts: ConfirmOptions) => Promise<boolean>;

let toastApi: ToastApi | null = null;
let confirmFn: ConfirmFn | null = null;

/** 由 ToastProvider 内部调用：注册命令式句柄 */
export function _registerToastBridge(api: ToastApi | null) {
  toastApi = api;
}

/** 由 ConfirmProvider 内部调用：注册命令式句柄 */
export function _registerConfirmBridge(fn: ConfirmFn | null) {
  confirmFn = fn;
}

/* ────────── 命令式 API ────────── */

function emit(type: ToastType, msg: string | ToastInput): string {
  if (!toastApi) {
    // 桥未就绪 (SSR 或 Provider 未挂)；做一次降级到 console
    console.warn('[dialog] toast bridge not ready:', msg);
    return '';
  }
  return toastApi[type](msg);
}

/** 中性提示（默认 info） */
export function notify(msg: string | ToastInput): string {
  return emit('info', msg);
}
export function notifyInfo(msg: string | ToastInput): string {
  return emit('info', msg);
}
export function notifySuccess(msg: string | ToastInput): string {
  return emit('success', msg);
}
export function notifyError(msg: string | ToastInput): string {
  return emit('error', msg);
}
export function notifyWarning(msg: string | ToastInput): string {
  return emit('warning', msg);
}

/**
 * 命令式确认弹层
 *
 * 接收两种参数：
 *  - 字符串：当作 description，展示标准"确认"
 *  - ConfirmOptions：完整定制
 *
 * 返回 Promise<boolean>，true=确认 false=取消
 */
export function confirmAsync(opts: string | ConfirmOptions): Promise<boolean> {
  const normalized: ConfirmOptions =
    typeof opts === 'string' ? { title: '请确认', description: opts } : opts;
  if (!confirmFn) {
    console.warn('[dialog] confirm bridge not ready:', normalized);
    // 降级到原生 confirm，至少不丢失业务流
    if (typeof window !== 'undefined') {
      const txt =
        typeof normalized.description === 'string'
          ? normalized.description
          : typeof normalized.title === 'string'
            ? normalized.title
            : '确认操作？';
      return Promise.resolve(window.confirm(txt));
    }
    return Promise.resolve(false);
  }
  return confirmFn(normalized);
}
