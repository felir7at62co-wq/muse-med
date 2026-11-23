# 数据站

[English](README.md) | 中文

数据站是 Muse 网站 `/data/` 下的作品数据站。它把红果、番茄、七猫的公开榜单采集进自己的 PGlite 数据库，搜索抖音并把抖音视频存到 TOS，接收 Mac 采集端推送的绿泡泡榜单，保存成员已取得的剧本和原小说，并运行储备看板：每天选出爆款剧并跟踪它们的转写任务。客户端是 Vite 构建的 React；服务端是 Node 上的 Hono，由 esbuild 打成单个文件。

Muse 通过三种方式使用数据站：

- 桌面 Muse 以已登录账号通过成员接口读取榜单、储备看板并发起立即转写（[`muse-account/src/data-station.ts`](../../packages/host/muse-account/src/data-station.ts)）。
- [爆款转写工人](../../integrations/muse-hit-transcription/README.zh.md)和 [`tool-hit-queue`](../../packages/drama/tool-hit-queue/README.zh.md) 工具用数据站服务令牌，通过 `/api/service/hits` 领取和回报转写任务。
- 数据站把储备任务变化推送到云端 Muse 的 `/api/muse/station-events` 路由，唤醒负责转写的 Bot（[`station-events.js`](../../third_party/plugins/ds-bot/src/host/station-events.js)）。

## 云端运行

云端以 systemd 服务 `muse-data-web` 运行数据站，使用独立用户 `muse-data-web`。服务用数据站自有的 Node 24.21.0（`/srv/muse-data-web/runtime/node`）运行 `/srv/muse-data-web/app/dist-server/main.js`，工作目录为 `/srv/muse-data-web/app`，只监听 `127.0.0.1:19617`，设置读自 `/srv/muse-data-web/access/server.env`，模板为 [`deploy/server.env.example`](deploy/server.env.example)。Muse 网站的 nginx 把 `/data/` 转发给它（[location 模板](deploy/nginx-data-location.muse-session.conf.example)）。状态是 `app/.data/live` 中的 PGlite 数据库，只允许一个写进程；身份、令牌、TOS 密钥和储备推送密钥是 `/srv/muse-data-web/access` 中的私有文件。定时器 `muse-data-feishu-links.timer` 每 10 分钟运行 [`deploy/export-muse-feishu-links.py`](deploy/export-muse-feishu-links.py)，导出数据站据以放行成员的 Muse 账号与飞书的对应关系。

## 来源

本目录是 muse-data-web 仓库的提交 `e53565b`（分支 `codex/station-events`，2026 年 11 月 20 日），即云端运行的版本。从本目录构建可逐字节复现线上文件：`dist-server/main.js`（SHA-256 `42b4b326…30ed`），以及以 `/data/` 为 base 构建的 `index.html`、`assets/index-DoFW9Osb.js`、`assets/index-SWNgSPoH.css` 和 `muse-mark.svg`。线上的 `package.json`、`pnpm-lock.yaml`、`scripts/setup-novel-runtime.mjs`、`third_party/fanqie-original/` 和七猫许可文件与本目录相同。

最后一次完整发布由 `scripts/prepare-cloud-release.mjs` 在 11 月 17 日制作，来自提交 `1252dbd`，服务器上的 `RELEASE.json` 仍写着它。此后的更新只替换 `/srv/muse-data-web/app` 中的单个构建文件；下表每个构建都复现了下一次更新所备份的文件：

| 服务器日期 | 替换内容 | 构建来源 |
|---|---|---|
| 11 月 20 日 | 客户端资源 | `3a630fe`：按剧名或红果 ID 搜索储备看板 |
| 11 月 20 日 | 客户端资源 | `8f453d1`：从作品数据发起转写 |
| 11 月 20 日 | 客户端资源 | `2e3b547`：看板加载时搜索保持可用（线上客户端） |
| 11 月 20 日 | `dist-server/main.js` | `ed994ea`：看板读取不再全表扫描，并对 `hit_candidates` 做一次 `VACUUM FULL` |
| 11 月 20 日 | `dist-server/main.js` | `0680436`：供桌面 Muse 使用的成员接口 |
| 11 月 21 日 | `dist-server/main.js` | `e53565b`：储备推送，同时在 `server.env` 增加两项设置（线上服务端） |

这些提交从 `1252dbd` 到 `e53565b` 是一条直线，因此不需要合并；`2e3b547` 之后客户端源码没有变化。服务器上的 `app/dist/assets` 仍保留更早的构建，`index.html` 只加载线上这一组。

未收录的有仓库历史、`.env.example`（其取值即 `src/server/config.ts` 中的默认值），以及所有被忽略的路径，例如 `.data/`、`node_modules/`、`dist/`、`dist-server/`、`artifacts/` 和 `test-results/`。除下列修改外，本目录与提交 `e53565b` 逐字节相同，这些修改都不进入构建产物：

- 项目 README 移到 [`docs/overview.md`](docs/overview.md)，其中链接改为相对 `docs/`。
- 测试、`docs/hit-transcription.md`、`docs/server-identity.md`、`deploy/server.env.example` 和 `src/shared/types.ts` 的一处注释用 用户甲、用户甲组、甲组成员 和 用户乙 代替两位同事的姓名和以其中一人命名的部门，用 `usera`、`userb` 代替他们的用户名。
- 绿泡泡采集端的默认主机标签、示例配置、`docs/lvpaopao.md` 及其测试用 `collector-mac` 代替一台 Mac 的主机名。新安装的采集端若配置中没有 `host`，上报 `collector-mac`。
- `.gitignore` 另外忽略 `.env.*`，并保留 `third_party/fanqie-original/vendor/signer/lib/`，不受仓库 `lib/` 规则影响。

## 目录

| 路径 | 内容 |
|---|---|
| `src/server/` | Hono 服务端：采集器、扩库、爆款选片与任务、抖音搜索与下载、小说、身份和 PGlite 存储；`main.ts` 是打包入口 |
| `src/client/` | 在 `/data/` 提供的 React 客户端 |
| `src/shared/` | 服务端与客户端共用的类型和 schema |
| `tests/` | Vitest 测试；`tests/browser/` 为 Playwright 测试 |
| `scripts/` | 云端发布打包器、小说下载用 Python 环境初始化、本地隔离检查 |
| `deploy/` | systemd 单元、nginx location 模板、设置与身份模板、飞书关联导出和中文部署说明 |
| `third_party/fanqie-original/` | 番茄原文下载的 Python worker，随发布包上线 |
| `mac-collectors/lvpaopao/` | 向数据站推送绿泡泡榜单的 Mac 采集端；它在 Mac 上运行，不在服务器上 |
| `docs/` | 中文文档：概览、API、架构、Crawlee、爆款转写、绿泡泡和身份 |

## 构建与测试

数据站使用自己的 `package.json` 和 `pnpm-lock.yaml`，不是仓库 pnpm workspace 的成员，仓库的安装和构建不包含它。在 `services/data-station` 下用 Node 24 运行：

```sh
pnpm install --frozen-lockfile --ignore-workspace --ignore-scripts
pnpm run typecheck
pnpm test
pnpm run build
pnpm run test:browser
```

`--ignore-workspace` 按数据站自己的锁文件安装，而不是仓库的 workspace。`--ignore-scripts` 跳过 esbuild 和 `tos-crc64-js` 的安装脚本，pnpm 10 及以后版本在没有允许列表时会拒绝它们；云端发布安装生产依赖时也用这个参数。`pnpm run build` 做类型检查，以 `/` 为 base 把客户端构建到 `dist/`，并把服务端打包为 `dist-server/main.js`。`test:browser` 以临时数据库在 `127.0.0.1:4318` 启动构建好的服务端，并驱动 `/Applications` 中的 Google Chrome。Python 测试在 `mac-collectors/lvpaopao` 中用 `python3 -m unittest discover -s tests` 运行；在 `third_party/fanqie-original` 中先把 `requirements.txt` 装进仓库之外的虚拟环境，再用 `python3 -m unittest test_worker` 运行。

云端构建产物来自以下两条命令，客户端以 `/data/` 为 base：

```sh
pnpm exec esbuild src/server/main.ts --bundle --platform=node --format=esm --packages=external --outfile=dist-server/main.js
pnpm exec vite build --base=/data/ --outDir=<output>/dist --emptyOutDir
```

## 部署

部署只改动 `/srv/muse-data-web`，只重启 `muse-data-web`；`app/.data` 原地保留并先做备份。PGlite 只有一个写进程，不能让第二份服务使用 `.data/live`。每次重启会短暂中断成员页面和转写工人对数据站的调用。

`package.json` 和 `pnpm-lock.yaml` 不变时，按 11 月 20 日和 21 日的做法替换构建文件：

1. 在 Mac 上用上面两条命令从某个提交构建 `dist-server/main.js` 和 `/data/` 客户端，记录每个产物的 SHA-256。
2. 把文件复制到服务器 `/root` 下的新目录，核对哈希。
3. 先把 `/srv/muse-data-web/access/server.env` 复制到这些文件旁边，再加入新设置；新构建必需的设置缺失时，服务会在启动时停止。
4. 运行 `systemctl stop muse-data-web`，确认没有进程在运行 `/srv/muse-data-web/app/dist-server/main.js`。
5. 把 `app/.data/live` 复制到 `/srv/muse-data-web/backups/data-before-<提交>-<UTC 时间>`。
6. 把当前的 `dist-server/main.js` 复制一份放在新文件旁边，再用 `install -m 0644 -o root -g root` 安装新文件。客户端有变化时，把 `app/dist` 复制为 `app/dist.before-<改动>-<日期>`，把新文件加入 `assets/`，最后替换 `index.html`。
7. 运行 `systemctl start muse-data-web`，等 `https://<Muse 网站>/data/api/health` 在已登录会话下返回 200，并查看 `journalctl -u muse-data-web` 有无启动错误。

依赖变化时制作完整发布包。提交后在 `services/data-station` 中运行 `pnpm run build`，再运行 `node scripts/prepare-cloud-release.mjs`。打包器拒绝本目录中未提交的改动，自行以 `/data/` 构建客户端，在独立 staging 目录安装生产依赖，并把归档、SHA-256 和清单写入 `artifacts/cloud-release-*`。之后按 [`deploy/README.md`](deploy/README.md) 的「后续升级与恢复」操作：停止数据站，备份 `.data/live`，保留 `.data` 并用核对过的发布包替换 `app`，只启动数据站。首次部署、运行时、服务用户、nginx 和身份也在那里说明。

## 仓库设置

根目录 `.gitattributes` 让 `docs/hit-transcription.md`（行尾空白）和 `src/server/novels/README.md`（末尾空行）不受 `git diff --check` 检查。`lefthook.yml` 的暂存区 lint、`.oxlintrc.json`、`scripts/verify-no-unknown-casts.ts` 和 `scripts/verify-repository-references.ts` 跳过 `services/data-station/`，导入的 TypeScript 保留自己的风格和类型断言，以及其解析器抽取来源的 Muse 提交号。`scripts/translation-pairing.manifest.json` 让 `deploy/`、`mac-collectors/`、`src/` 和 `third_party/` 下只有中文的 README 不参与双语配对。

## 不在本仓库

muse-data-web 仓库保留历史和分支；其中分支 `codex/muse-data-douyin-source-management-20261113` 有四个提交不在本目录中。该仓库被忽略的 `artifacts/` 目录保存发布回执、调研文件和截图。服务器状态、私有文件和备份留在服务器上。
