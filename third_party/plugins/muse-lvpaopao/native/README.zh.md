---
description: "维护单独部署、绑定固定版本的绿泡泡 Windows helper。"
kind: guide
---

# 绿泡泡 Windows helper

[English](README.md) | 中文

本目录保留适配器所用的自有 helper 源码与离线回归用例，不进入 npm 运行归档。桌面端安装此依赖不会在 Windows 自动安装 Python、插桩依赖或 helper。

## 部署

已验证范围仅限 Windows x64 微信 4.1.13.65 / WMPF 25560，以及未激活模板中的完整 exe、DLL 和入口字节检查。测试使用 Python 3.14.5 x64；wheel 版本和哈希见 [requirements-windows-25560.lock](requirements-windows-25560.lock)。媒体验证使用 ffmpeg、ffprobe 8.1.1。其他版本须单独分析和验收。

保留 `passive-probe` 和 `next-stage` 的相对目录关系。示例配置有意缺省现场进程 ID、创建时间、路径和证明哈希。部署时须在该 Windows 环境取得真实进程身份、被动观察和启动场景证明，然后用 `seal-persistent-helper.py` 封存。该脚本计算真实本机输入的哈希，不会生成合格的身份证据。真实连接设置、证明回执、加密播放地址和账号数据不得放入本目录。

适配器通过 Host 持有的一条 SSH 连接调用封存的 `run-persistent-host.py --rpc-stdio`。十分钟存活时间包含等待目标启动。helper 校验目标和完整导入清单，串行处理有数量限制的动作，并在退出前确认释放、卸载、脱离和服务关闭。经整条适配器获取新地址、整剧媒体下载尚无验收。此前通过的首集传输复用了私有保存回执，没有新请求播放地址。

## 离线检查

安装兼容的 Python 依赖后，在本目录运行：

```sh
python3 -B -m unittest discover -s passive-probe/next-stage -p 'test_*.py'
python3 -B -m unittest discover -s passive-probe -p 'test_*.py'
node --test passive-probe/observe-launch.spec.mjs passive-probe/next-stage/operations/fixed-operation.spec.mjs
```

这些检查以合成夹具替代原生进程和网络行为。通过检查不代表已部署 helper，也不代表新的 Windows 目标已通过验收。真实测试还需要私有本机配置、精确目标验证和单独授权的测试范围；下载重试须保留原始回执。
