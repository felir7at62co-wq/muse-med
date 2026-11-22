"""LLM prompt 模板(短剧分析专用)"""
from __future__ import annotations


# Step 2: 整体评估 + 受众画像
OVERALL_PROMPT = """你是资深短剧制片人,擅长评估剧本的市场潜力和制作价值。请基于以下信息综合评估剧本:

## 剧本信息
标题: {title}
集数: {episode_count}
总字数: {total_words}
平均每集字数: {avg_words}

## 大纲梗概
{synopsis}

## 各集摘要
{chapter_summaries}

## 程序化指标
- 总剧本场景数: {total_storyboards}
- 平均每集镜头数: {avg_shots}
- 主要角色戏份分布: {character_share_brief}
- 章节字数偏离度(超过 20% 视为异常): {word_deviation_brief}

---

# 评估维度(0-100 分)

1. **completeness(剧情完整度)**: 开头是否抓人 / 铺垫是否充分 / 高潮是否爆发 / 反转是否合理 / 结局是否收得住
2. **character(角色塑造)**: 人物弧光是否清晰 / 动机是否一致 / 配角是否立体 / 反派是否有说服力
3. **pacing(节奏密度)**: 短剧关键-每集 1-2 个钩子 / 信息密度是否够 / 有无拖沓段落 / 钩子分布是否均匀
4. **market(市场潜力)**: 题材热度 / 受众覆盖面 / 与同类爆款对比 / 投流潜力

综合分加权: completeness 0.25 + character 0.25 + pacing 0.30 + market 0.20

## 评级标准
- 90+: S (精品爆款潜质,强推)
- 80-89: A (优质作品,小爆款可能)
- 70-79: B (及格线,需打磨)
- 60-69: C (有明显问题需重写部分)
- <60: D (建议大改或弃用)

# 受众画像(基于剧情类型推断)
- tags: 题材标签数组(如 ["豪门","复仇","重生","战神","甜宠","悬疑"])
- target_age: 主受众年龄段(如 "25-35")
- target_gender: 主受众性别("女性为主"/"男性为主"/"均衡")
- target_region: 主投流地域("一线城市"/"二三线城市"/"下沉市场")
- completion_rate_predict: 完播率预测("high"/"medium"/"low")

---

# 输出要求
仅输出 JSON,无 Markdown 包装,无前后文字:

{{
  "overall_grade": "S|A|B|C|D",
  "overall_score": 整数 0-100,
  "summary": "一句话总评,15-40字",
  "scores": {{
    "completeness": 0-100,
    "character": 0-100,
    "pacing": 0-100,
    "market": 0-100
  }},
  "audience": {{
    "tags": ["标签1","标签2"],
    "target_age": "...",
    "target_gender": "...",
    "target_region": "...",
    "completion_rate_predict": "high|medium|low"
  }}
}}
"""


# Step 3: 单章爆点扫描
HOOKS_PROMPT = """你是短剧投流专家。请从以下章节中找出可作为"投流钩子"的爆点。

# 章节
集号: {chapter_order}
标题: {chapter_title}

正文/剧本:
{chapter_content}

---

# 爆点类型(对应短剧投流的黄金钩子)
- opening_hook: 开场钩(前 30 秒内发生的强冲突,抓住观众不划走)
- twist: 中段反转(出乎意料的情节转折)
- cliffhanger: 结尾悬念(钓下一集,让观众不舍得停)
- emotional_peak: 情绪炸裂(让观众破防的情感爆发,共情时刻)
- iconic_line: 名场面台词(可截图/做封面的金句)

# 强度(1-5)评判依据
- 戏剧冲突强度: 矛盾越尖锐越高
- 情绪冲击: 让观众"卧槽""哇"的程度
- 传播价值: 适不适合做投流素材的开头/封面

---

# 输出要求
仅输出 JSON 数组,每个元素如下,无前后文字:

[
  {{
    "type": "opening_hook|twist|cliffhanger|emotional_peak|iconic_line",
    "intensity": 1-5,
    "scene_no": "{chapter_order}-X (X是场次号,无场次填'-')",
    "snippet": "原文关键片段,30-80字",
    "comment": "为什么这是钩子,15-40字",
    "improvement": "如何能更强,可空字符串"
  }}
]

要求:
- 每章最多列 5 个钩子,优先列强度高的
- 若本章无明显钩子,返回空数组 []
- 强度 1-2 的钩子可以不列,除非确实是迷人的台词
"""


# Step 4: 风险综合 + 改进建议
DIAGNOSIS_REPORT_PROMPT = """你是国内顶级短剧总编/剧本医生,审稿风格像资深制片人给编剧的"过稿意见书"。请通读下面这部短剧的全部章节正文,写一篇**结构化、可落地、敢说硬话**的深度诊断报告。

【剧名】{title}
【集数】{episode_count}
【整体梗概/设定】
{synopsis}

【全剧正文(按集)】
{full_text}

==== 写作要求 ====
1. 输出**纯 Markdown 长文**,不要 JSON,不要代码块包裹。
2. 像人话,有判断、有取舍,敢指出"这是上线前必须修的硬伤"。引用剧情时带上**第几集**和具体细节(人物、道具、台词),不要泛泛而谈。
3. 严格按下面的分区结构(用 `##` 二级标题),每个分区都要写;若某分区确实无内容,写"暂未发现"并说明。
4. 硬伤类问题要给**定位 + 为什么是问题 + 至少一个具体改法(可给 A/B 方案)**。

==== 必须包含的分区 ====
## 一、总体判断
3-5 句给出这一版的核心结论:最大优点 + 最致命问题 + 当前属于"需润色 / 需总线重排 / 需重构"哪一档。

## 二、相比基线的进步点
逐条列出写得好的地方(钩子、主动性、世界观符号等),带集数佐证。

## 三、严重硬伤(上线前必修)
重点查:① 角色生死/状态连续性(如某集已死后续却出现);② 时间线矛盾(如"三年"与"一个月"打架);③ 世界观穿帮(古今混用、规则前后不一)。每条:**定位(第X集)→ 为什么出戏 → 改法 A/B**。

## 四、人物关系诊断
逐个主要角色:动机是否过载、人设是否漂移(忽正忽邪/保护者变占有欲)、男二/反派定位是否稳定。给收敛建议。

## 五、结构与节奏
判断爽点是否堆叠导致主线变碎;给出**分阶段重排建议**(如 1-10 入局 / 11-25 / 26-40 / ...),指出哪些重复桥段该删并。

## 六、版权与同质化风险
判断底层人物关系/桥段是否与常见爆款雷同,给风险档(低/中/中高/高)与**降险改法**(改底层关系而非只换皮)。

## 七、当前最需修的 N 个点
编号清单(8-12 条),按优先级排序,每条一句话、可直接派给编剧执行。

## 八、最终评价
分三档结论:作为"内部样稿 / 进入生产 / 商用发行"分别是否达标,各一句话。
"""

RISKS_AND_SUGGESTIONS_PROMPT = """你是短剧策划专家。基于已有的分析数据,综合给出风险提示和改进建议。

# 整体评估
{overall_summary}

# 各项分数
{scores_brief}

# 爆点分布(共 {total_hooks} 个钩子)
{hooks_brief}

# 程序化指标
{metrics_brief}

---

# 风险类别(列出 3-8 条主要风险)
- audience_loss: 观众流失风险(节奏拖沓段落 / 爽点缺失集数)
- logic_gap: 逻辑漏洞(动机断裂 / 伏笔未回收 / 时间线矛盾)
- homogeneous: 同质化风险(题材雷同 / 套路化严重)
- character_imbalance: 角色失衡(戏份过度集中 / 主角光环 / 配角扁平)
- completion_risk: 完播风险(前 3 集薄弱 / 中间集断层)

每条风险:
- severity: high(严重影响完播) / medium(影响评级) / low(建议优化)
- location: 具体集号或集号范围,如 "第3-4集"

# 改进建议(列出 3-10 条,按优先级排序)
- P0: 必改(不改影响完播率)
- P1: 推荐(能提升评级)
- P2: 可选(锦上添花)

每条建议:
- expected_score_lift: 改完预计提升综合分(整数,1-10)
- 必须 actionable,具体到"在哪一集做什么"

---

# 输出要求
仅输出 JSON,无 Markdown 包装,无前后文字:

{{
  "risks": [
    {{
      "category": "audience_loss|logic_gap|homogeneous|character_imbalance|completion_risk|safety",
      "severity": "high|medium|low",
      "location": "具体集号,如'第3-4集'或'全剧'",
      "description": "风险描述,30-80字",
      "suggestion": "如何缓解,30-80字"
    }}
  ],
  "suggestions": [
    {{
      "priority": "P0|P1|P2",
      "location": "具体位置,如'第2集开头'",
      "current_issue": "当前问题,20-50字",
      "suggestion": "具体改法,30-80字",
      "expected_score_lift": 整数 1-10
    }}
  ]
}}
"""
