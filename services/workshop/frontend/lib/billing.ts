/** 计费 API 封装 (用户端)。 */
import { authFetch } from './auth';

const BASE = process.env.NEXT_PUBLIC_ORCHESTRATOR_URL || '';

export type BillingRecord = {
  id: number;
  job_id: number;
  user_id: number;
  kind: string;      // generate | upscale
  model: string;     // gpt-image-2 | gemini-3-pro-image-preview | runninghub
  unit: string;      // 张 | 小时
  quantity: number;
  unit_price: number;
  amount: number;
  detail?: Record<string, unknown> | null;
  created_at?: string | null;
};

export type BillingSummary = {
  total_amount: number;
  total_count: number;
  by_model: { model: string; amount: number; count: number }[];
};

export type PricingRule = {
  model: string;
  desc: string;
  unit: string;
  price: number;
};

const MODEL_LABEL: Record<string, string> = {
  'gpt-image-2': 'GPT Image 2',
  'gemini-3-pro-image-preview': 'Nano Banana Pro',
  'gemini-3.1-flash-image': 'Nano Banana 2',
  runninghub: '高清放大',
};

export function modelLabel(model: string): string {
  return MODEL_LABEL[model] || model;
}

export function yuan(n: number): string {
  return `¥${(n || 0).toFixed(2)}`;
}

export async function getMySummary(): Promise<BillingSummary> {
  const res = await authFetch(`${BASE}/v1/billing/summary`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function getMyRecords(limit = 50, offset = 0): Promise<{ items: BillingRecord[]; total: number }> {
  const res = await authFetch(`${BASE}/v1/billing/records?limit=${limit}&offset=${offset}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function getPricing(): Promise<{ currency: string; rules: PricingRule[] }> {
  const res = await authFetch(`${BASE}/v1/billing/pricing`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}