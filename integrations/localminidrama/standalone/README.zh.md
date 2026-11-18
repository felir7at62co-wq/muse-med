# 发布独立制作平台

[English](README.md) | 中文

独立制作平台使用专用的 Linux systemd 单元、非特权用户、发布目录、SQLite 数据库和媒体目录。服务仅监听回环地址，生成保持禁用。本流程使用已有的授权服务器访问，不新增访问密钥，不修改共享 Muse 服务或 Nginx，也不公开监听端口。

## 构建并校验发布包

使用 Python 3.11 或更新版本，以及 [Dockerfile](../Dockerfile) 固定的上游版本。在该版本的干净检出中应用 `patch-upstream.mjs`，用 `npm ci --prefix <checkout>/frontweb` 安装前端依赖，再从 Muse 仓库运行 `node integrations/localminidrama/build-web.mjs <checkout> --base /`。构建期间保持检出目录不变。

```sh
python3 integrations/localminidrama/standalone/package_payload.py build /path/to/checkout /path/to/releases/muse-platform.tgz
python3 integrations/localminidrama/standalone/package_payload.py verify /path/to/releases/muse-platform.tgz --sha256 <trusted-sha256>
```

输出目录须已存在，且位于上游检出之外。构建创建新文件，不覆盖已有版本。发布包包含后端源码、迁移、技能、依赖清单、前端构建产物及文件清单，不包含已安装的依赖或供应商配置。通过已授权渠道转交发布包及完整校验值，在目标机器解包前校验整个包和文件清单。运行 `python3 -B integrations/localminidrama/standalone/test_package_payload.py` 可在无服务器环境下测试打包工具。

## 暂存并检查 Linux 发布

1. 通过 `systemctl cat muse-standalone-platform.service` 和 `systemctl show muse-standalone-platform.service -p ActiveState -p MainPID` 核对独立单元归属和状态。只读检查回环端口、容纳发布包和独立备份的磁盘余量、可用内存，以及共享服务状态。如有其他服务使用 19590 端口或目标路径，停止发布流程。
2. 将已校验的发布包解到新的暂存目录。用非特权构建用户在其中的 `backend-node` 运行 `npm ci --omit=dev`。安装和运行都使用 Node 22。确认 `better-sqlite3` 能在此运行时打开内存数据库，再把暂存目录放入 `/opt/muse/standalone-platform/releases/` 作为不可变版本。不要复制 Windows 依赖或复用锁文件不一致的 Linux 依赖目录。
3. 使用专用的 `muse-standalone` 用户和用户组。准备[服务单元](muse-standalone-platform.service)，将两处 `RELEASE` 替换为同一版本名，指定 `ExecStart` 中的 Node 绝对路径，并用 `systemd-analyze verify` 检查。启动前确认主机能执行 systemd 的 `IPAddressDeny` 和 `IPAddressAllow` 限制。将[示例配置](config.example.yaml) 配置到 `/var/lib/muse-standalone-platform/app/configs/config.yaml`，保留已核验的独立配置。运行数据只对专用用户可写，路径不得指向共享或上游数据。

## 备份并启动独立单元

升级时，只停止独立单元并确认已退出。将旧单元、私有配置、通过 SQLite 备份 API 生成的数据库备份及对应的完整媒体目录保存到同一个新建的私有备份目录。运行 `PRAGMA quick_check` 检查备份，并对比媒体清单。首次部署使用空的独立数据目录，或导入已核验且授权给该部署的数据副本。禁止将独立单元指向原始在线数据、合并租户或把供应商凭据导入活动数据库。

安装经核验的单元，执行 `systemctl daemon-reload`，再运行 `systemctl start muse-standalone-platform.service`。检查独立单元和 `http://127.0.0.1:19590/health`，预期值为 `status: "ok"`、`generationBackend: "unconfigured"` 和 `backgroundGeneration: false`。客户端通过自身授权的 SSH 连接把服务器回环端口转发到本机回环端口。使用仓库标准桌面启动器前，将桌面进程的 `MUSE_LOCALMINIDRAMA_URL` 设置为此隧道地址。

检查项目列表、一个已有制作包、一个历史视频的原始提示词及参考图，以及媒体下载；确认共享服务 PID 未变化后完成交接。健康检查或历史验证失败时只停独立单元，并保留日志、失败版本和当前数据。将旧单元和旧数据备份放在一起；确认数据架构兼容，或恢复已校验且配套的数据库和媒体副本后，才运行旧版本。不要让未经验证的旧版本打开可能已迁移的数据库。
