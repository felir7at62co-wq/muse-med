/**
 * cn() — clsx + tailwind-merge 工具函数
 * 标准的 shadcn/ui 风格 utility, 用于条件拼 className 并自动去重 tailwind 冲突 class.
 */
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
