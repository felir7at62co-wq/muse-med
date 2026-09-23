# Agent Note: 从 scriptName 读取剧变项目名称

Status: implemented

[English](2026-09-23-jubian-project-name-field.md) | 中文

## Problem

提供方的 `GET /aigc/script/2708` 返回 `scriptName: "山海自有相逢处"`，顶层没有 `name`。项目读取器只检查 `name`，导致有名称的项目在 `jubian_catalog script` 中被报告为 `name: null`。另一次 `GET /aigc/storyboard/1611753` 则在分镜自己的快照中返回 `scriptName: null`，虽然最初创建分镜的请求体包含该名称。

## Decision

`readScript()` 把非空的项目 `scriptName` 投影到现有结果字段 `name`，旧载荷仍可回退读取 `name`。项目名称缺失或为空时仍返回 `null`。`readStoryboard()` 继续原样暴露分镜快照；项目读取永远不会改写远端分镜数据。

## Alternatives considered

**用项目名称填充分镜快照中的空值。** 这会误报提供方实际保存的值，还可能让后续基于快照的 PUT 变成未经验证的远端写入。

**保存或重建既有分镜来填充字段。** 提供方接受包含 `scriptName` 的创建请求体之后，分镜回读仍是空值；没有证据证明再写一次能保存它。项目名称读取不需要写操作。

## Consequences

目录读取现在通过现有结果字段报告真实项目名称，不增加公开诊断方法，也不增加 HTTP 请求。既有分镜的快照仍可能显示 `scriptName: null`；调用方不能把目录修复视作远端分镜修复。解析器与工具测试覆盖项目响应及旧字段回退。
