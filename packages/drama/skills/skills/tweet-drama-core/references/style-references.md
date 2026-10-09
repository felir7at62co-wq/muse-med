# 资产参考搜索与角色服化道归档

角色（含主角）、场景、道具和全剧视觉风格都可主动搜索参考。优先沿用用户已指定的合适图片；没有时，Agent 直接检索并审核网上素材，不默认要求用户交图。按年代、角色职业、空间用途、道具形制和项目风格构造搜索词，记录来源页及拟采用的具体元素。场景、道具记录放在项目参考文档中；下文 `style_references.py` 只管理角色服化道，不把其他资产填写成角色。网上图只用于生成参考，不能登记为最终入镜资产；正式资产仍需剧变生成、实际视觉审核、确认出演和当前项目身份回查。当前项目已有合格正式资产时直接复用，不为取得参考图重复收费。

## 来源与归档

网上路径先用 `web_search` 找候选，再用 `web_fetch` 阅读图片来源页和许可页。核对来源页的图片与作者或提供者、明确许可、商业生成参考与提供方上传用途；搜索摘要、图片直链和“可免费下载”字样均不能证明这些权利。不满足用途或无法核实来源时换候选；没有合格候选时只暂停受影响角色并向用户索取。用现有 `pwsh` 或 `bash` 下载图片到项目工作区，`read_image` 实看原图；优先采用可提炼服装、妆发的非身份素材，排除可识别真人身份、品牌标志、独占图案及与剧本不符的内容。不自动安装或启动小红书及定制浏览器。

从 `tweet-drama-core` 实际目录执行，网上图每次导入一张；同角色多来源用第二次命令加 `--append`：

```powershell
python -B scripts/style_references.py <project> <role_id> import-online --name <角色名> --role-class lead --image <下载的本地图片> --source-page <图片介绍页HTTPS地址> --image-url <图片文件HTTPS地址> --license-name <许可名称> --license-url <许可页HTTPS地址> --usage-rights-reason <本次用途的权利依据>
python -B scripts/style_references.py <project> <role_id> check
```

用户提供图片仍用原入口，`--image` 可重复。同一角色选定一种导入路径；更换来源时重新导入会重置该角色批准。

```powershell
python -B scripts/style_references.py <project> <role_id> import --name <角色名> --role-class lead --image <用户图片路径>
```

本地历史人物素材库先用 `jubian-asset-library` 的 `character_candidates.py` 分别检索并确认人脸 ID 与全身造型 ID，再用下面的入口一次归档两张已选图。导入前会重新校验库索引、两张裁图、风格与群像状态；不上传，也不调用生图。它只复制两张选中的图到当前项目，不修改素材库。用户还需实看并明确确认本次选择，不能把导入当成使用批准。

```powershell
python -B scripts/style_references.py <project> <role_id> import-library --name <角色名> --role-class lead --library-root <素材库根目录> --face-id <人脸asset_id> --body-id <全身asset_id>
python -B scripts/style_references.py <project> <role_id> check
```

导入复用 `asset_image_import` 的校验与 PNG 归档，输出在项目 `assets/character/reference_<hash>.png`，不改原图。`asset_style_references.json` 保留其他角色；网上候选的 `origin=online`、`source_url`、`image_url`、`license_name`、`license_url` 和 `usage_rights_reason` 记录来源与用途判断，`note_id=online-<归档图片SHA256>` 绑定归档字节。用户候选的 `origin=user_supplied`、`note_id=local-<归档图片SHA256>` 保留文件来源；素材库候选用 `origin=library`、`library_asset_id`、`library_kind` 和 `source_relative_path` 记录来源，并以归档图摘要绑定选定版本。总控串行更新清单，不并发写入。

## 审核与使用

Agent 用 `read_image` 实看每张归档图，按角色、场次和全剧风格评估服装版型、面料、配色、妆发及使用可行性。逐候选填 `review_status=approved` 或 `rejected`、具体 `review_reason`、非空 `extracted_visual_elements`，写清采用元素和不继承的身份、标志或图案；图片可解码、文件存在、点赞量或检索命中均不能替代判断。网上图在角色级 `review_authority=agent_review` 与 `review_reason` 记录 Agent 核对来源、许可和视觉适配的决定，再填 `style_reference_status=approved`；许可文字与本次上传或商业用途不符时不得批准。用户图和素材库图则向用户展示选用图及提炼结果，取得当前用户明确确认，在角色的 `review_reason` 记录确认内容和可追溯的对话位置，保留 `review_authority=user_confirmation` 后才批准；导入图片本身不等于确认选用。

收费生图前逐角色运行 `check`。它拒绝缺少批准、所选图缺视觉元素或用途记录、路径越界、图片字节变化和网上来源字段不完整；它不联网验证许可文本，也不代替 Agent 实际看图、确认自然语言证据、项目付费授权或预算检查。资产清单的 `style_reference_ids` 引用已采用候选的 `note_id`；生成时只上传这些候选的归档图片，并确认图片尺寸满足剧变上传要求。网上素材不得以 `jubian_asset register` 登记为正式资产，也不得直接用于分镜；生成图仍要视觉审核、确认出演和身份回查。该检查是技能工作流前置，不是 `jubian_video` 工具内的付费拦截。

用户明确选择并自行准备合法小红书运行时及独立账号端点时，可消费其既有候选格式，同样逐图审核并取得用户确认后再检查。不得用旧服务健康响应冒充当前账号归属。
