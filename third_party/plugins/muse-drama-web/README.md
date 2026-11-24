# muse-drama-web

Muse tools for the Jubian drama resource site (**剧壳资源管理系统**, `drama-web.jubianai.net`). The site is a separate service from the Jubian production backend at `web.jubianai.net/prod-api`: its API root is `/api/v1`, it authenticates with a token from `POST /auth/login`, and nothing in `@deepseek-ai/dsh-jubian` covers it.

## What the tools do

| Tool | Endpoint | Effect |
| --- | --- | --- |
| `drama_web_login` | `POST /auth/login` | Exchanges credentials from host environment variables for a bearer token; the token stays in memory |
| `drama_web_library` | `GET /dramas` | Library search by keyword, status, market, push status, dates and leader |
| `drama_web_profile` | `GET /dramas/{id}` | Real profile fields plus optional siblings |
| `drama_web_files` | `GET /dramas/{id}/files` | Resource ids by category (`final`, `subtitle`, `poster`, `script`, …) |
| `drama_web_download` | `GET /files/{id}/url` | Signed URL, optional workspace download with byte count and SHA-256 |
| `drama_web_pan_share` | `POST/GET /dramas/{id}/pan-share` | Creates an asynchronous pan share; `tasks` confirms generation |
| `drama_web_title` | `POST /dramas/{id}/generate-title` | Server-side title or script analysis, 330s budget |
| `drama_web_subtitle_erase` | `GET/POST /dramas/{id}/subtitle-erase-tasks` | Region-based subtitle erasure |
| `drama_web_link` | none | Builds the browser URL for a drama |

## Mount

```yaml
- insert:
    - id: muse-drama-web
      name: muse-drama-web
      config:
        baseUrl: http://drama-web.jubianai.net/api/v1
        tokenEnv: DRAMA_WEB_TOKEN
```

The host owns the token value. Without one, call `drama_web_login` after setting `DRAMA_WEB_USERNAME` / `DRAMA_WEB_PASSWORD`; the login tool never accepts credentials as arguments.

## Limits that are real

- Unauthenticated calls answer HTTP 401 with an empty body, so the plugin reports the status and never guesses "expired" from it.
- There is no refresh token; a 401 means signing in again.
- Pan shares are generated asynchronously: an accepted request is not a finished share.
- Subtitle erasure needs the region measured against the same video resolution; a guessed box produces unusable output.
- Pan share is limited to team leaders and above: a plain member gets `403 仅组长及以上可管理网盘分享`, which the plugin surfaces verbatim.
- The deployment can be behind a Feishu SSO for interactive sign-in; the token that flow yields is the same bearer token these tools use.

## Verify

Unit tests run against a local stub server and never contact the real site:

```sh
node --test tests/*.test.js
```

A live check needs one real token; it is not part of the default test run.
