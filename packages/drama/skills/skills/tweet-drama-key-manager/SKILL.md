---
name: tweet-drama-key-manager
description: Use when 仿真人剧变流水线需要检查 JubianAI 登录态、基址、本地剪辑路径或当前用户的项目收费授权范围。
---

# 密钥与配置

剧变登录态是凭据库里的一条引用 `JUBIANAI_ADMIN_TOKEN`，实际值存在产品凭据文件 `${DSH_HOME:-~/.dsh}/.credentials.yaml` 的 `refs:` 段，由设置页（Settings → Jubian）或同名环境变量写入；产品里没有 `secrets/` 目录，不要去找它。从本技能实际目录运行 `python -B scripts/check_keys.py` 按同样顺序解析：环境变量 `JUBIANAI_ADMIN_TOKEN`（兼容旧名 `JUBIAN_TOKEN`）> 凭据文件 > `DSH_PIPELINE_ENV` 指定的文件或工作间最近的 `.agents/secrets/pipeline.env`；只报告来源路径与是否存在，不输出值。基址可选 `JUBIANAI_BASE_URL`。不得把 token 写入项目、日志、命令示例实值或聊天回复。

缺 token 时，在任何变更或收费请求前询问用户；已有 token 时只验证，不重复索取。**token 存在不等于花费授权**，不得继承其他操作者或历史项目的授权。收费须有当前用户对具体项目、操作范围及预算的明确授权；未授权或范围不明时先询问，不能用预算配置代替授权。**在当前用户已明确授权的范围内自主执行，不逐笔征求同意**；调用前自检并登记当前项目归属、正式资产身份、实时规格和目录报价、预计费用与次数、已有任务及授权范围（留档与对账用），调用后用回读的 `realCost` 记账。**换到更贵的渠道或超出项目、操作范围、预算授权时，须先询问并获准再动**；既有预算闸门仍须遵守。超时后先查任务状态，禁止无条件重提。
