# 绿泡泡 Mac 采集端

在 Mac 上常驻运行：守着一份隔离的微信副本（`WeChat-Muse-Test.app`，Mac 微信 4.1.13 / 269602），按时段只读采集绿泡泡小程序的榜单和每集互动数，经 HTTPS 推给数据站（接口见 [docs/lvpaopao.md](../../docs/lvpaopao.md)）。不下载视频，不点赞、评论、分享。代码只用 Python 标准库；连接微信的 helper 来自 Muse 插件 `muse-lvpaopao` 的 `native/`。

## 怎么工作

一个 launchd 任务 `cn.muse.lvpaopao.collector`，一个进程里三个线程：

| 线程 | 作用 |
| --- | --- |
| 微信守护 | 用私有 `HOME`/`CFFIXED_USER_HOME`/`TMPDIR` 启动隔离副本，退出后按 30/60/120/300/600 秒退避拉起；每 5 秒用 `lsof` 检查副本是否打开了主微信的数据目录，一旦发现立即停掉副本且不再拉起；判断是否停在登录界面，是的话每 20 秒只截登录窗口上传。 |
| 调度 | 每 15 秒检查一次：睡眠检测、补跑、按时段采集、需要人处理时每 15 分钟探测一次。 |
| 上传 | 按顺序上传待发队列，5 分钟一次心跳（等扫码时 20 秒一次），执行并确认数据站下发的指令。 |

守护放在采集进程里而不是单独一个 launchd 任务：截图上传、`start-login` 指令和采集前的登录判断都要用它，同进程省掉进程间通信；副本用独立会话启动（plist 里 `AbandonProcessGroup`），采集进程重启时副本不会被杀，新进程按可执行文件路径、私有 `HOME` 认领它。

每次采集：拿锁 → 清理自己上次残留的进程 → `boot.py --prepare` → 启动 helper 并握手 → 自动「重新进入小程序」→ `status` 就绪 → 取数（每次调用间隔 ≥1 秒）→ 关闭 helper 并确认清理 → 放锁。每个 helper 最多发 1000 个请求或到寿命前 2 分钟就换一个新连接（新连接也要重新进入一次小程序）。

- 榜单：默认 09、12、15、19、22 点；从口碑榜（6）开始，按接口返回的榜单列表逐榜读，每榜 5 页 × 20 条。
- 互动数：默认 10 点；对象依次是关注列表、当天最近一次榜单里各榜前 10 名（按名次交错：各榜第 1 名，再各榜第 2 名……）；每部剧先 `detail` 取集数，再每集一次 `engagement`；每天总预算 1500 次调用，用完即停，结果标 `partial` / `budget-exhausted`。当天还没有榜单时先读各榜第一页。

### 失败处理

每个时段：失败后隔 1、2、4 分钟重试 → 仍失败就重启微信副本再试一次 → 进入「需要人处理」，之后每 15 分钟探测一次（准备连接 + 重新进入 + `status`），通了自动恢复。登录掉了、微信版本变了这类人不来就修不好的情况，跳过重试直接进入「需要人处理」。

| 情况 | 怎么发现 | 自动处理 | 上报 |
| --- | --- | --- | --- |
| Mac 睡眠 | 墙上时钟走得比 `CLOCK_UPTIME_RAW`（睡眠时不走）多 60 秒以上 | 丢掉当前连接重试；醒来后网络稳定 60 秒才补跑 | 睡眠期间错过的时段上报 `failed`/`mac-asleep`，只补跑最近一个 |
| Mac 关机、重启、采集端停止 | 启动时比较上次存活时间 | 开机自动登录后 launchd 拉起 | 同上，`mac-asleep`，说明为「采集端未运行」 |
| 断网 | TCP 探测 `servicewechat.com:443`、`223.5.5.5:53` | 最多等 15 分钟网络恢复再试 | 心跳 `offline-network`；待发数据留在本地 |
| 数据站 5xx、连不上 | 上传失败 | 本地积压，30 秒起指数退避到 15 分钟，恢复后按顺序补发；重复上传由 `runId` 去重 | 超过 6 小时连不上且配置了飞书时，用 `lark-cli` 直接发一条（恢复后再发一条） |
| 数据站 4xx | 400/409/413/415 等 | 文件移到 `outbox/rejected/` 并记原因，不重试 | 本地日志 |
| 令牌错、未配置（401/403/404） | 上传返回 | 保留积压，退避重试 | 心跳 message |
| 微信崩溃或被关 | 进程号 + 启动时间不再匹配 | 退避后拉起；采集时自动适配新进程 | `wechat-not-running` |
| 微信掉登录 | 登录窗口出现「进入微信」或二维码文字 | 每 20 秒上传登录窗口截图；`start-login` 指令点「进入微信」或刷新二维码 | `waiting-login`，`wechat-logged-out` |
| 无法重新进入小程序 | 所有重新进入方案后 `status` 仍未就绪 | 重试 → 重启微信 → 每 15 分钟探测 | `reentry-failed` |
| 连接中断或到期 | helper 返回需重连的错误、进程退出 | 换新连接接着读（已读完的榜单、已读的集保留） | 重试耗尽后 `helper-error` |
| 小程序业务出错 | 结果 status 不是 `*-returned` | 该页/该集记缺失，继续 | `partial`/`business-error` |
| 上次崩溃留下的 helper | `state/processes.json` 里的进程号 + 启动时间 | 只杀自己记录且启动时间一致的进程，从不按名字杀 | — |
| Muse 插件同时要用连接 | 共用 `flock` 锁文件，9421 端口被占 | 最多等 10 分钟 | `helper-error`（说明「锁被占用」） |
| 微信版本或文件哈希变化 | `boot.py` 返回 `mac-runtime-build-unsupported` | 不再连接 | `build-changed` |
| 副本访问主微信数据 | `lsof` | 立即停止副本，不再拉起，重启采集端才解除 | `error` |
| 收到 SIGTERM | — | 取消当前请求，关闭 helper，写状态；该时段留到重启后再跑 | 本次 `failed`/`cancelled` |

锁文件：`~/Library/Application Support/muse-lvpaopao-collector/run/helper.lock`（`flock(LOCK_EX|LOCK_NB)`，进程退出自动释放）。Muse 的绿泡泡工具接入时，启动 helper 前拿同一把锁，拿不到就返回「采集端占用中」。

## 启用步骤

前提：专用微信号已准备好；数据站已配置 `MUSE_DATA_LVPAOPAO_TOKEN_FILE`。隔离副本里现在可能还登着主号，启用前不要随手启动它（会把主号的桌面登录踢掉）。

1. 停掉 Muse 的隔离会话监护（`run-isolated-session.py`），确认隔离副本没在运行。
2. 系统设置 → 用户与群组：打开自动登录（FileVault 已关）。按需关闭自动锁屏（见下面「未验证」）。
3. 安装：`./install.sh --token-file <令牌文件> --move-wechat`。会把副本和 `user-home` 从仓库 `.artifacts/` 移到 `~/Library/Application Support/muse-lvpaopao-collector/wechat/`，建 venv，装好 helper 依赖，加载 launchd 任务。
4. 给安装脚本最后打印的 Python 实际路径（python.org 框架版的 `Python.app`）授予「辅助功能」和「屏幕录制」；第一次点击时允许它控制「System Events」。改完权限后 `launchctl kickstart -k gui/$(id -u)/cn.muse.lvpaopao.collector`。
5. 登录专用号：打开数据站「绿泡泡采集」页，扫页面上的二维码（或点「发起登录」后在手机确认）。
6. 打开绿泡泡小程序，运行 `probe-windows`（命令见下），把输出文件里小程序胶囊「…」按钮、「重新进入小程序」菜单项、主窗口「小程序」入口、列表里绿泡泡条目的 role/title/description 记下来，写进 `config.json` 的 `reentry.strategies`。输出可能含聊天标题，只留在本机。
7. 重新进入试验 20 次：数据站点 20 次「立即采集」（或 `launchctl` 停掉服务后跑 20 次 `once --kind rankings`），全部 `complete` 才算过；锁屏状态下再试几次。
8. 故障演练：杀微信、采集中合盖、关 Wi-Fi、重启 Mac、手机端退出微信，各记一次恢复时间和数据站上的缺口、告警是否正确。

## 日常操作

```sh
ROOT="$HOME/Library/Application Support/muse-lvpaopao-collector"
PY="$ROOT/venv/bin/python3"; export PYTHONPATH="$ROOT/app"
$PY -m lvpaopao_collector --config "$ROOT/config.json" status            # 本地状态、待上传数、需要人处理的原因
$PY -m lvpaopao_collector --config "$ROOT/config.json" probe-windows --out "$ROOT/logs/ax.json"
$PY -m lvpaopao_collector --config "$ROOT/config.json" once --kind rankings   # 服务停着时手动跑一次
launchctl kickstart -k gui/$(id -u)/cn.muse.lvpaopao.collector             # 重启服务
tail -f "$ROOT/logs/collector.log"
```

目录：`config.json`、`station-token`（0600）、`state/`（调度状态、预算、进程记录）、`outbox/pending|rejected/`、`logs/`、`wechat/`（副本与 `user-home`）。卸载：`./uninstall.sh`（保留数据、副本）或 `--purge`（副本和 `user-home` 也保留）。

测试（Linux 也能跑，全部用假 helper、假时钟、假 macOS 调用和本地假数据站）：

```sh
cd mac-collectors/lvpaopao && python3 -I -m unittest discover -s tests -v
```

## 尚未验证

- 所有辅助功能路径都是猜的：胶囊「更多」按钮、「重新进入小程序」、关闭小程序窗口、主窗口「小程序」入口、列表里的「绿泡泡」条目名。要在第 6 步用 `probe-windows` 定下来。
- 登录判断是启发式：只看主进程窄窗口（宽 ≤ 520）里有没有「进入微信」/扫码文字；宽窗口或开着小程序窗口算已登录；一个窗口都没有时为「未知」。
- 「进入微信」按钮能否用 AXPress 点、二维码过期后的「刷新」文字。
- 截图：用 JXA 调 `CGWindowListCopyWindowInfo` 取窗口号，再按登录窗口的位置大小匹配，`screencapture -l` 只截该窗口。
- 微信重启后 WeChatAppEx 是否立即启动；如果要先打开小程序才启动，采集端会先走「从列表打开」再准备一次。
- 锁屏、屏幕关闭时点击和截图是否有效。
- launchd 重启采集进程时副本是否真能活下来（`AbandonProcessGroup` + 独立会话）。
- macOS 上 `CLOCK_UPTIME_RAW` 在睡眠时不走（按文档如此），睡眠检测依赖它。
- 隔离副本重启后是否每次都要手机确认登录。
- `lark-cli im +messages-send --user-id` 发私聊（`--chat-id` 发群已在帮助里确认）。
