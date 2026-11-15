---
description: "通过普通 dsh profile 配置独立的本机 Skill 目录服务。"
kind: "package-reference"
---

# Skill 目录 profile

[English](README.md) | 中文

## 概览

此目录定义独立的 `dsh` profile，包含两个插件：本机 HTTP 服务器和 Skill 目录提供者，不提供包级可执行入口或 agent（智能体）预设。[账户网关](../README.zh.md#skill-market-proxy)认证公开请求并转发到此私有目录；[市场包](../../../packages/host/muse-market/README.zh.md#account-bound-cloud)定义发布和安装行为。

## 启动

将 `package.json` 和 `cordis.patch.yml` 复制到 `$DSH_HOME/profiles/market`，然后通过部署环境的包源安装版本匹配的运行时依赖。profile、私有策略和持久存储均应放在不可变发布目录之外。使用已安装的 `dsh` 启动器运行：

```sh
MUSE_MARKET_PORT=8921 MUSE_MARKET_POLICY=/etc/muse/market-catalog.json dsh --profile market
```

两个环境变量都必须设置。端口为 0 至 65535 的整数；零表示由操作系统原子分配端口。提供者仅绑定 `127.0.0.1`。网关配置的上游必须使用目录实际监听的端口。启动器正常关闭时会停止路由接收新请求，中断尚未读完的请求体，等待已接收的 HTTP 工作完成，再关闭 SQLite。

## 私有策略

`MUSE_MARKET_POLICY` 指向绝对路径下的普通 JSON 文件，不允许符号链接，文件大小最多 64 KiB，必须且只能包含下面八个字段。在 POSIX 上，组用户和其他用户不得拥有写权限。`root` 为私有持久存储目录的绝对路径；`secretFile` 为仅所有者可访问的普通文件的绝对路径，不允许符号链接，其中保存与网关配置相同的 32–256 字符 URL 安全密钥。密钥文件最多 1024 字节；读取时会去除首尾空白。

```json
{
  "root": "/var/lib/muse/market",
  "secretFile": "/etc/muse/market-gateway-secret",
  "maxReleases": 10000,
  "maxActiveUploads": 2,
  "jsonRequestBytes": 65536,
  "jsonResponseBytes": 4194304,
  "catalogLimit": 100,
  "limits": {
    "archiveBytes": 16777216,
    "expandedBytes": 67108864,
    "fileCount": 1024,
    "recordBytes": 1048576
  }
}
```

所有数值设置均为正整数。`maxReleases` 允许存储 1–100000 个发布记录；`maxActiveUploads` 允许 1–32 个账户同时上传，每个账户同一时间仅允许一次上传。`catalogLimit` 允许返回 1–100 条记录。JSON 请求预算允许 1 KiB–16 MiB，响应预算允许 1 KiB–64 MiB。归档预算允许 1 KiB–64 MiB，解压后字节数允许 1 KiB–256 MiB，文件数量允许 2–4096，单条记录字节数允许 1 KiB–16 MiB。完整目录响应必须满足 `jsonResponseBytes`；超出时明确返回错误，不会截断记录。网关处需独立配置兼容的预算。

服务器先认证共享 Bearer 密钥，再接受可选的网关账户断言。匿名目录请求只能读取已发布记录；身份、下载和变更请求均要求账户断言。断言包含网关当前的 16 字符账户标识、用户名及管理员标记。发布记录和发布团队使用独立的 32 字符十六进制标识；本地版本标识仍为归档的 SHA-256 哈希。

## 存储和限制

SQLite 文件 `market.sqlite` 和不可变的 `blobs/<sha256>.zip` 归档保存在 `root` 下。目录支持 schema 版本 1；遇到更高版本会拒绝打开，不会重置或降级。已有 Bot 记录在严格解析 Skill 之前被过滤，其原始记录和归档字节仍保留。无法支持的 Skill 记录会明确报错。发布存储不会执行归档资源。

上传会保留原始账户范围内的请求密钥、发布团队及精确归档字节。重复这一组合会返回同一发布记录；改变字节或团队会返回冲突。已验证归档通过原子方式安装，以 SHA-256 命名。后续数据库写入失败时，可能留下经过验证但尚未被引用的缓存归档；此服务保留它们，不自动回收。请勿删除可能被其他发布记录引用的归档。

审批在数据库事务之外验证不可变归档，然后在短暂的同步 SQLite 事务中重新检查请求的修订号及权限。同一修订号的并发审核请求只能提交一次。上传结果不确定时，必须使用原始密钥及字节对账；审核结果不确定时，应先读取原始发布记录，再决定下一步操作。

目录结果为有限数组，在完成可见性、已归档类型和查询过滤后，最多返回 `catalogLimit` 条。查询会搜索包名、声明的 Skill 名称、发布标识及描述元数据。结果不表示已列出所有匹配项；此协议不提供游标分页。`recordBytes` 限制单个已存储 manifest（元数据清单），与完整 JSON 响应预算相互独立。
