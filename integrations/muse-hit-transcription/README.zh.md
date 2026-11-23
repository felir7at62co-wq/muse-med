# 云端热门剧转写

[English](README.md) | 中文

此执行器从 Muse 数据站领取剧目，每次处理一部。数据站管理选材排序和任务租约。需要选材复核时，Muse 检查候选剧目，然后下载并验证全集，每集使用独立的 SDK 会话转写，并将进度回报到数据站。剧本工坊上传的视频使用相同的逐集执行与交付校验。[工坊接入说明](../../services/muse-workbenches/README.zh.md)。

## 运行要求

- 使用 Python 3.11 或更新版本，模块搜索路径指向配套的 Harness Python SDK。使用通过验证的 Linux 发行目录中的 Node 和已构建的 `dsh`。
- 使用专用 SDK 目录及配套的云转写配置，启用语音、视频检查、字幕识别、稿件检查和 Word 导出插件。该隔离部署需提供账号会话及经过验证的媒体和 Office 运行环境。
- 在独立的 `hongguo` 配置中安装常规的红果插件包，并指定 Linux 的 FFmpeg 和 FFprobe 路径。[红果命令行](../../third_party/plugins/muse-hongguo-download/CLI.md)。
- 允许执行器读取数据站的私有服务令牌文件。数据站接口监听本机地址。在执行器主机上使用独立的私有状态目录。

## 启动和检查

复制[配置示例](config.example.json)到部署目录，填写实际路径。`excludeCatalogs` 从已有人工队列读取剧目 ID 并排除重复任务。`onlySeries` 将试跑限定为指定剧目，留空表示可领取任何符合条件的未领剧目。重启时保留 `stateRoot`、`workerId` 和两个配置的主目录。

1. 运行 `python3 -B worker.py /absolute/worker.json --check-runtime` 启动两套配置，检查运行环境。
2. 运行 `python3 -B worker.py /absolute/worker.json --inspect` 查看数据站计数和下一部可领取的剧目。
3. 试跑使用 `--once`，持续服务使用 `--run`。服务使用专用账号和进程组停止策略，给该账号开放状态目录及两个配置目录的写权限。

`publishChecked=false` 将完整底稿留给编辑审核，数据站记录为待处理。已获授权的发布任务可设为 `true`。数据站接收完整 Markdown 正文，执行器保留每集通过校验的 Word。自动校验把原片、语音、完整画面审查和字幕识别与交付文件关联起来，编辑另行评价内容。

## 恢复

中断后保留当前收据和剧目目录。重启后以同一执行器身份核对、续领原任务。下载在冷却期后恢复原下载任务。已校验的集继续复用，未完成的集在原会话、原片、工作区、模型和配置上续跑。每集只允许创建一次语音识别任务，之后读取原收据。归属不明、来源变化、校验缺失或次数用尽时需检查。本执行器以失败或待处理结束的剧，数据站重新排队（立即转写）后沿用已下载原片、已校验的集和逐集记录续跑；其他已有剧目目录不会被领取。Muse 账号网关因镜流积分用完拒绝模型或语音调用（`quota_exhausted`）时，剧目停为待处理并提示「额度已用完，请找组长划拨后再继续」，这一轮不计入本集的尝试次数；因读不到镜流余额而拒绝（`quota_unavailable`）时，在原会话里每 30 秒重试一次，最多 10 次，仍不行再同样停下。供应商自己的 402 按普通失败处理。

进度回报会续租。失去租约后停止当前执行进程。重启后可对照数据站核查未收到响应的回报。逐集收据、全剧清单与最终结果保存在私有剧目目录中。

## Agent 生产

[agent_runner.py](agent_runner.py) 用同一个数据站队列，转写全部交给 Muse agent。它领取一部剧并保持租约，优先用服务器上已有、校验和一致的下载（`mediaCaches`），否则以执行器账号运行本执行器的下载器（`--child <剧号> download`），再把全剧复制到云端 Muse 的工作区，命名为 `原片/NNNN.mp4`。每 `batchSize` 集开一个云端 Muse 会话（预设 `preset`，工作区相同），发一条请求，写明这批集数和交付位置（`episodes/第N集.md`、`qa/第N集-待核.md`、`final/第N集.docx`）；用什么技能、开不开子代理由 agent 自己决定。工作区里没有会话运行、连续两次轮询都如此时，做机械检查：每集要有带场次标题的剧本、完整的逐帧审看记录、语音识别结果和 Word；缺待核文件或台词与语音识别差距过大（`minSpeechCoverage`）只作提醒。缺的部分按集发回同一会话，最多 `followUps` 次；仍不完整的批次把这部剧标为待处理并写明原因，工作区保留。运行超过 `batchTimeoutMinutes` 的批次会被取消后再检查。全剧完成后作为一份 Markdown 剧本发布到数据站，之后删除工作区和执行器下载里的原片。运行器通过云端 Muse 自己的网页接口工作，登录令牌取自 `museUnit` 的日志，因此以 root 运行。

监管 Bot 和运维通过 `<workspaceRoot>/.production/control.json` 控制运行器；文件由运行器按默认值创建并交给 `workspaceOwner`：`paused` 让每部在做的剧都在下一个批次边界停住（租约保持）并且不再领新剧，`dramasAtOnce` 设同时做几部剧（1 到配置里的 `maxDramasAtOnce`，默认 1；每个位置用自己的执行器编号领剧，依次是 `workerId`、`workerId-2` 等，调小后多出的位置做完手上这部再停），`onlySeries` 只领这些剧，`skipSeries` 不领这些剧（红果剧号，带不带 `hongguo:` 都行）；文件读不出时沿用上一次有效的设置。运行器每次轮询都在旁边写 `status.json`：生效的控制设置、`maxDramasAtOnce`、每个位置一行（执行器编号、`stage`，即 `claimed`、`preparing`、`transcribing`、`paused`、`idle` 或带错误码和说明的 `error`，以及当前这部剧的工作区和各批次），还有最近十部的结果和各自的 `retries`。停下的剧重新排队后，已完成的批次保留，未完成的批次在新会话里从头做；`retries` 记录这样的次数。批次的会话空闲后，运行器从 `museSessionsRoot` 下的会话日志读出最后一轮是怎么结束的。正常完成的才做检查；被中断的（被中止，例如云端 Muse 重启；出错，例如服务商或模型适配器故障；或者开始了却没有结束）在同一会话里续做，不计入追问次数，每连续中断一次等待时间翻倍，最长 `resumeBackoffMaxSeconds`；模型调用因额度用完（`quota_exhausted`）被拒时，这部剧改标为待处理。批次请求和每次追问各开一个 `batchTimeoutMinutes` 的时间窗口，续做只受这个窗口限制。云端 Muse 启动满 `museWarmupSeconds` 之前不发任何请求（启动时间用 systemd 的 `--timestamp=unix` 读取）。只有正常完成的一轮之后才计入追问。如果缺的只是语音识别回执还没等到服务返回的集（`prepared`、`processing`、`uncertain` 等状态），运行器等 `asrRetrySeconds` 后请 agent 再查这些回执，不计入追问。每次请求都告诉 agent 用已有的语音识别结果和回执，子代理同时最多开三个。运行器自己早先停下的剧重新排队后，即使别的执行器的租约过期用掉了一次领取次数，也会领回来。打开 `library.enabled` 后，每完成一批，运行器另开一个短会话用 `script_finalize` 把第 1 集到这批最后一集存为这部剧在剧本工坊定稿库里的新版本，标题按 `library.title`（默认 `{title}【转写稿】`），版权为授权改编，原作是这部红果剧；上传没成功时记为 `libraryFailed`，下一批会把所有集再存一次。

## 给 Bot 用的转写工作台

[desk.py](desk.py)（转写工作台）是云端 Muse 里的转写 Bot 当工具调用的数据站对接部分；做哪部剧、交给哪个 Bot、怎么转写、什么时候算完，都由 Bot 决定。它在 Unix 套接字（`socketPath`，属组 `socketGroup`）上每行处理一个 JSON 请求，[desk_mcp.py](desk_mcp.py) 作为 DS Bot 的 MCP 能力登记后提供这些操作：`reserve_list` 按数据站排队顺序列出储备库里待转写的剧、正在被做的剧和工作台手上的剧；`drama_claim` 用 `deskWorkerId` 为指定 Bot 领一部剧并保持租约，在后台按运行器同样的方式准备全集（需要时复核选材，用服务器上校验过的下载或执行器的下载器，放进云端 Muse 工作区的 `原片/NNNN.mp4`），再把这个 Bot 的工作文件夹设到那里，已经拿着一部剧的 Bot 不再派；`drama_status` 报告准备进度、租约，并把运行器的逐集检查作为参考给出，同时刷新数据站进度；`drama_publish` 在每集都通过必需检查后把合并的剧本上架到数据站并删除原片；`drama_release` 带着 Bot 写的原因把剧退回为待处理，已做的保留。状态在 `<stateRoot>/<剧号>/desk.json`；重启后工作台用同一个执行器编号重新领回手上的剧（数据站返回同一个租约），没准备完的接着准备。工作台每 `watchSeconds` 记一次在做的剧里每集第一次通过检查的时间（`doneAt`，剧本管理据此报每集用时）；Bot 的对话空闲、最后一轮是被中断结束的情况连续两次出现时，给这个 Bot 发一条接着做的消息，之后每次再催的间隔翻倍，最长 `resumeBackoffMaxSeconds`。它还记下 Bot 对话每换一段、段内每次上下文压缩，并把每集通过检查时的检查数据连同当时所在的段和压缩次数存下来；`drama_status` 用 `quality` 报告这些数据（每个阶段的平均语音覆盖率和有待核文件的比例），用 `usage` 报告 Bot 接这部剧以来用掉的模型 token（领剧时的 DS Bot 用量汇总与现在之差，总量和每完成一集的平均）、这部剧的语音分钟数，`prices` 里有这个 Bot 的模型（每百万 token 的价格）时再报元。每集第一次通过时还会存下 Bot 当时的用量，所以 [desk_report.py](desk_report.py) `<desk 配置> <剧号> [起 止] [--json 输出]` 能按集列出距上一集通过的分钟数和花费、覆盖率、逐帧审看规模、有无待核文件，并给出这段集数的中位数，用来对比不同版本。

## 本地验证

在仓库根目录执行 `python3 -B -m unittest discover -s integrations/muse-hit-transcription -p 'test_*.py'`。测试用本机数据站和可控的执行步骤覆盖租约丢失、重启、媒体校验、部分下载保留和发布响应丢失。在持续运行前，先用 `--check-runtime` 和限定剧目的试跑验证实际 Linux 媒体环境。
