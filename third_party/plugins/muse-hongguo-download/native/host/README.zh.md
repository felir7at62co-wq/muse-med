# 红果 v2 本地运行时

[English](README.md) | 中文

## 概要

使用明确提供的本地文件，准备原版 2.0.0 SDK、自有 Java 宿主和 .NET 许可桥接程序。准备阶段不运行安装器、不请求许可、不初始化媒体访客，也不下载视频。原 SDK 的 JAR 和 DLL 保持锁定字节不变，v1 运行时及配置单独保留。

## 目录

- [准备](#prepare)
- [平台与私有状态](#platforms-and-private-state)
- [宿主与验证](#host-and-validation)

<a id="prepare"></a>

## 准备

在插件目录运行以下命令。原安装包、Java 17、.NET 10 x64 运行时、.NET SDK 10、ECJ、Python 3.9 或更新版本、FFmpeg、私有状态及新输出目录均使用绝对路径：

```sh
node scripts/prepare-v2.mjs \
  --setup-exe "$HG_SETUP_EXE" \
  --java "$HG_JAVA" \
  --dotnet "$HG_DOTNET_RUNTIME" \
  --dotnet-sdk "$HG_DOTNET_SDK" \
  --ecj "$HG_ECJ" \
  --python "$HG_PYTHON" \
  --state-dir "$HG_STATE_DIR" \
  --output "$HG_RUNTIME_OUTPUT" \
  --ffmpeg "$HG_FFMPEG"
```

命令核对固定安装包的 SHA256 和精确的 37 个库 JAR、2 个签名器 JAR、3 个原许可 DLL，再从原 JNA JAR 提取匹配的本机库。ECJ 将自有宿主编译成 JAR；提供的 .NET SDK 使用空 NuGet 来源和私有构建缓存编译桥接程序。不会复制或全局安装 SDK，并明确关闭开发证书生成及遥测。

`v2-runtime.json` 记录 SDK 和宿主的相对路径、全部已准备文件的大小与哈希，以及外部 Java、.NET、FFmpeg 程序标识。不发布裸 Java class 文件。已有输出目录会被拒绝，失败后清理本次创建的临时目录，描述符最后发布。调用方必须在准备完成后才能启用该目录。

<a id="platforms-and-private-state"></a>

## 平台与私有状态

支持为当前 Mac 或 Windows 准备运行环境，不为另一操作系统交叉准备。Mac Java 可为 ARM64 或 x64，Windows Java 必须为 x64。原许可 SDK 使用 .NET 10 x64，因此 Apple Silicon 需要 Rosetta。Linux 会被拒绝。Mac 的准备和离线协议组合已在本地验证；Windows 分支有自动化覆盖，但没有 Windows 实机验收结论。

`state-dir/device.json` 仅保存版本、平台和派生设备 ID。Mac 从当前 IOPlatformUUID 使用独立 Muse 前缀派生；Windows 保留原 SDK 从注册表 MachineGuid 进行区分大小写的 `mg:` 派生方式。原始硬件标识不会保存或输出。已有记录必须与本机匹配，不自动更换或修复设备。POSIX 设备文件要求 0600 权限，状态目录也须私有；其他许可状态保持不变。

<a id="host-and-validation"></a>

## 宿主与验证

Java 入口为 `muse.hongguo.v2.PortableHost`，仅接收一个私有配置文件路径。`deviceFile` 指向已准备的设备记录。目录和资源配置须与 APPDATA 及明确的 Java user.home、java.io.tmpdir、签名器、FFmpeg 配置一致；不修改 HOME。输出和队列文件位于 privateRoot 内。每次运行要求新的队列文件，旧 SDK 队列不会未经单独决定自动恢复。

原校验器、生产公钥、challenge/proof 方法及同一个 Licence 实例保留在控制器和下载 API 中。不使用默认 Open 控制器或私有字段反射。媒体访客策略由原 SDK 管理，自有宿主不增加设备轮换或任务重试。许可启动和离线握手不能证明服务器已经授权或视频已经下载完成。

`node --test tests/prepare-v2.test.js` 检查身份持久化、冲突保留、失败清理、ZIP 越界／软链接／重复成员拒绝，以及选定文件字节验证。独立的真实工具验收会在宣称下载成功前检查正常授权、单集和请求的完整剧集；仅准备完成文件不能证明这些结果。
