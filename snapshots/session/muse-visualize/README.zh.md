# 原生可视化卡片

[English](README.md) | 中文

这个无需密钥的场景挂载实际默认的 `short-drama` 模式和桌面工具发现配置。首个模型请求直接提供 `visualize` 和 `skill`，整个场景不调用工具搜索。原生 Skill 加载后执行真实的创建和更新；测试独立核对持久化结果元数据、私有 home 中保存的片段以及完整工作区结果。

回放使用专用的 `snapshot-visualize` 模型提供方，没有真实 API 回退路径。将 `MUSE_VISUALIZE_PACKAGE` 设为已审查并解包的插件目录，可以通过其中构建后的 `lib/index.js` 运行相同场景；默认使用保留的源码。运行时文件和资源都放在测试私有 home 中，不读取个人样式文件或账号。

`apps/web/tests/muse-visualize.e2e.ts` 使用相同的原生 Session 数据打开已打包的客户端，检查滑块交互和刷新、两个会话的隔离，并验证图卡提示只填入草稿，保留用户已有草稿和附件。浏览器截图和验收回执保存在 `.artifacts/visualize-browser-ui/` 下。
