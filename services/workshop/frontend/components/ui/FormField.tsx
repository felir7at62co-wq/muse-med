'use client';
import * as React from 'react';
import { cn } from '@/lib/cn';

export type FormFieldProps = {
  /** label 文本，必填则在末尾加 * */
  label?: React.ReactNode;
  required?: boolean;
  /** 帮助文本 (description) */
  hint?: React.ReactNode;
  /** 错误消息（出现时优先显示，替代 hint，并把外观切到 invalid） */
  error?: React.ReactNode;
  /** 右上角的提示（如字数统计） */
  endAdornment?: React.ReactNode;
  htmlFor?: string;
  className?: string;
  children: React.ReactNode;
};

/**
 * FormField — 表单单元包装，统一 label / hint / error 排版。
 *
 * 用法:
 *   <FormField label="标题" required error={errMsg}>
 *     <Input value={...} onChange={...} invalid={!!errMsg} />
 *   </FormField>
 */
export function FormField({
  label,
  required,
  hint,
  error,
  endAdornment,
  htmlFor,
  className,
  children,
}: FormFieldProps) {
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      {(label || endAdornment) && (
        <div className="flex items-center justify-between">
          {label && (
            <label
              htmlFor={htmlFor}
              className="text-caption font-medium text-ink-secondary"
            >
              {label}
              {required && <span className="ml-0.5 text-danger">*</span>}
            </label>
          )}
          {endAdornment && (
            <span className="text-caption text-ink-muted">{endAdornment}</span>
          )}
        </div>
      )}
      {children}
      {error ? (
        <p role="alert" className="text-caption text-danger leading-tight">
          {error}
        </p>
      ) : hint ? (
        <p className="text-caption text-ink-muted leading-tight">{hint}</p>
      ) : null}
    </div>
  );
}
