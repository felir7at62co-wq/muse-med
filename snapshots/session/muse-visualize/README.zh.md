# 原生可视化卡片

[English](README.md) | 中文

这个无需密钥的场景挂载实际默认的 `short-drama` 模式和桌面工具发现配置。首个模型请求直接提供 `visualize` 和 `skill`，整个场景不调用工具搜索。原生 Skill 加载后执行真实的创建和更新；测试独立核对持久化结果元数据、私有 home 中保存的片段以及完整工作区结果。

回放使用专用的 `snapshot-visualize` 模型提供方，没有真实 API 回退路径。源码回放使用保留的源码；`DSH_EXAMPLE_MODE=lib` 使用保留且已审查的 `lib/index.js`。将 `MUSE_VISUALIZE_PACKAGE` 设为已审查并解包的插件目录，可以改用其中构建后的入口。运行时文件、资源和明确的 Host peer 链接都放在测试私有 home 中，不读取个人样式文件或账号。

`apps/web/tests/muse-visualize.e2e.ts` 使用相同的原生 Session 数据打开已打包的客户端，检查滑块交互和刷新、两个会话的隔离，并验证图卡提示只填入草稿，保留用户已有草稿和附件。浏览器截图和验收回执保存在 `.artifacts/visualize-browser-ui/` 下。

精确请求预算的期望值根据已分配的工作目录和 Session id 展开已提交的提示词、工具定义及工具文本。源码资源位于 `.dsh/plugins/dsh-visualize`；构建版资源位于经过审查的 `.dsh/profiles/headless/node_modules/@nagi-ovo/dsh-visualize` 安装目录。期望输入只将可视化工具描述中的三处资源引用和指定 Skill 结果中的一行 Base directory 绑定到该布局；其余文本与工具参数保留原字节。运行时上下文路径保留解析后的目录，可视化存储路径保留所配置 home 的写法，包括 Windows 路径别名。夹具销毁时恢复临时 home 环境变量，规范录制文件保持不变。
