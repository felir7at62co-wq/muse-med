# muse-med

[English](README.md) | 中文

muse-med 是基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）分支开发的短剧 AIGC 桌面智能体。底层框架由 [DeepSeek AI](https://deepseek.com) 开发；本分支保留上游包名与署名，并非 DeepSeek 官方发行版。

底层框架采用**一切皆插件**的架构，由 [Cordis](https://github.com/cordiverse/cordis) 驱动，其设计参见论文 [_A Programming Paradigm for Spatiotemporal Composability_](https://arxiv.org/abs/2608.25512)。

上游 dsh 文档：[https://deepseek-harness.github.io/deepseek-harness/](https://deepseek-harness.github.io/deepseek-harness/)

## 开发者预览

muse-med 与底层框架目前都处于 _开发者预览_ 阶段。**未来将出现破坏兼容性的变更。** Windows 安装包与完整的免安装媒体运行时尚未发布；源码目录不是组员可用的安装包。

运行前请阅读[安全说明](SAFETY.zh.md)。桌面开发版可从源码执行 `pnpm run dev:desktop`，开发机器仍需 Node.js 和 pnpm。详见[桌面端说明](apps/desktop/README.zh.md)和[社区插件源码快照](third_party/plugins/README.zh.md)。

## 短剧工作流

桌面预览版在一个短剧预设中结合剧本准备、用户提供的视觉参考、资产审核、镜头规划、BGM 选择和分集交付。参考图由用户提供，不要求或附带小红书接入。参考审核和用户确认是技能层面的工作流要求，不是每个收费工具都会强制执行的授权检查。

Windows 媒体运行时为本地渲染和 Whisper 转写准备了依赖及锁定的 OFL 许可 Noto 字体；这不代表在线模型提供方、剧变账号或公开 BGM 下载能够离线使用。可选的 MERT 分析需要另行准备模型资源，且仅限非商业用途。最新安装包仍需完成新配置与干净机器验收；未签名测试产物不等于已签名的公开发行版。运行时与凭据限制详见[桌面端说明](apps/desktop/README.zh.md)。

<a id="run"></a>

## 运行

### 通过 `npm` 运行上游 `dsh` 命令行

安装 `Node.js`，然后运行：

```sh
npx @deepseek-ai/dsh web
```

该命令默认会在 `http://127.0.0.1:3080` 启动 Web UI，本机启动时还会用默认浏览器打开页面。通过 SSH 启动时只打印宿主机 URL，因为本地转发地址由 SSH 客户端或编辑器持有。传入 `--no-open` 可仅运行服务器而不打开浏览器。详见 [Web UI 指南](docs/user/guide/index.zh.md)。

<a id="run-from-source"></a>

### 从源码运行

如需从仓库源码运行：

```sh
git clone https://github.com/felir7at62co-wq/muse-med.git
cd muse-med
pnpm install
pnpm run build
pnpm dsh web
```

`pnpm run build` 会准备仓库产物。`pnpm dsh web` 会直接使用这些已构建产物，不会重新构建。

### muse-med 入口

在仓库检出目录里，产品入口是 Web GUI 的 `pnpm muse:web` 与桌面壳的 `pnpm muse:desktop`：

```sh
pnpm muse:web
pnpm muse:web -- --port 3399
pnpm muse:desktop
pnpm muse:desktop:start
```

`muse:web` 在 muse 产品 home（`$MUSE_HOME`，否则 `~/.muse`）上提供 Web GUI，默认端口 327，因此不会与默认绑定 3080 的普通 `dsh web` 冲突；`--port` 可指定其他端口，`--dry-run` 只准备 home 后退出。`muse:desktop` 构建当前源码并启动桌面壳，桌面壳使用同一 home 并保留旧 `~/.muse-med` 回退；`muse:desktop:start` 跳过构建。`MUSE_MED_HOME` 可覆盖桌面 home，而继承的 `DSH_HOME` 或 `MUSE_HOME` 都不会选中它。

## 社区与支持

- muse-med 的问题请提交到 [muse-med 仓库](https://github.com/felir7at62co-wq/muse-med/issues)。
- 上游 dsh 的问题请到 [DeepSeek Harness Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions) 或 [Discord 社区](https://discord.gg/Ycq5dCaS4)。
- 兼容插件可使用 [`dsh-plugin`](https://github.com/topics/dsh-plugin) 话题；下方企微群是 DeepSeek Harness 上游社区，并非 muse-med 的官方支持渠道。

<table>
  <thead>
    <tr>
      <th align="center">企微小助手</th>
      <th align="center">入群问卷</th>
      <th align="center">微信公众号</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td align="center"><img src="https://cdn.deepseek.com/harness/readme/community-wecom-assistant.png" alt="DeepSeek Harness 企微小助手二维码" width="180" height="180"></td>
      <td align="center"><a href="https://trtgsjkv6r.feishu.cn/share/base/form/shrcnIt5twSVdLGD52KJBckGCgg"><img src="https://cdn.deepseek.com/harness/readme/community-wecom-survey.png" alt="DeepSeek Harness 入群问卷二维码" width="180" height="180"></a></td>
      <td align="center"><img src="https://cdn.deepseek.com/harness/readme/community-wechat-official-account.png" alt="DeepSeek Harness 团队微信公众号二维码" width="180" height="180"></td>
    </tr>
  </tbody>
</table>

## 参与贡献

参见 [CONTRIBUTING.md](CONTRIBUTING.zh.md)。

## 开发

请先阅读[开发指南](docs/development.zh.md)与[架构文档](docs/architecture.zh.md)。

面向 agent：请遵循 [AGENTS.md](AGENTS.md)。

## 上游引用

```bibtex
@misc{deepseek-harness2026,
  title={DeepSeek Harness: Everything is a Plugin},
  author={DeepSeek-AI},
  year={2026},
  publisher={GitHub},
  howpublished={\url{https://github.com/deepseek-ai/deepseek-harness}},
}
```

## 许可证

[MIT](LICENSE)

第三方依赖及其许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
