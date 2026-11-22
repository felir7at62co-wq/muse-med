import { Badge, type BadgeProps } from './Badge';
import {
  type DraftStatus,
  type BatchJobStatus,
  type RiskLevel,
  draftStatusMeta,
  batchJobStatusMeta,
  riskLevelMeta,
} from './_statusColors';

type CommonProps = Pick<BadgeProps, 'size' | 'variant' | 'className'> & {
  /** 是否带圆点 */
  withDot?: boolean;
  /** 自定义文案覆盖 */
  label?: string;
};

/* ───── DraftStatusBadge ───── */
export function DraftStatusBadge({
  status,
  withDot = true,
  label,
  ...rest
}: { status: DraftStatus } & CommonProps) {
  const meta = draftStatusMeta[status];
  return (
    <Badge tone={meta.tone} withDot={withDot} {...rest}>
      {label ?? meta.label}
    </Badge>
  );
}

/* ───── BatchJobStatusBadge ───── */
export function BatchJobStatusBadge({
  status,
  withDot = true,
  label,
  ...rest
}: { status: BatchJobStatus } & CommonProps) {
  const meta = batchJobStatusMeta[status];
  return (
    <Badge tone={meta.tone} withDot={withDot} {...rest}>
      {label ?? meta.label}
    </Badge>
  );
}

/* ───── RiskLevelBadge ───── */
export function RiskLevelBadge({
  level,
  withDot = true,
  label,
  ...rest
}: { level: RiskLevel } & CommonProps) {
  const meta = riskLevelMeta[level];
  return (
    <Badge tone={meta.tone} withDot={withDot} {...rest}>
      {label ?? meta.label}
    </Badge>
  );
}
