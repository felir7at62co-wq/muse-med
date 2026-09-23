# Agent Note: 可选的受限 Client 构建

Status: implemented

[English](2026-09-23-bounded-client-build.md) | 中文

## 问题

Windows 资源耗尽事件证实了多次构建失败期间的系统提交内存压力，但没有匹配的 Node 故障报告能定位具体崩溃的原生模块。Tsdown 0.22.2 会并发启动每个解析后的配置；限制 Rayon 线程不会限制这些 JavaScript 任务。

## 决策

`DSH_BUILD_CLIENT_CONCURRENCY` 可选地限制完整 Client 工作区构建中的原生 bundle 并发。不设置时保留 tsdown 的默认并发。正整数限制作用于原生工作区解析选出的全部配置，包括自定义 worker 配置和 Node 配套入口。它不改变所选入口、环境、产物或完整构建记录要求。watch 模式拒绝此选项。

根 `build:prepare` hook 获取容量。最后执行的顺序 Rolldown `closeBundle` hook 在其他关闭 hook 之后释放容量。若在 tsdown 的 `build:done` 中释放，同包多编译面的构建会死锁，因为 tsdown 在调用该 hook 前等待包的所有编译面完成。原生构建和渲染错误会拒绝排队配置。现有完整构建执行器仍仅在全部库和 Web 构建成功后写入记录。

包内插件和无关 hook 保持不变。新增的包内 `build:prepare` 或 `build:before` hook 必须在受限模式下组合根 hook；定向检查保护当前配置集合不覆盖它们。真实原生同包双编译面测试验证并发上限、完整完成、done hook 保留、失败拒绝与 watch 拒绝。

## 考虑过的替代方案

**按包名过滤。** 这会漏掉名称带 `/client` 后缀的浏览器配置。另设名单或使用 tsdown 私有解析器会重复维护归属，并带来产物不完整的风险。公开 hook 保留原生选集。

**仅限制 Rayon。** 这不会限制并发的 JavaScript 构建配置。受限模式控制这些配置，无需终止无关应用，也不改变普通构建性能。

## 影响

可选限制无需修改依赖或包管理器，以构建耗时换取完整产物集。若单个 bundle 或无关进程耗尽系统资源，它不能保证避免内存耗尽。自定义同名根 hook 必须组合而非替换。
