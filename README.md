# gemini2api-cfworker

Cloudflare Worker that converts Google Gemini's web StreamGenerate protocol into **OpenAI-compatible** and **Google AI Studio-compatible** APIs. Single-file, zero dependencies.

## Features

- **OpenAI API** — `GET /v1/models`, `POST /v1/chat/completions`
- **Responses API** — `POST /v1/responses` (Codex CLI compatible)
- **Google AI API** — `POST /v1beta/models/{model}:generateContent`, `:streamGenerateContent`
- Streaming (SSE) and non-streaming modes
- Tool calling / function calling support
- Image input via Scotty upload (requires cookie)
- Raw TCP socket upstream to bypass Cloudflare egress 429
- Actual upstream model reporting and Cookie/Pro route verification
- Dynamic model discovery from Gemini Web: Flash-Lite, Flash, and Pro, each with Standard or Extended Thinking
- Anonymous/guest requests keep working through Gemini's auto-routing model when no Cookie is configured
- Built-in web console for models, masked Cookie health/import/refresh, and Playground
- Automatic persisted Cookie rotation every six hours through a Cloudflare Cron Trigger
- Built-in retry, timeout, and debug probe endpoint

## Quick Start

### One-Click Deploy

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/banana2556/gemini2api-cfworker)

Click the button above, or deploy the repository with Wrangler. Cookie login is
stored **only** in the `COOKIE_STORE` Durable Object, so a bare Quick Edit paste
is suitable only for anonymous use unless you also configure the binding,
migration, and Cron Trigger from `wrangler.toml`.

### Wrangler CLI

```bash
npx wrangler deploy
```

Protect API calls and the console with the same key:

```bash
npx wrangler secret put API_KEYS
```

Once a Gemini Cookie is configured, `API_KEYS` is required so the logged-in
account cannot be consumed anonymously.

Open the deployed Worker URL in a browser for the console. The checked-in
Durable Object migration provisions persistent Cookie storage on deployment.

## Configuration

Edit the `CONFIG` object at the top of `worker.js`, or set the non-Cookie Worker
variables/secrets with the same names. Gemini login fields are deliberately not
read from Worker variables or secrets.

| Variable | Required? | Description | Default |
|---|---|---|---|
| `API_KEYS` | With a Cookie | Comma-separated keys or JSON array used for both API calls and the console. May be empty only for anonymous Gemini use | `[]` |
| `GEMINI_BL` | No | Fallback Gemini web build number; the current value is detected automatically and cached | `boq_assistant-bard-web-server_...` |
| `GEMINI_ORIGIN` | No | Upstream origin; point to a relay proxy if 429'd | `https://gemini.google.com` |
| `UPSTREAM_SOCKET` | No | Prefer raw TCP socket over fetch to upstream | `true` |
| `DEFAULT_MODEL` | No | Preferred alias; empty selects Flash Standard with a Cookie, or `gemini-auto` when guest | `""` |
| `RETRY_ATTEMPTS` | No | Max retry count on upstream failure | `3` |
| `RETRY_DELAY_SEC` | No | Delay between retries (seconds) | `2` |
| `REQUEST_TIMEOUT_SEC` | No | Per-request timeout (seconds) | `180` |
| `LOG_REQUESTS` | No | Enable request logging | `true` |
| `ENABLE_DEBUG` | No | Enable `/debug` probe endpoint | `true` |

No variable is required for anonymous text requests. Import a Cookie from the
web console for image input and logged-in Gemini features. Once the Durable
Object contains a Cookie, `API_KEYS` becomes mandatory for generation
endpoints.

> **Security tip:** Keep `API_KEYS` as a Worker secret. The
> console keeps it in the current tab's `sessionStorage`; Gemini
> Cookie values live only in Durable Object storage and are never returned by a
> status endpoint. Legacy `GEMINI_COOKIE`, `SAPISID`, `GEMINI_AUTH_USER`, and
> `GEMINI_XSRF_TOKEN` secrets are ignored by the Worker and may be deleted.

## Models

With a configured Cookie, `GET /v1/models` calls Gemini Web's current
`GetUserStatus` data and builds exactly six aliases for the account in use:

| Base family | Standard | Extended Thinking |
|---|---|---|
| Flash-Lite | `gemini-{version}-flash-lite` | `gemini-{version}-flash-lite-thinking` |
| Flash | `gemini-{version}-flash` | `gemini-{version}-flash-thinking` |
| Pro | `gemini-{version}-pro` | `gemini-{version}-pro-thinking` |

The version and both upstream route IDs are discovered rather than hard-coded.
For example, different rollout cohorts can expose `3.6 Flash` or `3.7 Flash`.
The catalog is cached for six hours and automatically fetched again after it
expires or the Durable Object Cookie changes.

Without a Cookie, the Worker does not pretend those families are available.
It exposes `gemini-auto` and `gemini-auto-thinking`, which use Gemini's guest
auto-routing mode. Unknown client aliases still work: a `*-thinking` name
keeps Extended Thinking, and everything else maps to `gemini-auto`.

Standard uses Gemini Web thinking level `1`; Extended Thinking uses level `2`
for all families. Level `3` is the separate **Deep Think** feature and is
not one of these aliases. Guest auto-routing typically lands on Flash-Lite
and does not honor a requested Pro/Flash route.

Paid Gemini / Google AI Pro accounts need the web model-select header
(`x-goog-ext-525001261-jspb`). The Worker now builds it from GetUserStatus
(primary model ID + account capacity). Without that header, Google keeps the
UI default — usually Flash — even when Pro is in the catalog.

To probe Gemini and see the model each alias actually routes to, request
`GET /v1/models?live=1`. Each entry then
includes `available`, `upstream_model`, and `route_status` (`matched`,
`fallback`, `auto`, or `unknown`). Live probing makes one small upstream
request per alias, so use it for diagnostics rather than every client startup.

## Usage Examples

Fetch `/v1/models` first and substitute an ID returned for your account. The
examples below use `gemini-3.6-flash` only as an illustrative rollout value.

### OpenAI SDK (Python)

```python
from openai import OpenAI

client = OpenAI(
    base_url="https://your-worker.workers.dev/v1",
    api_key="your-api-key",  # or omit if API_KEYS is empty
)

response = client.chat.completions.create(
    model="gemini-3.6-flash",
    messages=[{"role": "user", "content": "Hello!"}],
    stream=True,
)
for chunk in response:
    print(chunk.choices[0].delta.content or "", end="")
```

### cURL

```bash
curl https://your-worker.workers.dev/v1/chat/completions \
  -H "Authorization: Bearer your-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-3.6-flash",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": true
  }'
```

### Google AI SDK

```bash
curl "https://your-worker.workers.dev/v1beta/models/gemini-3.6-flash:generateContent?key=your-api-key" \
  -H "Content-Type: application/json" \
  -d '{"contents":[{"parts":[{"text":"Hello!"}]}]}'
```

## API Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/` | Browser console when `Accept: text/html`; health JSON for API clients |
| `GET` | `/health` | Health JSON (version + current `GEMINI_BL`; model catalog is served separately) |
| `GET` | `/admin/status` | Masked configuration/Cookie status; `?verify=1` probes Pro, `?live=1` probes all aliases |
| `PUT` | `/admin/cookie` | Persist a raw Cookie or Cookie Sync JSON (management key required) |
| `POST` | `/admin/cookie/refresh` | Validate the login and persist approved values returned by Google's `Set-Cookie` rotation |
| `DELETE` | `/admin/cookie` | Remove the Durable Object Cookie and return to unsigned-in mode |
| `GET` | `/v1/models` | Discover the six current aliases; add `?live=1` for actual upstream routes |
| `POST` | `/v1/chat/completions` | Chat completions (OpenAI format) |
| `POST` | `/v1/responses` | Responses API (Codex CLI) |
| `GET` | `/v1beta/models` | Discover the six current aliases; add `?live=1` for actual upstream routes |
| `POST` | `/v1beta/models/{model}:generateContent` | Generate content (Google format) |
| `POST` | `/v1beta/models/{model}:streamGenerateContent` | Stream generate (Google format) |
| `GET` | `/debug` | Connectivity, Cookie token, and Pro-route probe |

## Authentication

Clients can authenticate via any of:

- `Authorization: Bearer <key>`
- `x-api-key: <key>`
- `x-goog-api-key: <key>`
- `?key=<key>` query parameter

If `API_KEYS` is empty and no Cookie is configured, model-generation endpoints
are open. With any configured Cookie, generation fails closed until `API_KEYS`
is set. Cookie-management endpoints use the same `API_KEYS` values. Management
never accepts a query-string key.

## Cookie verification

`hasCookie: true` only means a value was configured. Use the web console or `/debug` and check
`cookie.status`:

- `pro_route_verified`: the configured Cookie really routed a Pro request to Pro
- `configured_but_pro_unavailable`: the request worked but did not use Pro; the Cookie may be expired, invalid, or lack Pro access
- `unverified`: no upstream model label was returned

Normal API responses keep the requested alias in `model`/`modelVersion` and
report the truth separately as `upstream_model`/`upstreamModel` plus routing
status. Cookie requests also attach
Gemini's current page token automatically.

The importer accepts the upstream Cookie Sync extension's JSON fields
(`cookie`, `sapisid`, `auth_user`, `xsrf_token`, `gemini_bl`). Page-token cache
entries are isolated by a cryptographic Cookie fingerprint, so replacing a
Cookie or switching Google accounts cannot reuse the previous account's XSRF
token. Raw browser Cookie pastes are normalized to approved authentication and
anti-abuse fields, including `AEC`, `NID`, and `COMPASS`; unrelated preference,
search, and billing fields are not stored or sent upstream.

The console's **Refresh Cookie** action and the repository's six-hour Cron
Trigger request Gemini's signed-in app page, save the newest page token, merge
only approved `Set-Cookie` rotations, and persist the result in `COOKIE_STORE`. Manual refresh
returns `refreshed`, `no_rotation`, or `reauth_required`. Rotation can extend a
valid session, but it cannot recreate an expired Google login;
`reauth_required` means the Cookie must be exported from the browser again.

Durable Object storage survives normal Worker code deployments, so redeploying
does not require another import. Re-import is needed only when Google rejects
the login, the Cookie is manually deleted, or the Durable Object storage itself
is removed.

## Troubleshooting

**Empty responses in production but works locally?**

Cloudflare Workers share egress IPs that Google may rate-limit. Solutions:
1. Enable `UPSTREAM_SOCKET: true` (default) — uses raw TCP to bypass fetch egress
2. Set `GEMINI_ORIGIN` to a relay proxy on a clean IP
3. Check `/debug` endpoint for upstream status

**Responses suddenly all empty?**

`GEMINI_BL` is detected automatically from the Gemini `/app` page when a
generation request needs it, then cached for one hour per origin. The configured
value is only a fallback if Gemini cannot be reached. If responses stay empty,
check `/debug` and the upstream status first.

## License

MIT
