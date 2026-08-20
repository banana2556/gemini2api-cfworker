/**
 * gemini-web2api — Cloudflare Worker(单文件)
 *
 * 把 Google Gemini 网页版的 StreamGenerate 协议转换成 OpenAI 兼容的 API。
 * 这是 Python 版 `gemini_web2api` 包的 JS 移植,改写为 Cloudflare Workers /
 * Web Fetch 运行时(不依赖 Node,不依赖标准库)。
 *
 * 接口:
 *   OpenAI:      GET  /v1/models
 *                POST /v1/chat/completions
 *                POST /v1/responses                       (Codex CLI)
 *   Google CLI:  GET  /v1beta/models
 *                POST /v1beta/models/{model}:generateContent
 *                POST /v1beta/models/{model}:streamGenerateContent
 *
 * 部署:把这个单文件粘贴到 Cloudflare 后台
 * (Workers & Pages → Create → 粘贴 → Deploy),或执行 `wrangler deploy`。
 * 核心 API 不需要 wrangler.toml 的 [vars]；若要在网页持久匯入 Cookie，
 * 则需使用仓库内 wrangler.toml 提供的 COOKIE_STORE Durable Object 绑定。
 *
 * 配置:编辑本文件顶部的 CONFIG 对象。每个键也都可以用同名的 Worker
 * 环境变量 / secret 覆盖(GEMINI_COOKIE / API_KEYS 建议用 secret,避免提交进仓库):
 *   GEMINI_COOKIE        完整 cookie 字符串,或 JSON {"cookie": "...", "sapisid": "..."}
 *   SAPISID              可选,显式指定 SAPISID(否则从 cookie 自动提取)
 *   API_KEYS             逗号分隔的列表或 JSON 数组;使用 Cookie 时必须设置
 *   ADMIN_KEY            面板管理密钥;设置后仅接受此 key,为空时才接受 API_KEYS
 *   GEMINI_AUTH_USER     可选,Google 多帐号索引
 *   GEMINI_XSRF_TOKEN    可选,显式指定 SNlM0e(否则自动抓取)
 *   GEMINI_BL            Gemini 网页版构建号(会随时间变化)
 *   GEMINI_ORIGIN        上游源站;部署被 Google 429 限流时,指向干净 IP 的反向代理
 *   UPSTREAM_SOCKET      true/false;true=上游优先用裸 socket(绕开 fetch 的 429)
 *   DEFAULT_MODEL        默认模型名
 *   RETRY_ATTEMPTS / RETRY_DELAY_SEC / REQUEST_TIMEOUT_SEC   整数
 *   LOG_REQUESTS         true/false
 *   ENABLE_DEBUG         true/false;false=关闭 /debug 端点(避免泄露内部配置)
 *
 * 限制:图片/多模态输入需要登录态 —— 设置了 GEMINI_COOKIE 时,图片会经 Scotty
 * 上传到 Gemini 再绑进会话;未设置 cookie 时图片会被忽略(匿名带图会被后端以
 * 1100 拒绝),并在 prompt 里加一句提示。`gemini-3.1-pro` 也只有带付费账号 cookie
 * 时才会真正路由到 Pro,否则回退到 Flash。
 */

const VERSION = "1.4.0-worker";

// ════════════════════════════════════════════════════════════════════════════
//  CONFIG —— 改这些值,然后直接部署本文件。
//  若设置了同名的 Worker 环境变量 / secret,会覆盖这里的值;不设则用此处的值。
// ════════════════════════════════════════════════════════════════════════════
const CONFIG = {
  // 调用方必须携带的密钥(Authorization: Bearer <key> 或 x-api-key: <key>)。
  // 空数组 = 仅匿名 Gemini 模式不鉴权；配置 Cookie 后必须设置。
  API_KEYS: [],

  // 面板 Cookie 管理密钥。设置后仅接受此 key；留空时才接受 API_KEYS 中任一
  // key。两者都为空时，面板仍可查看公开信息，但禁止 Cookie 管理操作。
  ADMIN_KEY: "",

  // Gemini cookie。匿名访问对所有模型都可用,唯独真正的 Pro 路由需要它。
  // 原始 cookie 字符串,例如:
  //   "SID=...; HSID=...; SSID=...; APISID=...; SAPISID=...; __Secure-1PSID=..."
  // 匿名就留空 ""。(出于安全考虑,建议把它设为 Worker secret。)
  GEMINI_COOKIE: "",
  SAPISID: "", // 可选;留空则自动从上面的 cookie 中提取
  GEMINI_AUTH_USER: "", // 多 Google 帐号索引，例如 0、1；默认帐号留空
  GEMINI_XSRF_TOKEN: "", // 可选；上游扩展导出的 SNlM0e

  // Gemini 网页版构建号。如果返回开始变空,去 gemini.google.com 页面源码里
  // 找一个新的值("boq_assistant-bard-web-server_...")。
  GEMINI_BL: "boq_assistant-bard-web-server_20260811.23_p0",

  // 上游源站。默认直连 gemini.google.com。若部署在 Cloudflare/无服务器平台
  // 被 Google 以 429 限流(出口 IP 被拦),把它指向一个跑在“干净 IP”上的反向
  // 代理(转发到 gemini.google.com 并保留 Host/Origin),即可绕开。例:
  //   GEMINI_ORIGIN = "https://your-relay.example.com"
  GEMINI_ORIGIN: "https://gemini.google.com",

  // 上游请求是否优先用裸 socket(cloudflare:sockets)绕开 fetch 的 429 限流。
  // true=优先 socket,不可用/失败再回退 fetch;false=只用 fetch。
  UPSTREAM_SOCKET: true,

  DEFAULT_MODEL: "gemini-3.6-flash",
  RETRY_ATTEMPTS: 3,
  RETRY_DELAY_SEC: 2,
  REQUEST_TIMEOUT_SEC: 180,
  LOG_REQUESTS: true,
  ENABLE_DEBUG: true,
};

// ─── 模型 ────────────────────────────────────────────────────────────────
// MODE_CATEGORY 枚举(来自 Gemini 前端 JS):
//   1=FAST, 2=THINKING, 3=PRO, 4=AUTO, 5=FAST_DYNAMIC_THINKING,
//   6=FLASH_LITE, 7=FLASH_PLUS
// model/submodel 是 2026-08-20 GetUserStatus 与 Gemini Web 实际选中的路由。
// 仅传 mode 会被降级；StreamGenerate 还必须携带主模型与子模型 ID。
const MODELS = {
  "gemini-3.7-flash": { mode: 1, think: 1, model: "fbb127bbb056c959", submodel: "56fdd199312815e2", submode: 1, desc: "Latest all-around model (Gemini 3.7 Flash)" },
  "gemini-3.6-flash": { mode: 1, think: 1, model: "fbb127bbb056c959", submodel: "56fdd199312815e2", submode: 1, desc: "All-around model (Gemini 3.6 Flash)" },
  "gemini-3.6-flash-thinking": { mode: 2, think: 2, model: "fbb127bbb056c959", submodel: "56fdd199312815e2", desc: "Deep thinking mode, longest output (~20k chars)" },
  "gemini-3.1-pro": { mode: 3, think: 1, model: "9d8ca3786ebdfbea", submodel: "e6fa609c3fa255c0", submode: 3, desc: "Pro model (requires cookie for real routing)" },
  "gemini-3.1-pro-enhanced": { mode: 3, think: 3, model: "9d8ca3786ebdfbea", submodel: "e6fa609c3fa255c0", submode: 3, extra: { 31: 2 }, desc: "Pro with enhanced output (experimental)" },
  "gemini-auto": { mode: 4, think: 1, desc: "Auto model selection" },
  "gemini-3.6-flash-thinking-lite": { mode: 5, think: 1, model: "fbb127bbb056c959", submodel: "56fdd199312815e2", desc: "Dynamic thinking with adaptive depth" },
  "gemini-3.6-flash-lite": { mode: 6, think: 1, model: "cf41b0e0dd7d53e5", submodel: "8c46e95b1a07cecc", submode: 6, desc: "Lightweight fast model" },
};

/**
 * 把模型名解析成路由参数。
 * 未知名称会回退到 `def` 而不是报错(客户端可能传任意 id)。
 * 支持 `@think=N` 后缀来覆盖思考深度。
 * 返回 { name, modeId, thinkMode, extra },或 { error }。
 */
function resolveModel(modelName, def) {
  let thinkOverride = null;
  if (modelName.includes("@think=")) {
    const idx = modelName.lastIndexOf("@think=");
    const thinkStr = modelName.slice(idx + "@think=".length);
    modelName = modelName.slice(0, idx);
    if (!/^-?\d+$/.test(thinkStr)) return { error: `Invalid think level: ${thinkStr}` };
    thinkOverride = parseInt(thinkStr, 10);
  }
  let cfg = MODELS[modelName];
  if (!cfg) {
    modelName = def;
    cfg = MODELS[def];
  }
  return {
    name: modelName,
    modeId: cfg.mode,
    thinkMode: thinkOverride !== null ? thinkOverride : cfg.think,
    extra: cfg.model ? {
      59: cfg.model,
      ...(cfg.submodel ? { 64: cfg.submodel } : {}),
      ...(cfg.submode ? { 75: cfg.submode } : {}),
      ...(cfg.extra || {}),
    } : (cfg.extra || null),
  };
}

// ─── 配置 ──────────────────────────────────────────────────────────────────
function parseBool(v, def) {
  if (v === undefined || v === null || v === "") return def;
  return /^(1|true|yes|on)$/i.test(String(v));
}

function parseIntDefault(v, def) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}

function parseApiKeys(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v.map(String).filter(Boolean);
  v = String(v).trim();
  if (v.startsWith("[")) {
    try {
      const arr = JSON.parse(v);
      if (Array.isArray(arr)) return arr.map(String);
    } catch (_) { /* 继续往下走 */ }
  }
  return v.split(",").map((s) => s.trim()).filter(Boolean);
}

// 当 env[key] 设置了非空值时返回它,否则返回内嵌的默认值。
function envOr(env, key, fallback) {
  const v = env[key];
  return v !== undefined && v !== null && v !== "" ? v : fallback;
}

const SESSION_COOKIE_NAMES = ["__Secure-1PSID", "__Secure-3PSID", "SID"];
const MAX_COOKIE_BYTES = 64 * 1024;
const FORWARDED_COOKIE_NAMES = [
  "SID", "HSID", "SSID", "APISID", "SAPISID", "LSID", "OSID", "SIDCC",
  "AEC", "NID", "COMPASS",
  "__Secure-1PAPISID", "__Secure-1PSID", "__Secure-1PSIDTS", "__Secure-1PSIDRTS", "__Secure-1PSIDCC",
  "__Secure-3PAPISID", "__Secure-3PSID", "__Secure-3PSIDTS", "__Secure-3PSIDRTS", "__Secure-3PSIDCC",
  "__Secure-OSID", "__Host-1PLSID", "__Host-3PLSID",
];
const FORWARDED_COOKIE_SET = new Set(FORWARDED_COOKIE_NAMES);

function parseCookiePairs(cookie) {
  const pairs = new Map();
  for (const part of String(cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i <= 0) continue;
    const name = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();
    if (name && value) pairs.set(name, value);
  }
  return pairs;
}

function serializeCookiePairs(pairs) {
  return FORWARDED_COOKIE_NAMES
    .filter((name) => pairs.has(name))
    .map((name) => `${name}=${pairs.get(name)}`)
    .join("; ");
}

function getSetCookieValues(headers) {
  if (!headers) return [];
  let values = [];
  if (typeof headers.getSetCookie === "function") {
    values = headers.getSetCookie() || [];
  }
  if (!values.length) {
    const combined = headers.get && headers.get("set-cookie");
    if (combined) values = [combined];
  }
  return values.flatMap((value) =>
    String(value).split(/,(?=\s*[!#$%&'*+\-.^_`|~0-9A-Za-z]+=)/).map((part) => part.trim()).filter(Boolean)
  );
}

function mergeRotatedCookies(cookie, setCookieValues) {
  const pairs = parseCookiePairs(cookie);
  const changed = new Set();
  let ignoredCookieCount = 0;

  for (const line of setCookieValues || []) {
    const parts = String(line || "").split(";");
    const first = parts.shift() || "";
    const i = first.indexOf("=");
    if (i <= 0) continue;
    const name = first.slice(0, i).trim();
    const value = first.slice(i + 1).trim();
    if (!FORWARDED_COOKIE_SET.has(name)) {
      ignoredCookieCount += 1;
      continue;
    }

    let remove = !value;
    for (const attribute of parts) {
      const j = attribute.indexOf("=");
      const key = (j < 0 ? attribute : attribute.slice(0, j)).trim().toLowerCase();
      const attrValue = j < 0 ? "" : attribute.slice(j + 1).trim();
      if (key === "max-age" && Number(attrValue) <= 0) remove = true;
      if (key === "expires") {
        const expiresAt = Date.parse(attrValue);
        if (Number.isFinite(expiresAt) && expiresAt <= Date.now()) remove = true;
      }
    }

    if (remove) {
      if (pairs.delete(name)) changed.add(name);
    } else if (pairs.get(name) !== value) {
      pairs.set(name, value);
      changed.add(name);
    }
  }

  return {
    cookie: serializeCookiePairs(pairs),
    changed_cookie_names: [...changed],
    ignored_cookie_count: ignoredCookieCount,
  };
}

function parseAuthPayload(input, strict = false) {
  let payload = input;
  if (typeof payload === "string") {
    const raw = payload.trim();
    if (raw.startsWith("{")) {
      try { payload = JSON.parse(raw); } catch (_) { payload = { cookie: raw }; }
    } else {
      payload = { cookie: raw };
    }
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) payload = {};

  const rawCookie = String(payload.cookie ?? payload.GEMINI_COOKIE ?? "")
    .replace(/^cookie\s*:\s*/i, "")
    .replace(/[\r\n]+[\t ]*/g, " ")
    .trim();
  const pairs = parseCookiePairs(rawCookie);
  const forwarded = FORWARDED_COOKIE_NAMES.filter((name) => pairs.has(name));
  const cookie = serializeCookiePairs(pairs);
  const removedCookieCount = Math.max(0, pairs.size - forwarded.length);
  const embeddedSapisid = pairs.get("SAPISID") || "";
  const explicitSapisid = String(payload.sapisid ?? payload.SAPISID ?? "").trim();
  const sapisid = explicitSapisid || embeddedSapisid;
  const authUserRaw = payload.auth_user ?? payload.authUser ?? payload.GEMINI_AUTH_USER ?? "";
  const authUser = authUserRaw === null || authUserRaw === "" ? null : String(authUserRaw).trim();
  const xsrfToken = String(payload.xsrf_token ?? payload.xsrfToken ?? payload.GEMINI_XSRF_TOKEN ?? "").trim();
  const geminiBl = String(payload.gemini_bl ?? payload.geminiBl ?? "").trim();

  if (strict) {
    if (!rawCookie) throw new Error("Cookie 不可為空");
    if (new TextEncoder().encode(rawCookie).length > MAX_COOKIE_BYTES) throw new Error("Cookie 超過 64 KiB 上限");
    if (!sapisid) throw new Error("缺少 SAPISID");
    if (explicitSapisid && embeddedSapisid && !timingSafeEqual(explicitSapisid, embeddedSapisid)) {
      throw new Error("JSON 內的 sapisid 與 Cookie 中的 SAPISID 不一致");
    }
    if (!SESSION_COOKIE_NAMES.some((name) => pairs.has(name))) {
      throw new Error("缺少登入工作階段 Cookie（__Secure-1PSID、__Secure-3PSID 或 SID）");
    }
    if (authUser !== null && !/^\d+$/.test(authUser)) throw new Error("auth_user 必須是非負整數");
  }

  return {
    cookie,
    sapisid,
    auth_user: authUser,
    xsrf_token: xsrfToken,
    gemini_bl: geminiBl,
    removed_cookie_count: removedCookieCount,
  };
}

function cookieSummary(cfg) {
  const pairs = parseCookiePairs(cfg.cookie);
  const sessionCookie = SESSION_COOKIE_NAMES.find((name) => pairs.has(name)) || null;
  const issues = [];
  if (cfg.cookie && !pairs.has("SAPISID") && !cfg.sapisid) issues.push("missing_sapisid");
  if (cfg.cookie && !sessionCookie) issues.push("missing_session_cookie");
  return {
    configured: !!cfg.cookie,
    source: cfg.cookie_source || "none",
    updated_at: cfg.cookie_updated_at || null,
    refreshed_at: cfg.cookie_refreshed_at || null,
    byte_length: cfg.cookie ? new TextEncoder().encode(cfg.cookie).length : 0,
    cookie_count: pairs.size,
    removed_cookie_count: cfg.removed_cookie_count || 0,
    sapisid_present: !!cfg.sapisid,
    session_cookie: sessionCookie,
    xsrf_token_present: !!cfg.xsrf_token,
    auth_user: cfg.auth_user,
    structurally_valid: !!cfg.cookie && !issues.length,
    issues,
  };
}

function getConfig(env) {
  env = env || {};
  const rawCookie = envOr(env, "GEMINI_COOKIE", CONFIG.GEMINI_COOKIE) || "";
  const auth = parseAuthPayload(rawCookie);
  const sapisid = String(envOr(env, "SAPISID", CONFIG.SAPISID) || auth.sapisid || "").trim();
  const authUserRaw = envOr(env, "GEMINI_AUTH_USER", CONFIG.GEMINI_AUTH_USER);
  const authUser = authUserRaw === "" || authUserRaw === null || authUserRaw === undefined
    ? auth.auth_user
    : String(authUserRaw);
  const xsrfToken = String(envOr(env, "GEMINI_XSRF_TOKEN", CONFIG.GEMINI_XSRF_TOKEN) || auth.xsrf_token || "");
  const envGeminiBl = env.GEMINI_BL !== undefined && env.GEMINI_BL !== null && env.GEMINI_BL !== ""
    ? env.GEMINI_BL
    : null;
  return {
    gemini_bl: envGeminiBl || auth.gemini_bl || CONFIG.GEMINI_BL,
    gemini_origin: String(envOr(env, "GEMINI_ORIGIN", CONFIG.GEMINI_ORIGIN)).replace(/\/$/, ""),
    upstream_socket: parseBool(envOr(env, "UPSTREAM_SOCKET", CONFIG.UPSTREAM_SOCKET), true),
    default_model: envOr(env, "DEFAULT_MODEL", CONFIG.DEFAULT_MODEL),
    retry_attempts: parseIntDefault(envOr(env, "RETRY_ATTEMPTS", CONFIG.RETRY_ATTEMPTS), 3),
    retry_delay_sec: parseIntDefault(envOr(env, "RETRY_DELAY_SEC", CONFIG.RETRY_DELAY_SEC), 2),
    request_timeout_sec: parseIntDefault(envOr(env, "REQUEST_TIMEOUT_SEC", CONFIG.REQUEST_TIMEOUT_SEC), 180),
    log_requests: parseBool(envOr(env, "LOG_REQUESTS", CONFIG.LOG_REQUESTS), true),
    enable_debug: parseBool(envOr(env, "ENABLE_DEBUG", CONFIG.ENABLE_DEBUG), true),
    api_keys: parseApiKeys(envOr(env, "API_KEYS", CONFIG.API_KEYS)),
    admin_key: String(envOr(env, "ADMIN_KEY", CONFIG.ADMIN_KEY) || ""),
    cookie: auth.cookie,
    sapisid,
    auth_user: authUser === "" || authUser === null || authUser === undefined ? null : String(authUser),
    xsrf_token: xsrfToken,
    cookie_source: auth.cookie
      ? (env.GEMINI_COOKIE !== undefined && env.GEMINI_COOKIE !== "" ? "secret" : "inline")
      : "none",
    cookie_updated_at: null,
    cookie_refreshed_at: null,
    removed_cookie_count: auth.removed_cookie_count,
  };
}

function applyStoredAuth(cfg, record) {
  if (!record || !record.cookie) return cfg;
  const auth = parseAuthPayload(record);
  return {
    ...cfg,
    cookie: auth.cookie,
    sapisid: auth.sapisid,
    auth_user: auth.auth_user,
    xsrf_token: auth.xsrf_token,
    gemini_bl: auth.gemini_bl || cfg.gemini_bl,
    cookie_source: "dashboard",
    cookie_updated_at: record.updated_at || null,
    cookie_refreshed_at: record.refreshed_at || null,
    removed_cookie_count: record.removed_cookie_count || auth.removed_cookie_count || 0,
  };
}

function cookieStoreStub(env) {
  if (!env || !env.COOKIE_STORE) return null;
  return env.COOKIE_STORE.get(env.COOKIE_STORE.idFromName("settings"));
}

async function readStoredAuth(env) {
  const stub = cookieStoreStub(env);
  if (!stub) return null;
  const response = await stub.fetch("https://cookie-store.internal/auth");
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Cookie store read failed (${response.status})`);
  return response.json();
}

async function writeStoredAuth(env, record) {
  const stub = cookieStoreStub(env);
  if (!stub) throw new Error("COOKIE_STORE Durable Object 尚未綁定");
  const response = await stub.fetch("https://cookie-store.internal/auth", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(record),
  });
  if (!response.ok) throw new Error(`Cookie store write failed (${response.status})`);
}

async function clearStoredAuth(env) {
  const stub = cookieStoreStub(env);
  if (!stub) throw new Error("COOKIE_STORE Durable Object 尚未綁定");
  const response = await stub.fetch("https://cookie-store.internal/auth", { method: "DELETE" });
  if (!response.ok) throw new Error(`Cookie store delete failed (${response.status})`);
}

async function getRequestConfig(env) {
  const cfg = getConfig(env);
  return applyStoredAuth(cfg, await readStoredAuth(env));
}

export class CookieStore {
  constructor(state) { this.state = state; }

  async fetch(request) {
    if (request.method === "GET") {
      const auth = await this.state.storage.get("auth");
      return auth
        ? new Response(JSON.stringify(auth), { headers: { "Content-Type": "application/json" } })
        : new Response(null, { status: 404 });
    }
    if (request.method === "PUT") {
      const auth = await request.json();
      await this.state.storage.put("auth", auth);
      return new Response(null, { status: 204 });
    }
    if (request.method === "DELETE") {
      await this.state.storage.delete("auth");
      return new Response(null, { status: 204 });
    }
    return new Response(null, { status: 405 });
  }
}

// ─── 小工具 ──────────────────────────────────────────────────────────────────
function log(cfg, msg) {
  if (cfg && cfg.log_requests) {
    try { console.error(`[gemini-web2api] ${msg}`); } catch (_) {}
  }
}

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function timeoutSignal(ms) {
  if (typeof AbortSignal !== "undefined" && AbortSignal.timeout) {
    return AbortSignal.timeout(ms);
  }
  const ac = new AbortController();
  setTimeout(() => ac.abort(), ms);
  return ac.signal;
}

function randomBytes(n) {
  const arr = new Uint8Array(n);
  if (globalThis.crypto && globalThis.crypto.getRandomValues) {
    globalThis.crypto.getRandomValues(arr);
  } else {
    for (let i = 0; i < n; i++) arr[i] = Math.floor(Math.random() * 256);
  }
  return arr;
}

/** 生成 `n` 个十六进制字符的随机串(n/2 个随机字节)。 */
function randHex(n) {
  const bytes = randomBytes(Math.ceil(n / 2));
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s.slice(0, n);
}

/** SAPISIDHASH 鉴权头(对 "<ts> <sapisid> <origin>" 做 SHA-1)。 */
async function makeSapisidHash(sapisid) {
  const ts = nowSec();
  const data = new TextEncoder().encode(`${ts} ${sapisid} https://gemini.google.com`);
  const buf = await globalThis.crypto.subtle.digest("SHA-1", data);
  const hex = [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `SAPISIDHASH ${ts}_${hex}`;
}

function tokenEst(s) {
  return Math.floor((s ? s.length : 0) / 4);
}

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

function timingSafeEqual(a, b) {
  const enc = new TextEncoder();
  const ab = enc.encode(a), bb = enc.encode(b);
  const len = Math.max(ab.length, bb.length);
  let diff = ab.length ^ bb.length;
  for (let i = 0; i < len; i++) diff |= (ab[i] || 0) ^ (bb[i] || 0);
  return diff === 0;
}

// ─── Gemini StreamGenerate 协议 ────────────────────────────────────────────
// f.req 数组的已知槽位（来自 Gemini 前端 JS 逆向）
const SLOT = {
  PROMPT: 0, LANG: 1, META: 2, FLAGS_6: 6, FLAGS_7: 7,
  FLAGS_10: 10, FLAGS_11: 11, THINK_MODE: 17, FLAGS_18: 18,
  FLAGS_27: 27, FLAGS_30: 30, FLAGS_41: 41, FLAGS_53: 53,
  MODEL_ID: 59, FLAGS_61: 61, FLAGS_68: 68, MODE: 79, THINK_LEVEL: 80,
};

function buildPayload(prompt, modelId, thinkMode, fileRefs, extra) {
  const inner = new Array(102).fill(null);
  if (fileRefs && fileRefs.length) {
    // 每个上传文件表示为 [[fileRef, 1], filename](格式来自 gemini_webapi,
    // 已实测能被后端接受 —— 详见 test/live-image.mjs 的诊断)。
    const files = fileRefs.map((ref) => [[ref, 1], "image.png"]);
    inner[SLOT.PROMPT] = [prompt, 0, null, files, null, null, 0];
  } else {
    inner[SLOT.PROMPT] = [prompt, 0, null, null, null, null, 0];
  }
  inner[SLOT.LANG] = ["en"];
  inner[SLOT.META] = ["", "", "", null, null, null, null, null, null, ""];
  inner[SLOT.FLAGS_6] = [0];
  inner[SLOT.FLAGS_7] = 1;
  inner[SLOT.FLAGS_10] = 1;
  inner[SLOT.FLAGS_11] = 0;
  inner[SLOT.THINK_MODE] = [[thinkMode]];
  inner[SLOT.FLAGS_18] = 0;
  inner[SLOT.FLAGS_27] = 1;
  inner[SLOT.FLAGS_30] = [4];
  inner[SLOT.FLAGS_41] = [2];
  inner[SLOT.FLAGS_53] = 0;
  inner[SLOT.FLAGS_61] = [];
  inner[SLOT.FLAGS_68] = 1;
  inner[SLOT.MODE] = modelId;
  if (thinkMode >= 1 && thinkMode <= 3) inner[SLOT.THINK_LEVEL] = thinkMode;
  if (extra) {
    for (const k of Object.keys(extra)) inner[Number(k)] = extra[k];
  }
  const outer = [null, JSON.stringify(inner)];
  return new URLSearchParams({ "f.req": JSON.stringify(outer) }).toString();
}

function accountPrefix(cfg) {
  return cfg.auth_user === null || cfg.auth_user === undefined || cfg.auth_user === ""
    ? ""
    : `/u/${cfg.auth_user}`;
}

function applyAccountHeaders(headers, cfg) {
  if (cfg.auth_user !== null && cfg.auth_user !== undefined && cfg.auth_user !== "") {
    headers["X-Goog-AuthUser"] = String(cfg.auth_user);
  }
  return headers;
}

function getUrl(cfg) {
  const reqid = (nowSec() * 1000 + Math.floor(Math.random() * 1000)) % 10000000;
  const origin = cfg.gemini_origin || "https://gemini.google.com";
  return (
    origin + accountPrefix(cfg) +
    "/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate" +
    `?bl=${encodeURIComponent(cfg.gemini_bl)}&hl=en&_reqid=${reqid}&rt=c`
  );
}

async function buildHeaders(cfg) {
  const headers = {
    "Content-Type": "application/x-www-form-urlencoded",
    "Origin": "https://gemini.google.com",
    "Referer": `https://gemini.google.com${accountPrefix(cfg)}/app`,
    "X-Same-Domain": "1",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
  };
  applyAccountHeaders(headers, cfg);
  if (cfg.cookie) headers["Cookie"] = cfg.cookie;
  if (cfg.sapisid) headers["Authorization"] = await makeSapisidHash(cfg.sapisid);
  return headers;
}

// ─── Socket 上游(绕开 fetch)──────────────────────────────────────────────────
// Cloudflare Workers 的 fetch 子请求走共享出口、易被 Google 429。改用
// cloudflare:sockets 的 connect() 裸 TCP+TLS 自行拼 HTTP/1.1,出口路径不同,
// 常能避开限流。Node(测试)拿不到该模块 -> resolveConnect() 返回 null -> 回退 fetch。
let _connect; // undefined=未解析, null=不可用, function=可用
async function resolveConnect() {
  if (_connect !== undefined) return _connect;
  try {
    const mod = await import("cloudflare:sockets");
    _connect = mod.connect || null;
  } catch (_) {
    _connect = null;
  }
  return _connect;
}
// 测试注入(Node 用 tls 模拟 connect();传 null 可强制走 fetch)。
function __setConnect(fn) { _connect = fn === undefined ? null : fn; }

function _concatBytes(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
function _findCRLF(buf, from) {
  for (let i = from; i + 1 < buf.length; i++) if (buf[i] === 13 && buf[i + 1] === 10) return i;
  return -1;
}
function _findDoubleCRLF(buf) {
  for (let i = 0; i + 3 < buf.length; i++) {
    if (buf[i] === 13 && buf[i + 1] === 10 && buf[i + 2] === 13 && buf[i + 3] === 10) return i;
  }
  return -1;
}

// 用裸 socket 发一个 HTTP/1.1 请求,返回类 Response 对象:{status, ok, headers, body, text()}。
// body 是已解码(去 chunked、identity 编码)的 ReadableStream<Uint8Array>,支持流式。
async function socketHttp(connect, url, { method = "GET", headers = {}, body, timeoutMs = 180000 } = {}) {
  const u = new URL(url);
  const secure = u.protocol !== "http:";
  const port = u.port ? Number(u.port) : (secure ? 443 : 80);
  const socket = connect({ hostname: u.hostname, port }, { secureTransport: secure ? "on" : "off", allowHalfOpen: false });

  let timer = null;
  if (timeoutMs) timer = setTimeout(() => { try { socket.close(); } catch (_) {} }, timeoutMs);

  const enc = new TextEncoder();
  const bodyBytes = body == null ? null : (typeof body === "string" ? enc.encode(body) : new Uint8Array(body));
  // 自管 Host/Connection/Accept-Encoding(identity 避免 gzip)/Content-Length
  const reqHeaders = { Host: u.hostname, "Accept-Encoding": "identity", Connection: "close" };
  for (const [k, v] of Object.entries(headers)) {
    if (/^(host|connection|accept-encoding|content-length)$/i.test(k)) continue;
    reqHeaders[k] = v;
  }
  if (bodyBytes) reqHeaders["Content-Length"] = String(bodyBytes.length);
  let head = `${method} ${u.pathname}${u.search} HTTP/1.1\r\n`;
  for (const [k, v] of Object.entries(reqHeaders)) head += `${k}: ${v}\r\n`;
  head += "\r\n";

  const writer = socket.writable.getWriter();
  await writer.write(enc.encode(head));
  if (bodyBytes) await writer.write(bodyBytes);
  try { writer.releaseLock(); } catch (_) {}

  const reader = socket.readable.getReader();
  let buf = new Uint8Array(0);
  let he = -1;
  while (he < 0) {
    const { done, value } = await reader.read();
    if (done) break;
    buf = _concatBytes(buf, value);
    he = _findDoubleCRLF(buf);
  }
  if (he < 0) { if (timer) clearTimeout(timer); throw new Error("socket: incomplete HTTP response headers"); }
  const headerText = new TextDecoder().decode(buf.slice(0, he));
  let pending = buf.slice(he + 4);
  const hlines = headerText.split("\r\n");
  const status = parseInt((hlines[0] || "").split(" ")[1], 10) || 0;
  const respHeaders = new Headers();
  for (let i = 1; i < hlines.length; i++) {
    const c = hlines[i].indexOf(":");
    if (c > 0) { try { respHeaders.append(hlines[i].slice(0, c).trim(), hlines[i].slice(c + 1).trim()); } catch (_) {} }
  }
  const chunked = /chunked/i.test(respHeaders.get("transfer-encoding") || "");
  const clen = respHeaders.has("content-length") ? parseInt(respHeaders.get("content-length"), 10) : null;

  const stream = new ReadableStream({
    async start(controller) {
      const pull = async () => {
        const { done, value } = await reader.read();
        if (done) return false;
        pending = _concatBytes(pending, value);
        return true;
      };
      try {
        if (chunked) {
          for (;;) {
            let nl = _findCRLF(pending, 0);
            while (nl < 0) { if (!(await pull())) { controller.close(); return; } nl = _findCRLF(pending, 0); }
            const size = parseInt(new TextDecoder().decode(pending.slice(0, nl)).trim().split(";")[0], 16);
            pending = pending.slice(nl + 2);
            if (!size || Number.isNaN(size)) { controller.close(); return; } // 末块 0
            while (pending.length < size + 2) { if (!(await pull())) break; }
            controller.enqueue(pending.slice(0, size));
            pending = pending.slice(size + 2); // 跳过块尾 \r\n
          }
        } else if (clen != null) {
          let got = 0;
          if (pending.length) { const t = pending.slice(0, clen); controller.enqueue(t); got += t.length; pending = pending.slice(t.length); }
          while (got < clen) { const { done, value } = await reader.read(); if (done) break; const need = clen - got; const t = value.length > need ? value.slice(0, need) : value; controller.enqueue(t); got += t.length; }
          controller.close();
        } else {
          if (pending.length) controller.enqueue(pending);
          for (;;) { const { done, value } = await reader.read(); if (done) break; controller.enqueue(value); }
          controller.close();
        }
      } catch (e) {
        controller.error(e);
      } finally {
        if (timer) clearTimeout(timer);
        try { reader.releaseLock(); } catch (_) {}
        try { socket.close(); } catch (_) {}
      }
    },
    cancel() { if (timer) clearTimeout(timer); try { socket.close(); } catch (_) {} },
  });

  const res = { status, ok: status >= 200 && status < 300, headers: respHeaders, body: stream };
  res.text = async () => {
    const r = stream.getReader();
    const chunks = []; let total = 0;
    for (;;) { const { done, value } = await r.read(); if (done) break; chunks.push(value); total += value.length; }
    const merged = new Uint8Array(total); let off = 0;
    for (const c of chunks) { merged.set(c, off); off += c.length; }
    return new TextDecoder().decode(merged);
  };
  return res;
}

// 统一上游入口:socket 优先,失败/不可用则回退 fetch。返回类 Response 对象。
async function httpFetch(url, { method = "GET", headers = {}, body, timeoutMs = 180000, socket = true } = {}) {
  if (socket) {
    const connect = await resolveConnect();
    if (connect) {
      try {
        return await socketHttp(connect, url, { method, headers, body, timeoutMs });
      } catch (e) {
        // socket 连接层失败(非 HTTP 错误)-> 回退 fetch
      }
    }
  }
  return fetch(url, { method, headers, body, signal: timeoutSignal(timeoutMs) });
}

// ─── 多模态:图片上传(Scotty 续传)───────────────────────────────────────────
// 说明:图片输入需要登录态(GEMINI_COOKIE)。匿名会话上传文件能成功,但带图
// 生成会被后端以 BardErrorInfo[1100] 拒绝(权限门)。无 cookie 时不上传,
// 改为在 prompt 里追加一句提示,降级为纯文本。详见 test/live-image.mjs。

const _UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";
let _pageTokens = { key: "", tokens: null, ts: 0 };
const GEMINI_BL_CACHE_TTL_SEC = 3600;
let _geminiBlMemory = { origin: "", value: "", expiresAt: 0 };

async function authCacheKey(cfg) {
  const raw = [cfg.gemini_origin || "https://gemini.google.com", cfg.auth_user ?? "", cfg.cookie || "", cfg.xsrf_token || ""].join("\n");
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
  return [...new Uint8Array(digest)].slice(0, 12).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function extractGeminiBl(html) {
  const cfb2h = /"cfb2h":"([^"]+)"/.exec(html || "");
  if (cfb2h && /^boq_assistant-bard-web-server_/.test(cfb2h[1])) return cfb2h[1];
  const build = /(boq_assistant-bard-web-server_[A-Za-z0-9._-]+)/.exec(html || "");
  return build ? build[1] : "";
}

function extractPageTokens(html) {
  const tokens = {};
  for (const [key, pattern] of [
    ["push_id", /"qKIAYe":"([^"]+)"/],
    ["pctx", /"Ylro7b":"([^"]+)"/],
    ["at", /"SNlM0e":"([^"]+)"/],
  ]) {
    const match = pattern.exec(html || "");
    if (match) tokens[key] = match[1];
  }
  const bl = extractGeminiBl(html);
  if (bl) tokens.bl = bl;
  return tokens;
}

async function refreshGeminiBl(cfg) {
  const origin = cfg.gemini_origin || "https://gemini.google.com";
  const now = Date.now();
  let stale = "";
  if (_geminiBlMemory.origin === origin && _geminiBlMemory.value) {
    stale = _geminiBlMemory.value;
    if (_geminiBlMemory.expiresAt > now) {
      cfg.gemini_bl = stale;
      return stale;
    }
  }

  const cache = globalThis.caches && globalThis.caches.default;
  const key = new Request("https://gemini2api-cache.invalid/gemini-bl?origin=" + encodeURIComponent(origin));
  if (cache) {
    try {
      const cached = await cache.match(key);
      if (cached) {
        const record = JSON.parse(await cached.text());
        if (record.bl) {
          stale = record.bl;
          _geminiBlMemory = { origin, value: record.bl, expiresAt: record.expiresAt || 0 };
          if (_geminiBlMemory.expiresAt > now) {
            cfg.gemini_bl = record.bl;
            return record.bl;
          }
        }
      }
    } catch (_) {}
  }

  try {
    const headers = { "User-Agent": _UA, "Accept-Language": "en-US,en;q=0.9" };
    applyAccountHeaders(headers, cfg);
    if (cfg.cookie) headers.Cookie = cfg.cookie;
    if (cfg.sapisid) headers.Authorization = await makeSapisidHash(cfg.sapisid);
    const resp = await httpFetch(origin + accountPrefix(cfg) + "/app", { headers, timeoutMs: 30000, socket: cfg.upstream_socket });
    const bl = extractGeminiBl(await resp.text());
    if (bl) {
      const expiresAt = Date.now() + GEMINI_BL_CACHE_TTL_SEC * 1000;
      const record = { bl, expiresAt };
      _geminiBlMemory = { origin, value: bl, expiresAt };
      if (cache) {
        try {
          await cache.put(key, new Response(JSON.stringify(record), {
            headers: {
              "Content-Type": "application/json",
              "Cache-Control": "public, max-age=" + GEMINI_BL_CACHE_TTL_SEC,
            },
          }));
        } catch (e) {
          log(cfg, "GEMINI_BL cache write failed: " + e);
        }
      }
      cfg.gemini_bl = bl;
      return bl;
    }
    log(cfg, "GEMINI_BL auto-detect returned no build (status=" + resp.status + ")");
  } catch (e) {
    log(cfg, "GEMINI_BL auto-detect failed: " + e);
  }

  if (stale) cfg.gemini_bl = stale;
  return cfg.gemini_bl;
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// 解析 OpenAI image_url:data:URL(base64)或 http(s) URL。返回 {b64,mime} 或 {url} 或 null。
function parseImageUrl(url) {
  if (!url || typeof url !== "string") return null;
  const m = /^data:([^;,]+);base64,([\s\S]*)$/.exec(url);
  if (m) return { b64: m[2], mime: m[1] || "image/png" };
  if (/^https?:\/\//.test(url)) return { url };
  return null;
}

// 抓取 gemini.google.com/app 页面里的上传 token(带 10 分钟缓存)。
async function getPageTokens(cfg) {
  const now = Date.now();
  const origin = cfg.gemini_origin || "https://gemini.google.com";
  const key = await authCacheKey(cfg);
  if (_pageTokens.key === key && _pageTokens.tokens && now - _pageTokens.ts < 600000) return _pageTokens.tokens;
  const headers = { "User-Agent": _UA };
  applyAccountHeaders(headers, cfg);
  if (cfg.cookie) headers["Cookie"] = cfg.cookie;
  if (cfg.sapisid) headers["Authorization"] = await makeSapisidHash(cfg.sapisid);
  const tokens = cfg.xsrf_token ? { at: cfg.xsrf_token } : {};
  try {
    const resp = await httpFetch(`${origin}${accountPrefix(cfg)}/app`, { headers, timeoutMs: 30000, socket: cfg.upstream_socket });
    const html = await resp.text();
    Object.assign(tokens, extractPageTokens(html));
  } catch (e) {
    log(cfg, `getPageTokens failed: ${e}`);
  }
  if (Object.keys(tokens).length) {
    _pageTokens = { key, tokens, ts: now };
  }
  return tokens;
}

// Scotty 续传上传一张图,返回文件引用(形如 "/contrib_service/ttl_1d/...")。
async function uploadImage(cfg, bytes, mime) {
  const tokens = await getPageTokens(cfg);
  const pushId = tokens.push_id || "feeds/mcudyrk2a4khkz";
  const pctx = tokens.pctx || "CgcSBWjK7pYx";

  const startHeaders = {
    "Push-ID": pushId,
    "X-Tenant-Id": "bard-storage",
    "X-Client-Pctx": pctx,
    "X-Goog-Upload-Header-Content-Length": String(bytes.length),
    "X-Goog-Upload-Header-Content-Type": mime,
    "X-Goog-Upload-Protocol": "resumable",
    "X-Goog-Upload-Command": "start",
    "Content-Type": "application/x-www-form-urlencoded;charset=utf-8",
    "User-Agent": _UA,
  };
  if (cfg.cookie) startHeaders["Cookie"] = cfg.cookie;
  if (cfg.sapisid) startHeaders["Authorization"] = await makeSapisidHash(cfg.sapisid);

  const r1 = await httpFetch("https://content-push.googleapis.com/upload/", { method: "POST", headers: startHeaders, body: "", timeoutMs: 30000, socket: cfg.upstream_socket });
  const uploadUrl = r1.headers.get("x-goog-upload-url");
  if (!uploadUrl) throw new Error(`no upload URL (status ${r1.status})`);

  const r2 = await httpFetch(uploadUrl, {
    method: "POST",
    headers: { "X-Goog-Upload-Command": "upload, finalize", "X-Goog-Upload-Offset": "0", "Content-Type": "application/octet-stream", "User-Agent": _UA },
    body: bytes,
    timeoutMs: 60000,
    socket: cfg.upstream_socket,
  });
  const fileRef = (await r2.text()).trim();
  if (!fileRef.startsWith("/")) throw new Error(`invalid file ref: ${fileRef.slice(0, 120)}`);
  return fileRef;
}

// 把收集到的图片解析/上传成文件引用。返回 { fileRefs, droppedNote }。
// 无 cookie 时不上传(会被 1100 拒),改为返回一段提示文字追加到 prompt。
async function resolveImages(cfg, images) {
  if (!images || !images.length) return { fileRefs: null, droppedNote: "" };
  if (!cfg.cookie) {
    return { fileRefs: null, droppedNote: `\n\n[Note: ${images.length} image(s) were provided but ignored — image input requires a configured GEMINI_COOKIE.]` };
  }
  const refs = [];
  for (const img of images) {
    try {
      let bytes, mime;
      if (img.url) {
        const r = await fetch(img.url, { signal: timeoutSignal(cfg.request_timeout_sec * 1000) });
        const cl = parseInt(r.headers.get("content-length") || "0", 10);
        if (cl > MAX_IMAGE_BYTES) throw new Error(`image too large: ${cl} bytes (max ${MAX_IMAGE_BYTES})`);
        const ab = await r.arrayBuffer();
        if (ab.byteLength > MAX_IMAGE_BYTES) throw new Error(`image too large: ${ab.byteLength} bytes (max ${MAX_IMAGE_BYTES})`);
        bytes = new Uint8Array(ab);
        mime = img.mime || r.headers.get("content-type") || "image/png";
      } else {
        bytes = base64ToBytes(img.b64);
        mime = img.mime || "image/png";
      }
      refs.push(await uploadImage(cfg, bytes, mime));
    } catch (e) {
      log(cfg, `image upload failed: ${e}`);
    }
  }
  return { fileRefs: refs.length ? refs : null, droppedNote: "" };
}

function stripArtifacts(text) {
  if (!text) return "";
  text = text.replace(
    /```(?:python|javascript|text)\?code_(?:reference|stdout)&code_event_index=\d+\n[\s\S]*?```\n?/g,
    ""
  );
  text = text.replace(/http:\/\/googleusercontent\.com\/card_content\/\d+\n?/g, "");
  return text;
}

// 整段清理:去掉残留标记并裁剪首尾空白。
function cleanText(text) {
  return stripArtifacts(text).trim();
}

/** 解析单行 `wrb.fr`,返回其中包含的文本字符串。 */
function extractTextsFromLine(line) {
  if (!line.includes('"wrb.fr"') || line.length < 200) return [];
  try {
    const arr = JSON.parse(line);
    const innerStr = arr[0][2];
    if (!innerStr || innerStr.length < 50) return [];
    const inner = JSON.parse(innerStr);
    if (!(Array.isArray(inner) && inner.length > 4 && inner[4])) return [];
    const texts = [];
    for (const part of inner[4]) {
      if (Array.isArray(part) && part.length > 1 && part[1] && Array.isArray(part[1])) {
        for (const t of part[1]) {
          if (typeof t === "string" && t) texts.push(t);
        }
      }
    }
    return texts;
  } catch (_) {
    return [];
  }
}

function extractResponseText(raw) {
  let lastText = "";
  for (const line of raw.split("\n")) {
    for (const t of extractTextsFromLine(line)) {
      if (t.length > lastText.length) lastText = t;
    }
  }
  return cleanText(lastText);
}

const ACTUAL_MODEL_RE = /^(?:Gemini\s+)?\d+(?:\.\d+)?\s+(?:Flash|Pro)\b[- A-Za-z0-9.()]{0,40}$/i;

function extractActualModelFromLine(line) {
  if (!line.includes('"wrb.fr"')) return "";
  try {
    const inner = JSON.parse(JSON.parse(line)[0][2]);
    const label = Array.isArray(inner) ? inner.find((v) => typeof v === "string" && ACTUAL_MODEL_RE.test(v)) : "";
    return label || "";
  } catch (_) {
    return "";
  }
}

function extractActualModel(raw) {
  let actualModel = "";
  for (const line of raw.split("\n")) {
    const found = extractActualModelFromLine(line);
    if (found) actualModel = found;
  }
  return actualModel;
}

function routeStatus(modelId, actualModel) {
  if (!actualModel) return "unknown";
  if (modelId === 4) return "auto";
  const actual = /\bPro\b/i.test(actualModel)
    ? "pro"
    : /Flash[- ]Lite/i.test(actualModel)
      ? "lite"
      : /\bFlash\b/i.test(actualModel)
        ? "flash"
        : "unknown";
  const expected = modelId === 3 ? "pro" : modelId === 6 ? "lite" : "flash";
  return actual === "unknown" ? "unknown" : actual === expected ? "matched" : "fallback";
}

function routeMetadata(modelId, actualModel) {
  return { upstream_model: actualModel || null, route_status: routeStatus(modelId, actualModel) };
}

async function buildRequestBody(cfg, prompt, modelId, thinkMode, fileRefs, extra) {
  let body = buildPayload(prompt, modelId, thinkMode, fileRefs || null, extra);
  if (cfg.cookie) {
    const at = cfg.xsrf_token || (await getPageTokens(cfg)).at;
    if (at) body += "&at=" + encodeURIComponent(at);
  }
  return body;
}

/** 非流式生成(带重试)。返回最终的响应文本。 */
async function generateResult(cfg, prompt, modelId, thinkMode, extra, fileRefs) {
  await refreshGeminiBl(cfg);
  const body = await buildRequestBody(cfg, prompt, modelId, thinkMode, fileRefs, extra);
  const url = getUrl(cfg);
  const headers = await buildHeaders(cfg);
  let lastErr;
  for (let attempt = 0; attempt < cfg.retry_attempts; attempt++) {
    try {
      const resp = await httpFetch(url, {
        method: "POST",
        headers,
        body,
        timeoutMs: cfg.request_timeout_sec * 1000,
        socket: cfg.upstream_socket,
      });
      const raw = await resp.text();
      const text = extractResponseText(raw);
      const actualModel = extractActualModel(raw);
      if (!resp.ok || !text) {
        log(cfg, `upstream status=${resp.status} rawLen=${raw.length} parsedLen=${text.length} snippet=${JSON.stringify(raw.slice(0, 200))}`);
      }
      return {
        text,
        actualModel,
        status: resp.status,
        contentType: resp.headers.get("content-type"),
        rawLength: raw.length,
      };
    } catch (e) {
      lastErr = e;
      if (attempt < cfg.retry_attempts - 1) {
        log(cfg, `Retry ${attempt + 1}/${cfg.retry_attempts}: ${e}`);
        await sleep(cfg.retry_delay_sec * 1000);
      }
    }
  }
  throw lastErr;
}

async function generate(cfg, prompt, modelId, thinkMode, extra, fileRefs) {
  return (await generateResult(cfg, prompt, modelId, thinkMode, extra, fileRefs)).text;
}

/**
 * 流式生成。每步 yield 一段文本增量(本次新追加的后缀)。
 * 只在尚未 yield 过任何内容时才重试,以避免重复输出。
 */
async function* generateStream(cfg, prompt, modelId, thinkMode, extra, fileRefs, onRoute) {
  await refreshGeminiBl(cfg);
  const body = await buildRequestBody(cfg, prompt, modelId, thinkMode, fileRefs, extra);
  const url = getUrl(cfg);
  const headers = await buildHeaders(cfg);
  let lastErr;
  let yielded = false;

  for (let attempt = 0; attempt < cfg.retry_attempts; attempt++) {
    try {
      const resp = await httpFetch(url, {
        method: "POST",
        headers,
        body,
        timeoutMs: cfg.request_timeout_sec * 1000,
        socket: cfg.upstream_socket,
      });
      if (!resp.body) {
        const raw = await resp.text();
        const actualModel = extractActualModel(raw);
        if (actualModel && onRoute) onRoute(routeMetadata(modelId, actualModel));
        const text = extractResponseText(raw);
        if (text) {
          yielded = true;
          yield text;
        }
        return;
      }
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let prev = "";
      let started = false; // 是否已 yield 过非空内容(用于裁掉开头的空白)
      let actualModel = "";
      const consumeLine = function* (line) {
        const found = extractActualModelFromLine(line);
        if (found && found !== actualModel) {
          actualModel = found;
          if (onRoute) onRoute(routeMetadata(modelId, actualModel));
        }
        for (const t of extractTextsFromLine(line)) {
          if (t.length > prev.length) {
            // 每段增量:去掉残留标记,但流式过程中不裁剪内部空白,
            // 以保留分块之间的空格(比如 "1, 2, 3" 而不是 "1, 2,3")。
            // 在首个可见内容出现前,持续裁掉前导空白(避免开头空行)。
            let delta = stripArtifacts(t.slice(prev.length));
            prev = t;
            if (!started) delta = delta.replace(/^\s+/, "");
            if (delta) {
              started = true;
              yield delta;
            }
          }
        }
      };
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          for (const delta of consumeLine(line)) {
            yielded = true;
            yield delta;
          }
        }
      }
      buf += decoder.decode();
      if (buf) {
        for (const delta of consumeLine(buf)) {
          yielded = true;
          yield delta;
        }
      }
      if (!yielded) log(cfg, `stream upstream produced no text (status=${resp.status})`);
      return;
    } catch (e) {
      lastErr = e;
      if (!yielded && attempt < cfg.retry_attempts - 1) {
        log(cfg, `Stream retry ${attempt + 1}/${cfg.retry_attempts}: ${e}`);
        await sleep(cfg.retry_delay_sec * 1000);
        continue;
      }
      throw e;
    }
  }
  if (lastErr) throw lastErr;
}

// ─── 工具调用 / 消息转换 ─────────────────────────────────────────────────────
function shimIsObj(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function shimXmlEscapeAttr(v) {
  return String(v == null ? "" : v)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function shimDecodeXmlEntities(v) {
  return String(v == null ? "" : v)
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function shimPromptCDATA(v) {
  return `<![CDATA[${String(v == null ? "" : v).replace(/\]\]>/g, "]]]]><![CDATA[>")}]]>`;
}

function shimDecodeCDATA(v) {
  const s = String(v == null ? "" : v).trim();
  const matches = [...s.matchAll(/<!\[CDATA\[([\s\S]*?)\]\]>/g)];
  if (matches.length) return matches.map((m) => m[1] || "").join("");
  return shimDecodeXmlEntities(s);
}

function shimParseJsonTolerant(value) {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed) return {};
  try { return JSON.parse(trimmed); } catch (_) {}
  try {
    return JSON.parse(
      trimmed
        .replace(/(['"])?([a-zA-Z0-9_]+)(['"])?\s*:/g, '"$2":')
        .replace(/:\s*'([^']*)'/g, ':"$1"')
    );
  } catch (_) {
    return undefined;
  }
}

function shimNormalizeToolDefs(tools) {
  const out = [];
  for (const tool of tools || []) {
    if (!tool) continue;
    if (Array.isArray(tool.functionDeclarations)) {
      for (const fn of tool.functionDeclarations) {
        if (!fn || !fn.name) continue;
        out.push({
          name: String(fn.name),
          description: String(fn.description || ""),
          parameters: fn.parameters || fn.parametersJsonSchema || {},
        });
      }
      continue;
    }
    const fn = tool.type === "function" ? (tool.function || tool) : (tool.function || tool);
    const name = fn.name != null ? fn.name : (tool.name || "");
    if (!name) continue;
    out.push({
      name: String(name),
      description: String(fn.description != null ? fn.description : (tool.description || "")),
      parameters: fn.parameters || fn.input_schema || tool.parameters || {},
    });
  }
  return out;
}

function shimBuildToolCallInstructions() {
  return `TOOL CALL FORMAT - FOLLOW EXACTLY:

<|DSML|tool_calls>
  <|DSML|invoke name="TOOL_NAME_HERE">
    <|DSML|parameter name="PARAMETER_NAME"><![CDATA[PARAMETER_VALUE]]></|DSML|parameter>
  </|DSML|invoke>
</|DSML|tool_calls>

RULES:
1) Use one <|DSML|tool_calls> wrapper.
2) Put one or more <|DSML|invoke> entries under that wrapper.
3) Put the tool name in the invoke name attribute.
4) All string values must use <![CDATA[...]]>, especially code, diffs, file contents, paths, names, prompts, and queries.
5) Every top-level argument must be a <|DSML|parameter name="ARG_NAME">...</|DSML|parameter> node.
6) Objects use nested XML elements inside the parameter body. Arrays may repeat <item> children.
7) Numbers, booleans, and null stay plain text.
8) Use only parameter names from the tool schema. Do not invent aliases.
9) Do not emit placeholder, blank, or whitespace-only required parameters.
10) If a required parameter value is unknown, ask the user or answer normally instead of outputting an empty tool call.
11) If you call a tool, output ONLY the DSML block. Do not wrap it in markdown fences.
12) Compatibility note: legacy tool_call/function_call code fences are accepted, but DSML is preferred.`;
}

function shimBuildToolPrompt(toolDefs, toolChoiceInstruction = "") {
  return (
    "# Tool Use\n\n" +
    "You have access to tools that are executed by the user's local environment. " +
    "These tools may read the user's local workspace or perform other local actions after you request them.\n" +
    "Some tools may create or modify local files. If the user asks to change local files and such a tool is available, request the local tool. Do not say you cannot modify local files solely because you are a remote model.\n\n" +
    `Available tools:\n${JSON.stringify(toolDefs, null, 2)}\n\n` +
    shimBuildToolCallInstructions() +
    toolChoiceInstruction
  );
}

function shimFormatPromptParamValue(value) {
  if (typeof value === "string") return shimPromptCDATA(value);
  if (value === null || typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map((v) => `<item>${shimFormatPromptParamValue(v)}</item>`).join("");
  if (shimIsObj(value)) {
    return Object.entries(value).map(([k, v]) => {
      if (/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(k)) return `<${k}>${shimFormatPromptParamValue(v)}</${k}>`;
      return `<field name="${shimXmlEscapeAttr(k)}">${shimFormatPromptParamValue(v)}</field>`;
    }).join("");
  }
  return "";
}

function shimFormatPromptToolCallBlock(name, input) {
  const args = shimIsObj(input) ? input : {};
  let out = `<|DSML|tool_calls><|DSML|invoke name="${shimXmlEscapeAttr(name || "")}">`;
  for (const [key, value] of Object.entries(args)) {
    out += `<|DSML|parameter name="${shimXmlEscapeAttr(key)}">${shimFormatPromptParamValue(value)}</|DSML|parameter>`;
  }
  return out + "</|DSML|invoke></|DSML|tool_calls>";
}

function shimParseTagAttributes(attrs) {
  const out = {};
  const re = /([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*(["'])([\s\S]*?)\2/g;
  let m;
  while ((m = re.exec(String(attrs || ""))) !== null) out[m[1]] = shimDecodeXmlEntities(m[3]);
  return out;
}

function shimNormalizeDSMLToolCallMarkup(text) {
  return String(text || "")
    .replace(/<\s*(\/?)\s*(?:\|DSML\|)?\s*(tool-calls|toolcalls|tool_calls|invoke|parameter)\b([^>]*)>/gi,
      (_m, close, name, rest) => {
        const n = String(name).toLowerCase().replace(/-/g, "_").replace(/^toolcalls$/, "tool_calls");
        return `<${close ? "/" : ""}${n}${rest}>`;
      });
}

function shimFindXmlElementBlocks(text, tag) {
  const blocks = [];
  const re = new RegExp(`<\\s*${tag}\\b([^>]*)>([\\s\\S]*?)<\\s*\\/\\s*${tag}\\s*>`, "gi");
  let m;
  while ((m = re.exec(String(text || ""))) !== null) {
    blocks.push({ attrs: m[1] || "", body: m[2] || "", raw: m[0], start: m.index, end: m.index + m[0].length });
  }
  return blocks;
}

function shimAppendMarkupValue(obj, key, value) {
  if (obj[key] === undefined) obj[key] = value;
  else if (Array.isArray(obj[key])) obj[key].push(value);
  else obj[key] = [obj[key], value];
}

function shimParseMarkupValue(body) {
  const raw = String(body == null ? "" : body).trim();
  if (!raw) return "";
  if (/^<!\[CDATA\[/i.test(raw)) return shimDecodeCDATA(raw);

  const childBlocks = [...raw.matchAll(/<\s*([A-Za-z_][A-Za-z0-9_.-]*|field)\b([^>]*)>([\s\S]*?)<\s*\/\s*\1\s*>/g)];
  if (childBlocks.length) {
    if (childBlocks.every((m) => m[1] === "item")) return childBlocks.map((m) => shimParseMarkupValue(m[3]));
    const obj = {};
    for (const m of childBlocks) {
      const attrs = shimParseTagAttributes(m[2] || "");
      const key = m[1] === "field" ? (attrs.name || "field") : m[1];
      shimAppendMarkupValue(obj, key, shimParseMarkupValue(m[3]));
    }
    return obj;
  }

  const decoded = shimDecodeCDATA(raw).trim();
  if (/^(true|false)$/i.test(decoded)) return /^true$/i.test(decoded);
  if (/^null$/i.test(decoded)) return null;
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(decoded)) {
    const n = Number(decoded);
    if (Number.isFinite(n)) return n;
  }
  if ((decoded.startsWith("{") && decoded.endsWith("}")) || (decoded.startsWith("[") && decoded.endsWith("]"))) {
    try { return JSON.parse(decoded); } catch (_) {}
  }
  return shimDecodeXmlEntities(decoded);
}

function shimParseDSMLToolCallsDetailed(text) {
  const raw = String(text || "");
  if (!/<\s*(?:\|DSML\|)?\s*(tool_calls|tool-calls|toolcalls|invoke|parameter)\b/i.test(raw)) {
    return { cleanText: raw.trim(), calls: [] };
  }
  let normalized = shimNormalizeDSMLToolCallMarkup(raw);
  let blocks = shimFindXmlElementBlocks(normalized, "tool_calls");
  if (!blocks.length && /<\s*invoke\b/i.test(normalized) && /<\s*\/\s*tool_calls\s*>/i.test(normalized)) {
    normalized = "<tool_calls>" + normalized;
    blocks = shimFindXmlElementBlocks(normalized, "tool_calls");
  }

  const calls = [];
  for (const block of blocks) {
    for (const invoke of shimFindXmlElementBlocks(block.body, "invoke")) {
      const attrs = shimParseTagAttributes(invoke.attrs);
      const name = String(attrs.name || "").trim();
      if (!name) continue;
      const input = {};
      for (const param of shimFindXmlElementBlocks(invoke.body, "parameter")) {
        const pAttrs = shimParseTagAttributes(param.attrs);
        const pName = String(pAttrs.name || "").trim();
        if (!pName) continue;
        shimAppendMarkupValue(input, pName, shimParseMarkupValue(param.body));
      }
      calls.push({ name, input });
    }
  }

  if (!calls.length) return { cleanText: raw.trim(), calls: [] };
  let clean = normalized;
  for (let i = blocks.length - 1; i >= 0; i--) clean = clean.slice(0, blocks[i].start) + clean.slice(blocks[i].end);
  return { cleanText: clean.trim(), calls };
}

function shimExtractToolNames(tools) {
  const names = shimNormalizeToolDefs(tools).map((t) => t.name).filter(Boolean);
  return names.length ? new Set(names) : null;
}

function shimSchemaForTool(name, tools) {
  const found = shimNormalizeToolDefs(tools).find((t) => t.name === name);
  return found && found.parameters && found.parameters.properties ? found.parameters : null;
}

function shimCoerceBySchema(value, schema) {
  if (!schema || value == null) return value;
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  if (type === "boolean" && typeof value === "string" && /^(true|false)$/i.test(value.trim())) return /^true$/i.test(value.trim());
  if ((type === "number" || type === "integer") && typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n)) return type === "integer" ? Math.trunc(n) : n;
  }
  if ((type === "object" || type === "array") && typeof value === "string") {
    const parsed = shimParseJsonTolerant(value);
    if (parsed !== undefined) return parsed;
  }
  return value;
}

function shimNormalizeCallInput(name, input, tools) {
  const args = shimIsObj(input) ? { ...input } : {};
  const schema = shimSchemaForTool(name, tools);
  if (!schema || !schema.properties) return args;
  for (const [key, propSchema] of Object.entries(schema.properties)) {
    if (args[key] !== undefined) args[key] = shimCoerceBySchema(args[key], propSchema);
  }
  return args;
}

function shimMakeOpenAIToolCall(name, args, tools) {
  const cleanName = String(name || "").trim();
  if (!cleanName) return null;
  return {
    id: `call_${randHex(8)}`,
    type: "function",
    function: {
      name: cleanName,
      arguments: JSON.stringify(shimNormalizeCallInput(cleanName, args, tools)),
    },
  };
}

function shimFilterCallsForTools(calls, tools) {
  const allowed = shimExtractToolNames(tools);
  if (!allowed) return calls;
  return calls.filter((call) => allowed.has(call.function.name));
}

function shimParseLegacyToolCalls(text, tools) {
  const toolCalls = [];
  const patterns = [
    /```tool_call\s*\n([\s\S]*?)\n```/g,
    /```function_call\s*\n([\s\S]*?)\n```/g,
  ];
  let clean = String(text || "");
  for (const re of patterns) {
    for (const m of clean.matchAll(new RegExp(re.source, re.flags))) {
      try {
        const data = JSON.parse(m[1].trim());
        const name = data.name || data.tool_name || (data.function || {}).name;
        const args = data.arguments != null ? data.arguments : (data.args != null ? data.args : (data.input != null ? data.input : {}));
        const call = shimMakeOpenAIToolCall(name, args, tools);
        if (call) toolCalls.push(call);
      } catch (_) {}
    }
    clean = clean.replace(new RegExp(re.source, re.flags), "").trim();
  }
  return [clean, shimFilterCallsForTools(toolCalls, tools)];
}

function shimParseJsonToolEnvelope(text, tools) {
  const source = String(text || "").trim();
  if (!source.startsWith("{") && !source.startsWith("[")) return null;
  const parsed = shimParseJsonTolerant(source);
  if (parsed === undefined) return null;
  const rawCalls = Array.isArray(parsed)
    ? parsed
    : (Array.isArray(parsed.tool_calls) ? parsed.tool_calls : (Array.isArray(parsed.function_calls) ? parsed.function_calls : (parsed.name || parsed.tool_name ? [parsed] : [])));
  const calls = [];
  for (const item of rawCalls) {
    if (!item || typeof item !== "object") continue;
    const fn = item.function && typeof item.function === "object" ? item.function : {};
    const name = item.name || item.tool_name || fn.name || item.function;
    const args = item.input != null ? item.input : (item.arguments != null ? item.arguments : (item.parameters != null ? item.parameters : (fn.arguments != null ? fn.arguments : {})));
    const call = shimMakeOpenAIToolCall(name, args, tools);
    if (call) calls.push(call);
  }
  return calls.length ? ["", shimFilterCallsForTools(calls, tools)] : null;
}

function buildToolChoiceInstruction(toolChoice) {
  if (toolChoice === "none") return "\n\nIMPORTANT: Do NOT call any tools. Respond with text only.";
  if (toolChoice === "required") return "\n\nIMPORTANT: You MUST call at least one tool. Do not respond with text only.";
  if (toolChoice && typeof toolChoice === "object") {
    const fn = (toolChoice.function || {}).name || toolChoice.name || "";
    if (fn) return `\n\nIMPORTANT: You MUST call the tool "${fn}". Do not call other tools.`;
    if (toolChoice.type === "allowed_tools" && Array.isArray(toolChoice.tools) && toolChoice.tools.length) {
      const names = toolChoice.tools
        .map((t) => typeof t === "string" ? t : ((t.function || t).name || ""))
        .filter(Boolean);
      if (names.length) return `\n\nIMPORTANT: You may call only these tools: ${names.map((n) => `"${n}"`).join(", ")}.`;
    }
  }
  return "";
}

/** OpenAI messages -> [promptString, images]。images 恒为 [](不支持图片输入)。 */
function messagesToPrompt(messages, tools, toolChoice) {
  const parts = [];
  const images = [];

  if (tools && toolChoice !== "none") {
    const toolDefs = shimNormalizeToolDefs(tools);
    if (toolDefs.length) {
      const constraint = buildToolChoiceInstruction(toolChoice);
      parts.push(shimBuildToolPrompt(toolDefs, constraint));
    }
  }

  for (const msg of messages) {
    const role = msg.role || "user";
    let content = msg.content != null ? msg.content : "";

    if (Array.isArray(content)) {
      const textParts = [];
      for (const c of content) {
        const t = c && c.type;
        if (t === "text" || t === "input_text") {
          textParts.push(c.text || "");
        } else if (t === "image_url") {
          const u = c.image_url && (c.image_url.url || c.image_url);
          const img = parseImageUrl(typeof u === "string" ? u : "");
          if (img) images.push(img);
        } else if (t === "image") {
          // 兼容 Anthropic 风格 {source:{type:"base64",media_type,data}}
          if (c.source && c.source.data) {
            images.push({ b64: c.source.data, mime: c.source.media_type || "image/png" });
          } else if (c.image_url) {
            const img = parseImageUrl(typeof c.image_url === "string" ? c.image_url : c.image_url.url || "");
            if (img) images.push(img);
          }
        }
      }
      content = textParts.join(" ");
    }

    if (role === "system") {
      parts.push(`[System instruction]: ${content}`);
    } else if (role === "assistant") {
      if (msg.tool_calls) {
        const tcStrs = msg.tool_calls.map((tc) => {
          const fn = tc.function || {};
          return shimFormatPromptToolCallBlock(fn.name || tc.name || "", shimParseJsonTolerant(fn.arguments || "{}") || {});
        });
        parts.push(`[Assistant]: ${content || ""}\n` + tcStrs.join("\n"));
      } else {
        parts.push(`[Assistant]: ${content}`);
      }
    } else if (role === "tool") {
      parts.push(`[Tool result for ${msg.name || ""}]: ${content}`);
    } else {
      parts.push(content ? content : "");
    }
  }

  return [parts.filter((p) => p).join("\n\n"), images];
}

/** 提取 ```tool_call``` 代码块 -> [cleanText, toolCalls]。 */
function parseToolCalls(text, tools) {
  const dsml = shimParseDSMLToolCallsDetailed(text);
  if (dsml.calls.length) {
    const calls = dsml.calls
      .map((call) => shimMakeOpenAIToolCall(call.name, call.input, tools))
      .filter(Boolean);
    return [dsml.cleanText, shimFilterCallsForTools(calls, tools)];
  }

  const [legacyClean, legacyCalls] = shimParseLegacyToolCalls(text, tools);
  if (legacyCalls.length) return [legacyClean, legacyCalls];

  const jsonCalls = shimParseJsonToolEnvelope(String(text || "").trim(), tools);
  if (jsonCalls) return jsonCalls;

  return [String(text || "").trim(), []];
}

// Google native API helpers
function toOpenAIStreamToolCallDeltas(toolCalls) {
  return (toolCalls || []).map((toolCall, index) => ({ index, ...toolCall }));
}

function buildToolPrompt(toolDefs) {
  return shimBuildToolPrompt(toolDefs);
}

function googleToolChoiceInstruction(req) {
  const fc = (req.toolConfig || {}).functionCallingConfig || {};
  const mode = fc.mode || "AUTO";
  const allowed = fc.allowedFunctionNames || [];
  if (mode === "NONE") return "\n\nIMPORTANT: Do NOT call any tools. Respond with text only.";
  if (mode === "ANY") {
    if (allowed.length) {
      const names = allowed.map((n) => `"${n}"`).join(", ");
      return `\n\nIMPORTANT: You MUST call one of these tools: ${names}. Do not respond with text only.`;
    }
    return "\n\nIMPORTANT: You MUST call at least one tool. Do not respond with text only.";
  }
  return "";
}

/** Google 的 contents/tools/systemInstruction -> [promptString, images]。 */
function googleContentsToPrompt(req) {
  const parts = [];
  const images = [];

  const fcMode = ((req.toolConfig || {}).functionCallingConfig || {}).mode || "AUTO";
  const tools = req.tools;
  const toolDefs = [];
  if (tools && fcMode !== "NONE") {
    for (const group of tools) {
      for (const fn of group.functionDeclarations || []) {
        const td = { name: fn.name || "", description: fn.description || "" };
        const params = fn.parameters || fn.parametersJsonSchema;
        if (params) td.parameters = params;
        toolDefs.push(td);
      }
    }
  }

  const sysInst = req.systemInstruction;
  if (sysInst) {
    const sysText = (sysInst.parts || []).filter((p) => p.text).map((p) => p.text).join(" ");
    if (sysText) {
      if (toolDefs.length) {
        parts.push(sysText + "\n\n" + buildToolPrompt(toolDefs) + googleToolChoiceInstruction(req));
      } else {
        parts.push(sysText);
      }
    }
  } else if (toolDefs.length) {
    parts.push(buildToolPrompt(toolDefs) + googleToolChoiceInstruction(req));
  }

  for (const content of req.contents || []) {
    const role = content.role || "user";
    const msgParts = [];
    for (const p of content.parts || []) {
      if (p.text) {
        msgParts.push(p.text);
      } else if (p.inlineData) {
        images.push({ b64: p.inlineData.data, mime: p.inlineData.mimeType || "image/png" });
      } else if (p.functionCall) {
        const fc = p.functionCall;
        msgParts.push(shimFormatPromptToolCallBlock(fc.name, fc.args || {}));
      } else if (p.functionResponse) {
        const fr = p.functionResponse;
        msgParts.push(`[Tool result for ${fr.name || ""}]: ${JSON.stringify(fr.response || {})}`);
      }
    }
    const text = msgParts.join("\n");
    if (role === "model") parts.push(`[Assistant]: ${text}`);
    else parts.push(text);
  }

  return [parts.filter((p) => p).join("\n\n"), images];
}

/** 提取 ```function_call``` 代码块(3 种格式)-> [cleanText, functionCalls]。 */
function parseGoogleFunctionCalls(text, tools) {
  const [openAIClean, openAIToolCalls] = parseToolCalls(text, tools);
  if (openAIToolCalls.length) {
    return [openAIClean, openAIToolCalls.map((tc) => ({
      name: tc.function.name,
      args: shimParseJsonTolerant(tc.function.arguments) || {},
    }))];
  }

  const functionCalls = [];
  const patterns = [
    /```function_call\s*\n([\s\S]*?)\n```/g,
    /(?:^|\n)function_call\s*\n(\{[^`]*?\})/g,
  ];
  let clean = text;
  for (const pat of patterns) {
    for (const m of clean.matchAll(new RegExp(pat.source, pat.flags))) {
      try {
        const data = JSON.parse(m[1].trim());
        if (data && "name" in data) {
          functionCalls.push({ name: data.name, args: data.args != null ? data.args : (data.arguments != null ? data.arguments : {}) });
        }
      } catch (_) { /* 跳过 */ }
    }
    clean = clean.replace(new RegExp(pat.source, pat.flags), "").trim();
  }
  if (!functionCalls.length && clean.trim().startsWith("{")) {
    try {
      const data = JSON.parse(clean.trim());
      if (data && "name" in data && ("args" in data || "arguments" in data)) {
        functionCalls.push({ name: data.name, args: data.args != null ? data.args : data.arguments });
        clean = "";
      }
    } catch (_) { /* skip */ }
  }
  return [clean, functionCalls];
}

// ─── HTTP 辅助函数 ──────────────────────────────────────────────────────────────
// CORS 对所有来源开放——这是 API 代理的常规设定；配合 API_KEYS 鉴权使用。
function corsHeaders() {
  return { "Access-Control-Allow-Origin": "*" };
}

function jsonResponse(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(), ...extra },
  });
}

function privateJsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch (_) {
    return null;
  }
}

// 从多种来源取调用方 key:Bearer / x-api-key / x-goog-api-key / ?key=
// (分别兼容 OpenAI 客户端、Anthropic 风格、Gemini CLI)。任一匹配即放行。
function authorized(request, url, cfg) {
  const keys = cfg.api_keys || [];
  if (!keys.length) return true;
  const h = request.headers;
  const auth = h.get("authorization") || "";
  const candidates = [
    auth.startsWith("Bearer ") ? auth.slice(7) : null,
    h.get("x-api-key"),
    h.get("x-goog-api-key"),
    url ? url.searchParams.get("key") : null,
  ];
  return candidates.some((k) => k && keys.some((valid) => timingSafeEqual(k, valid)));
}

function adminAuthorized(request, cfg) {
  const validKeys = cfg.admin_key ? [cfg.admin_key] : (cfg.api_keys || []);
  if (!validKeys.length) return false;
  const auth = request.headers.get("authorization") || "";
  const candidates = [
    request.headers.get("x-admin-key"),
    auth.startsWith("Bearer ") ? auth.slice(7) : null,
  ];
  return candidates.some((key) => key && validKeys.some((valid) => timingSafeEqual(key, valid)));
}

/**
 * 构造一个 SSE 响应,响应体由 `producer(write)` 生成。
 * `write(str)` 会入队一个 UTF-8 分块。producer 结束后流会自动关闭。
 */
function sseResponse(producer) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const write = (s) => controller.enqueue(encoder.encode(s));
      try {
        await producer(write);
      } catch (_) {
        /* 尽力而为:停止流式输出 */
      } finally {
        try { controller.close(); } catch (_) {}
      }
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      ...corsHeaders(),
    },
  });
}

// ─── 处理函数 ──────────────────────────────────────────────────────────────────

// 上游返回为空时给客户端的可见提示(否则像 Cherry 这类客户端会“无返回”)。
// 线上常见原因:部署在 Cloudflare/无服务器平台时,出口 IP 被 Google 区别对待
// (本地能跑、线上空);其次是 GEMINI_BL 过期。用 `wrangler tail` 看上游状态。
const EMPTY_UPSTREAM_MSG =
  "⚠️ Upstream Gemini returned an empty response. " +
  "If this Worker runs on Cloudflare/serverless, Google may be blocking the egress IP " +
  "(works locally but empty in production); also verify GEMINI_BL is current. " +
  "Run `wrangler tail` to see the upstream status.";

// POST /v1/chat/completions
async function handleChat(req, cfg) {
  const rm = resolveModel(req.model || cfg.default_model, cfg.default_model);
  if (rm.error) return jsonResponse({ error: { message: rm.error } }, 400);

  const tools = req.tools;
  const toolChoice = req.tool_choice != null ? req.tool_choice : "auto";
  const [prompt0, images] = messagesToPrompt(req.messages || [], tools, toolChoice);
  const { fileRefs, droppedNote } = await resolveImages(cfg, images);
  const prompt = prompt0 + droppedNote;
  if (!prompt.trim()) return jsonResponse({ error: { message: "empty prompt" } }, 400);

  const stream = req.stream || false;
  const cid = `chatcmpl-${randHex(12)}`;

  if (stream && (!tools || toolChoice === "none")) {
    return sseResponse(async (write) => {
      let got = false;
      let errMsg = "";
      let route = routeMetadata(rm.modeId, "");
      const chunk = (delta, finish) => write(`data: ${JSON.stringify({
        id: cid, object: "chat.completion.chunk", created: nowSec(), model: rm.name,
        ...route,
        choices: [{ index: 0, delta, finish_reason: finish }],
      })}\n\n`);
      try {
        for await (const delta of generateStream(cfg, prompt, rm.modeId, rm.thinkMode, rm.extra, fileRefs, (meta) => { route = meta; })) {
          got = true;
          chunk({ content: delta }, null);
        }
      } catch (e) {
        errMsg = `⚠️ upstream error: ${e}`;
      } finally {
        if (!got) {
          const note = errMsg || EMPTY_UPSTREAM_MSG;
          log(cfg, `chat stream produced no content -> ${note}`);
          chunk({ content: note }, null);
        } else if (errMsg) {
          log(cfg, `chat stream truncated: ${errMsg}`);
          chunk({ content: `\n\n${errMsg}` }, null);
        }
        chunk({}, "stop");
        write("data: [DONE]\n\n");
      }
    });
  }

  let result;
  let text;
  try {
    result = await generateResult(cfg, prompt, rm.modeId, rm.thinkMode, rm.extra, fileRefs);
    text = result.text;
  } catch (e) {
    return jsonResponse({ error: { message: `upstream error: ${e}` } }, 502);
  }

  let toolCalls = null;
  if (tools && text && toolChoice !== "none") {
    const [clean, tc] = parseToolCalls(text, tools);
    text = clean;
    toolCalls = tc.length ? tc : null;
  }
  if (!text && !toolCalls) {
    log(cfg, "chat non-stream produced no content (empty upstream)");
    text = EMPTY_UPSTREAM_MSG; // 可见提示,避免客户端“无返回”
  }
  const msg = { role: "assistant", content: text || null };
  if (toolCalls) msg.tool_calls = toolCalls;
  const finish = toolCalls ? "tool_calls" : "stop";

  if (stream) {
    return sseResponse(async (write) => {
      const delta = toolCalls
        ? { tool_calls: toOpenAIStreamToolCallDeltas(toolCalls) }
        : { role: "assistant", content: text || "" };
      write(`data: ${JSON.stringify({
        id: cid, object: "chat.completion.chunk", created: nowSec(), model: rm.name,
        ...routeMetadata(rm.modeId, result.actualModel),
        choices: [{ index: 0, delta, finish_reason: finish }],
      })}\n\n`);
      write("data: [DONE]\n\n");
    });
  }

  return jsonResponse({
    id: cid, object: "chat.completion", created: nowSec(), model: rm.name,
    ...routeMetadata(rm.modeId, result.actualModel),
    choices: [{ index: 0, message: msg, finish_reason: finish }],
    usage: {
      prompt_tokens: tokenEst(prompt),
      completion_tokens: tokenEst(text),
      total_tokens: tokenEst(prompt) + tokenEst(text),
    },
  });
}

// POST /v1/responses(Codex CLI 用)
async function handleResponses(req, cfg) {
  const rm = resolveModel(req.model || cfg.default_model, cfg.default_model);
  if (rm.error) return jsonResponse({ error: { message: rm.error } }, 400);

  const inputItems = req.input != null ? req.input : [];
  let tools = req.tools;
  const messages = [];
  if (req.instructions) messages.push({ role: "system", content: req.instructions });

  if (typeof inputItems === "string") {
    messages.push({ role: "user", content: inputItems });
  } else if (Array.isArray(inputItems)) {
    for (const item of inputItems) {
      if (typeof item === "string") {
        messages.push({ role: "user", content: item });
      } else if (item && typeof item === "object") {
        if (item.type === "function_call_output") {
          messages.push({ role: "tool", tool_call_id: item.call_id || "", name: item.name || "", content: item.output || "" });
        } else if (item.role === "assistant" || (item.type === "message" && item.role === "assistant")) {
          const cp = item.content != null ? item.content : [];
          let textAcc = "";
          const tcList = [];
          if (Array.isArray(cp)) {
            for (const c of cp) {
              if (c && typeof c === "object") {
                if (c.type === "output_text") textAcc += c.text || "";
                else if (c.type === "function_call") tcList.push(c);
              }
            }
          } else if (typeof cp === "string") {
            textAcc = cp;
          }
          const m = { role: "assistant", content: textAcc || null };
          if (tcList.length) {
            m.tool_calls = tcList.map((tc, i) => ({
              id: tc.call_id || `call_${i}`, type: "function",
              function: { name: tc.name || "", arguments: tc.arguments || "{}" },
            }));
          }
          messages.push(m);
        } else {
          const role = item.role || "user";
          let content = item.content != null ? item.content : "";
          if (Array.isArray(content)) {
            content = content.filter((c) => c.type === "text" || c.type === "input_text").map((c) => c.text || "").join(" ");
          }
          messages.push({ role, content });
        }
      }
    }
  }

  if (tools) {
    tools = tools.map((t) =>
      t.type === "function" && !("function" in t)
        ? { type: "function", function: { name: t.name, description: t.description || "", parameters: t.parameters || {} } }
        : t
    );
  }

  const toolChoice = req.tool_choice != null ? req.tool_choice : "auto";
  const [prompt0, images] = messagesToPrompt(messages, tools, toolChoice);
  const { fileRefs, droppedNote } = await resolveImages(cfg, images);
  const prompt = prompt0 + droppedNote;
  if (!prompt.trim()) return jsonResponse({ error: { message: "empty input" } }, 400);

  let result;
  let text;
  try {
    result = await generateResult(cfg, prompt, rm.modeId, rm.thinkMode, rm.extra, fileRefs);
    text = result.text;
  } catch (e) {
    return jsonResponse({ error: { message: `upstream error: ${e}` } }, 502);
  }

  let toolCalls = null;
  if (tools && text && toolChoice !== "none") {
    const [clean, tc] = parseToolCalls(text, tools);
    text = clean;
    toolCalls = tc.length ? tc : null;
  }

  const rid = `resp_${randHex(16)}`;
  const mid = `msg_${randHex(12)}`;
  const output = [];
  if (toolCalls) {
    for (const tc of toolCalls) {
      output.push({ type: "function_call", id: tc.id, call_id: tc.id, name: tc.function.name, arguments: tc.function.arguments, status: "completed" });
    }
  }
  if (text || !toolCalls) {
    output.push({ type: "message", id: mid, role: "assistant", status: "completed", content: [{ type: "output_text", text: text || "", annotations: [] }] });
  }

  const usage = { input_tokens: tokenEst(prompt), output_tokens: tokenEst(text), total_tokens: tokenEst(prompt) + tokenEst(text) };

  if (req.stream) {
    return sseResponse(async (write) => {
      const route = routeMetadata(rm.modeId, result.actualModel);
      write(`event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id: rid, object: "response", status: "in_progress", model: rm.name, ...route, output: [] } })}\n\n`);
      for (const item of output) {
        if (item.type === "function_call") {
          write(`event: response.function_call_arguments.done\ndata: ${JSON.stringify({ type: "response.function_call_arguments.done", item_id: item.id, call_id: item.call_id, name: item.name, arguments: item.arguments })}\n\n`);
        } else if (item.type === "message") {
          item.content.forEach((cp, ci) => {
            write(`event: response.output_text.done\ndata: ${JSON.stringify({ type: "response.output_text.done", item_id: item.id, content_index: ci, text: cp.text })}\n\n`);
          });
        }
      }
      const respObj = { id: rid, object: "response", status: "completed", model: rm.name, ...route, output, usage };
      write(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: respObj })}\n\n`);
    });
  }

  return jsonResponse({ id: rid, object: "response", created_at: nowSec(), status: "completed", model: rm.name, ...routeMetadata(rm.modeId, result.actualModel), output, usage });
}

// POST /v1beta/models/{model}:generateContent | :streamGenerateContent
async function handleGoogleGenerate(req, cfg, path, stream) {
  const m = /\/v1beta\/models\/([^:?]+)/.exec(path);
  const rm = resolveModel(m ? m[1] : cfg.default_model, cfg.default_model);
  if (rm.error) return jsonResponse({ error: { message: rm.error } }, 400);

  const fcMode = ((req.toolConfig || {}).functionCallingConfig || {}).mode || "AUTO";
  const hasTools = !!req.tools && fcMode !== "NONE";
  const [prompt0, images] = googleContentsToPrompt(req);
  const { fileRefs, droppedNote } = await resolveImages(cfg, images);
  const prompt = prompt0 + droppedNote;
  if (!prompt.trim()) return jsonResponse({ error: { message: "empty content" } }, 400);

  log(cfg, `Google API: model=${rm.name} stream=${stream} tools=${hasTools} prompt_len=${prompt.length}`);

  if (stream && !hasTools) {
    return sseResponse(async (write) => {
      let fullText = "";
      let route = routeMetadata(rm.modeId, "");
      try {
        for await (const delta of generateStream(cfg, prompt, rm.modeId, rm.thinkMode, rm.extra, fileRefs, (meta) => { route = meta; })) {
          if (!delta) continue;
          fullText += delta;
          write(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: delta }], role: "model" }, index: 0 }], modelVersion: rm.name, upstreamModel: route.upstream_model, routeStatus: route.route_status })}\n\n`);
        }
      } finally {
        write(`data: ${JSON.stringify({
          candidates: [{ finishReason: "STOP", index: 0 }],
          usageMetadata: { promptTokenCount: tokenEst(prompt), candidatesTokenCount: tokenEst(fullText), totalTokenCount: tokenEst(prompt) + tokenEst(fullText) },
          modelVersion: rm.name,
          upstreamModel: route.upstream_model,
          routeStatus: route.route_status,
        })}\n\n`);
      }
    });
  }

  let result;
  let text;
  try {
    result = await generateResult(cfg, prompt, rm.modeId, rm.thinkMode, rm.extra, fileRefs);
    text = result.text;
  } catch (e) {
    return jsonResponse({ error: { message: `upstream error: ${e}` } }, 502);
  }
  if (!text) log(cfg, "Warning: empty response from Gemini");

  const responseParts = [];
  if (hasTools && text) {
    const [clean, fcs] = parseGoogleFunctionCalls(text, req.tools);
    if (fcs.length) {
      if (clean) responseParts.push({ text: clean });
      for (const fc of fcs) responseParts.push({ functionCall: { name: fc.name, args: fc.args } });
    } else {
      responseParts.push({ text });
    }
  } else {
    responseParts.push({ text: text || "I apologize, but I was unable to generate a response. Please try again." });
  }

  const responseObj = {
    candidates: [{ content: { parts: responseParts, role: "model" }, finishReason: "STOP", index: 0 }],
    usageMetadata: { promptTokenCount: tokenEst(prompt), candidatesTokenCount: tokenEst(text), totalTokenCount: tokenEst(prompt) + tokenEst(text) },
    modelVersion: rm.name,
    upstreamModel: result.actualModel || null,
    routeStatus: routeStatus(rm.modeId, result.actualModel),
  };

  if (stream) {
    return sseResponse(async (write) => { write(`data: ${JSON.stringify(responseObj)}\n\n`); });
  }
  return jsonResponse(responseObj);
}

// GET /debug: compare a configured-Cookie Pro request with the same guest request.
function cookieRouteSummary(cfg, proRoute, pageTokenFound) {
  const verified = proRoute && proRoute.route_status === "matched";
  const status = !cfg.cookie
    ? "not_configured"
    : verified
      ? "pro_route_verified"
      : proRoute && proRoute.upstream_model
        ? "configured_but_pro_unavailable"
        : "unverified";
  return {
    configured: !!cfg.cookie,
    page_token_found: !!pageTokenFound,
    status,
    pro_route_verified: !!verified,
    actual_model: proRoute ? proRoute.upstream_model : null,
  };
}

async function probeModelRoute(cfg, name, detailed = false) {
  const rm = resolveModel(name, cfg.default_model);
  const result = await generateResult(cfg, "Reply with one word: PONG", rm.modeId, rm.thinkMode, rm.extra, null);
  const metadata = routeMetadata(rm.modeId, result.actualModel);
  const route = {
    requested_model: name,
    ...metadata,
    available: metadata.route_status === "matched" || metadata.route_status === "auto",
  };
  return detailed ? {
    ...route,
    status: result.status,
    content_type: result.contentType,
    raw_length: result.rawLength,
    parsed: result.text.slice(0, 160),
  } : route;
}

async function inspectModelRoutes(cfg) {
  await refreshGeminiBl(cfg);
  let pageTokenFound = false;
  if (cfg.cookie) pageTokenFound = !!(await getPageTokens(cfg)).at;
  const pairs = await Promise.all(Object.keys(MODELS).map(async (name) => {
    try {
      return [name, await probeModelRoute(cfg, name)];
    } catch (e) {
      return [name, { requested_model: name, upstream_model: null, route_status: "unknown", available: false, error: String((e && e.message) || e) }];
    }
  }));
  const routes = Object.fromEntries(pairs);
  const actualModels = [...new Set(Object.values(routes).map((r) => r.upstream_model).filter(Boolean))];
  return {
    routes,
    actual_models: actualModels,
    cookie: cookieRouteSummary(cfg, routes["gemini-3.1-pro"], pageTokenFound),
  };
}

async function handleDebug(cfg) {
  await refreshGeminiBl(cfg);
  let pageTokenFound = false;
  if (cfg.cookie) pageTokenFound = !!(await getPageTokens(cfg)).at;
  const guestCfg = { ...cfg, cookie: "", sapisid: "" };
  const safeProbe = async (probeCfg) => {
    try {
      return await probeModelRoute(probeCfg, "gemini-3.1-pro", true);
    } catch (e) {
      return { upstream_model: null, route_status: "unknown", error: String((e && e.message) || e) };
    }
  };

  const [configuredProbe, guestProbe] = await Promise.all([safeProbe(cfg), safeProbe(guestCfg)]);
  return jsonResponse({
    note: "A_configured requests Pro with the configured Cookie and page token; B_guest requests the same route without it. Compare upstream_model and route_status to verify whether Pro was actually granted.",
    bl: cfg.gemini_bl,
    geminiOrigin: cfg.gemini_origin,
    hasCookie: !!cfg.cookie,
    cookie: cookieRouteSummary(cfg, configuredProbe, pageTokenFound),
    socket: { configEnabled: cfg.upstream_socket, available: !!(await resolveConnect()) },
    A_configured: configuredProbe,
    A_bare: configuredProbe,
    B_guest: guestProbe,
  });
}

async function safeModelProbe(cfg, name, detailed = false) {
  try {
    return await probeModelRoute(cfg, name, detailed);
  } catch (e) {
    return {
      requested_model: name,
      upstream_model: null,
      route_status: "unknown",
      available: false,
      error: String((e && e.message) || e),
    };
  }
}

async function handleAdminStatus(cfg, env, url) {
  const verify = parseBool(url.searchParams.get("verify"), false);
  const live = parseBool(url.searchParams.get("live"), false);
  let inspection = null;
  let cookieVerification = null;

  if (live) {
    inspection = await inspectModelRoutes(cfg);
    cookieVerification = inspection.cookie;
  } else if (verify && cfg.cookie) {
    const pageTokenFound = !!(cfg.xsrf_token || (await getPageTokens(cfg)).at);
    const proRoute = await safeModelProbe(cfg, "gemini-3.1-pro", true);
    cookieVerification = cookieRouteSummary(cfg, proRoute, pageTokenFound);
  }

  return privateJsonResponse({
    status: "ok",
    version: VERSION,
    gemini_bl: cfg.gemini_bl,
    gemini_origin: cfg.gemini_origin,
    default_model: cfg.default_model,
    socket_enabled: cfg.upstream_socket,
    storage_available: !!cookieStoreStub(env),
    cookie: {
      ...cookieSummary(cfg),
      verification: cookieVerification,
    },
    models: Object.entries(MODELS).map(([id, model]) => ({
      id,
      description: model.desc,
      ...(inspection ? inspection.routes[id] : {}),
    })),
  });
}

async function handleCookieRefresh(cfg, env) {
  if (!cookieStoreStub(env)) {
    return privateJsonResponse({
      error: { message: "COOKIE_STORE 尚未綁定；刷新後的 Cookie 無法持久保存。" },
    }, 503);
  }
  if (!cfg.cookie) {
    return privateJsonResponse({
      error: { message: "尚未設定 Cookie；請先從瀏覽器匯入。" },
    }, 400);
  }

  const headers = { "User-Agent": _UA, "Accept-Language": "en-US,en;q=0.9" };
  applyAccountHeaders(headers, cfg);
  headers.Cookie = cfg.cookie;
  if (cfg.sapisid) headers.Authorization = await makeSapisidHash(cfg.sapisid);

  const origin = cfg.gemini_origin || "https://gemini.google.com";
  const response = await httpFetch(`${origin}${accountPrefix(cfg)}/app`, {
    headers,
    timeoutMs: 30000,
    socket: cfg.upstream_socket,
  });
  const html = await response.text();
  const tokens = extractPageTokens(html);

  if (!response.ok || !tokens.at) {
    return privateJsonResponse({
      status: "reauth_required",
      cookie: cookieSummary(cfg),
      changed_cookie_names: [],
      message: "Google 已不接受這份登入態；Worker 無法自行重新登入，請從瀏覽器重新匯入 Cookie。",
    });
  }

  const merged = mergeRotatedCookies(cfg.cookie, getSetCookieValues(response.headers));
  if (!merged.changed_cookie_names.length) {
    return privateJsonResponse({
      status: "no_rotation",
      cookie: cookieSummary(cfg),
      changed_cookie_names: [],
      ignored_cookie_count: merged.ignored_cookie_count,
      message: "登入態有效；Google 本次沒有輪替 Cookie。",
    });
  }

  const now = new Date().toISOString();
  const auth = parseAuthPayload({
    cookie: merged.cookie,
    sapisid: cfg.sapisid,
    auth_user: cfg.auth_user,
    xsrf_token: tokens.at,
    gemini_bl: tokens.bl || cfg.gemini_bl,
  }, true);
  const record = {
    ...auth,
    removed_cookie_count: cfg.removed_cookie_count || 0,
    updated_at: now,
    refreshed_at: now,
  };
  await writeStoredAuth(env, record);

  const refreshedCfg = applyStoredAuth(cfg, record);
  _pageTokens = {
    key: await authCacheKey(refreshedCfg),
    tokens,
    ts: Date.now(),
  };
  return privateJsonResponse({
    status: "refreshed",
    cookie: cookieSummary(refreshedCfg),
    changed_cookie_names: merged.changed_cookie_names,
    ignored_cookie_count: merged.ignored_cookie_count,
    message: `已保存 Google 輪替的 ${merged.changed_cookie_names.length} 個 Cookie。`,
  });
}

async function handleCookieImport(request, cfg, env) {
  if (!cookieStoreStub(env)) {
    return privateJsonResponse({
      error: { message: "COOKIE_STORE 尚未綁定；請用 wrangler.toml 部署，或繼續使用 GEMINI_COOKIE Secret。" },
    }, 503);
  }

  let body;
  try {
    body = await request.json();
  } catch (_) {
    return privateJsonResponse({ error: { message: "請提供 JSON 請求" } }, 400);
  }

  try {
    const input = body && Object.prototype.hasOwnProperty.call(body, "auth") ? body.auth : body;
    const auth = parseAuthPayload(input, true);
    const record = { ...auth, updated_at: new Date().toISOString() };
    await writeStoredAuth(env, record);
    const importedCfg = applyStoredAuth(cfg, record);
    return privateJsonResponse({
      status: "imported",
      cookie: cookieSummary(importedCfg),
      message: "Cookie 已持久匯入；原文不會由管理 API 回傳。",
    });
  } catch (e) {
    return privateJsonResponse({ error: { message: String((e && e.message) || e) } }, 400);
  }
}

async function handleCookieDelete(cfg, env) {
  try {
    await clearStoredAuth(env);
    const fallback = getConfig(env);
    return privateJsonResponse({
      status: "deleted",
      cookie: cookieSummary(fallback),
      message: fallback.cookie ? "已移除面板覆寫，恢復使用環境 Secret。" : "已移除面板 Cookie。",
    });
  } catch (e) {
    return privateJsonResponse({ error: { message: String((e && e.message) || e) } }, 503);
  }
}

function dashboardResponse(cfg) {
  const nonce = randHex(32);
  const boot = JSON.stringify({
    version: VERSION,
    defaultModel: cfg.default_model,
    models: Object.entries(MODELS).map(([id, model]) => ({ id, description: model.desc })),
  }).replace(/</g, "\\u003c");

  const html = `<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light">
  <title>Gemini Bridge · Worker Console</title>
  <style nonce="${nonce}">
    :root {
      --canvas: #dfe7e9;
      --paper: #f8faf9;
      --ink: #152127;
      --muted: #52636b;
      --line: #c7d2d6;
      --line-strong: #92a4ab;
      --blue: #2456c7;
      --blue-dark: #163b8d;
      --blue-soft: #e5ecff;
      --green: #19704f;
      --green-soft: #dff3e9;
      --amber: #8a5700;
      --amber-soft: #fff0cc;
      --red: #a32929;
      --red-soft: #fde6e4;
      --radius: 14px;
      --shadow: 0 18px 42px rgba(30, 51, 60, .13);
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: var(--ink);
      background: var(--canvas);
    }
    * { box-sizing: border-box; }
    html { scroll-behavior: smooth; }
    body { margin: 0; min-width: 320px; background: var(--canvas); color: var(--ink); }
    button, input, textarea, select { font: inherit; }
    button, select { cursor: pointer; }
    a { color: inherit; }
    .skip-link { position: fixed; left: 1rem; top: -5rem; z-index: 20; padding: .7rem 1rem; background: var(--ink); color: #fff; border-radius: 8px; }
    .skip-link:focus { top: 1rem; }
    .shell { width: min(1180px, calc(100% - 32px)); margin: 28px auto; background: var(--paper); border-radius: 18px; box-shadow: var(--shadow); overflow: hidden; }
    .topbar { min-height: 76px; display: flex; align-items: center; gap: 24px; padding: 14px 24px; color: #fff; background: #17252c; }
    .brand { display: inline-flex; align-items: center; gap: 12px; text-decoration: none; flex: 0 0 auto; }
    .brand svg { width: 34px; height: 34px; }
    .brand-copy { display: grid; gap: 1px; }
    .brand-copy strong { font-size: .98rem; letter-spacing: -.01em; }
    .brand-copy span { color: #b9c9cf; font-size: .75rem; letter-spacing: .08em; text-transform: uppercase; }
    .access { margin-left: auto; display: grid; grid-template-columns: repeat(2, minmax(120px, 220px)) auto; align-items: end; gap: 8px; }
    .access label { display: grid; gap: 5px; color: #c6d3d8; font-size: .75rem; }
    .access input { width: 100%; min-height: 38px; border: 1px solid #4b616a; border-radius: 9px; padding: 0 11px; color: #fff; background: #22343c; font-size: 1rem; }
    main { display: block; }
    .hero { padding: clamp(38px, 6vw, 76px) clamp(24px, 6vw, 72px) 32px; }
    .hero-copy { max-width: 760px; }
    h1, h2, h3, p { margin-top: 0; }
    h1 { max-width: 14ch; margin-bottom: 18px; font-size: 4.4rem; line-height: .98; letter-spacing: -.04em; text-wrap: balance; }
    .hero-copy p { max-width: 66ch; margin-bottom: 30px; color: var(--muted); font-size: 1.03rem; line-height: 1.65; }
    .health-strip { display: grid; grid-template-columns: 1.1fr 1.8fr 1.2fr; border-block: 1px solid var(--line); }
    .datum { min-width: 0; padding: 16px 18px 16px 0; }
    .datum + .datum { padding-left: 18px; border-left: 1px solid var(--line); }
    .datum span { display: block; margin-bottom: 6px; color: var(--muted); font-size: .72rem; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
    .datum strong { display: flex; align-items: center; gap: 8px; min-width: 0; font-size: .9rem; font-weight: 650; }
    .datum code { overflow: hidden; color: var(--ink); font-family: ui-monospace, "Cascadia Code", Consolas, monospace; font-size: .82rem; text-overflow: ellipsis; white-space: nowrap; }
    .dot { width: 9px; height: 9px; flex: 0 0 auto; border-radius: 50%; background: var(--line-strong); box-shadow: 0 0 0 4px rgba(146, 164, 171, .2); }
    .dot.ok { background: var(--green); box-shadow: 0 0 0 4px rgba(25, 112, 79, .16); }
    .section-nav { display: flex; gap: 7px; padding: 0 clamp(24px, 6vw, 72px) 30px; overflow-x: auto; }
    .section-nav a { padding: 8px 12px; border: 1px solid var(--line); border-radius: 999px; color: var(--muted); font-size: .83rem; font-weight: 650; text-decoration: none; white-space: nowrap; }
    .section-nav a:hover { color: var(--blue-dark); border-color: #8aa5e8; background: var(--blue-soft); }
    .surface { padding: clamp(34px, 5vw, 58px) clamp(24px, 6vw, 72px); border-top: 1px solid var(--line); }
    .section-head { display: flex; align-items: end; justify-content: space-between; gap: 24px; margin-bottom: 24px; }
    .section-head h2 { margin-bottom: 7px; font-size: 2.1rem; line-height: 1.08; letter-spacing: -.03em; }
    .section-head p { max-width: 64ch; margin-bottom: 0; color: var(--muted); line-height: 1.55; }
    .button { min-height: 42px; display: inline-flex; align-items: center; justify-content: center; gap: 8px; border: 0; border-radius: 9px; padding: 0 15px; color: #fff; background: var(--blue); font-weight: 700; transition: background-color .18s ease, box-shadow .18s ease, transform .18s ease; }
    .button:hover { background: var(--blue-dark); box-shadow: 0 8px 18px rgba(36, 86, 199, .2); transform: translateY(-1px); }
    .button:active { transform: translateY(0); }
    .button.secondary { border: 1px solid var(--line-strong); color: var(--ink); background: transparent; }
    .topbar .button.secondary { color: #fff; border-color: #5e737c; }
    .button.secondary:hover { color: var(--blue-dark); border-color: #7192de; background: var(--blue-soft); box-shadow: none; }
    .topbar .button.secondary:hover { color: #fff; border-color: #9db3bc; background: #304750; }
    .button.danger { color: var(--red); border: 1px solid #e0aaa5; background: transparent; }
    .button.danger:hover { color: #7b1c1c; background: var(--red-soft); box-shadow: none; }
    .button:disabled { cursor: wait; opacity: .58; transform: none; box-shadow: none; }
    .model-list { border-block: 1px solid var(--line-strong); }
    .model-row { display: grid; grid-template-columns: minmax(210px, .85fr) minmax(260px, 1.4fr) 130px; gap: 24px; align-items: center; min-height: 74px; padding: 13px 4px; border-bottom: 1px solid var(--line); }
    .model-row:last-child { border-bottom: 0; }
    .model-id { font-family: ui-monospace, "Cascadia Code", Consolas, monospace; font-size: .86rem; font-weight: 700; overflow-wrap: anywhere; }
    .model-desc { color: var(--muted); font-size: .9rem; line-height: 1.45; }
    .badge { width: max-content; display: inline-flex; align-items: center; gap: 7px; border-radius: 999px; padding: 6px 9px; color: var(--muted); background: #e9eef0; font-size: .72rem; font-weight: 750; white-space: nowrap; }
    .badge.good { color: var(--green); background: var(--green-soft); }
    .badge.warn { color: var(--amber); background: var(--amber-soft); }
    .badge.bad { color: var(--red); background: var(--red-soft); }
    .cookie-layout { display: grid; grid-template-columns: minmax(260px, .75fr) minmax(360px, 1.25fr); gap: clamp(32px, 6vw, 72px); }
    .status-panel h3, .import-panel h3, .play-form h3, .result-panel h3 { margin-bottom: 9px; font-size: 1.12rem; letter-spacing: -.015em; }
    .status-panel > p, .import-panel > p { color: var(--muted); line-height: 1.55; }
    .cookie-state { margin: 26px 0; padding-block: 20px; border-block: 1px solid var(--line); }
    .cookie-state strong { display: block; margin-bottom: 8px; font-size: 1.35rem; letter-spacing: -.02em; }
    .cookie-state span { color: var(--muted); font-size: .88rem; }
    .facts { display: grid; gap: 12px; margin: 0; }
    .facts div { display: flex; justify-content: space-between; gap: 24px; }
    .facts dt { color: var(--muted); }
    .facts dd { margin: 0; font-weight: 700; text-align: right; }
    .inline-actions { display: flex; flex-wrap: wrap; gap: 9px; margin-top: 24px; }
    .field { display: grid; gap: 8px; margin-bottom: 17px; }
    .field label { font-size: .84rem; font-weight: 750; }
    .field small { color: var(--muted); line-height: 1.5; }
    textarea, select, .text-input { width: 100%; border: 1px solid var(--line-strong); border-radius: 10px; padding: 12px 13px; color: var(--ink); background: #fff; }
    textarea { min-height: 148px; resize: vertical; line-height: 1.5; }
    textarea::placeholder, input::placeholder { color: #718188; opacity: 1; }
    textarea:focus, select:focus, input:focus, button:focus-visible, a:focus-visible { outline: 3px solid rgba(36, 86, 199, .28); outline-offset: 2px; border-color: var(--blue); }
    .security-note { margin: 18px 0 0; padding: 13px 15px; border-radius: 10px; color: #374c55; background: #e8eff1; font-size: .82rem; line-height: 1.55; }
    .play-layout { display: grid; grid-template-columns: minmax(320px, .9fr) minmax(360px, 1.1fr); gap: clamp(28px, 5vw, 56px); align-items: start; }
    .play-form textarea { min-height: 180px; }
    .result-panel { min-width: 0; }
    .result-meta { min-height: 24px; margin-bottom: 9px; color: var(--muted); font-size: .78rem; }
    .result { min-height: 292px; margin: 0; overflow: auto; border: 1px solid #2a3b43; border-radius: 12px; padding: 18px; color: #dce8eb; background: #17252c; font-family: ui-monospace, "Cascadia Code", Consolas, monospace; font-size: .85rem; line-height: 1.65; white-space: pre-wrap; overflow-wrap: anywhere; }
    .result.fresh { animation: result-reveal .38s cubic-bezier(.16, 1, .3, 1); }
    @keyframes result-reveal { from { clip-path: inset(0 0 18% 0); filter: blur(2px); } to { clip-path: inset(0); filter: blur(0); } }
    .endpoint { display: flex; align-items: center; justify-content: space-between; gap: 18px; margin-top: 24px; padding: 14px 0; border-top: 1px solid var(--line); }
    .endpoint code { color: var(--blue-dark); font-family: ui-monospace, "Cascadia Code", Consolas, monospace; font-size: .86rem; overflow-wrap: anywhere; }
    .text-button { border: 0; padding: 6px 0; color: var(--blue-dark); background: transparent; font-weight: 750; }
    .text-button:hover { text-decoration: underline; text-underline-offset: 3px; }
    .footer { display: flex; justify-content: space-between; gap: 20px; padding: 22px clamp(24px, 6vw, 72px); border-top: 1px solid var(--line); color: var(--muted); font-size: .78rem; }
    .toast { position: fixed; right: 22px; bottom: 22px; z-index: 30; max-width: min(420px, calc(100vw - 44px)); padding: 13px 16px; border-radius: 10px; color: #fff; background: #17252c; box-shadow: 0 12px 30px rgba(15, 33, 41, .24); transform: translateY(20px); opacity: 0; pointer-events: none; transition: transform .24s cubic-bezier(.16, 1, .3, 1), opacity .2s ease; }
    .toast.show { transform: translateY(0); opacity: 1; }
    .toast.error { background: #7f2424; }
    .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
    @media (max-width: 760px) {
      .shell { width: 100%; margin: 0; border-radius: 0; }
      .topbar { align-items: stretch; flex-direction: column; gap: 14px; padding: 18px 20px; }
      .access { width: 100%; margin-left: 0; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
      .access .button { grid-column: 1 / -1; }
      .hero { padding-top: 42px; }
      h1 { font-size: 3rem; }
      .section-head h2 { font-size: 1.8rem; }
      .health-strip { grid-template-columns: 1fr; }
      .datum { padding: 14px 0; }
      .datum + .datum { padding-left: 0; border-left: 0; border-top: 1px solid var(--line); }
      .section-head { align-items: stretch; flex-direction: column; }
      .section-head .button { width: 100%; }
      .model-row { grid-template-columns: 1fr auto; gap: 7px 14px; padding-block: 16px; }
      .model-desc { grid-column: 1 / -1; }
      .cookie-layout, .play-layout { grid-template-columns: 1fr; }
      .import-panel, .result-panel { padding-top: 30px; border-top: 1px solid var(--line); }
      .footer { flex-direction: column; }
    }
    @media (prefers-reduced-motion: reduce) {
      html { scroll-behavior: auto; }
      *, *::before, *::after { animation-duration: .01ms !important; transition-duration: .01ms !important; }
    }
  </style>
</head>
<body>
  <!--
    THESIS: One operator bench exposes route truth, credential health, and a real request without dashboard clutter.
    OWN-WORLD: Cool daylight paper, dense ink, cobalt action, ruled data rows, and restrained status color.
    STORY: Confirm the Worker, inspect models and Cookie health, then prove the route in Playground.
    FIRST VIEWPORT: Large operational headline over a three-part health rail; section controls remain immediately below.
    FORM: Single-page operator console, direct functional extension; seed key scoped-worker-console.
    FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, and DESIGN.md
  -->
  <a class="skip-link" href="#content">跳到主要內容</a>
  <div class="shell">
    <header class="topbar">
      <a class="brand" href="/" aria-label="Gemini Bridge 首頁">
        <svg viewBox="0 0 36 36" aria-hidden="true">
          <rect x="2" y="2" width="14" height="14" rx="4" fill="#8eb0ff"/>
          <rect x="20" y="2" width="14" height="14" rx="7" fill="#4fd09b"/>
          <rect x="2" y="20" width="14" height="14" rx="7" fill="#ffffff"/>
          <rect x="20" y="20" width="14" height="14" rx="4" fill="#f1bf58"/>
        </svg>
        <span class="brand-copy"><strong>Gemini Bridge</strong><span>Worker Console</span></span>
      </a>
      <div class="access">
        <label for="api-key">API 金鑰
          <input id="api-key" type="password" autocomplete="off" placeholder="模型與 Playground">
        </label>
        <label for="admin-key">Admin 金鑰
          <input id="admin-key" type="password" autocomplete="off" placeholder="留空則沿用 API 金鑰">
        </label>
        <button class="button secondary" id="connect-key" type="button">套用</button>
      </div>
    </header>

    <main id="content">
      <section class="hero" aria-labelledby="page-title">
        <div class="hero-copy">
          <h1 id="page-title">Worker 狀態，一眼看完。</h1>
          <p>檢查實際模型路由、管理 Gemini 登入 Cookie，並從同一個位址送出測試請求。Cookie 原文只會送往這個 Worker，不會由狀態 API 回傳。</p>
        </div>
        <div class="health-strip" aria-live="polite">
          <div class="datum"><span>Worker</span><strong><i class="dot" id="health-dot"></i><b id="health-state">連線中</b></strong></div>
          <div class="datum"><span>Gemini build</span><strong><code id="build-value">讀取中</code></strong></div>
          <div class="datum"><span>版本</span><strong><code id="version-value">${VERSION}</code></strong></div>
        </div>
      </section>

      <nav class="section-nav" aria-label="頁面區段">
        <a href="#models">模型</a><a href="#cookie">Cookie</a><a href="#playground">Playground</a>
      </nav>

      <section class="surface" id="models" aria-labelledby="models-title">
        <div class="section-head">
          <div><h2 id="models-title">模型與實際路由</h2><p>一般清單顯示穩定別名；即時探測會真的向 Gemini 各送一個短請求，確認上游回到哪個模型。</p></div>
          <button class="button secondary" id="probe-models" type="button">即時探測</button>
        </div>
        <div class="model-list" id="model-list" role="table" aria-label="模型清單"></div>
      </section>

      <section class="surface" id="cookie" aria-labelledby="cookie-title">
        <div class="section-head"><div><h2 id="cookie-title">Cookie 狀態與匯入</h2><p>支援完整 Cookie header，以及上游 Cookie Sync 擴充輸出的 <code>gemini-auth.json</code>。</p></div></div>
        <div class="cookie-layout">
          <div class="status-panel">
            <h3>目前登入鏈</h3>
            <p>先做結構檢查，再用 Pro 路由探測驗證這份登入態是否真的被上游接受。</p>
            <div class="cookie-state"><strong id="cookie-state">需要管理金鑰</strong><span id="cookie-detail">輸入金鑰後讀取，不會顯示 Cookie 值。</span></div>
            <dl class="facts">
              <div><dt>來源</dt><dd id="cookie-source">—</dd></div>
              <div><dt>工作階段</dt><dd id="cookie-session">—</dd></div>
              <div><dt>XSRF token</dt><dd id="cookie-xsrf">—</dd></div>
              <div><dt>最近刷新</dt><dd id="cookie-refreshed">尚未刷新</dd></div>
              <div><dt>實際 Pro 路由</dt><dd id="cookie-route">尚未探測</dd></div>
            </dl>
            <div class="inline-actions">
              <button class="button secondary" id="refresh-cookie" type="button">刷新 Cookie</button>
              <button class="button secondary" id="verify-cookie" type="button">驗證 Cookie</button>
              <button class="button danger" id="clear-cookie" type="button">移除面板覆寫</button>
            </div>
          </div>
          <form class="import-panel" id="cookie-form">
            <h3>匯入新的登入態</h3>
            <p>貼上 raw Cookie，或整份 JSON。匯入成功後輸入框會立即清空。</p>
            <div class="field">
              <label for="cookie-input">Cookie / gemini-auth.json</label>
              <textarea id="cookie-input" required autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="SAPISID=...; __Secure-1PSID=...; ..."></textarea>
              <small>至少需要 SAPISID，以及 SID、__Secure-1PSID、__Secure-3PSID 其中之一。</small>
            </div>
            <button class="button" id="import-cookie" type="submit">持久匯入</button>
            <p class="security-note">API 呼叫使用 <code>API_KEYS</code>；Cookie 管理使用 <code>ADMIN_KEY</code>，只有未設定 Admin key 時才接受 API key。持久資料由 <code>COOKIE_STORE</code> Durable Object 保存。</p>
          </form>
        </div>
      </section>

      <section class="surface" id="playground" aria-labelledby="playground-title">
        <div class="section-head"><div><h2 id="playground-title">Playground</h2><p>使用同一組 OpenAI 相容 API，回覆會同時顯示實際上游模型與路由狀態。</p></div></div>
        <div class="play-layout">
          <form class="play-form" id="play-form">
            <h3>送出測試</h3>
            <div class="field"><label for="play-model">模型</label><select id="play-model"></select></div>
            <div class="field"><label for="play-prompt">訊息</label><textarea id="play-prompt" required placeholder="請用一句話確認服務正常。">請只回答：Worker OK</textarea></div>
            <button class="button" id="send-prompt" type="submit">送出請求</button>
          </form>
          <div class="result-panel">
            <h3>回覆</h3>
            <div class="result-meta" id="result-meta">尚未送出請求</div>
            <pre class="result" id="result" tabindex="0">回覆會顯示在這裡。</pre>
          </div>
        </div>
        <div class="endpoint"><code id="base-url">/v1</code><button class="text-button" id="copy-url" type="button">複製 API Base URL</button></div>
      </section>
    </main>
    <footer class="footer"><span>Gemini Bridge ${VERSION}</span><span>Cookie 值永不出現在狀態回應或瀏覽器儲存。</span></footer>
  </div>
  <div class="toast" id="toast" role="status" aria-live="polite"></div>

  <script nonce="${nonce}">
    const BOOT = ${boot};
    const byId = function (id) { return document.getElementById(id); };
    let apiKey = sessionStorage.getItem("gemini-worker-api-key") || "";
    let adminKey = sessionStorage.getItem("gemini-worker-admin-key") || "";
    let toastTimer;

    function showToast(message, error) {
      const toast = byId("toast");
      toast.textContent = message;
      toast.className = "toast show" + (error ? " error" : "");
      clearTimeout(toastTimer);
      toastTimer = setTimeout(function () { toast.className = "toast"; }, 4200);
    }

    function requestHeaders(admin, json) {
      const headers = {};
      const key = admin ? (adminKey || apiKey) : apiKey;
      if (json) headers["Content-Type"] = "application/json";
      if (key) {
        headers.Authorization = "Bearer " + key;
        if (admin) headers["X-Admin-Key"] = key;
      }
      return headers;
    }

    async function readJson(response) {
      let data = null;
      try { data = await response.json(); } catch (_) {}
      if (!response.ok) {
        const message = data && data.error ? (data.error.message || data.error) : "HTTP " + response.status;
        throw new Error(message);
      }
      return data;
    }

    function statusBadge(route) {
      const badge = document.createElement("span");
      const status = route && route.route_status;
      badge.className = "badge" + (status === "matched" || status === "auto" ? " good" : status === "fallback" ? " warn" : "");
      badge.textContent = status === "matched" ? "路由吻合" : status === "auto" ? "自動選擇" : status === "fallback" ? "已回退" : "尚未探測";
      return badge;
    }

    function renderModels(models) {
      const list = byId("model-list");
      const select = byId("play-model");
      list.textContent = "";
      select.textContent = "";
      models.forEach(function (model) {
        const row = document.createElement("div");
        row.className = "model-row";
        row.setAttribute("role", "row");
        const id = document.createElement("div");
        id.className = "model-id";
        id.setAttribute("role", "cell");
        id.textContent = model.id;
        const desc = document.createElement("div");
        desc.className = "model-desc";
        desc.setAttribute("role", "cell");
        desc.textContent = model.upstream_model ? model.description + " · upstream: " + model.upstream_model : model.description;
        row.append(id, desc, statusBadge(model));
        list.appendChild(row);
        const option = document.createElement("option");
        option.value = model.id;
        option.textContent = model.id;
        option.selected = model.id === BOOT.defaultModel;
        select.appendChild(option);
      });
    }

    function sourceLabel(source) {
      return source === "dashboard" ? "面板持久匯入" : source === "secret" ? "Worker Secret" : source === "inline" ? "程式內設定" : "未設定";
    }

    function renderCookie(cookie) {
      const configured = cookie && cookie.configured;
      byId("cookie-state").textContent = configured ? (cookie.structurally_valid ? "結構完整" : "設定不完整") : "尚未設定 Cookie";
      byId("cookie-detail").textContent = configured
        ? String(cookie.cookie_count) + " 個登入欄位，" + String(cookie.byte_length) + " bytes" + (cookie.removed_cookie_count ? "；已移除 " + cookie.removed_cookie_count + " 個非必要欄位。" : "；Cookie 值已遮蔽。")
        : "匿名文字請求仍可使用；圖片與真正 Pro 路由需要登入態。";
      byId("cookie-source").textContent = sourceLabel(cookie && cookie.source);
      byId("cookie-session").textContent = cookie && cookie.session_cookie ? cookie.session_cookie : "缺少";
      byId("cookie-xsrf").textContent = cookie && cookie.xsrf_token_present ? "已匯入" : configured ? "請求時自動抓取" : "—";
      byId("cookie-refreshed").textContent = cookie && cookie.refreshed_at ? new Date(cookie.refreshed_at).toLocaleString() : "尚未刷新";
      const verification = cookie && cookie.verification;
      byId("cookie-route").textContent = !verification ? "尚未探測" : verification.pro_route_verified ? "已驗證 Pro" : verification.actual_model ? "回到 " + verification.actual_model : "無法確認";
    }

    async function loadHealth() {
      try {
        const data = await readJson(await fetch("/health"));
        byId("health-dot").className = "dot ok";
        byId("health-state").textContent = "正常";
        byId("build-value").textContent = data.gemini_bl || "未取得";
        byId("version-value").textContent = data.version || BOOT.version;
      } catch (error) {
        byId("health-state").textContent = "無法連線";
        byId("build-value").textContent = error.message;
      }
    }

    async function loadAdmin(mode) {
      const suffix = mode === "verify" ? "?verify=1" : "";
      const data = await readJson(await fetch("/admin/status" + suffix, { headers: requestHeaders(true, false) }));
      renderCookie(data.cookie);
      return data;
    }

    async function loadLiveModels() {
      const data = await readJson(await fetch("/v1/models?live=1", { headers: requestHeaders(false, false) }));
      renderModels(data.data || []);
      return data;
    }

    function setBusy(button, busy, text) {
      if (!button.dataset.label) button.dataset.label = button.textContent;
      button.disabled = busy;
      button.textContent = busy ? text : button.dataset.label;
    }

    byId("connect-key").addEventListener("click", async function () {
      apiKey = byId("api-key").value.trim();
      adminKey = byId("admin-key").value.trim();
      if (apiKey) sessionStorage.setItem("gemini-worker-api-key", apiKey);
      else sessionStorage.removeItem("gemini-worker-api-key");
      if (adminKey) sessionStorage.setItem("gemini-worker-admin-key", adminKey);
      else sessionStorage.removeItem("gemini-worker-admin-key");
      try {
        await loadAdmin("");
        showToast("金鑰已套用，管理狀態已載入", false);
      } catch (error) {
        renderCookie(null);
        byId("cookie-state").textContent = "管理存取未通過";
        byId("cookie-detail").textContent = error.message;
        showToast(error.message, true);
      }
    });

    byId("probe-models").addEventListener("click", async function (event) {
      setBusy(event.currentTarget, true, "探測中…");
      try { await loadLiveModels(); showToast("模型路由探測完成", false); }
      catch (error) { showToast(error.message, true); }
      finally { setBusy(event.currentTarget, false, ""); }
    });

    byId("verify-cookie").addEventListener("click", async function (event) {
      setBusy(event.currentTarget, true, "驗證中…");
      try { await loadAdmin("verify"); showToast("Cookie 驗證完成", false); }
      catch (error) { showToast(error.message, true); }
      finally { setBusy(event.currentTarget, false, ""); }
    });

    byId("refresh-cookie").addEventListener("click", async function (event) {
      setBusy(event.currentTarget, true, "刷新中…");
      try {
        const data = await readJson(await fetch("/admin/cookie/refresh", {
          method: "POST",
          headers: requestHeaders(true, false)
        }));
        renderCookie(data.cookie);
        showToast(data.message, data.status === "reauth_required");
      } catch (error) { showToast(error.message, true); }
      finally { setBusy(event.currentTarget, false, ""); }
    });

    byId("cookie-form").addEventListener("submit", async function (event) {
      event.preventDefault();
      const button = byId("import-cookie");
      const value = byId("cookie-input").value.trim();
      if (!value) return;
      setBusy(button, true, "匯入中…");
      try {
        const data = await readJson(await fetch("/admin/cookie", {
          method: "PUT",
          headers: requestHeaders(true, true),
          body: JSON.stringify({ auth: value })
        }));
        byId("cookie-input").value = "";
        renderCookie(data.cookie);
        showToast(data.message, false);
      } catch (error) { showToast(error.message, true); }
      finally { setBusy(button, false, ""); }
    });

    byId("clear-cookie").addEventListener("click", async function (event) {
      if (!confirm("移除面板匯入的 Cookie，並恢復環境 Secret？")) return;
      setBusy(event.currentTarget, true, "移除中…");
      try {
        const data = await readJson(await fetch("/admin/cookie", { method: "DELETE", headers: requestHeaders(true, false) }));
        renderCookie(data.cookie);
        showToast(data.message, false);
      } catch (error) { showToast(error.message, true); }
      finally { setBusy(event.currentTarget, false, ""); }
    });

    byId("play-form").addEventListener("submit", async function (event) {
      event.preventDefault();
      const button = byId("send-prompt");
      const result = byId("result");
      const started = performance.now();
      setBusy(button, true, "等待上游…");
      result.className = "result";
      result.textContent = "請求處理中…";
      try {
        const data = await readJson(await fetch("/v1/chat/completions", {
          method: "POST",
          headers: requestHeaders(false, true),
          body: JSON.stringify({
            model: byId("play-model").value,
            messages: [{ role: "user", content: byId("play-prompt").value }],
            stream: false
          })
        }));
        const message = data.choices && data.choices[0] && data.choices[0].message;
        result.textContent = message && message.content ? message.content : JSON.stringify(data, null, 2);
        const elapsed = (performance.now() - started) / 1000;
        byId("result-meta").textContent = elapsed.toFixed(1) + "s · upstream " + (data.upstream_model || "unknown") + " · " + (data.route_status || "unknown");
        void result.offsetWidth;
        result.className = "result fresh";
      } catch (error) {
        result.textContent = "請求失敗：" + error.message + "\\n\\n請確認 API key、Cookie 狀態與上游連線。";
        byId("result-meta").textContent = "請求失敗";
        showToast(error.message, true);
      } finally { setBusy(button, false, ""); }
    });

    byId("copy-url").addEventListener("click", async function () {
      const value = location.origin + "/v1";
      try { await navigator.clipboard.writeText(value); showToast("API Base URL 已複製", false); }
      catch (_) { showToast("無法存取剪貼簿，請手動複製", true); }
    });

    byId("api-key").value = apiKey;
    byId("admin-key").value = adminKey;
    byId("base-url").textContent = location.origin + "/v1";
    renderModels(BOOT.models);
    loadHealth();
    if (adminKey || apiKey) loadAdmin("").catch(function (error) { showToast(error.message, true); });
  </script>
</body>
</html>`;

  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`,
      "Cross-Origin-Opener-Policy": "same-origin",
      "Referrer-Policy": "no-referrer",
      "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
    },
  });
}

// ─── 路由 ────────────────────────────────────────────────────────────────────
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    const adminPath = path.startsWith("/admin/");
    const publicGet = method === "GET" && (path === "/" || path === "/health");
    let cfg;

    try {
      cfg = publicGet ? getConfig(env) : await getRequestConfig(env);
    } catch (e) {
      const baseCfg = getConfig(env);
      log(baseCfg, `Cookie store unavailable; refusing fallback credentials: ${e}`);
      const error = { error: { code: "cookie_store_unavailable", message: "Cookie 儲存暫時無法讀取；為避免切換到錯誤帳號，本次請求已拒絕。" } };
      return adminPath ? privateJsonResponse(error, 503) : jsonResponse(error, 503);
    }

    if (method === "OPTIONS") {
      if (adminPath) return new Response(null, { status: 204, headers: { "Allow": "GET, POST, PUT, DELETE, OPTIONS" } });
      return new Response(null, {
        status: 204,
        headers: { ...corsHeaders(), "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "*" },
      });
    }

    if (adminPath) {
      if (!cfg.admin_key && !(cfg.api_keys || []).length) {
        return privateJsonResponse({ error: { message: "管理功能已停用；請先設定 ADMIN_KEY 或 API_KEYS。" } }, 403);
      }
      if (!adminAuthorized(request, cfg)) {
        return privateJsonResponse({ error: { message: "管理金鑰無效" } }, 401);
      }
    }

    if (!adminPath && path !== "/" && path !== "/health" && cfg.cookie && !(cfg.api_keys || []).length) {
      return jsonResponse({
        error: {
          code: "api_keys_required_with_cookie",
          message: "設定 Cookie 後必須設定 API_KEYS，避免公開使用登入帳號。",
        },
      }, 503);
    }

    // 鉴权:配置了 API_KEYS 时,除公开首页与健康检查外的 API 都需要有效 key
    // (含 /v1/* 与 /v1beta/*,防止 Google 原生端点被绕过白嫖)。
    if (!adminPath && path !== "/" && path !== "/health" && !authorized(request, url, cfg)) {
      return jsonResponse({ error: { message: "invalid api key" } }, 401);
    }

    try {
      if (adminPath) {
        if (path === "/admin/status" && method === "GET") return await handleAdminStatus(cfg, env, url);
        if (path === "/admin/cookie" && method === "PUT") return await handleCookieImport(request, cfg, env);
        if (path === "/admin/cookie" && method === "DELETE") return await handleCookieDelete(cfg, env);
        if (path === "/admin/cookie/refresh" && method === "POST") return await handleCookieRefresh(cfg, env);
        return privateJsonResponse({ error: { message: "not found" } }, 404);
      }

      if (method === "GET") {
        if (path === "/v1/models") {
          const live = parseBool(url.searchParams.get("live"), false);
          const inspection = live ? await inspectModelRoutes(cfg) : null;
          return jsonResponse({
            object: "list",
            dynamic: live,
            actual_models: inspection ? inspection.actual_models : undefined,
            cookie: inspection ? inspection.cookie : undefined,
            data: Object.entries(MODELS).map(([n, c]) => ({
              id: n,
              object: "model",
              created: 1700000000,
              owned_by: "google",
              description: c.desc,
              ...(inspection ? inspection.routes[n] : {}),
            })),
          });
        }
        if (path.startsWith("/v1beta/models")) {
          const live = parseBool(url.searchParams.get("live"), false);
          const inspection = live ? await inspectModelRoutes(cfg) : null;
          return jsonResponse({
            dynamic: live,
            actualModels: inspection ? inspection.actual_models : undefined,
            cookie: inspection ? inspection.cookie : undefined,
            models: Object.entries(MODELS).map(([n, c]) => ({
              name: `models/${n}`,
              displayName: n,
              description: c.desc,
              supportedGenerationMethods: ["generateContent", "streamGenerateContent"],
              ...(inspection ? inspection.routes[n] : {}),
            })),
          });
        }
        if (path === "/" || path === "/health") {
          const wantsHtml = path === "/" && (
            url.searchParams.get("ui") === "1" ||
            (url.searchParams.get("ui") !== "0" && (request.headers.get("accept") || "").includes("text/html"))
          );
          if (wantsHtml) return dashboardResponse(cfg);
          const publicCfg = { ...cfg, cookie: "", sapisid: "", xsrf_token: "" };
          await refreshGeminiBl(publicCfg);
          return jsonResponse({ status: "ok", version: VERSION, gemini_bl: publicCfg.gemini_bl, models: Object.keys(MODELS) });
        }
        if (path === "/debug") {
          if (!cfg.enable_debug) return jsonResponse({ error: "debug endpoint disabled" }, 403);
          return await handleDebug(cfg);
        }
        return jsonResponse({ error: "not found" }, 404);
      }

      if (method === "POST") {
        const bodyText = await request.text();
        const req = parseJson(bodyText);

        if (path === "/v1/chat/completions") {
          if (req === null) return jsonResponse({ error: { message: "invalid JSON" } }, 400);
          return await handleChat(req, cfg);
        }
        if (path === "/v1/responses") {
          if (req === null) return jsonResponse({ error: { message: "invalid JSON" } }, 400);
          return await handleResponses(req, cfg);
        }
        if (path.includes(":generateContent")) {
          if (req === null) return jsonResponse({ error: { message: "invalid JSON" } }, 400);
          return await handleGoogleGenerate(req, cfg, path, false);
        }
        if (path.includes(":streamGenerateContent")) {
          if (req === null) return jsonResponse({ error: { message: "invalid JSON" } }, 400);
          return await handleGoogleGenerate(req, cfg, path, true);
        }
        return jsonResponse({ error: "not found" }, 404);
      }

      return jsonResponse({ error: "not found" }, 404);
    } catch (e) {
      log(cfg, `error: ${(e && e.stack) || e}`);
      return adminPath
        ? privateJsonResponse({ error: { message: String((e && e.message) || e) } }, 500)
        : jsonResponse({ error: { message: String((e && e.message) || e) } }, 500);
    }
  },
};

// Node 测试挂点。Cloudflare 会把具名 export 当成 Durable Object / Worker
// entrypoint，因此仅在 Node 环境挂到 globalThis，不进入线上导出表。
if (typeof process !== "undefined" && process.versions && process.versions.node) {
  globalThis.__GEMINI_WORKER_TEST__ = {
    MODELS, SLOT, resolveModel, getConfig, getRequestConfig, parseAuthPayload, cookieSummary, authCacheKey,
    getSetCookieValues, mergeRotatedCookies,
    buildPayload, getUrl, buildHeaders, cleanText,
    extractTextsFromLine, extractResponseText, extractActualModel, routeStatus, generate, generateResult, generateStream,
    messagesToPrompt, parseToolCalls, toOpenAIStreamToolCallDeltas, googleContentsToPrompt, parseGoogleFunctionCalls,
    makeSapisidHash, parseImageUrl, extractGeminiBl, extractPageTokens, getPageTokens, uploadImage, resolveImages,
    __setConnect, httpFetch, socketHttp, timingSafeEqual, MAX_IMAGE_BYTES,
  };
}
