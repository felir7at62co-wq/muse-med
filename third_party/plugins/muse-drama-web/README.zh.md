# muse-drama-web

[English](README.md) | 中文

Muse 的**剧壳资源管理系统**（`drama-web.jubianai.net`）工具包。剧壳使用 `/api/v1` 接口，通过 `POST /auth/login` 签发 Bearer token。

## 工具做什么

| 工具 | 端点 | 作用 |
| --- | --- | --- |
| `drama_web_login` | `POST /auth/login` | 用宿主环境变量里的账号换 bearer token，token 只留内存 |
| `drama_web_library` | `GET /dramas` | 按剧名、状态、市场、推送状态、日期、组长检索短剧库 |
| `drama_web_profile` | `GET /dramas/{id}` | 真实档案字段，可选同名剧 |
| `drama_web_files` | `GET /dramas/{id}/files` | 按分类取资源 id（成片、字幕、海报、剧本等） |
| `drama_web_download` | `GET /files/{id}/url` | 下载到当前工作区的新文件，返回路径、字节数与 SHA-256 |
| `drama_web_pan_share` | `POST/GET /dramas/{id}/pan-share` | 创建异步网盘分享，必须用 `tasks` 复查生成结果 |
| `drama_web_title` | `POST /dramas/{id}/generate-title` | 服务端生成剧名或解析剧本，330 秒预算 |
| `drama_web_subtitle_erase` | `GET/POST /dramas/{id}/subtitle-erase-tasks` | 指定画面区域的去字幕 |
| `drama_web_link` | 无 | 拼出剧目的浏览器地址 |

## 在 Muse 中配置

在 Muse 宿主环境中将 `DRAMA_WEB_BASE_URL` 设为剧壳部署的 HTTPS API 根地址，包含 `/api/v1`。短剧编导会根据此配置加载内置插件，手动安装的插件也使用同一项配置。

在宿主环境设置 `DRAMA_WEB_TOKEN`，或由宿主设置 `DRAMA_WEB_USERNAME` 与 `DRAMA_WEB_PASSWORD` 后调用 `drama_web_login`。如文件通过另一个 HTTPS 源下载，把该源填入 `DRAMA_WEB_MEDIA_ORIGIN`，只填协议和主机端口。

下载需要当前会话的工作区写入权限，以及指向新文件的相对路径。创建网盘分享、生成标题、分析剧本和提交去字幕都需要宿主显式启用 `allowRemoteWrites`。启用前确认目标项目和操作效果。

## 服务行为

- 鉴权失败时保留上游 HTTP 状态。凭据过期后需更新宿主 token 或重新登录。
- 网盘分享是异步的：受理不等于生成完成。
- 去字幕必须用与源视频同分辨率测出的区域，猜坐标会得到废片。
- 网盘分享需要组长及以上权限。服务拒绝访问时，插件保留 HTTP 403 状态。
- 交互登录可能走飞书 SSO；该流程拿到的仍是同一枚 bearer token。

## 验证

单元测试只打本地桩服务器，不访问真实站点：

```sh
node --test tests/client.test.js tests/tools.test.js
```

需要验证真实服务的读取时，在测试环境设置 `DRAMA_WEB_BASE_URL` 和 `DRAMA_WEB_TOKEN`，然后单独运行 `node --test tests/live.test.js`。
