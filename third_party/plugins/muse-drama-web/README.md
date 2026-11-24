# muse-drama-web

English | [中文](README.zh.md)

Muse tools for the Jubian drama resource site (**剧壳资源管理系统**, `drama-web.jubianai.net`). The resource site uses the `/api/v1` API and issues bearer tokens through `POST /auth/login`.

## What the tools do

| Tool | Endpoint | Effect |
| --- | --- | --- |
| `drama_web_login` | `POST /auth/login` | Exchanges credentials from host environment variables for a bearer token; the token stays in memory |
| `drama_web_library` | `GET /dramas` | Library search by keyword, status, market, push status, dates and leader |
| `drama_web_profile` | `GET /dramas/{id}` | Real profile fields plus optional siblings |
| `drama_web_files` | `GET /dramas/{id}/files` | Resource ids by category (`final`, `subtitle`, `poster`, `script`, …) |
| `drama_web_download` | `GET /files/{id}/url` | Downloads to a new file in the current workspace and reports the path, byte count and SHA-256 |
| `drama_web_pan_share` | `POST/GET /dramas/{id}/pan-share` | Creates an asynchronous pan share; `tasks` confirms generation |
| `drama_web_title` | `POST /dramas/{id}/generate-title` | Server-side title or script analysis, 330s budget |
| `drama_web_subtitle_erase` | `GET/POST /dramas/{id}/subtitle-erase-tasks` | Region-based subtitle erasure |
| `drama_web_link` | none | Builds the browser URL for a drama |

## Configure in Muse

Set `DRAMA_WEB_BASE_URL` in the Muse Host environment to the deployment's HTTPS API root, including `/api/v1`. With this setting, Muse loads the bundled plugin in the short-drama agent. The manual plugin patch uses the same setting.

Set `DRAMA_WEB_TOKEN` in the Host environment or use `drama_web_login` with Host-provided `DRAMA_WEB_USERNAME` and `DRAMA_WEB_PASSWORD`. When the service sends downloads from a separate HTTPS origin, set `DRAMA_WEB_MEDIA_ORIGIN` to that origin, without a path or query.

Downloads require a session that allows workspace writes and a relative destination for a new file. Remote creation of shares, title generation, script analysis and subtitle-erasure submissions require an explicit Host override of `allowRemoteWrites`. Review the target project and expected effect before enabling these operations.

## Service behavior

- Authentication failures retain the upstream HTTP status. Renew the Host token or sign in again when the token expires.
- Pan shares are generated asynchronously: an accepted request is not a finished share.
- Subtitle erasure needs the region measured against the same video resolution; a guessed box produces unusable output.
- Pan share requires a team leader or higher role. The plugin retains the HTTP 403 status when the service rejects access.
- The deployment can be behind a Feishu SSO for interactive sign-in; the token that flow yields is the same bearer token these tools use.

## Verify

Unit tests run against a local stub server and never contact the real site:

```sh
node --test tests/client.test.js tests/tools.test.js
```

For an opt-in live read check, set `DRAMA_WEB_BASE_URL` and `DRAMA_WEB_TOKEN` in the test environment and run `node --test tests/live.test.js`.
