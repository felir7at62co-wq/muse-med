"""
大纲AI校验与优化服务 V2.0 (结构化检查清单)

V2.0改进:
- 用明确的pass/fail检查项替代抽象评分
- 11个必须项 + 3个建议项
- 每项有明确的通过条件和失败示例
- 可追溯、可复现、可解释
"""
import json
import logging
from typing import Dict, Any, List, Optional
from ..models.llm import get_llm

logger = logging.getLogger(__name__)


# === 标准检查清单定义 ===

STANDARD_CHECKS = [
    # === 结构类(必须项) ===
    {
        "id": "has_episode_count",
        "name": "明确集数",
        "category": "structure",
        "required": True,
        "check_prompt": "大纲中是否明确说明总集数?",
        "pass_condition": "必须包含明确的总集数(如50集、80集)",
        "fail_examples": ["集数待定", "若干集", "不确定"]
    },
    {
        "id": "episode_count_reasonable",
        "name": "集数合理",
        "category": "structure",
        "required": True,
        "check_prompt": "集数是否在合理范围?",
        "pass_condition": "30-100集之间",
        "fail_examples": ["10集(太少)", "200集(太多)"]
    },
    {
        "id": "has_clear_structure",
        "name": "结构完整",
        "category": "structure",
        "required": True,
        "check_prompt": "是否包含完整的故事结构?",
        "pass_condition": "必须有开端、发展、高潮、结局四部分",
        "fail_examples": ["只有开端和发展", "跳过高潮直接结局"]
    },
    
    # === 剧情类(必须项) ===
    {
        "id": "mainline_clear",
        "name": "主线清晰",
        "category": "plot",
        "required": True,
        "check_prompt": "主线剧情是否清晰可追踪?",
        "pass_condition": "有明确的主角目标和冲突线",
        "fail_examples": ["主线模糊", "多条主线混乱", "主角目标不明"]
    },
    {
        "id": "conflict_escalation",
        "name": "冲突递进",
        "category": "plot",
        "required": True,
        "check_prompt": "冲突是否层层递进?",
        "pass_condition": "冲突强度应从低到高,有节奏感",
        "fail_examples": ["冲突强度持平", "高潮前冲突下降"]
    },
    {
        "id": "ending_logical",
        "name": "结局合理",
        "category": "plot",
        "required": True,
        "check_prompt": "结局是否合理收尾?",
        "pass_condition": "主线冲突得到解决,不能烂尾",
        "fail_examples": ["主线未解决", "突然草草收尾", "开放式结局但未铺垫"]
    },
    
    # === 人物类(必须项) ===
    {
        "id": "protagonist_clear",
        "name": "主角明确",
        "category": "character",
        "required": True,
        "check_prompt": "是否有明确的主角?",
        "pass_condition": "必须有1-2个明确的主角",
        "fail_examples": ["群像戏无主角", "主角不明确"]
    },
    {
        "id": "character_consistent",
        "name": "人设自洽",
        "category": "character",
        "required": True,
        "check_prompt": "人物设定前后是否一致?",
        "pass_condition": "性格、能力、背景不能前后矛盾",
        "fail_examples": ["前面懦弱后面突然勇敢(无铺垫)", "前面是穷人后面突然变富(无解释)"]
    },
    {
        "id": "relationship_logical",
        "name": "关系合理",
        "category": "character",
        "required": True,
        "check_prompt": "人物关系是否合理?",
        "pass_condition": "人物间的关系符合逻辑,无矛盾",
        "fail_examples": ["A和B是仇人又是好友(无解释)", "父子关系但年龄只差5岁"]
    },
    
    # === 逻辑类(必须项) ===
    {
        "id": "timeline_coherent",
        "name": "时间线连贯",
        "category": "logic",
        "required": True,
        "check_prompt": "时间线是否连贯无倒错?",
        "pass_condition": "事件顺序合理,无时间跳跃矛盾",
        "fail_examples": ["前面冬天后面突然夏天(无时间跨度说明)", "孩子出生前父母就去世"]
    },
    {
        "id": "logic_consistent",
        "name": "逻辑自洽",
        "category": "logic",
        "required": True,
        "check_prompt": "是否有明显逻辑bug?",
        "pass_condition": "无明显逻辑漏洞和常识错误",
        "fail_examples": ["古代用手机", "现代剧提到清朝皇帝", "死人复活(非奇幻设定)"]
    },
    {
        "id": "cause_effect_clear",
        "name": "因果关系",
        "category": "logic",
        "required": True,
        "check_prompt": "事件之间的因果关系是否清晰?",
        "pass_condition": "重要事件有清晰的因果关系",
        "fail_examples": ["A突然做B(无动机)", "C的转变无铺垫"]
    },
    
    # === 质量类(建议项,非必须) ===
    {
        "id": "emotion_line_exists",
        "name": "情感线存在",
        "category": "quality",
        "required": False,
        "check_prompt": "是否有情感线?",
        "pass_condition": "建议有爱情/亲情/友情线之一",
        "fail_examples": []
    },
    {
        "id": "villain_motivated",
        "name": "反派有动机",
        "category": "quality",
        "required": False,
        "check_prompt": "反派动机是否合理?",
        "pass_condition": "建议反派有合理动机,不是纯脸谱化",
        "fail_examples": []
    },
    {
        "id": "pacing_reasonable",
        "name": "节奏合理",
        "category": "quality",
        "required": False,
        "check_prompt": "节奏是否合理?",
        "pass_condition": "建议高潮不要太早(不在前1/3),不要太晚(不在最后5集)",
        "fail_examples": []
    }
]


def _get_check_item_by_id(check_id: str) -> Optional[Dict[str, Any]]:
    """根据ID获取检查项定义"""
    for item in STANDARD_CHECKS:
        if item["id"] == check_id:
            return item
    return None


async def validate_v2(
    outline_json: Dict[str, Any],
    custom_checks: Optional[List[Dict[str, Any]]] = None
) -> Dict[str, Any]:
    """
    V2校验: 逐项检查,返回详细结果
    
    Args:
        outline_json: 大纲JSON
        custom_checks: 自定义检查项(可选)
        
    Returns:
        {
            "overall_passed": bool,  # 所有必须项都通过
            "required_passed": int,  # 通过的必须项数量
            "required_total": int,   # 必须项总数
            "optional_passed": int,  # 通过的建议项数量
            "optional_total": int,   # 建议项总数
            "failed_items": List[Dict],  # 未通过的项
            "all_results": List[Dict]    # 所有检查结果
        }
    """
    # 合并标准检查项和自定义检查项
    checks = STANDARD_CHECKS.copy()
    if custom_checks:
        checks.extend(custom_checks)
    
    results = []
    
    for check_item in checks:
        # 构造针对性检查prompt
        fail_examples_text = ""
        if check_item.get("fail_examples"):
            fail_examples_text = f"\n失败示例: {', '.join(check_item['fail_examples'])}"
        
        prompt = f"""你是剧本策划专家。请检查以下大纲中的【{check_item['name']}】。

大纲:
{json.dumps(outline_json, ensure_ascii=False, indent=2)}

检查项: {check_item['name']}
检查要求: {check_item['check_prompt']}
通过条件: {check_item['pass_condition']}{fail_examples_text}

请返回JSON:
{{
  "passed": true/false,
  "reason": "具体原因(如果不通过,说明哪里不符合;如果通过,简要说明符合点)"
}}
"""
        
        try:
            llm = get_llm(provider="gpt5", temperature=0.1)
            result = await llm.ainvoke(prompt)
            
            check_result = json.loads(result.content)
            results.append({
                "id": check_item['id'],
                "name": check_item['name'],
                "category": check_item['category'],
                "required": check_item['required'],
                "passed": check_result['passed'],
                "reason": check_result['reason']
            })
            
            logger.info(f"Check {check_item['id']}: {'PASS' if check_result['passed'] else 'FAIL'} - {check_result['reason']}")
            
        except json.JSONDecodeError as e:
            logger.error(f"Failed to parse AI response for check {check_item['id']}: {e}")
            results.append({
                "id": check_item['id'],
                "name": check_item['name'],
                "category": check_item['category'],
                "required": check_item['required'],
                "passed": False,
                "reason": "AI返回格式错误,无法解析"
            })
        except Exception as e:
            logger.error(f"Error checking {check_item['id']}: {e}")
            results.append({
                "id": check_item['id'],
                "name": check_item['name'],
                "category": check_item['category'],
                "required": check_item['required'],
                "passed": False,
                "reason": f"检查过程出错: {str(e)}"
            })
    
    # 汇总结果
    required_items = [r for r in results if r['required']]
    failed_required = [r for r in required_items if not r['passed']]
    
    optional_items = [r for r in results if not r['required']]
    failed_optional = [r for r in optional_items if not r['passed']]
    
    return {
        "overall_passed": len(failed_required) == 0,
        "required_passed": len(required_items) - len(failed_required),
        "required_total": len(required_items),
        "optional_passed": len(optional_items) - len(failed_optional),
        "optional_total": len(optional_items),
        "failed_items": failed_required + failed_optional,
        "all_results": results
    }


async def optimize_v2(
    outline_json: Dict[str, Any],
    validation_result: Dict[str, Any]
) -> Dict[str, Any]:
    """
    V2优化: 针对failed项逐个修复
    
    Args:
        outline_json: 原大纲
        validation_result: validate_v2的返回结果
        
    Returns:
        优化后的大纲(JSON格式)
    """
    failed_items = validation_result.get('failed_items', [])
    
    if not failed_items:
        logger.info("No failed items, no optimization needed")
        return outline_json
    
    # 构造优化prompt
    failed_descriptions = []
    for i, item in enumerate(failed_items):
        check_def = _get_check_item_by_id(item['id'])
        if check_def:
            failed_descriptions.append(
                f"{i+1}. 【{item['name']}】未通过\n"
                f"   原因: {item['reason']}\n"
                f"   要求: {check_def['pass_condition']}"
            )
        else:
            failed_descriptions.append(
                f"{i+1}. 【{item['name']}】未通过\n"
                f"   原因: {item['reason']}"
            )
    
    failed_text = "\n\n".join(failed_descriptions)
    
    prompt = f"""你是剧本策划专家。以下大纲存在{len(failed_items)}个问题需要修复:

原大纲:
{json.dumps(outline_json, ensure_ascii=False, indent=2)}

需要修复的问题:
{failed_text}

请优化大纲,针对性修复上述问题,但保持以下不变:
1. 题材和主题
2. 主角人设核心
3. 整体框架

返回优化后的完整大纲(JSON格式)。
"""
    
    try:
        llm = get_llm(provider="gpt5", temperature=0.3)
        result = await llm.ainvoke(prompt)
        
        optimized = json.loads(result.content)
        logger.info(f"Optimization completed, {len(failed_items)} issues addressed")
        return optimized
        
    except json.JSONDecodeError as e:
        logger.error(f"Failed to parse optimized outline: {e}")
        return outline_json
    except Exception as e:
        logger.error(f"Error during optimization: {e}")
        return outline_json


# === 向后兼容的V1接口 ===

async def validate(outline_json: Dict[str, Any]) -> Dict[str, Any]:
    """
    V1兼容接口: 返回简化的passed/issues格式
    
    内部使用V2逻辑,但返回V1格式以保持向后兼容
    """
    logger.warning("Using deprecated V1 validate() interface, consider migrating to validate_v2()")
    
    v2_result = await validate_v2(outline_json)
    
    # 转换为V1格式
    issues = [f"{item['name']}: {item['reason']}" for item in v2_result['failed_items']]
    
    return {
        "passed": v2_result['overall_passed'],
        "issues": issues
    }


async def optimize(outline_json: Dict[str, Any], issues: List[str]) -> Dict[str, Any]:
    """
    V1兼容接口: 接受issues列表
    
    内部转换为V2格式后调用optimize_v2
    """
    logger.warning("Using deprecated V1 optimize() interface, consider migrating to optimize_v2()")
    
    # 将V1的issues转换为V2的validation_result格式
    failed_items = []
    for issue in issues:
        # 简单解析 "名称: 原因" 格式
        parts = issue.split(":", 1)
        if len(parts) == 2:
            failed_items.append({
                "id": "unknown",
                "name": parts[0].strip(),
                "reason": parts[1].strip(),
                "required": True
            })
        else:
            failed_items.append({
                "id": "unknown",
                "name": "未知问题",
                "reason": issue,
                "required": True
            })
    
    v2_validation_result = {
        "overall_passed": False,
        "failed_items": failed_items
    }
    
    return await optimize_v2(outline_json, v2_validation_result)