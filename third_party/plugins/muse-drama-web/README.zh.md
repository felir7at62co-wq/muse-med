# muse-drama-web

Muse 的剧变剧壳资源站点（**剧壳资源管理系统**，`drama-web.jubianai.net`）工具包。它与剧变制作后台 `web.jubianai.net/prod-api` 是两个服务：API 根是 `/api/v1`，鉴权靠 `POST /auth/login` 换来的 token，`@deepseek-ai/dsh-jubian` 对它没有覆盖。

## 工具做什么

| 工具 | 端点 | 作用 |
| --- | --- | --- |
| `drama_web_login` | `POST /auth/login` | 用宿主环境变量里的账号换 bearer token，token 只留内存 |
| `drama_web_library` | `GET /dramas` | 按剧名、状态、市场、推送状态、日期、组长检索短剧库 |
| `drama_web_profile` | `GET /dramas/{id}` | 真实档案字段，可选同名剧 |
| `drama_web_files` | `GET /dramas/{id}/files` | 按分类取资源 id（成片、字幕、海报、剧本等） |
| `drama_web_download` | `GET /files/{id}/url` | 签名地址；可选落盘并给出字节数与 SHA-256 |
| `drama_web_pan_share` | `POST/GET /dramas/{id}/pan-share` | 创建异步网盘分享，必须用 `tasks` 复查生成结果 |
| `drama_web_title` | `POST /dramas/{id}/generate-title` | 服务端生成剧名或解析剧本，330 秒预算 |
| `drama_web_subtitle_erase` | `GET/POST /dramas/{id}/subtitle-erase-tasks` | 指定画面区域的去字幕 |
| `drama_web_link` | 无 | 拼出剧目的浏览器地址 |

## 挂载

```yaml
- insert:
    - id: muse-drama-web
      name: muse-drama-web
      config:
        baseUrl: http://drama-web.jubianai.net/api/v1
        tokenEnv: DRAMA_WEB_TOKEN
```

token 由宿主保管。没有 token 时，设好 `DRAMA_WEB_USERNAME` / `DRAMA_WEB_PASSWORD` 后调用 `drama_web_login`；该工具不接受模型传入的账号密码。

## 真实的限制

- 未鉴权一律 HTTP 401 且响应体为空，插件只报状态码，不据此猜"过期"。
- 没有 refresh token，401 只能重新登录。
- 网盘分享是异步的：受理不等于生成完成。
- 去字幕必须用与源视频同分辨率测出的区域，猜坐标会得到废片。
- 网盘分享限组长及以上：普通成员调用会得到 `403 仅组长及以上可管理网盘分享`，插件原样透出该文案。
- 交互登录可能走飞书 SSO；该流程拿到的仍是同一枚 bearer token。

## 验证

单元测试只打本地桩服务器，不访问真实站点：

```sh
node --test tests/*.test.js
```

活体验证需要一枚真实 token，不在默认测试范围内。
