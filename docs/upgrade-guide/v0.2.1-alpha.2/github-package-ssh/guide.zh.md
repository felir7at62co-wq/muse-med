---
kind: upgrade-guide
description: "pnpm 12 通过 HTTPS 解析 GitHub 包地址，使用 SSH 访问时需要配置 Git URL 重写。"
---

# 通过 SSH 安装 GitHub 插件需要配置 Git 重写

[English](guide.md) | 中文

## 变更

旧版 Desktop 安装器可以根据显式的 `git+ssh://` 地址选择 SSH。内置的 pnpm 12 通过 HTTPS URL 解析 GitHub 仓库，即使使用 `git+ssh://` 或 `github:` 地址也是如此。用 SSH 密钥访问 GitHub 私有仓库时，需要在运行 Desktop 的账号下配置 Git。参见 [pnpm 的 Git 解析规则](https://pnpm.io/package-sources#how-git-dependencies-are-resolved)。

## 迁移

1. 在运行 Desktop 的同一账号下打开终端，为仓库所属账号配置重写。将 `OWNER` 替换为 GitHub 账号名或组织名。

   ```sh
   git config --global --add url."git@github.com:OWNER/".insteadOf "https://github.com/OWNER/"
   ```

2. 使用实际账号或组织及仓库名运行 `git ls-remote https://github.com/OWNER/REPO.git HEAD`。确认 Git 输出 `HEAD` 对应的提交哈希。
3. 在 Desktop 中重试安装，确认该组合包出现在已安装列表中。
