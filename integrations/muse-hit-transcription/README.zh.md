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

中断后保留当前收据和剧目目录。重启后以同一执行器身份核对、续领原任务。下载在冷却期后恢复原下载任务。已校验的集继续复用，未完成的集在原会话、原片、工作区、模型和配置上续跑。每集只允许创建一次语音识别任务，之后读取原收据。归属不明、来源变化、校验缺失或次数用尽时需检查。

进度回报会续租。失去租约后停止当前执行进程。重启后可对照数据站核查未收到响应的回报。逐集收据、全剧清单与最终结果保存在私有剧目目录中。

## 本地验证

在仓库根目录执行 `python3 -B -m unittest discover -s integrations/muse-hit-transcription -p 'test_*.py'`。测试用本机数据站和可控的执行步骤覆盖租约丢失、重启、媒体校验、部分下载保留和发布响应丢失。在持续运行前，先用 `--check-runtime` 和限定剧目的试跑验证实际 Linux 媒体环境。
