# Agent Note: 在剧变工具执行时检查角色参考图审核

Status: proposed

[English](2026-10-08-character-reference-approval-at-tool-execution.md) | 中文

## Problem

[角色参考图检查脚本](../../../../packages/drama/skills/skills/tweet-drama-core/scripts/style_references.py)在被调用时会拒绝待审核、已拒绝、记录缺失、文件改变和身份不符的证据。[技能流程](../../../../packages/drama/skills/skills/tweet-drama-core/references/style-references.md)要求 Agent 在收费生图前调用它。剧变工具执行器没有调用该检查，因此 Agent 跳过此步骤后，仍可能上传有效的待审核图片或提交参考图 URL；现有文件、请求和预算检查与审核是不同约束。[Muse 独立 Desktop 决策](../../implemented/architecture/2026-09-23-muse-med-independent-desktop.zh.md)也明确指出当前检查是技能流程前置步骤，并非收费工具的授权检查。

## Proposal

在可上传受管理图片的剧变操作，以及可使用其 URL 的每个生图操作中执行审核约束。项目中的 `asset_style_references.json` 继续作为审核状态依据。Agent 自报的 `approved`、来源标签或过去一次 `check` 的成功输出均不能直接授权。

### Current entry points

[`jubian_asset upload_reference`](../../../../packages/jubian/tool-jubian/src/methods.ts)目前接收 `image_path` 并调用 `uploadReferenceMethod`，没有项目或角色参数。[`jubian_video image_generate`](../../../../packages/jubian/tool-jubian/src/methods.ts)接收 `script_id`、资产身份、`prompt`、有序 HTTPS URL 列表 `references` 和 `idempotency_key`，随后构造收费的 `/aigc/asset` 请求。`image_generate_batch` 逐项调用同一生图方法，也必须在任何一项发送前检查。[工具注册处](../../../../packages/jubian/tool-jubian/src/index.ts)检查必需参数，并对其他操作使用 `tools/pre-execute` 钩子；目前没有角色参考图审核。

### Identity and records

对启用约束的项目，工具应从可信的执行上下文确定规范化项目目录，复用 `validateProjectBinding` 与 `project_config.json:jubian_script_id` 绑定，并要求角色和候选 ID 对应此项目清单中的记录。上传前比对归档文件的规范化路径、SHA-256 与当前角色及候选审核状态。生图前通过工具自己保存的上传关联记录核对每个受管理 URL；记录包含项目目录、`script_id`、角色 ID、候选 `note_id`、归档文件 SHA-256、返回 URL 和审核记录指纹。剧变模块只在上传成功后写入此关联，并在每次构造收费请求前读取；drama 脚本继续维护审核清单。关联记录本身不代表持续批准：每次都要重新读清单，使撤销审核在下一次生成前生效。

工具应通过绑定项目中的真实文件路径、清单记录和文件字节识别受管理图片，通过自己记录的上传结果识别受管理 URL。路径前缀、文件名或调用方自报来源都不够。为防止 Agent 省略新增字段而绕过启用约束的项目，项目绑定与启用状态必须来自 Host 或项目状态，不能取决于 Agent 是否传可选参数。未启用的项目在迁移参考图前保持现有工具行为。

### Refusals and compatibility

在启用约束的项目中，待审核、已拒绝、记录缺失或不可读、文件缺失或改变、角色或项目不符、未知的受管理 URL，以及批准被撤销，都必须在上传对象或提交 `/aigc/asset` 前拒绝。URL 关联缺失时应重新完成审核后的上传，不能直接信任 URL 字符串。现有直接 URL 与非素材库参考图需要明确的迁移或已审核外部参考图入口；旧项目暂时保持原行为。维护方还需决定：在启用约束的会话中，是否要求每次参考图上传都绑定项目，因为任意复制到项目外的文件无法仅凭字节可靠判定来源。本方案不声称能阻止其他工具或外部客户端上传，也不声称能限制未启用项目使用任意 URL 生成。

## Alternatives considered

**只加强技能措辞或依赖 `check` 输出。** 直接调用工具会跳过说明；审核撤销或文件改变后，过去的成功结果也会过期。

**只过滤本地素材库路径。** 复制图片到别处或传入已上传的 URL 都可绕过路径过滤；一概禁止路径又会影响已有的用户参考图。

**立即拒绝所有项目的全部 URL。** 在迁移方式确定之前，这会破坏已有网上和用户提供参考图的流程。

## Acceptance criteria

- 通过已注册的工具执行器验证：待审核、拒绝、记录缺失、文件改变、跨角色、跨项目和撤销批准时，模拟对象上传和模拟 `/aigc/asset` 的调用次数均为 0。
- 明确标记的已批准合成夹具只上传一次并记录准确 URL 关联；仅当当前审核与项目绑定仍一致时，单项和批量生图才可继续；提供方调用全部使用 mock。
- 直接 URL 和旧项目测试固定选定的兼容规则，不能把 Agent 自报来源当作证据。
- 真实 Host 路径也在副作用前返回同样的拒绝；不需要真实上传或收费生成。

## Risks

所有角色参考图都要求项目上下文会改变现有工具输入，合法直接 URL 需要迁移。按项目启用可降低兼容影响，但无法管理外部工具或未启用项目。上传关联必须原子写入，审核改变后不能把它当作永久许可。本提案不授权建立大型权限系统，也不授权人物素材库 worktree 修改剧变维护方代码。
