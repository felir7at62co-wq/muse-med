"use client";
import { useState, useEffect, useCallback } from "react";
import { useRouter, useParams } from "next/navigation";
import { getUser, getToken } from "../../../../lib/auth";
import { UserNav } from "../../../_UserNav";
import {
  ArrowLeft, Loader2, AlertCircle, Download, GitBranch,
  Star, Clock, FileText, Package, ExternalLink
} from "lucide-react";
import { Button, Card, Badge } from "@/components/ui";

const BASE = process.env.NEXT_PUBLIC_ORCHESTRATOR_URL || "";
const API = `${BASE}/v1/factory`;

type TraceNode = {
  id: number;
  product_type: string;
  title: string;
  source_type: string;
  created_at: string;
  parent_id?: number;
  children: TraceNode[];
};

type QualityScore = {
  id: number;
  score: number;
  dimension: string;
  comment: string;
  scored_at: string;
};

type UsageRecord = {
  id: number;
  used_by: string;
  used_for: string;
  used_at: string;
};

type ProductDetail = {
  id: number;
  job_id: number;
  product_type: string;
  draft_id?: number;
  title: string;
  content_json: any;
  oss_key?: string;
  parent_product_id?: number;
  source_type: string;
  status: string;
  episode_count?: number;
  download_url?: string;
  validation_json: any;
  error?: string;
  created_at: string;
  finished_at?: string;
  trace_tree: TraceNode;
  quality_scores: QualityScore[];
  usage_records: UsageRecord[];
};

const PRODUCT_TYPE_LABELS: Record<string, string> = {
  script: "剧本",
  novel: "小说",
  tweet: "推文",
  video: "视频",
  outline: "大纲",
};

const SOURCE_TYPE_LABELS: Record<string, string> = {
  original: "原创",
  adapted_from_script: "改编自剧本",
  imported: "导入",
  spawned: "裂变",
};

export default function ProductTracePage() {
  if (typeof window !== "undefined") {
    if (!getUser()) {
      window.location.href = "/login?from=/factory";
      return null;
    }
  }

  const router = useRouter();
  const params = useParams();
  const productId = params.id as string;
  const authHeaders = () => ({ Authorization: `Bearer ${getToken()}` });

  const [product, setProduct] = useState<ProductDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // 加载产物详情
  const loadProductDetail = useCallback(async () => {
    try {
      const r = await fetch(`${API}/products/${productId}/trace`, {
        headers: authHeaders(),
      });

      if (!r.ok) {
        if (r.status === 404) {
          throw new Error("产物不存在");
        }
        throw new Error(`HTTP ${r.status}`);
      }

      const data = await r.json();
      setProduct(data);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [productId]);

  useEffect(() => {
    loadProductDetail();
  }, [loadProductDetail]);

  // 导出产物文本(后端生成txt)
  const handleExport = async () => {
    if (!product) return;
    try {
      const r = await fetch(`${API}/products/${productId}/export`, {
        headers: authHeaders(),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({ detail: "导出失败" }));
        throw new Error(err.detail || "导出失败");
      }
      const blob = await r.blob();
      const cd = r.headers.get("Content-Disposition") || "";
      let filename = `${product.title || `product-${productId}`}.docx`;
      const m = cd.match(/filename\*=UTF-8''([^;]+)/);
      if (m) filename = decodeURIComponent(m[1]);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      link.click();
      URL.revokeObjectURL(url);
    } catch (e: any) {
      alert(`❌ 导出失败: ${e.message}`);
    }
  };

  // 递归渲染溯源树
  const renderTraceTree = (node: TraceNode, level: number = 0) => {
    const isCurrentProduct = node.id === Number(productId);
    
    return (
      <div key={node.id} className="relative">
        <div
          className={`flex items-center gap-3 p-3 rounded-lg border transition-colors ${
            isCurrentProduct
              ? "border-primary bg-primary/5"
              : "border-line hover:bg-surface-elevated"
          }`}
          style={{ marginLeft: `${level * 32}px` }}
        >
          <Package className="w-5 h-5 text-ink-secondary flex-shrink-0" />
          <div className="flex-1">
            <div className="flex items-center gap-2">
              <span className="font-medium">{node.title}</span>
              <Badge variant="outline" className="text-xs">
                {PRODUCT_TYPE_LABELS[node.product_type] || node.product_type}
              </Badge>
              {isCurrentProduct && (
                <Badge className="bg-primary text-white text-xs">当前</Badge>
              )}
            </div>
            <div className="text-xs text-ink-secondary mt-1">
              {SOURCE_TYPE_LABELS[node.source_type]} ·{" "}
              {new Date(node.created_at).toLocaleString("zh-CN")}
            </div>
          </div>
          {!isCurrentProduct && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => router.push(`/factory/products/${node.id}`)}
            >
              查看
            </Button>
          )}
        </div>

        {node.children && node.children.length > 0 && (
          <div className="mt-2 space-y-2">
            {node.children.map((child) => renderTraceTree(child, level + 1))}
          </div>
        )}
      </div>
    );
  };

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-surface-base">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  if (error || !product) {
    return (
      <div className="flex h-screen items-center justify-center bg-surface-base">
        <Card className="p-8 max-w-md">
          <AlertCircle className="w-12 h-12 mx-auto text-red-600 mb-4" />
          <h2 className="text-xl font-semibold text-center mb-2">加载失败</h2>
          <p className="text-center text-ink-secondary mb-4">{error || "未知错误"}</p>
          <Button onClick={() => router.push("/factory")} className="w-full">
            返回主页
          </Button>
        </Card>
      </div>
    );
  }

  const avgScore = product.quality_scores.length > 0
    ? product.quality_scores.reduce((sum, s) => sum + s.score, 0) / product.quality_scores.length
    : 0;

  return (
    <div className="flex h-screen bg-surface-base">
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* 顶部导航 */}
        <header className="h-topbar border-b border-line flex items-center justify-between px-6 bg-surface-elevated">
          <div className="flex items-center gap-3">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => router.push("/factory")}
              className="gap-2"
            >
              <ArrowLeft className="w-4 h-4" />
              返回
            </Button>
            <div className="flex items-center gap-2">
              <GitBranch className="w-5 h-5 text-primary" />
              <h1 className="text-xl font-semibold">产物追溯</h1>
            </div>
          </div>
          <UserNav />
        </header>

        {/* 主体内容 */}
        <main className="flex-1 overflow-y-auto p-6">
          <div className="max-w-[1600px] mx-auto space-y-6">
            {/* 产物基本信息 */}
            <Card className="p-6">
              <div className="flex items-start justify-between mb-4">
                <div>
                  <div className="flex items-center gap-3 mb-2">
                    <h2 className="text-2xl font-semibold">{product.title}</h2>
                    <Badge variant="outline">
                      {PRODUCT_TYPE_LABELS[product.product_type]}
                    </Badge>
                    <Badge
                      className={
                        product.status === "completed"
                          ? "bg-green-500 text-white"
                          : product.status === "failed"
                          ? "bg-red-500 text-white"
                          : "bg-blue-500 text-white"
                      }
                    >
                      {product.status === "completed" ? "已完成" : product.status === "failed" ? "失败" : "生成中"}
                    </Badge>
                  </div>
                  <div className="text-sm text-ink-secondary space-y-1">
                    <p>产物 ID: {product.id}</p>
                    <p>任务 ID: {product.job_id}</p>
                    <p>来源: {SOURCE_TYPE_LABELS[product.source_type]}</p>
                    {product.episode_count && <p>集数: {product.episode_count}</p>}
                    <p>创建时间: {new Date(product.created_at).toLocaleString("zh-CN")}</p>
                    {product.finished_at && (
                      <p>完成时间: {new Date(product.finished_at).toLocaleString("zh-CN")}</p>
                    )}
                  </div>
                </div>

                <div className="flex gap-2">
                  {product.draft_id && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => router.push(`/drafts/${product.draft_id}`)}
                    >
                      <FileText className="w-4 h-4 mr-1" />
                      查看草稿
                    </Button>
                  )}
                  {product.download_url && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => window.open(product.download_url, "_blank")}
                    >
                      <Download className="w-4 h-4 mr-1" />
                      下载
                    </Button>
                  )}
                  <Button variant="outline" size="sm" onClick={handleExport}>
                    <Download className="w-4 h-4 mr-1" />
                    导出文本
                  </Button>
                </div>
              </div>

              {/* 质量评分概览 */}
              {product.quality_scores.length > 0 && (
                <div className="mt-4 p-4 bg-surface-elevated rounded-lg">
                  <div className="flex items-center gap-2 mb-2">
                    <Star className="w-5 h-5 text-yellow-500" />
                    <span className="font-medium">平均质量评分</span>
                  </div>
                  <div className="flex items-center gap-4">
                    <div className="text-3xl font-bold text-primary">
                      {avgScore.toFixed(1)}
                    </div>
                    <div className="text-sm text-ink-secondary">
                      基于 {product.quality_scores.length} 次评分
                    </div>
                  </div>
                </div>
              )}

              {product.error && (
                <div className="mt-4 p-3 bg-red-50 border border-red-200 rounded-lg flex items-center gap-2 text-red-700">
                  <AlertCircle className="w-5 h-5 flex-shrink-0" />
                  <span className="text-sm">{product.error}</span>
                </div>
              )}
            </Card>

            {/* 溯源树 */}
            <Card className="p-6">
              <div className="flex items-center gap-2 mb-4">
                <GitBranch className="w-5 h-5 text-primary" />
                <h3 className="text-lg font-semibold">溯源树</h3>
              </div>
              <div className="space-y-2">
                {renderTraceTree(product.trace_tree)}
              </div>
              <div className="mt-4 p-3 bg-blue-50 border border-blue-200 rounded-lg text-sm text-blue-800">
                <strong>说明:</strong> 溯源树展示了从原始主题到最终产物的完整创作链路
              </div>
            </Card>

            {/* 质量评分历史 */}
            {product.quality_scores.length > 0 && (
              <Card className="p-6">
                <div className="flex items-center gap-2 mb-4">
                  <Star className="w-5 h-5 text-primary" />
                  <h3 className="text-lg font-semibold">质量评分历史</h3>
                </div>
                <div className="space-y-3">
                  {product.quality_scores.map((score) => (
                    <div
                      key={score.id}
                      className="p-4 border border-line rounded-lg"
                    >
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-3">
                          <div className="text-2xl font-bold text-primary">
                            {score.score}
                          </div>
                          <div>
                            <div className="font-medium">{score.dimension}</div>
                            <div className="text-xs text-ink-secondary">
                              {new Date(score.scored_at).toLocaleString("zh-CN")}
                            </div>
                          </div>
                        </div>
                        <div className="flex items-center gap-1">
                          {[...Array(5)].map((_, i) => (
                            <Star
                              key={i}
                              className={`w-4 h-4 ${
                                i < score.score / 20
                                  ? "text-yellow-500 fill-yellow-500"
                                  : "text-gray-300"
                              }`}
                            />
                          ))}
                        </div>
                      </div>
                      {score.comment && (
                        <p className="text-sm text-ink-secondary">{score.comment}</p>
                      )}
                    </div>
                  ))}
                </div>
              </Card>
            )}

            {/* 使用记录 */}
            {product.usage_records.length > 0 && (
              <Card className="p-6">
                <div className="flex items-center gap-2 mb-4">
                  <Clock className="w-5 h-5 text-primary" />
                  <h3 className="text-lg font-semibold">使用记录</h3>
                </div>
                <div className="space-y-2">
                  {product.usage_records.map((record) => (
                    <div
                      key={record.id}
                      className="p-3 border border-line rounded-lg flex items-center justify-between"
                    >
                      <div>
                        <div className="font-medium">{record.used_for}</div>
                        <div className="text-sm text-ink-secondary">
                          使用者: {record.used_by} ·{" "}
                          {new Date(record.used_at).toLocaleString("zh-CN")}
                        </div>
                      </div>
                      <ExternalLink className="w-4 h-4 text-ink-secondary" />
                    </div>
                  ))}
                </div>
              </Card>
            )}

            {/* 校验结果 */}
            {product.validation_json && Object.keys(product.validation_json).length > 0 && (
              <Card className="p-6">
                <h3 className="text-lg font-semibold mb-4">校验结果</h3>
                <pre className="p-4 bg-surface-elevated rounded-lg text-sm overflow-auto max-h-96">
                  {JSON.stringify(product.validation_json, null, 2)}
                </pre>
              </Card>
            )}

            {/* 操作按钮 */}
            <div className="flex gap-3">
              <Button
                variant="outline"
                onClick={() => router.push(`/factory/jobs/${product.job_id}`)}
                className="flex-1"
              >
                查看任务详情
              </Button>
              <Button
                onClick={() => router.push("/factory")}
                className="flex-1"
              >
                返回工厂主页
              </Button>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
