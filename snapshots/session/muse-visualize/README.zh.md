# 原生可视化卡片

[English](README.md) | 中文

这个无需密钥的场景挂载实际默认的 `short-drama` 模式和桌面工具发现配置。首个模型请求直接提供 `visualize` 和 `skill`，整个场景不调用工具搜索。原生 Skill 加载后执行真实的创建和更新；测试独立核对持久化结果元数据、私有 home 中保存的片段以及完整工作区结果。

回放使用专用的 `snapshot-visualize` 模型提供方，没有真实 API 回退路径。源码模式将保留的源码放入测试私有 home。构建版回放通过 `test:snapshot:built` 执行 `scripts/prepare-visualize-snapshot.mjs`：正式工具链验证保留的 pin 和本地修改，将插件及固定版本的 React 依赖树打包，并拒绝安装生命周期脚本。测试通过公开的包操作接口，按父包精确版本给 React 的两条传递依赖配置本地覆盖，仅将已审查的归档离线安装到真实的私有 profile，并检查私有锁文件。随后刷新公开的包解析器，检查八个 Host peer 与正在运行的安装使用同一模块身份。整个过程不改动全局配置，亦不读取个人样式文件或账号。

定向执行构建版回放前，先运行准备脚本。`MUSE_VISUALIZE_PACKAGE` 可选择准备脚本解包的 `package` 目录，其旁必须有已检查的归档和 `installation.json`；运行时不会将导入重定向到外部源码目录。

`apps/web/tests/muse-visualize.e2e.ts` 使用相同的原生 Session 数据打开已打包的客户端，检查滑块交互和刷新、两个会话的隔离，并验证图卡提示只填入草稿，保留用户已有草稿和附件。浏览器截图和验收回执保存在 `.artifacts/visualize-browser-ui/` 下。
