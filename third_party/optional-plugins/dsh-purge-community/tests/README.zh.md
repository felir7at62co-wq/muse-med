# 便携适配器测试

[English](README.md) | 中文

从仓库根目录运行 `node third_party/optional-plugins/dsh-purge-community/build.mjs --out <output-directory>`，构建可选包。把 `MUSE_PURGE_PACKAGE_DIR` 设置为构建结果返回的绝对 `packageDir`，安装该包声明的运行依赖，然后运行 `node --test third_party/optional-plugins/dsh-purge-community/tests/*.test.mjs`。只有宿主 YAML 依赖与可选包固定的版本一致时，才能通过 `--with-test-deps` 复用它。这些测试不会查找已安装的 Muse，也不会读取用户配置。

需要 Node 24 或更新版本。Windows 测试使用复制的 `node.exe` 创建真实、隔离的 Node 进程树，路径包含空格和非 ASCII 字符。其他平台执行便携断言，并明确跳过三个 Windows 进程用例。生成文件保存在每个测试工作进程独占的系统临时目录中，结束后删除。设置 `MUSE_PURGE_KEEP_TEST_FILES=1` 可保留文件以便诊断。

测试覆盖备份身份、缺失文件恢复、原始字节还原、并发账本写入、Muse 原生关闭行为、已知提示词和钩子补丁布局、重复应用，以及自定义预设保留。固定源码夹具的说明见 `fixtures/NOTICE.md`。

此前完整的真实 Cordis/SystemPrompt 和 Electron 检查需要准备好的应用运行环境，属于单独的验收证据。便携 CI 运行通过不能当作已执行这些检查。本测试不发送模型请求，不进行付费生成，也不关闭真实应用。
