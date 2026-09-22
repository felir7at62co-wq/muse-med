# Agent Note: 剧变 admin token 的 Web 设置页

Status: implemented

[English](2026-09-20-jubian-token-settings-page.md) | 中文

## Problem

`dsh-tool-jubian` 每次调用都通过 `ctx.credentials` 解析 `JUBIANAI_ADMIN_TOKEN`，而部署只能从继承的进程环境、`$DSH_HOME/.credentials.yaml` 或某个 `.env` 文件提供它。因此，使用 Web GUI 的人必须离开应用、找到凭据文件、手工编辑并重启。这个 GUI 里已经有通用的 `credentials` Remote 命名空间，但它是覆盖整条 seam 的配置面：它把引用名当作参数，所以使用它的页面能写该部署里的任意引用，而不只是这一个。

## Decision

`@deepseek-ai/dsh-tool-jubian` 增加浏览器半边与 `jubianToken` Remote 命名空间，该包现在两面都构建、都发布。

宿主半边是 `src/token.ts`：一个名为 `jubianToken` 的 `TypertRemoteService`，带 `describe`、`set`、`unset`，由该行自己的 `apply` 与五个工具一起挂载。引用是模块常量 `credentialRef(JUBIAN_TOKEN_REF)`，永远不是参数，所以这个命名空间只能写一个凭据。没有任何方法返回值：每个答案都是凭据 seam 的 `CredentialInfo`——已配置、来源、是否可写——并逐字段投影，因为 Gateway 承载业务结果时不做解码，若提供方返回了额外属性，就会有更多字段抵达浏览器。`set` 把空值或全空白值作为 `gateway/bad-request` 拒绝并点名 `unset`；提供方的拒绝是 `jubian-token/rejected`，声明在本包的 `src/types.ts` 里，其 details 只携带引用名。

浏览器半边是 `src/client/`：`mount.ts` 用 `ctx.remote.$mount` 挂载生成的 `./remote` 贡献，然后在一个等待 `remote.jubianToken` 的子 fiber 上注册 `settings.section`（`id: 'jubian'`、`order: 16`）；`JubianTokenSection.tsx` 渲染状态行、一个密码输入框、保存与清除。`remote.jubianToken` 刻意不出现在插件自身的 `inject` 里：该服务由本插件提供，声明它会让 fiber 停在自己 `apply` 必须先造成的到达上。入口 `src/client/index.ts` 只把 `mountJubianTokenSettings` 绑到生成的产物上。

页面在三处注册：`tsconfig.client.json` 引用该包新的 client leaf，`package.json` 声明 `dsh.client` 与 `./client` 导出，而该包自己的 `cordis.patch.yml` 行——profile 本来就会消费的 bundle 补丁——才是把插件挂进 Web profile 的东西。`packages/bundle/web-app/cordis.patch.yml` 里没有加行。那份名册属于 profile 自己的组合，而本包在自己的 bundle 补丁里已经带了这一行；同 id 的第二行会在 `EntryGroup.update` 里合并到第一行上，所以那次编辑会悄悄把计费的剧变工具挂进每一个默认 Web 会话，而对已经列出该 bundle 的部署毫无改变。

## Alternatives considered

**复用已有的 `credentials` Remote 命名空间。** `ctx.remote.credentials` 已经提供 `describe`、`set`、`unset`，`ui-settings-models` 与 `ui-settings-plugins` 也已经在调它。它把引用名当作参数，而这恰恰是本页不能拥有的权限：需求是这一页只写一个固定引用。专用命名空间把这一点变成 wire 契约的属性，而不是调用方自觉的产物。

**把贡献加进 `api-remotes` 的 client assembly。** 其他每个命名空间都是这样抵达浏览器的，这样本包的浏览器入口就会是一个普通的、用 `inject` 声明的插件，没有挂载生命周期。代价是把一个包的功能拆到两个包里，而那份 assembly 是一份手工维护的、指向其他包产物的清单。`client-ui-agent-team` 已经为「自己拥有生成贡献的包」确立了自挂载，所以本包改用自挂载。

**改用 `settings` 而不是 `credentials` 接收令牌。** settings seam 以同样的条件承载脱敏值，但凭据 seam 本就拥有本页要报告的令牌存储、修复、来源分层与可写性判定；改走 settings 会给一个字符串增加第二个存储。

## Consequences

现在可以在 GUI 里设置令牌，而该行会在下一次调用时取到它，无需重启，因为传输层每次操作都重新解析。写路径只沿一个方向跨越浏览器与宿主之间的边界。

代价是同一个引用有了第二条写路径：`ctx.remote.credentials` 与 `ctx.remote.jubianToken` 都会到达 `ctx.credentials.set` 写 `JUBIANAI_ADMIN_TOKEN`。两者不可互换——通用命名空间需要引用名，这一个根本不能接受引用名——但要单点审计的部署必须盯住 seam，而不是盯住其中任何一个命名空间。

本包现在是双面的，所以构建有两个编译面，浏览器入口导入的生成产物只在宿主构建之后才存在。因此 `packages/jubian/tool-jubian/src/client/index.ts` 在逐文件覆盖率门禁之外，理由与 `packages/experimental/client-ui-agent-team/src/client/index.ts` 相同：它绑定的那个导入没有可供执行的源形态。

页面无法清除由只读来源提供的令牌：`describe` 报告 `writable: false`，两个按钮都被禁用，文案说明原因。这是凭据 seam 的遮蔽规则透出来的结果，不是页面的缺口。

## Testing

`packages/jubian/tool-jubian/tests/token.spec.ts` 在真实的内存凭据提供方上驱动该命名空间，所以存进去的值是从 seam 读回来的，而不是从桩里读的，并覆盖了拒绝、空值守卫，以及一个会加宽回复的提供方。`tests/browser-plugin.client.spec.tsx` 注册进生产用的 `SlotRegistry` 与真实的 `LocaleRuntime`，其 `$mount` 记录贡献并提供该命名空间；`tests/section.client.spec.tsx` 直接给组件喂 props，断言用户在每种凭据状态下读到的文案。`npx vitest run --coverage packages/jubian/tool-jubian` 在受覆盖的源文件上报告逐文件 100% 的语句、分支、函数与行。
