---
name: jubian-project-upload
description: 用户要把已有剧本上传或登记到剧变、从稿件创建剧变项目，或新建剧变手动项目时使用。区分文档上传、稿件登记和制作项目创建，核对文件与项目身份，并处理提交后的未知结果。
---

# 剧变上传剧本与创建项目

使用 `jubian_manuscript` 和 `jubian_project`。本地 `drama_project` 只维护本地项目，不会创建剧变项目；图片/音频素材上传也不能代替剧本文档上传。使用 Muse 已配置的剧变账号，不读取或展示 token。账号未配置、过期或没有权限时说明缺项，交给用户在设置或平台处理。

## 先确定文件与用途

沿用用户已给的文件、项目名和设置。只上传用户指定的版本；保留原文件和批注，不自动覆盖或把草稿称为定稿。已有 Word 可原样上传；需要从 TXT/Markdown 转 Word 时，先保存一个新文档并核对正文，转换不能代替内容审阅。`upload_document` 可上传 DOC/DOCX/UTF-8 TXT，但平台稿件登记需要 Word。

需要登记稿件时，先用 `jubian_manuscript options` 读取当前分类标签。登记所缺的版权声明、版权方、原文来源、原文文件、团队、集数和项目类型集中询问一次，复用已有答案。不能从文件名、上传动作或默认选项猜这些信息；不能把同一份文件自动冒充剧本和原文。用户只要求上传时，到已授权的上传或登记步骤结束。

## 上传并登记稿件

1. 为本次明确的上传操作保存稳定 `idempotency_key`，调用 `jubian_manuscript method=upload_document document_path=<已选文件绝对路径> idempotency_key=<原key>`。保留返回的文件名、URL、object_key、SHA-256 和回执位置。上传对象成功并不表示稿件已登记。
2. 剧本和原文各自使用实际上传结果填入 `metadata.manuscriptFile` 和 `metadata.originalFile`。结合 options 的真实标签和用户信息，用另一个固定 key 调用 `jubian_manuscript method=register owner=<produce或editor> metadata=<已核对信息>`。不要自行创建文件 URL 或对象 key。
3. 根据工具返回的核实状态汇报。登记回执未给出精确 ID 时，用 `bindable` 按名称查询并按 total 分页，再用 `get` 核对确切稿件。同名多条必须按真实文件和元数据判断，不能取第一条。无法唯一核实就保留未核实状态。

## 创建项目只选一条路径

项目 `script_style` / `project.scriptStyle` 使用项目风格编码：0=真人写实，1=3d 动漫，2=3d 赛博，3=3d 写实，4=3d 国风，5=厚涂，6=真人古风。按用户已确定的风格对应填写；这些编码与稿件 `scriptFormat` 不是同一组，不能直接照抄。

- 从已登记的剧本创建制作项目：用 `jubian_manuscript method=start_produce manuscript_id=<已核对稿件ID> project=<明确项目表单> idempotency_key=<固定key>`。该操作本身创建项目，不再对同一意图调用 `jubian_project create`。
- 用户明确要求直接新建手动项目：用 `jubian_project method=create`。`produce_type=1` 是绑定真实稿件的内容项目；`produce_type=2` 是用户明确选择的前贴素材用途，不能用它绕过缺失的剧本登记。`production_type`、风格代码、集数和初始分镜数按用户确认的项目设置填写。

保存返回的 `script_id`，再用 `jubian_project get` 核对项目名和稿件绑定。`manuscript_id` 是稿件 ID，`script_id` 是制作项目 ID，二者不能混用。需要接入本地制作时，读取本地项目并通过现有 `drama_project` 更新对应的远端项目 ID；已有不同绑定先说明冲突，不覆盖。

## 超时和重试

上传、登记和创建各自保留原 key。遇到超时、断连或 unknown，调用 `jubian_project method=operation idempotency_key=<原key>` 读取原操作回执；需要当前平台状态时再用只读查询核对。原 key 回放保留最初文件的哈希，不表示后来修改的文件也已上传。不得换 key 或改名重提同一个未明确失败的操作；有回执不等于平台当前状态已核实。

向用户分别报告：上传的文件版本、稿件登记是否核实、项目 ID 及绑定是否核实、仍缺的字段或权限。创建项目不代表已经解析出分集、生成素材或生成视频；后续制作按用户另行提出的范围继续。
