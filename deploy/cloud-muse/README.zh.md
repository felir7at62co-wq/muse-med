# 从一个 main 提交发布云端 Muse

[English](README.md) | 中文

从本地 Muse `main` 分支的单个提交准备、切换、检查或回滚 `muse-cloud.service`。准备过程与线上服务并行。切换通常等正在执行的工作完成或暂停后再重启服务。

## 配置发布环境

在能通过 SSH 访问 macOS Git 主机和云服务器的机器上运行发布脚本。脚本在 Git 主机上执行 Git 命令。每条命令中的 `S` 都应使用同一个短或完整提交 ID。提交必须位于 Git 主机的本地 `main`，显式设置 `ALLOW_OFF_MAIN=1` 可以放宽该限制。

| 变量 | 含义 |
|---|---|
| `MUSE_RELEASE_GIT_HOST` | Git 主机的 SSH 地址，例如 `user@host` |
| `MUSE_RELEASE_GIT_REPO` | 本仓库在 Git 主机上的绝对路径 |
| `MUSE_RELEASE_SERVER` | 云服务器的 SSH 地址，以 root 登录 |

发布前按服务器上 `/opt/muse/cloud/staging/queue.md` 及同目录 README 记录改动。由一位负责人汇总队列，安排一次重启。服务器上的 `$OPS` 表示仅 root 可访问的 `/opt/muse/cloud/operations/release-main-<S 的前 10 个字符>`。其中的 `release.path` 指向发布目录，发布目录中的 `SOURCE_COMMIT` 记录完整提交 ID。

## 准备、切换与检查

| 步骤 | 命令 | 预期结果 |
|---|---|---|
| 预检 | `./prepare.sh S --check-only`、`./switch.sh S --check-only`、`./check.sh S --check-only` | 只读检查资源、当前服务和任务空闲状态。即使命令正常退出，也要查看切换预检的输出。 |
| 准备 | `./prepare.sh S` | 核验源码、构建运行时及插件、创建下一版配置、执行演练并生成 `$OPS/prepared.json`。 |
| 审查 | 在服务器读取 `$OPS/carry.txt` 和 `$OPS/dump/compare.txt` | 切换前审查相对线上插件和组合配置的变更，核对随包构建的红果引擎哈希。 |
| 切换 | `./switch.sh S [--wait-minutes 60]` | 重启并检查就绪状态，转写运行器保持暂停。 |
| 检查 | `./check.sh S [--keep-paused]` | 确认已安装版本及其状态，并输出队列处理计划。默认恢复由本次发布暂停的运行器。 |
| 收尾 | `./finish.sh S`，再执行 `./finish.sh S --apply` | 审查计划后移出已发布条目。应用计划需要 `$OPS/checked.ok`。 |

[准备脚本](prepare.sh)传输 Git 归档，服务器核验校验和后开始构建。默认传输路径使用 Git 主机上临时启动的 tailnet HTTP 服务。Git 主机到服务器的链路较慢时，可用 `--relay` 经发起命令的机器转发归档，或用 `--delta=B` 从已准备的版本发送差量。服务器重建的完整目录必须与 Git 主机的清单一致。服务器在 `$OPS/stages` 记录已完成的阶段，重试时跳过这些阶段。若先前阶段的输入发生变化，先查看该阶段输出及记录，再重新执行。

准备阶段按锁文件构建工作区和插件归档，创建独立的 `muse-cloud-next` 配置，检查其链接，并与线上组合配置对比。要发布配置变更，运行准备脚本前将完整候选配置放到 `/opt/muse/cloud/staging/next/cloud.patch.yml`。脚本会输出差异。该文件不存在时沿用线上配置。演练使用一次性的 home 和私有回环监听地址，在隔离环境中检查组合加载、客户端静态资源和 Bot 状态接口。线上 Bot 调度、生产账号访问和飞书投递需要单独验证。

[切换脚本](switch.sh)在临时 systemd 单元中持发布锁运行。它按准备记录核对待切换配置、下一版配置目录和生效中的服务 drop-in。空闲检查涵盖运行器批次状态、会话、待处理收件箱或队列、终端、调度及 Bot 工作。使用 `--allow-desk-turns` 放行能识别的转写工作台轮次，或使用 `--restart-busy` 记录在途工作后直接切换前，先查看完整状态。

确认可停止后，脚本写入 `before.json`、停止服务并生成仅 root 可读的状态备份。随后将线上配置目录的用户自定义层复制到下一版本，保留准备结束后写入的模型设置。脚本再交换配置目录，安装发布 drop-in 与待切换的云端配置，等待新 PID 和新客户端就绪。若计划停用数据站 webhook，可在切换前创建 `$OPS/retire-station-events`。切换会备份生效中的 webhook drop-in 并关闭其密钥文件设置。回滚会恢复原 drop-in。停服后失败时默认自动回滚，可用 `--no-auto-rollback` 关闭。

[检查脚本](check.sh)将正在提供的 Bot 客户端与构建产物对比，将 Bot 和会话清单与 `before.json` 对比，并检查飞书是否就绪、绑定是否与保存状态一致。它核对生效版本和配置，默认观察新 PID 和重启次数五分钟，写入 `after.json` 并在通过后生成 `checked.ok`。脚本通过管道把一次性登录链接写到 Git 主机的 `~/Muse云端登录链接.txt`，文件模式为 `0600`。只读的 `--check-only` 输出当前诊断，不发送链接，也不恢复转写运行器。

[收尾脚本](finish.sh)按队列条目中的首个提交 ID 判断该项是否随 `S` 发布。它保留其他服务的条目，并将标为已应用的条目移出留档。若改动通过另一提交合入或被后续条目替代，核对当前队列后按需使用 `--ship "<标题片段>"` 或 `--keep "<标题片段>"`。应用计划时会检查队列哈希、备份原队列并在 `staging/shipped/` 生成发布记录。

## 回滚与清理

运行 [`./rollback.sh S --check-only`](rollback.sh) 查看回滚计划。切换后的检查失败时运行 `./rollback.sh S`。该命令恢复先前的配置目录、服务 drop-in 和云端配置，带回当前用户设置，并确认正在提供先前版本的客户端。它只解除本次发布设置的转写暂停。仅在状态受损时使用 `--restore-state`，恢复备份会覆盖切换后新增的 Bot 和会话变更。

若回滚脚本无法运行，手动操作前先查看 `$OPS/prepared.json`、`$OPS/before.json` 和回滚日志。

1. 停止 `muse-cloud.service`。若下一版已上线，先保全 `profiles/muse-cloud/cordis.patch.yml` 中当前的用户自定义层。
2. 若配置目录已经交换，移开失败版本，将 `profiles/muse-cloud.before-<S 的前 10 个字符>` 恢复为 `profiles/muse-cloud`。把保全的用户自定义层复制到恢复后的目录。
3. 确认安装的发布 drop-in 与本次准备的文件一致后再移除。恢复上一版发布 drop-in、本次保存的 webhook drop-in（若存在），以及 `$OPS/backup/cloud.patch.yml.before`。只有 `$OPS/station-events-retired.created` 表明本次发布创建了 `station-events-retired.conf`，才移除该文件。
4. 重新加载 systemd，确认 `ExecStart` 指向上一版本。启动服务，将提供的客户端与 `before.json` 中的哈希比对。
5. 仅在 `$OPS/runner-pause.json` 记录了 `"wePaused": true` 时，才将运行器 `control.json` 中的 `"paused"` 设为 `false`。

在恢复窗口内保留回滚配置目录和备份。状态归档包含机密文件。若在线或预览服务仍引用旧版目录，应继续保留该版本。
