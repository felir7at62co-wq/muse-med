# 镜流后端

[English](README.md) | 中文

镜流是 Muse 的制片引擎。其 FastAPI 服务接入视频、图片、配音、语音识别、超分和字幕擦除的生成供应商。任务队列对重复提交去重，并按积分账本结算每个任务的花费。数据库保存项目、分集、镜头、资产、站位图、字幕和音频。一键批量流程把一个制片步骤应用到整集。

## Muse 如何调用

Muse 通过已登录的[镜流连接](../../packages/drama/jingliu-connection/README.zh.md)访问制片站的 `/fwp/v2` 接口。包括 `jingliu_run` 在内的[镜流工具](../../packages/drama/tool-jingliu/README.zh.md)从 `GET /desktop-agent/tools` 读取流程目录，用 `POST /desktop-agent/quote` 报价，再用 `POST /desktop-agent/tool` 执行。Muse 的制片面板使用同一连接。

## 来源

此目录基于云端发布 `20261121-jingliu-mkwait-01` 的后端，该发布即 2026-11-17 工作台备份加上五项已部署改动。镜头脚本改由 Muse 撰写并锁定，取代镜流自己的提示词撰写。存库的报错、任务结果和日志中的密钥已脱敏。`FW_ARK_TRUSTED_ASSETS` 把人像参考图入库交给模型网关，首帧生成已下线。站位图单独保存并绑定到镜头。字幕擦除等待火山 MediaKit 出片的上限放宽；字幕擦除和超分在状态查询失败时继续轮询，也不再发送取消请求，因为该接口不支持取消。

此目录中云端尚未运行的改动：

- 一步出字幕：`run_auto_subtitles` 可以只处理一集（`episode`）。转写镜头原声时，它用每个镜头剧本里的台词逐字纠正该镜头的转写结果，不调用模型（`align_script`，默认开启；旁白音频不纠正）。时间与断句来自声音，没念的台词不补，多念的保留。夹在对得上的字中间的一小处，只有两边按 pypinyin 带声调的读音相同、所含的否定字也相同时才换成剧本的字，阿拉伯数字按中文念法比较。改了会多出或少掉否定的一处，读音相同也按听到的保留，如「这不行啊」对剧本「这步行啊」。读轻声的「的」「地」「得」「了」，和另一边那个字声母韵母相同的任一读音都算相同；别的轻声字不算，因为「这是你吗」对「这是你妈」是问句对陈述。落在角色名或剧本说话人名里的字不比声调，并且可以取任一读音。「一」和「不」和别的字一样比声调，因为 pypinyin 只给部分词标出它们的变调：它把「一个」读作 yi2，「一样」却读作 yi1。其他声调不同的字（如「买」对「卖」）按听到的保留，不论在这一镜的什么位置都列进核对清单。
- 字幕核对清单：`script_check.review` 列出需要人核对的镜头：剧本有台词却什么都没听到的、与剧本的相似度低于 0.5 的、剧本里有 4 个字以上没念出来的、有因读音不同而按听到的保留的差异的（`differs`）、有需要人判断而按听到的保留的差异的（`doubts`），以及按剧本改过字的（`fixes`）。`doubts` 收录每一处两边一样长、逐字声母韵母相同，并且读音相同或只差轻声或「一」「不」的声调的保留的差异，不论在这一镜的什么位置：要由人分辨是听错还是念了别的字。其中有读音相近的否定变化，如「这不行啊」对「这步行啊」、「我全不要了」对「我全部要了」和「他们不对啊」对「他们部队啊」；有轻声，如「这是你吗」对「这是你妈」；也有读音相同、但旁边对得上的字太少而没有改的，如「林辰林辰」对「林晨林晨」。`differs` 收录其他每一处夹在对得上的字中间、读音不同的差异，以及其他每一处和剧本只差声调的保留的差异，如「你买不买」对「你卖不卖」，其中每个「买」旁边只有一个对得上的字。`doubts` 还收录其他每一处含否定字（不 没 别 未 非 无 莫 勿 甭 否）的多念、没念或保留的差异，缺的一边记为空字符串：「他是坏人」对剧本「他不是坏人」相似度很高，意思却相反，可能是识别漏了「不」，也可能是视频模型把台词念反了。转写或剧本不超过 3 个字的镜头里其他保留的差异也收录进来（如「林辰」对「林晨」）：对不上的字周围对得上的字太少，分不出是听错还是念了别的字。其他多念的字、更少的没念出来的字和其他保留的差异只计入字数统计。剧本里没有「角色：台词」格式台词的镜头计入 `no_script_shots`，在任务提示中只说一次。清单先列和剧本对不上的镜头，最多 300 个，再补只按剧本改过字的镜头，直到满 60 条。`review_count` 给出全部条数，`omitted_mismatch_shots` 和 `omitted_fix_shots` 给出没列进来的镜头数，任务提示最多写出 20 个对不上的镜头的镜号。
- 字幕用火山语音识别：设置 `FW_DRAMA_ASR_CONFIG` 后，字幕任务改用火山极速版语音识别，不再使用百炼 Paraformer 和 Whisper。通道在任务开始时选定，调用失败不会换到别的通道。变量的值是一个 JSON 文件的路径，文件中保存火山语音应用的 `appId` 和 `accessToken`。镜流只从进程环境读取这个变量，因此要通过 systemd 单元的 `Environment=` 或 `EnvironmentFile=` 设置；配置加载器会忽略 `backend/.env` 中的这一项。字幕只走极速版：文件中的 `routes.subtitles` 写的是标准版时，火山字幕通道保持关闭。每个镜头的音频不能超过文件中的 `maxAudioBytes` 和 `maxDurationSeconds`。火山每句话返回一段，任务按标点切开长句，并按字数分配时长。字幕调用不受每账号每日上限 `maxDailyJobs` 和 `maxDailySeconds` 约束；在定下语音识别价格之前，`auto_subtitles` 任务不扣积分（报价为 0）。
- 配置错误与转写接口：同一个变量会把镜流 `/v2/drama/asr/jobs` 下的转写接口从百炼 Paraformer 切换到火山，此后读取仍在进行的 Paraformer 任务会返回 503。文件不存在时，这些接口继续使用 Paraformer。文件无法读取时（坏 JSON、缺 `appId`、值的类型不对、没有读文件或进目录的权限），对它们的每个请求都返回 503（即使配置了百炼），并记录错误。两种情况下火山字幕通道都保持关闭，镜流在每个进程中只记录一次文件路径和错误类型，`GET /v2/asr/status` 在 `volc_config_error` 中报告错误类型，没有其他通道时字幕任务的报错会写明这一原因。
- 额度中的扣费开关：`budget.my_balance`（`GET /v2/budget/me`）和智能体工具 `get_my_balance` 返回 `enforced`，即 `FW_BUDGET_ENFORCED` 是否扣费并拦下生成。它为 false 时，余额为 0 也不会停止生成。
- 剧变生图模型与每张图只扣一次：Nano Banana Pro 在剧变网关上可用。剧变网关有 `gemini-3-pro-image`，没有 `gemini-3-pro-image-preview`；只有网关回答第一个名字不存在或没有可用渠道时，镜流才换用第二个名字。在剧变上，`gpt-image-2` 多一个备用名 `gpt-image-2-high`；`gpt-image-2.5`、`gpt-image-2.6`、`nano-banana`、`nano-banana-2.1` 和 `nano-banana-2-lite` 可以选用，但不作默认。这些只在剧变上有的名字，只在网关主机是 `jubianai.net` 或其子域名时使用。备用名，以及 Gemini 从 native `generateContent` 改走 `chat/completions`，都只在上游没有受理请求时使用。GPT 生图接口和 Gemini 接口返回非 200 时，只有状态码 408 和 429 会重试。`n` 大于 1 时，已经拿到一部分图之后出错，交回已有的图，丢掉的不再补发。默认值和环境变量都不变，新模型每张图的价格与其他模型相同。
- 生图单价：每张生成的图由 15 分改为 25 分（¥0.25），所有生图模型同价。价格只在 `pricing.IMAGE_PER_PIC` 一处设定，报价和扣费流水里的「生图 n 张 × 0.25 元」由它换算。改价之前记下的用量行保留原价。
- 每张图都扣积分：自由生图任务（`kind` 为 `image`，制片站生图页和 Muse 的 `jingliu_image` 提交的就是它）、资产弹窗的场景多视角和智能体工具 `generate_scene_views` 在提交时预扣积分，并按任务记下的出图张数结算；任务失败全额退还。用同一个 call id 重发 `generate_scene_views` 会接管它已提交的任务，不再预扣。这几条路此前不收费。自由生图任务按 `n` 预扣 1 到 4 张，Midjourney 任务固定 4 张；不带 `n` 的报价是一张图的价格，由 Muse 乘以张数。场景多视角的报价按点名的视角数算，不点名时按全部视角算。资产候选图按张数（最多 4 张）报价，不再按项目镜头数；兼容旧版的造型候选图同步接口按实际出的张数（最多 9 张）扣费；不带 `kinds` 的要素补全按缺图张数预扣，不再按每个镜头一张。和其他扣费任务一样，`FW_BUDGET_ENFORCED` 关闭时一分不扣；开启时，没有积分账户或余额不足的用户生成这些图也会收到 402。
- 生图请求受理后不重发：GPT 生图接口或 Gemini 接口返回 200 之后，或 Midjourney、RunningHub 的提交被受理之后，除审核拒绝外的每一种失败都以 `AcceptedFailure` 结束，包括取图失败、响应解析不了、任务超时或失败，以及任何意外错误。此时镜流不重发请求、不换名、不冷却该渠道，也不再试下一条渠道，报错写「上游已受理但未取回图片，请稍后重试」，不再建议增加 API KEY 或提升配额。只有从网关完整错误响应体解析出的标记表明模型不存在或没有可用渠道时，才试备用名；只凭报错文本不再算数。Midjourney 或 RunningHub 任务的某次状态查询失败时，等下一次查询；提交 RunningHub 任务时出现网络错误，和别家供应商一样算渠道故障。Gemini 最多返回 `n` 张图，同一个 chat 响应里重复的图只留一张，chat 请求遇到第一个没有图的 200 就不再发送。只有 PNG、JPEG、GIF 和 WebP 数据会落盘并计入用量；一张都没有的响应以 `AcceptedFailure` 结束。每一次下载（图片链接、Midjourney 和 RunningHub 的产出、http 参考图）都由镜流自己跟随跳转，最多 5 跳；每一跳都必须是 http 或 https，并且只解析到公网地址；单次下载最多 50 MiB、180 秒。链接中含 `/media/uploads/`、`/media/outputs/` 或 `/media/generated/` 的参考图仍从镜流自己的媒体存储读取，不按链接下载。
- 下载地址检查：公网地址检查解析的正是 httpx 要连接的主机名（`httpx.URL(url).raw_host`，按 IDNA 2008 编码），而不是网址里的 Unicode 主机名（Python 解析器按 IDNA 2003 编码它），因此含 ß、ς 或零宽连接符的主机不能再以一种编码通过检查、以另一种编码被下载。内嵌 IPv4 地址的 IPv6 地址（`::ffff:a.b.c.d`、`::a.b.c.d`、SIIT `::ffff:0:a.b.c.d` 和 NAT64 `64:ff9b::a.b.c.d`）按其中的 IPv4 地址检查；6to4 `2002::/16`、Teredo `2001::/32` 和本地 NAT64 `64:ff9b:1::/48` 一律拒绝，不论所用 Python 版本自己的规则如何。解析不了或查不到的地址，如 `http://[127.0.0.1]/`、空标签或超过 63 个字符的标签，按不安全拒绝。参考图缺失时，报错先写缺几张和该怎么做，再写其中几张因地址不安全被拒（「其中 K 张地址不安全被拒」），最后才是链接末尾，因此 `jobs.py` 截到 200 个字符时操作提示仍在。检查和 httpx 分别解析主机名，所以两次解析之间改变答案的名字（DNS 重绑定）检查不出来。
- 媒体进桶：每个写入点在文件写完之后、任务标记完成之前就把它传进 TOS，并记入 `media_objects` 台账。覆盖图片、每条视频通道、高清放大、去字幕、配音、缩略图、抽出的音轨、场景设定板、上传素材，以及剪映与资产导出包；图片直接用内存里的字节上传。上传失败只记一行日志，文件留给每五分钟一轮的巡检补传；巡检跳过两分钟内写出的文件，只传 `<目录>/<文件名>` 形式的文件。没配桶时一切不变。`FW_TOS_DIRS` 的默认值是 `generated`、`uploads`、`character-references` 和 `exports`，因此角色参考图与导出包（`exports/jianying/<文件名>`）各自在自己的前缀下进桶；导出包在桶里与本地一样保留 30 分钟。zx1 chat 视频通道下载失败时再试两次，仍失败就判这一镜失败，不再把供应商会过期的链接存进库。清理把 `asset_image_versions.image_url` 和 `shots.profile_override.refs` 里的参考图算作被引用。巡检把库备份复制到私有前缀 `backups/`，本地备份过期时一并删掉桶里那份。`/media` 对库文件、备份和以点开头的文件名一律返回 404。每次上传、回填或核对失败记一行不含链接与密钥的日志，每轮巡检记一行计数。
- 媒体接口：`POST /v2/media/resolve` 接收最多 200 个 `/fw/media/...` 或 `/fwp/media/...` 路径，按同样的顺序回答。桶里的文件得到 1 小时有效的预签名 GET 链接，以及 `size`、`etag`、`content_type` 和 `expires_at`；只在服务器磁盘上的文件，或没配桶时任何存在的文件，得到 `local: true`；其余得到 `error`：`invalid`、`not_in_tos`（桶不管的目录，如 `outputs/`）或 `not_found`。`POST /v2/media/upload-url` 接收 `filename`、`content_type`、`size` 和可选的 `project_id`，返回 15 分钟有效的预签名 PUT 链接、要带上的请求头、永久路径 `/fw/media/uploads/<id>.<ext>` 和一个令牌。它接受 50 MiB 以内的 PNG、JPEG、WebP 图片，200 MiB 以内的 MP3、WAV、AAC、M4A 音频和 1 GiB 以内的 MP4、MOV、MKV、WebM 视频；其他类型返回 415，超过上限返回 413，扩展名与类型不符返回 400，没配桶返回 503。`POST /v2/media/upload-complete` 接收路径和令牌，核对对象的大小、Content-Type 和图片的文件头，不符就删掉对象并返回带 `reason` 的 422；否则记入台账，上传时指定了项目的再登记进该项目的素材池，并返回 `path` 和 `size`。这些接口的登录与项目档位要求和其他 `/v2` 路由相同。所有链接都签在 `FW_TOS_PUBLIC_ENDPOINT` 上，它默认等于 `FW_TOS_ENDPOINT`。
- 本地副本：`FW_MEDIA_KEEP_LOCAL=false` 时，任务结束时删掉它写出或回填的文件的本地副本；另一个仍在运行的任务读过的文件，由那个任务结束时再删。其他本地副本由巡检在满一小时后删除。只有台账和一次 HEAD 请求都表明桶里有同样大小的文件时才删本地副本，之后要用文件的代码经 `media.ensure_local` 从桶里取回。默认值 `true` 保留所有本地副本。

除这些改动、Muse 登录适配和以下几处外，`backend/app` 与该发布逐字节一致：`app/at_refs.py`、`app/auth.py`、`app/budget.py`、`app/jobs.py`、`app/notify.py`、`app/routers/library.py`、`app/routers/shots.py` 和 `app/user_directory.py` 的注释与文档字符串用占位值代替用户和管理员的姓名、一个昵称和 IP 地址，`app/config.py` 中 `feishu_notify_contact` 的默认值是「管理员」，而不是一位管理员的姓名。

登录适配不在此目录中，由 [`../muse-workbenches/install.py`](../muse-workbenches/install.py) 在安装时写入发布副本。云端发布包含适配中的登录和共享素材库改动，但不包含安装器对剪映导出的适配。

## 目录结构

| 路径 | 内容 |
|---|---|
| `backend/app/` | FastAPI 应用，以 `app.main:app` 启动 |
| `backend/tests/` | pytest 测试；`tests/data` 存放文本夹具 |
| `backend/scripts/` | 静态代码检查，以及配乐库和音效库的导入脚本 |
| `backend/requirements.txt` | 固定版本的依赖 |

## 测试与静态检查

云端运行环境使用 Python 3.12。在仓库之外创建虚拟环境，并在 `backend/` 下运行：

```sh
uv venv --python 3.12 ~/.venvs/jingliu
uv pip install --python ~/.venvs/jingliu/bin/python -r requirements.txt pytest pyflakes
~/.venvs/jingliu/bin/python -m pytest -p no:cacheprovider tests
~/.venvs/jingliu/bin/python scripts/check_undefined_names.py
```

测试使用临时 SQLite 数据库和数据目录，不访问网络。仓库根目录的 `pytest.ini` 让 pytest 以仓库根目录为根目录，因此用 `-p no:cacheprovider` 避免 pytest 在那里写入 `.pytest_cache`。`check_lazy_imports.py`、`check_module_attrs.py` 和 `check_self_misuse.py` 只解析 `app/` 的源码，不导入它。`check_undefined_names.py` 用同一个解释器调用 pyflakes，因此该解释器中必须装有 pyflakes；没有装时这项检查会报告通过。

## 仓库属性

根目录的 `.gitattributes` 涉及八个导入文件。三个 `jianying_pack/*.bat` 设为 `-text`，因此 Git 不会转换 Windows 用户收到的 CRLF 换行。五个应用文件保留已部署版本中的行尾空格或末尾空行，因此不参与 `git diff --check`。

## 不在仓库中的内容

旧版制片站网页前端只在云端服务器和 11-17 备份中。镜流自己的文档、`backend/tools/`、一次性验证与审计脚本、后端顶层的测试脚本和 A/B 结果文件、Dockerfile 以及镜流原 README 保留在该备份和维护者的本地源码副本中。

## 已知限制与后续工作

Muse 将移除或替换镜流自己的模型驱动步骤、LangGraph 智能体和飞书机器人、Muse 不使用的代码，以及 Muse 账号与镜流账号之间单独的登录和扣费桥接。旧网站保留到 Muse 网页控制台上线。

已部署代码上有两项静态检查不通过。`check_module_attrs.py` 报告 `app/feishu_bot.py` 调用的 `agent_run.ResumeIn` 在 `app/routers/agent_run.py` 中没有定义。`check_undefined_names.py` 报告 `app/routers/shotflow.py:448` 的字符串注解 `"asyncio.Lock"`，其白名单条目记录的是第 395 行。
