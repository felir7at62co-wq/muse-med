"""剧本分析模块

提供 5 大维度的综合分析:
1. 程序化指标(metrics): 字数/角色戏份/节奏密度
2. 整体评估(overall): S-D 评级 + 4 项分数 + 受众画像
3. 爆点扫描(hooks): 短剧黄金钩子识别(每章并发扫描)
4. 风险综合(risks): 观众流失/逻辑漏洞/同质化等
5. 改进建议(suggestions): P0/P1/P2 优先级清单

入口: analyzer.run_analysis(draft_id, analysis_id)
"""
from .analyzer import run_analysis
from .metrics import compute_metrics
from .docx_export import build_analysis_docx

__all__ = ["run_analysis", "compute_metrics", "build_analysis_docx"]
