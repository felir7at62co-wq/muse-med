"""全自动批量产线（管理员专用）

入口流程:
  POST /v1/admin-api/auto-batch/jobs → 创建 AutoBatchJob 记录
   → 后台 task: orchestrator.run_batch(job_id)
     → step A: 概念生成 (concept_gen)
     → step B: 批量创建 ScriptDraft
     → step C: 部级并发处理(每部跑大纲→章节→剧本→分析)
   → 完成: status=done/partial_failed
"""
from .orchestrator import run_batch
from .concept_gen import generate_concepts

__all__ = ["run_batch", "generate_concepts"]
