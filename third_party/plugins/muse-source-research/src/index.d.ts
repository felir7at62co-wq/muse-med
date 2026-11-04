/** Immutable, versioned public-source evidence and conservative research reports. */
import type { Context } from '@deepseek-ai/cordis';
import type { Branded } from '@deepseek-ai/dsh-brand';
import type { HongguoConfig, RankingOptions } from 'muse-hongguo-search';
import type { QimaoConfig, RankingOptions as QimaoRankingOptions } from 'muse-qimao-data';
import type {} from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-fs';
import type {} from '@deepseek-ai/dsh-sandbox-policy';
import type {} from '@deepseek-ai/dsh-tools';

export type SourceSnapshotId = Branded<'SourceSnapshotId'>;
export type SourceReportId = Branded<'SourceReportId'>;
export type SourceItemId = Branded<'SourceItemId'>;
export type SourceCanonicalKey = Branded<'SourceCanonicalKey'>;
export type Platform = 'hongguo' | 'qimao';
export type EvidenceKind = 'official_public' | 'legacy_file';

/** Resource ceilings reject whole operations rather than truncating data; client settings retain their own TLS/cache bounds. */
export interface Config {
  maxJsonBytes?: number;
  maxItems?: number;
  maxSnapshots?: number;
  maxReportInputs?: number;
  maxComparisonPairs?: number;
  maxReportInputBytes?: number;
  maxListEntries?: number;
  maxReportBytes?: number;
  toolTimeoutMs?: number;
  hongguo?: HongguoConfig;
  qimao?: QimaoConfig;
}

export type SnapshotCall = ({ project?: string } & (
  | { action: 'collect'; platform: 'hongguo'; request: { operation: 'rankings' } & RankingOptions }
  | { action: 'collect'; platform: 'qimao'; request: { operation: 'rankings' } & QimaoRankingOptions }
  | { action: 'import_legacy'; path: string }
  | { action: 'list' }
  | { action: 'read'; snapshotId: string }
  | { action: 'compare'; beforeId: string; afterId: string }
));
export type ReportCall = { project?: string } & (
  | { action: 'build'; snapshotIds: string[]; baselineIds?: string[] }
  | { action: 'read'; reportId: string }
);

/** Each known count retains the source spelling, semantics and actual measurement time; null never means zero. */
export interface CanonicalMetric {
  label: string;
  semantic: string;
  unit: string;
  raw: string | null;
  value: number | null;
  approximate: boolean;
  precisionStep: number | null;
  observedAt: string | null;
  missingReason: string | null;
  scope: unknown;
}
/** Identity uses the source platform and decimal source ID; titles cannot merge works. */
export interface CanonicalItem {
  key: SourceCanonicalKey;
  id: SourceItemId;
  title: string;
  metrics: Record<string, CanonicalMetric>;
  observations: unknown[];
  sourceItemIndexes: number[];
}
/** A committed v1 snapshot retains the entire original result and its normalized projection. */
export interface SourceSnapshot {
  schemaVersion: 1;
  kind: 'source_snapshot';
  adapterVersion: '1.0.0';
  snapshotId: SourceSnapshotId;
  createdAt: string;
  platform: Platform;
  evidenceKind: EvidenceKind;
  sourceResult: unknown;
  request: unknown;
  scope: unknown;
  coverage: unknown;
  evidence?: { path: string; sha256: string };
  observedAt: { first: string | null; last: string | null };
  canonicalItems: CanonicalItem[];
  unidentifiedItems: unknown[];
}
/** Paths are resolved display paths; hashes identify exact stored UTF-8 bytes and no filesystem version is exposed. */
export interface SnapshotReceipt {
  snapshotId: SourceSnapshotId;
  schemaVersion: 1;
  platform: Platform;
  evidenceKind: EvidenceKind;
  path: string;
  sha256: string;
  reused: boolean;
  canonicalCount: number;
  unidentifiedCount: number;
  observedAt: { first: string | null; last: string | null };
  coverage: unknown;
}
export interface MetricChange {
  field: string;
  label: string;
  semantic: string;
  unit: string;
  before: number;
  after: number;
  delta: number;
  approximate: boolean;
  beforeObservedAt: string;
  afterObservedAt: string;
  measurementAdvanced: boolean;
}
export interface SnapshotComparison {
  beforeId: SourceSnapshotId;
  afterId: SourceSnapshotId;
  platform: Platform;
  sameScope: boolean;
  comparisons: { key: SourceCanonicalKey; id: SourceItemId; title: string; metrics: MetricChange[] }[];
  excluded: { key?: SourceCanonicalKey; field?: string; reason: string }[];
  limitations: string[];
}
export const name: 'muse-source-research';
export const inject: readonly ['tools', 'agents', 'fs'];
/** @param config Optional deployment resource and client settings. @returns Validated complete settings; rejects unknown fields before registering tools. */
export function resolveConfig(config?: Config): Readonly<Required<Config>>;
/** @param ctx Scoped tool registry, initiating agent, filesystem and optional sandbox policy. @param config Resource and official-client settings. @returns Nothing; unloading cancels and awaits owned collection calls. */
export function apply(ctx: Context, config?: Config): void;
