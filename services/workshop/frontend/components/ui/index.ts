/**
 * UI Kit v2 — barrel 导出
 *
 * 用法:
 *   import { Button, Card, useToast } from '@/components/ui';
 *
 * 注意: 引入此 barrel 不会污染 server components, 因为 'use client' 在各组件文件内单独标注.
 */

// Tier 1 原子
export { Spinner, type SpinnerProps } from './Spinner';
export { Skeleton, type SkeletonProps } from './Skeleton';
export { Badge, type BadgeProps } from './Badge';
export {
  DraftStatusBadge,
  BatchJobStatusBadge,
  RiskLevelBadge,
} from './StatusBadge';
export { TagChip, type TagChipProps } from './TagChip';
export { Avatar, type AvatarProps } from './Avatar';

// Tier 2 表单
export { Button, type ButtonProps } from './Button';
export { IconButton, type IconButtonProps } from './IconButton';
export { Input, type InputProps } from './Input';
export { Textarea, type TextareaProps } from './Textarea';
export { Select, type SelectProps } from './Select';
export { FormField, type FormFieldProps } from './FormField';

// Tier 3 反馈
export {
  ToastProvider,
  useToast,
  type ToastInput,
  type ToastType,
} from './Toast';
export {
  ConfirmProvider,
  useConfirm,
  type ConfirmOptions,
  type ConfirmTone,
} from './ConfirmDialog';
export { EmptyState, type EmptyStateProps } from './EmptyState';
export {
  Progress,
  ProgressBanner,
  type ProgressProps,
  type ProgressBannerProps,
  type ProgressBannerStatus,
} from './Progress';
export { Tooltip, type TooltipProps } from './Tooltip';

// Tier 4 浮层
export { Modal, type ModalProps } from './Modal';
export { Drawer, type DrawerProps } from './Drawer';
export { Popover, type PopoverProps, type PopoverPlacement } from './Popover';
export {
  DropdownMenu,
  type DropdownMenuProps,
  type DropdownItem,
} from './DropdownMenu';
export { Tabs, type TabsProps, type TabItem } from './Tabs';

// Tier 5 复合
export { Card, CardHeader, CardBody, CardFooter, type CardProps } from './Card';
export {
  SkeletonCard,
  SkeletonTable,
  SkeletonEditor,
  SkeletonList,
  SkeletonChart,
} from './SkeletonVariants';

// 状态色 类型 (供业务组件使用)
export {
  type Tone,
  type DraftStatus,
  type BatchJobStatus,
  type RiskLevel,
  type MemoryType,
  type RelationType,
  toneClasses,
  draftStatusMeta,
  batchJobStatusMeta,
  riskLevelMeta,
  memoryTypeMeta,
  relationTypeMeta,
} from './_statusColors';
