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
- Built-in retry, timeout, and debug probe endpoint

## Quick Start

### One-Click Deploy

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/banana2556/gemini2api-cfworker)

Click the button above, or paste `worker.js` directly into **Cloudflare Dashboard > Workers & Pages > Create > Quick Edit > Deploy**.

### Wrangler CLI

```bash
npx wrangler deploy
```

## Configuration

Edit the `CONFIG` object at the top of `worker.js`, or set Worker environment variables / secrets with the same names (secrets take precedence).

| Variable | Description | Default |
|---|---|---|
| `API_KEYS` | Comma-separated keys or JSON array. Empty = no auth | `[]` |
| `GEMINI_COOKIE` | Full cookie string or `{"cookie":"...","sapisid":"..."}` | `""` |
| `SAPISID` | Explicit SAPISID (auto-extracted from cookie if omitted) | `""` |
| `GEMINI_BL` | Gemini web build number (update when responses go empty) | `boq_assistant-bard-web-server_...` |
| `GEMINI_ORIGIN` | Upstream origin; point to a relay proxy if 429'd | `https://gemini.google.com` |
| `UPSTREAM_SOCKET` | Prefer raw TCP socket over fetch to upstream | `true` |
| `DEFAULT_MODEL` | Default model when client doesn't specify | `gemini-3.6-flash` |
| `RETRY_ATTEMPTS` | Max retry count on upstream failure | `3` |
| `RETRY_DELAY_SEC` | Delay between retries (seconds) | `2` |
| `REQUEST_TIMEOUT_SEC` | Per-request timeout (seconds) | `180` |
| `LOG_REQUESTS` | Enable request logging | `true` |
| `ENABLE_DEBUG` | Enable `/debug` probe endpoint | `true` |

> **Security tip:** Set `GEMINI_COOKIE` and `API_KEYS` as Worker **secrets** (`wrangler secret put`) to avoid committing them to the repo.

## Models

| Model ID | Mode | Description |
|---|---|---|
| `gemini-3.6-flash` | Fast | Fast general-purpose model |
| `gemini-3.6-flash-thinking` | Thinking | Deep thinking, longest output (~20k chars) |
| `gemini-3.1-pro` | Pro | Pro model (requires cookie) |
| `gemini-3.1-pro-enhanced` | Pro+ | Pro with enhanced output (experimental) |
| `gemini-auto` | Auto | Auto model selection |
| `gemini-3.6-flash-thinking-lite` | Dynamic | Dynamic thinking with adaptive depth |
| `gemini-3.6-flash-lite` | Lite | Lightweight fast model |

Append `@think=N` to override thinking depth, e.g. `gemini-3.6-flash@think=0`.

## Usage Examples

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
| `GET` | `/` | Health check (returns version + model list) |
| `GET` | `/v1/models` | List models (OpenAI format) |
| `POST` | `/v1/chat/completions` | Chat completions (OpenAI format) |
| `POST` | `/v1/responses` | Responses API (Codex CLI) |
| `GET` | `/v1beta/models` | List models (Google format) |
| `POST` | `/v1beta/models/{model}:generateContent` | Generate content (Google format) |
| `POST` | `/v1beta/models/{model}:streamGenerateContent` | Stream generate (Google format) |
| `GET` | `/debug` | Upstream connectivity probe |

## Authentication

Clients can authenticate via any of:

- `Authorization: Bearer <key>`
- `x-api-key: <key>`
- `x-goog-api-key: <key>`
- `?key=<key>` query parameter

If `API_KEYS` is empty, all endpoints are open (no auth required).

## Troubleshooting

**Empty responses in production but works locally?**

Cloudflare Workers share egress IPs that Google may rate-limit. Solutions:
1. Enable `UPSTREAM_SOCKET: true` (default) — uses raw TCP to bypass fetch egress
2. Set `GEMINI_ORIGIN` to a relay proxy on a clean IP
3. Check `/debug` endpoint for upstream status

**Responses suddenly all empty?**

`GEMINI_BL` build number may be outdated. Visit `gemini.google.com` page source, search for `boq_assistant-bard-web-server_`, and update the value.

## License

MIT
