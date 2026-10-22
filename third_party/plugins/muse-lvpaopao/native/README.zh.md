---
description: "维护单独部署、绑定固定版本的绿泡泡原生 helper。"
kind: guide
---

# 绿泡泡原生 helper

[English](README.md) | 中文

本目录包含自有运行文件及离线回归用例。包资源清单包含运行源码和依赖锁，排除测试、私有配置、账号数据和媒体。运行仍要求准备好 Python 环境和媒体工具，新电脑安装后的依赖交付尚未验收。

## 部署

`passive-probe/next-stage/runtime_profiles.py` 中 exe 与实际加载 DLL 的完整哈希组合决定适配器。Windows x64 微信 4.1.15.56 / WMPF 25799 已实际验收本地准备、搜索、完整目录、榜单、整剧交付和真实中断续传。其他构建须单独验收。Windows Python 依赖锁定在 [requirements-windows-25560.lock](requirements-windows-25560.lock)。Mac arm64 使用 [requirements-macos-arm64-269602.lock](requirements-macos-arm64-269602.lock) 与 `mac_runtime.py`：仅接受单独准备、哈希准确的微信 4.1.13 / 269602 隔离副本及私有 home。其 36 集原生下载、解码和哈希检查、续传、搜索、榜单及公开工具核对均通过；原版签名微信和新电脑安装仍未验收。

保留运行目录间的相对关系。`boot.py` 读取真实进程身份，校验对应平台的文件哈希，并暂存封存的私有副本，同时保留已有下载回执。示例进程配置保持未激活，真实连接配置、播放地址和账号数据不得放进源码目录。

Host 持有到 `run-persistent-host.py --rpc-stdio` 的一条本地或显式配置的 SSH 连接，同一下载任务内的调用复用该连接。helper 校验目标身份和导入文件，串行处理媒体动作，并在退出前报告清理结果。分集结果同时包含请求集号和已验证的播放序号；旧的仅含播放序号的回执从已核对的请求记录中恢复集号。获取结果未知时保留原请求键供核对，不自动再次请求地址。

## 离线检查

安装兼容的 Python 依赖后，在本目录运行：

```sh
python3 -B -m unittest discover -s passive-probe/next-stage -p 'test_*.py'
python3 -B -m unittest discover -s passive-probe -p 'test_*.py'
node --test passive-probe/observe-launch.spec.mjs passive-probe/next-stage/operations/fixed-operation.spec.mjs
```

这些检查以合成夹具替代原生进程和网络行为。通过检查不代表已部署 helper，也不代表新的目标已通过验收。真实测试还需要私有本机配置、精确目标验证和单独授权的测试范围；下载重试须保留原始回执。
