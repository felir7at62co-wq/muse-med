# Agent Note: 将 muse-med 自建 FFmpeg 与源码输入配对

Status: implemented

[English](2026-09-23-muse-ffmpeg-source-pairing.md) | 中文

## 问题

完整离线桌面安装包会分发媒体可执行文件。第三方二进制加上无关源码树，无法确定究竟是哪些源码、依赖版本或补丁生成了它。首次使用时下载不满足已选定的离线安装要求。

## 决策

专用[手动工作流](../../../../.github/workflows/muse-ffmpeg.yml)定义 Linux Docker 交叉构建，固定 BtbN/FFmpeg 版本及工具链镜像摘要。BtbN 解析精简的 x264/libass/zlib 依赖图；所有选定依赖的源码缓存及构建脚本与 FFmpeg 源码一并归档。编译期间禁止网络访问。二进制与源码归档共用同一 manifest（元数据清单）和校验清单，依赖许可声明也随二进制提供。桌面发布消费该配对之前，必须通过原生 Windows smoke。

## 考虑过的替代方案

**重新打包 Gyan，仅附上游 FFmpeg 源码。** 否决，因为这无法说明精确静态链接依赖的源码、补丁或构建脚本。

**首次使用时下载 FFmpeg。** 否决，因为用户要求离线安装包包含完整运行时。

## 影响

工作流上传临时产物，但不能发布 release 或改变桌面运行时选择。[所属 README](../../../../apps/desktop/scripts/ffmpeg-source-build/README.zh.md)定义源码保留与安装包 smoke 的交接要求。Linux Docker 是默认 Windows CI 规则下的专用构建例外；产品执行仍在原生 Windows 上检查。本地 fixture（测试前置数据）测试与固定上游生成器检查，不能证明交叉构建成功、法律合规或已安装桌面兼容性。维护者必须在分发前获得这些证据。
