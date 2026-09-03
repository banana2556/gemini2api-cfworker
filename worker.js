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
 * 部署:匿名模式可直接粘贴这个单文件；需要登入态时执行 `wrangler deploy`，
 * 让仓库内 wrangler.toml 建立 COOKIE_STORE Durable Object 与排程。
 *
 * 配置:编辑本文件顶部的 CONFIG 对象。每个键也都可以用同名的 Worker
 * 环境变量 / secret 覆盖(API_KEYS 建议用 secret,避免提交进仓库):
 *   API_KEYS             逗号分隔的列表或 JSON 数组;面板与 API 共用;使用 Cookie 时必须设置
 *   GEMINI_BL            Gemini 网页版构建号(会随时间变化)
 *   GEMINI_ORIGIN        上游源站;部署被 Google 429 限流时,指向干净 IP 的反向代理
 *   UPSTREAM_SOCKET      true/false;true=上游优先用裸 socket(绕开 fetch 的 429)
 *   DEFAULT_MODEL        默认模型名
 *   RETRY_ATTEMPTS / RETRY_DELAY_SEC / REQUEST_TIMEOUT_SEC   整数
 *   LOG_REQUESTS         true/false
 *   ENABLE_DEBUG         true/false;false=关闭 /debug 端点(避免泄露内部配置)
 *
 * 限制:图片/多模态输入需要登录态 —— 从面板匯入 Cookie 后,图片会经 Scotty
 * 上传到 Gemini 再绑进会话;未设置 cookie 时图片会被忽略(匿名带图会被后端以
 * 1100 拒绝),并在 prompt 里加一句提示。动态发现的 Pro 路由也需要对应账号权限,
 * 否则上游会回退到其他模型。
 */

const VERSION = "1.9.7";

// ════════════════════════════════════════════════════════════════════════════
//  CONFIG —— 改这些值,然后直接部署本文件。
//  若设置了同名的 Worker 环境变量 / secret,会覆盖这里的值;不设则用此处的值。
// ════════════════════════════════════════════════════════════════════════════
const CONFIG = {
  // 调用方必须携带的密钥(Authorization: Bearer <key> 或 x-api-key: <key>)。
  // 空数组 = 仅匿名 Gemini 模式不鉴权；配置 Cookie 后必须设置。
  // 面板登入与 Cookie 管理使用同一组 API_KEYS。
  API_KEYS: [],

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

  // 留空时自动选择 GetUserStatus 当前回传的 Flash 标准模型。
  DEFAULT_MODEL: "",
  RETRY_ATTEMPTS: 3,
  RETRY_DELAY_SEC: 2,
  REQUEST_TIMEOUT_SEC: 180,
  LOG_REQUESTS: true,
  ENABLE_DEBUG: true,
};

// ─── 动态模型目录 ─────────────────────────────────────────────────────────
// MODE_CATEGORY 是 Gemini 协议枚举，不是模型清单：1=Flash、3=Pro、4=Guest auto、6=Flash-Lite。
// 有 Cookie 时，实际版本、显示名称和主/子模型 ID 来自当前帐号的 GetUserStatus 与 /app。
// 无 Cookie 时不探测具体家族，改走 guest 自动路由（mode 4）。
const MODEL_CATEGORIES = [6, 1, 3];
const GUEST_MODE = 4;
const MODEL_STATUS_RPC = "otAQ7b";
const MODEL_CATALOG_TTL_SEC = 6 * 60 * 60;
let _modelCatalogMemory = { key: "", models: null, expiresAt: 0 };

function modelAlias(displayName) {
  const slug = String(displayName || "")
    .toLowerCase()
    .replace(/^gemini\s+/, "")
    .replace(/[^a-z0-9.]+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "");
  return slug ? `gemini-${slug}` : "";
}

function extractRpcPayload(raw, rpcId) {
  const escapedId = String(rpcId).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`\\["wrb\\.fr","${escapedId}","((?:\\\\.|[^"\\\\])*)"`).exec(raw || "");
  if (!match) throw new Error(`${rpcId} response payload not found`);
  return JSON.parse(JSON.parse(`"${match[1]}"`));
}

function extractRouteVariant(html, primaryId, candidates) {
  const allowed = new Set((candidates || []).filter((id) => id !== primaryId && /^[a-f0-9]{16}$/i.test(id)));
  let best = null;
  for (const group of String(html || "").match(/\[\[[\s\S]{0,2048}?\]\]/g) || []) {
    const ids = group.match(/[a-f0-9]{16}/gi) || [];
    const primaryIndex = ids.indexOf(primaryId);
    if (primaryIndex < 0) continue;
    for (let i = 0; i < ids.length; i++) {
      if (!allowed.has(ids[i])) continue;
      const score = Math.abs(i - primaryIndex) * 2 + (i > primaryIndex ? 1 : 0);
      if (!best || score < best.score) best = { id: ids[i], score };
    }
  }
  return best ? best.id : "";
}

function computeAccountCapacity(statusPayload) {
  const tier = Array.isArray(statusPayload?.[16]) ? statusPayload[16] : [];
  const caps = Array.isArray(statusPayload?.[17]) ? statusPayload[17] : [];
  if (tier.includes(21)) return { capacity: 1, capacity_field: 13 };
  if (tier.includes(22)) return { capacity: 2, capacity_field: 13 };
  if (caps.includes(115)) return { capacity: 4, capacity_field: 12 };
  if (tier.includes(16) || caps.includes(106)) return { capacity: 3, capacity_field: 12 };
  if (tier.includes(8) || caps.includes(19)) return { capacity: 2, capacity_field: 12 };
  return { capacity: 1, capacity_field: 12 };
}

function buildModelSelectHeader(modelId, mode, capacity = 1, capacityField = 12) {
  if (!modelId) return "";
  const tail = capacityField === 13 ? `null,${capacity}` : String(Number(capacity) || 1);
  return `[1,null,null,null,"${modelId}",null,null,0,[4,5,6,8],null,null,${tail},null,null,${Number(mode) || 1}]`;
}

function buildModelCatalog(statusPayload, appHtml) {
  const rows = statusPayload && Array.isArray(statusPayload[15]) ? statusPayload[15] : [];
  const { capacity, capacity_field } = computeAccountCapacity(statusPayload);
  const models = {};
  for (const category of MODEL_CATEGORIES) {
    const row = rows.find((item) => Array.isArray(item) && item[17] === category);
    if (!row) throw new Error(`GetUserStatus missing model category ${category}`);
    const primaryId = String(row[0] || "");
    const displayName = String(row[11] || row[19] || row[1] || "").trim();
    const id = modelAlias(displayName);
    if (!primaryId || !id) throw new Error(`GetUserStatus returned an invalid model category ${category}`);
    const submodel = extractRouteVariant(appHtml, primaryId, Array.isArray(row[6]) ? row[6] : []);
    if (!submodel) throw new Error(`Gemini /app missing route ID for ${displayName}`);
    const description = String(row[12] || row[2] || displayName).trim();
    models[id] = {
      mode: category,
      thinking_level: 1,
      model: primaryId,
      submodel,
      capacity,
      capacity_field,
      desc: `${displayName} · ${description}`,
    };
    models[`${id}-thinking`] = {
      mode: category,
      thinking_level: 2,
      model: primaryId,
      submodel,
      capacity,
      capacity_field,
      desc: `${displayName} · Extended thinking`,
    };
  }
  if (Object.keys(models).length !== 6) throw new Error("Gemini model catalog did not produce six models");
  return models;
}

function guestModelCatalog() {
  return {
    "gemini-auto": {
      mode: GUEST_MODE,
      thinking_level: 1,
      model: "",
      submodel: "",
      desc: "Gemini · Guest auto routing",
    },
    "gemini-auto-thinking": {
      mode: GUEST_MODE,
      thinking_level: 2,
      model: "",
      submodel: "",
      desc: "Gemini · Guest auto routing · Extended thinking",
    },
  };
}

function defaultModelName(models, preferred = "", thinkingLevel = null) {
  if (preferred && models[preferred] && (thinkingLevel == null || models[preferred].thinking_level === thinkingLevel)) {
    return preferred;
  }
  const level = thinkingLevel == null ? 1 : thinkingLevel;
  return Object.keys(models).find((name) => models[name].mode === 1 && models[name].thinking_level === level)
    || Object.keys(models).find((name) => models[name].thinking_level === level)
    || Object.keys(models)[0]
    || "";
}

function modelNameForCategory(models, category, thinkingLevel = 1) {
  return Object.keys(models).find((name) => models[name].mode === category && models[name].thinking_level === thinkingLevel) || "";
}

/**
 * 把模型名解析成路由参数。
 * 未知名称会回退到 `def` 而不是报错(客户端可能传任意 id)。
 * 返回 { name, modeId, thinkingLevel, extra },或 { error }。
 */
function resolveModel(modelName, def, models) {
  let cfg = models[modelName];
  if (!cfg) {
    const level = /thinking|deep.?think/i.test(String(modelName || "")) ? 2 : 1;
    const preferred = models[def] && models[def].thinking_level === level ? def : "";
    modelName = defaultModelName(models, preferred, level);
    cfg = models[modelName];
  }
  if (!cfg) return { error: "Gemini model catalog is empty" };
  return {
    name: modelName,
    modeId: cfg.mode,
    thinkingLevel: cfg.thinking_level,
    extra: cfg.submodel ? { 64: cfg.submodel, 75: cfg.mode } : null,
    header: buildModelSelectHeader(cfg.model, cfg.mode, cfg.capacity, cfg.capacity_field),
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
  "AEC", "NID", "COMPASS", "GOOGLE_ABUSE_EXEMPTION", "__Secure-BUCKET", "__Secure-STRP", "__Secure-ENID",
  "__Secure-1PAPISID", "__Secure-1PSID", "__Secure-1PSIDTS", "__Secure-1PSIDRTS", "__Secure-1PSIDCC",
  "__Secure-3PAPISID", "__Secure-3PSID", "__Secure-3PSIDTS", "__Secure-3PSIDRTS", "__Secure-3PSIDCC",
  "__Secure-OSID", "__Host-1PLSID", "__Host-3PLSID",
];
const FORWARDED_COOKIE_SET = new Set(FORWARDED_COOKIE_NAMES);

function normalizePastedCookieText(cookie) {
  return String(cookie || "")
    .replace(/\\([_*])/g, "$1")
    .replace(/[\u200B-\u200D\uFEFF]/g, "");
}

function normalizeCookieName(name) {
  const clean = normalizePastedCookieText(name).trim();
  return /^[_*]+Secure-/.test(clean) ? clean.replace(/^[_*]+Secure-/, "__Secure-") : clean;
}

function parseCookiePairs(cookie) {
  const pairs = new Map();
  for (const part of String(cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i <= 0) continue;
    const name = normalizeCookieName(part.slice(0, i));
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

  const rawCookie = String(payload.cookie ?? "")
    .replace(/^cookie\s*:\s*/i, "")
    .replace(/[\r\n]+[\t ]*/g, " ")
    .replace(/\\([_*])/g, "$1")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .trim();
  const pairs = parseCookiePairs(rawCookie);
  const forwarded = FORWARDED_COOKIE_NAMES.filter((name) => pairs.has(name));
  const cookie = serializeCookiePairs(pairs);
  const removedCookieCount = Math.max(0, pairs.size - forwarded.length);
  const embeddedSapisid = pairs.get("SAPISID") || "";
  const explicitSapisid = String(payload.sapisid ?? "").trim();
  const sapisid = explicitSapisid || embeddedSapisid;
  const authUserRaw = payload.auth_user ?? payload.authUser ?? "";
  const authUser = authUserRaw === null || authUserRaw === "" ? null : String(authUserRaw).trim();
  const xsrfToken = String(payload.xsrf_token ?? payload.xsrfToken ?? "").trim();
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
    refresh_checked_at: cfg.cookie_refresh_checked_at || null,
    refresh_status: cfg.cookie_refresh_status || null,
    refresh_error: cfg.cookie_refresh_error || null,
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
  const envGeminiBl = env.GEMINI_BL !== undefined && env.GEMINI_BL !== null && env.GEMINI_BL !== ""
    ? env.GEMINI_BL
    : null;
  return {
    gemini_bl: envGeminiBl || CONFIG.GEMINI_BL,
    gemini_origin: String(envOr(env, "GEMINI_ORIGIN", CONFIG.GEMINI_ORIGIN)).replace(/\/$/, ""),
    upstream_socket: parseBool(envOr(env, "UPSTREAM_SOCKET", CONFIG.UPSTREAM_SOCKET), true),
    default_model: envOr(env, "DEFAULT_MODEL", CONFIG.DEFAULT_MODEL),
    retry_attempts: parseIntDefault(envOr(env, "RETRY_ATTEMPTS", CONFIG.RETRY_ATTEMPTS), 3),
    retry_delay_sec: parseIntDefault(envOr(env, "RETRY_DELAY_SEC", CONFIG.RETRY_DELAY_SEC), 2),
    request_timeout_sec: parseIntDefault(envOr(env, "REQUEST_TIMEOUT_SEC", CONFIG.REQUEST_TIMEOUT_SEC), 180),
    log_requests: parseBool(envOr(env, "LOG_REQUESTS", CONFIG.LOG_REQUESTS), true),
    enable_debug: parseBool(envOr(env, "ENABLE_DEBUG", CONFIG.ENABLE_DEBUG), true),
    api_keys: parseApiKeys(envOr(env, "API_KEYS", CONFIG.API_KEYS)),
    cookie: "",
    sapisid: "",
    auth_user: null,
    xsrf_token: "",
    cookie_source: "none",
    cookie_updated_at: null,
    cookie_refreshed_at: null,
    cookie_refresh_checked_at: null,
    cookie_refresh_status: null,
    cookie_refresh_error: null,
    removed_cookie_count: 0,
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
    cookie_source: "durable_object",
    cookie_updated_at: record.updated_at || null,
    cookie_refreshed_at: record.refreshed_at || null,
    cookie_refresh_checked_at: record.refresh_checked_at || null,
    cookie_refresh_status: record.refresh_status || null,
    cookie_refresh_error: record.refresh_error || null,
    removed_cookie_count: record.removed_cookie_count || auth.removed_cookie_count || 0,
  };
}

function switchToGuest(cfg, reason) {
  cfg.cookie = "";
  cfg.sapisid = "";
  cfg.auth_user = null;
  cfg.xsrf_token = "";
  cfg.cookie_source = "guest_fallback";
  cfg.cookie_refresh_error = reason || "guest_fallback";
  return cfg;
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
  REQUEST_ID: 59, FLAGS_61: 61, ROUTE_ID: 64, FLAGS_68: 68,
  VARIANT_MODE: 75, MODE: 79, THINK_LEVEL: 80,
};

function buildPayload(prompt, modelId, thinkingLevel, fileRefs, extra) {
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
  // 17 是旧版自动思考模式；现行网页的标准/延伸开关使用独立的 80。
  inner[SLOT.THINK_MODE] = [[4]];
  inner[SLOT.FLAGS_18] = 0;
  inner[SLOT.FLAGS_27] = 1;
  inner[SLOT.FLAGS_30] = [4];
  inner[SLOT.FLAGS_41] = [2];
  inner[SLOT.FLAGS_53] = 0;
  inner[SLOT.REQUEST_ID] = globalThis.crypto.randomUUID();
  inner[SLOT.FLAGS_61] = [];
  inner[SLOT.FLAGS_68] = 1;
  inner[SLOT.MODE] = modelId;
  if (thinkingLevel >= 1 && thinkingLevel <= 3) inner[SLOT.THINK_LEVEL] = thinkingLevel;
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

async function buildAppPageHeaders(cfg, cookie) {
  const headers = { "User-Agent": _UA, "Accept-Language": "en-US,en;q=0.9" };
  applyAccountHeaders(headers, cfg);
  if (cookie) headers.Cookie = cookie;
  if (cfg.sapisid) headers.Authorization = await makeSapisidHash(cfg.sapisid);
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

async function buildHeaders(cfg, modelHeader) {
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
  if (modelHeader) {
    headers["x-goog-ext-525001261-jspb"] = modelHeader;
    headers["x-goog-ext-73010989-jspb"] = "[0]";
    headers["x-goog-ext-73010990-jspb"] = "[0]";
  }
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
async function httpFetch(url, { method = "GET", headers = {}, body, timeoutMs = 180000, socket = true, redirect } = {}) {
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
  return fetch(url, { method, headers, body, redirect, signal: timeoutSignal(timeoutMs) });
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_APP_REDIRECTS = 6;

function isGoogleRedirectTarget(url) {
  return url.protocol === "https:" && (url.hostname === "google.com" || url.hostname.endsWith(".google.com"));
}

async function fetchAppPage(cfg, headers, timeoutMs = 30000, maxRedirects = MAX_APP_REDIRECTS) {
  const origin = cfg.gemini_origin || "https://gemini.google.com";
  const originUrl = new URL(origin);
  let url = `${origin}${accountPrefix(cfg)}/app`;
  const setCookieValues = [];
  let redirectHost = "";
  let response = null;

  for (let i = 0; i < maxRedirects; i++) {
    response = await httpFetch(url, { headers, timeoutMs, socket: cfg.upstream_socket, redirect: "manual" });
    const rotated = getSetCookieValues(response.headers);
    setCookieValues.push(...rotated);
    if (rotated.length && headers.Cookie) headers.Cookie = mergeRotatedCookies(headers.Cookie, rotated).cookie || headers.Cookie;
    if (!REDIRECT_STATUSES.has(response.status)) {
      return { response, html: await response.text(), setCookieValues, redirect_host: redirectHost };
    }

    const location = response.headers.get("location");
    try { await response.text(); } catch (_) {}
    if (!location) return { response, html: "", setCookieValues, redirect_host: "missing_location" };
    const next = new URL(location, url);
    redirectHost = next.hostname.replace(/[^a-z0-9.-]/gi, "_");
    const abuseCookie = next.searchParams.get("google_abuse");
    if (abuseCookie) {
      setCookieValues.push(abuseCookie);
      headers.Cookie = mergeRotatedCookies(headers.Cookie || "", [abuseCookie]).cookie || headers.Cookie;
      next.searchParams.delete("google_abuse");
    }
    if (next.origin !== originUrl.origin && !isGoogleRedirectTarget(next)) return { response, html: "", setCookieValues, redirect_host: redirectHost };
    if (next.origin !== originUrl.origin) {
      delete headers.Authorization;
      delete headers["X-Same-Domain"];
      delete headers.Origin;
    } else if (cfg.sapisid) {
      headers.Authorization = await makeSapisidHash(cfg.sapisid);
    }
    url = next.href;
  }

  return { response, html: "", setCookieValues, redirect_host: redirectHost || "too_many_redirects" };
}

// ─── 多模态:图片上传(Scotty 续传)───────────────────────────────────────────
// 说明:图片输入需要从面板匯入登录态。匿名会话上传文件能成功,但带图
// 生成会被后端以 BardErrorInfo[1100] 拒绝(权限门)。无 cookie 时不上传,
// 改为在 prompt 里追加一句提示,降级为纯文本。详见 test/live-image.mjs。

const _UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";
const ROTATE_COOKIES_URL = "https://accounts.google.com/RotateCookies";
const ROTATE_COOKIES_BODY = '[000,"-0000000000000000000"]';
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

function extractXsrfToken(raw) {
  const normalized = String(raw || "").replace(/\\"/g, '"');
  const match = /\[\s*"xsrf"\s*,\s*"([^"]+)"/.exec(normalized);
  return match ? match[1] : "";
}

async function probeXsrfToken(cfg, geminiBl) {
  const probeCfg = {
    ...cfg,
    gemini_bl: geminiBl || cfg.gemini_bl,
    xsrf_token: "",
  };
  const response = await httpFetch(getUrl(probeCfg), {
    method: "POST",
    headers: await buildHeaders(probeCfg),
    body: buildPayload("Reply with one word: OK", 1, 1, null, null),
    timeoutMs: 30000,
    socket: cfg.upstream_socket,
  });
  const token = extractXsrfToken(await response.text());
  log(cfg, `XSRF probe status=${response.status} token=${token ? "found" : "missing"}`);
  return token;
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
    const page = await fetchAppPage(cfg, headers);
    const bl = extractGeminiBl(page.html);
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
    log(cfg, "GEMINI_BL auto-detect returned no build (status=" + (page.response && page.response.status) + ")");
  } catch (e) {
    log(cfg, "GEMINI_BL auto-detect failed: " + e);
  }

  if (stale) cfg.gemini_bl = stale;
  return cfg.gemini_bl;
}

async function fetchModelCatalog(cfg, key) {
  const origin = cfg.gemini_origin || "https://gemini.google.com";
  const headers = await buildHeaders(cfg);
  const page = await fetchAppPage(cfg, headers);
  const appResponse = page.response;
  const appHtml = page.html;
  if (!appResponse.ok) throw new Error(`Gemini /app returned ${appResponse.status}`);

  const tokens = extractPageTokens(appHtml);
  const pageToken = tokens.at || cfg.xsrf_token;
  if (cfg.cookie && !pageToken) throw new Error("Gemini no longer accepts the stored Cookie; re-import is required");
  if (tokens.bl) {
    cfg.gemini_bl = tokens.bl;
    _geminiBlMemory = {
      origin,
      value: tokens.bl,
      expiresAt: Date.now() + GEMINI_BL_CACHE_TTL_SEC * 1000,
    };
  }
  if (Object.keys(tokens).length) _pageTokens = { key, tokens, ts: Date.now() };

  const reqid = (nowSec() * 1000 + Math.floor(Math.random() * 1000)) % 10000000;
  const sourcePath = `${accountPrefix(cfg)}/app`;
  const url = origin + accountPrefix(cfg) + "/_/BardChatUi/data/batchexecute" +
    `?rpcids=${MODEL_STATUS_RPC}&source-path=${encodeURIComponent(sourcePath)}` +
    `&bl=${encodeURIComponent(cfg.gemini_bl)}&hl=en&_reqid=${reqid}&rt=c`;
  const body = new URLSearchParams({
    "f.req": JSON.stringify([[[MODEL_STATUS_RPC, "[]", null, "generic"]]]),
  });
  if (pageToken) body.set("at", pageToken);
  const statusResponse = await httpFetch(url, {
    method: "POST",
    headers,
    body: body.toString(),
    timeoutMs: 30000,
    socket: cfg.upstream_socket,
  });
  const raw = await statusResponse.text();
  if (!statusResponse.ok) throw new Error(`GetUserStatus returned ${statusResponse.status}`);
  return buildModelCatalog(extractRpcPayload(raw, MODEL_STATUS_RPC), appHtml);
}

async function getModelCatalog(cfg, force = false) {
  if (!cfg.cookie) return guestModelCatalog();
  const key = await authCacheKey(cfg);
  const now = Date.now();
  let stale = _modelCatalogMemory.key === key ? _modelCatalogMemory.models : null;
  if (!force && stale && _modelCatalogMemory.expiresAt > now) return stale;

  const cache = globalThis.caches && globalThis.caches.default;
  const cacheKey = new Request(`https://gemini2api-cache.invalid/model-catalog?account=${key}`);
  if (cache) {
    try {
      const cached = await cache.match(cacheKey);
      if (cached) {
        const record = JSON.parse(await cached.text());
        if (record.models && Object.keys(record.models).length === 6) {
          stale = record.models;
          _modelCatalogMemory = { key, models: record.models, expiresAt: record.expiresAt || 0 };
          if (!force && _modelCatalogMemory.expiresAt > now) return record.models;
        }
      }
    } catch (_) {}
  }

  try {
    const models = await fetchModelCatalog(cfg, key);
    const expiresAt = Date.now() + MODEL_CATALOG_TTL_SEC * 1000;
    _modelCatalogMemory = { key, models, expiresAt };
    if (cache) {
      try {
        await cache.put(cacheKey, new Response(JSON.stringify({ models, expiresAt }), {
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": `public, max-age=${MODEL_CATALOG_TTL_SEC}`,
          },
        }));
      } catch (e) {
        log(cfg, `model catalog cache write failed: ${e}`);
      }
    }
    return models;
  } catch (e) {
    if (cfg.cookie) {
      const reason = String((e && e.message) || e);
      log(cfg, `model catalog refresh failed; falling back to guest catalog: ${reason}`);
      const guestCfg = switchToGuest({ ...cfg }, reason);
      const models = await getModelCatalog(guestCfg, force);
      switchToGuest(cfg, reason);
      return models;
    }
    if (stale) {
      log(cfg, `model catalog refresh failed; using stale catalog: ${e}`);
      return stale;
    }
    log(cfg, `model catalog refresh failed; using guest auto routing: ${e}`);
    return guestModelCatalog();
  }
}

async function invalidateModelCatalog(...configs) {
  _modelCatalogMemory = { key: "", models: null, expiresAt: 0 };
  const cache = globalThis.caches && globalThis.caches.default;
  if (!cache) return;
  try {
    await Promise.all(configs.map(async (cfg) => {
      const key = await authCacheKey(cfg);
      await cache.delete(new Request(`https://gemini2api-cache.invalid/model-catalog?account=${key}`));
    }));
  } catch (_) {}
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
    const page = await fetchAppPage(cfg, headers);
    Object.assign(tokens, extractPageTokens(page.html));
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
    return { fileRefs: null, droppedNote: `\n\n[Note: ${images.length} image(s) were provided but ignored — image input requires a Cookie imported into the Worker console.]` };
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
  if (modelId === GUEST_MODE) return "auto";
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

async function buildRequestBody(cfg, prompt, modelId, thinkingLevel, fileRefs, extra) {
  let body = buildPayload(prompt, modelId, thinkingLevel, fileRefs || null, extra);
  if (cfg.cookie) {
    const at = cfg.xsrf_token || (await getPageTokens(cfg)).at;
    if (at) body += "&at=" + encodeURIComponent(at);
  }
  return body;
}

/** 非流式生成(带重试)。返回最终的响应文本。 */
async function generateResult(cfg, prompt, modelId, thinkingLevel, extra, fileRefs, modelHeader) {
  let body, url, headers;
  try {
    await refreshGeminiBl(cfg);
    body = await buildRequestBody(cfg, prompt, modelId, thinkingLevel, fileRefs, extra);
    url = getUrl(cfg);
    headers = await buildHeaders(cfg, modelHeader);
  } catch (e) {
    if (cfg.cookie) {
      const reason = String((e && e.message) || e || "authenticated request setup failed");
      log(cfg, `authenticated request setup failed; falling back to guest: ${reason}`);
      return await generateResult(switchToGuest({ ...cfg }, reason), prompt, modelId, thinkingLevel, extra, fileRefs, modelHeader);
    }
    throw e;
  }
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
      if (cfg.cookie && (!resp.ok || (!text && !actualModel))) {
        throw new Error(`authenticated upstream returned ${resp.status} without usable content`);
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
  if (cfg.cookie) {
    const reason = String((lastErr && lastErr.message) || lastErr || "authenticated upstream failed");
    log(cfg, `authenticated generation failed; falling back to guest: ${reason}`);
    return await generateResult(switchToGuest({ ...cfg }, reason), prompt, modelId, thinkingLevel, extra, fileRefs, modelHeader);
  }
  throw lastErr;
}

async function generate(cfg, prompt, modelId, thinkingLevel, extra, fileRefs, modelHeader) {
  return (await generateResult(cfg, prompt, modelId, thinkingLevel, extra, fileRefs, modelHeader)).text;
}

/**
 * 流式生成。每步 yield 一段文本增量(本次新追加的后缀)。
 * 只在尚未 yield 过任何内容时才重试,以避免重复输出。
 */
async function* generateStream(cfg, prompt, modelId, thinkingLevel, extra, fileRefs, onRoute, modelHeader) {
  let body, url, headers;
  try {
    await refreshGeminiBl(cfg);
    body = await buildRequestBody(cfg, prompt, modelId, thinkingLevel, fileRefs, extra);
    url = getUrl(cfg);
    headers = await buildHeaders(cfg, modelHeader);
  } catch (e) {
    if (cfg.cookie) {
      const reason = String((e && e.message) || e || "authenticated stream setup failed");
      log(cfg, `authenticated stream setup failed; falling back to guest: ${reason}`);
      yield* generateStream(switchToGuest({ ...cfg }, reason), prompt, modelId, thinkingLevel, extra, fileRefs, onRoute, modelHeader);
      return;
    }
    throw e;
  }
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
        if (!yielded && cfg.cookie) throw new Error(`authenticated stream returned ${resp.status} without usable content`);
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
      if (!yielded && cfg.cookie) throw new Error(`authenticated stream returned ${resp.status} without usable content`);
      return;
    } catch (e) {
      lastErr = e;
      if (!yielded && attempt < cfg.retry_attempts - 1) {
        log(cfg, `Stream retry ${attempt + 1}/${cfg.retry_attempts}: ${e}`);
        await sleep(cfg.retry_delay_sec * 1000);
        continue;
      }
      if (!yielded && cfg.cookie) {
        const reason = String((e && e.message) || e || "authenticated stream failed");
        log(cfg, `authenticated stream failed; falling back to guest: ${reason}`);
        yield* generateStream(switchToGuest({ ...cfg }, reason), prompt, modelId, thinkingLevel, extra, fileRefs, onRoute, modelHeader);
        return;
      }
      throw e;
    }
  }
  if (lastErr) {
    if (cfg.cookie) {
      const reason = String((lastErr && lastErr.message) || lastErr || "authenticated stream failed");
      log(cfg, `authenticated stream failed; falling back to guest: ${reason}`);
      yield* generateStream(switchToGuest({ ...cfg }, reason), prompt, modelId, thinkingLevel, extra, fileRefs, onRoute, modelHeader);
      return;
    }
    throw lastErr;
  }
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

function headerApiKeyCandidates(request, includeAdmin = false) {
  const h = request.headers;
  const auth = h.get("authorization") || "";
  const bearer = /^Bearer\s+(.+)$/i.exec(auth);
  const candidates = [
    bearer ? bearer[1].trim() : null,
    h.get("x-api-key"),
    h.get("x-goog-api-key"),
    h.get("api-key"),
    h.get("apikey"),
  ];
  if (includeAdmin) candidates.push(h.get("x-admin-key"));
  return candidates.map((key) => typeof key === "string" ? key.trim() : key);
}

// 从多种来源取调用方 key:Bearer / API key headers / ?key=
// (分别兼容 OpenAI 客户端、Anthropic/Gemini 风格与常見代理客戶端)。任一匹配即放行。
function authorized(request, url, cfg) {
  const keys = cfg.api_keys || [];
  if (!keys.length) return true;
  const candidates = [
    ...headerApiKeyCandidates(request),
    url ? url.searchParams.get("key") : null,
  ];
  return candidates.some((k) => k && keys.some((valid) => timingSafeEqual(k, valid)));
}

function adminAuthorized(request, cfg) {
  const keys = cfg.api_keys || [];
  if (!keys.length) return false;
  const candidates = headerApiKeyCandidates(request, true);
  return candidates.some((key) => key && keys.some((valid) => timingSafeEqual(key, valid)));
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
  const models = await getModelCatalog(cfg);
  const rm = resolveModel(req.model || cfg.default_model, cfg.default_model, models);
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
        for await (const delta of generateStream(cfg, prompt, rm.modeId, rm.thinkingLevel, rm.extra, fileRefs, (meta) => { route = meta; }, rm.header)) {
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
    result = await generateResult(cfg, prompt, rm.modeId, rm.thinkingLevel, rm.extra, fileRefs, rm.header);
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
  const models = await getModelCatalog(cfg);
  const rm = resolveModel(req.model || cfg.default_model, cfg.default_model, models);
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
    result = await generateResult(cfg, prompt, rm.modeId, rm.thinkingLevel, rm.extra, fileRefs, rm.header);
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
  const models = await getModelCatalog(cfg);
  const rm = resolveModel(m ? m[1] : cfg.default_model, cfg.default_model, models);
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
        for await (const delta of generateStream(cfg, prompt, rm.modeId, rm.thinkingLevel, rm.extra, fileRefs, (meta) => { route = meta; }, rm.header)) {
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
    result = await generateResult(cfg, prompt, rm.modeId, rm.thinkingLevel, rm.extra, fileRefs, rm.header);
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

async function probeModelRoute(cfg, name, detailed = false, models = null) {
  models = models || await getModelCatalog(cfg);
  const rm = resolveModel(name, cfg.default_model, models);
  const result = await generateResult(cfg, "Reply with one word: PONG", rm.modeId, rm.thinkingLevel, rm.extra, null, rm.header);
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
  const models = await getModelCatalog(cfg);
  await refreshGeminiBl(cfg);
  let pageTokenFound = false;
  if (cfg.cookie) pageTokenFound = !!(await getPageTokens(cfg)).at;
  const pairs = await Promise.all(Object.keys(models).map(async (name) => {
    try {
      return [name, await probeModelRoute(cfg, name, false, models)];
    } catch (e) {
      return [name, { requested_model: name, upstream_model: null, route_status: "unknown", available: false, error: String((e && e.message) || e) }];
    }
  }));
  const routes = Object.fromEntries(pairs);
  const actualModels = [...new Set(Object.values(routes).map((r) => r.upstream_model).filter(Boolean))];
  const proName = modelNameForCategory(models, 3);
  return {
    models,
    routes,
    actual_models: actualModels,
    cookie: cookieRouteSummary(cfg, routes[proName], pageTokenFound),
  };
}

async function handleDebug(cfg) {
  await refreshGeminiBl(cfg);
  let pageTokenFound = false;
  if (cfg.cookie) pageTokenFound = !!(await getPageTokens(cfg)).at;
  const guestCfg = { ...cfg, cookie: "", sapisid: "", auth_user: null, xsrf_token: "" };
  const safeProbe = async (probeCfg) => {
    try {
      const models = await getModelCatalog(probeCfg);
      const name = probeCfg.cookie ? modelNameForCategory(models, 3) : defaultModelName(models);
      return await probeModelRoute(probeCfg, name, true, models);
    } catch (e) {
      return { upstream_model: null, route_status: "unknown", error: String((e && e.message) || e) };
    }
  };

  const [configuredProbe, guestProbe] = await Promise.all([safeProbe(cfg), safeProbe(guestCfg)]);
  return jsonResponse({
    note: "A_configured requests Pro with the configured Cookie and page token; B_guest requests gemini-auto without it. Compare upstream_model and route_status to verify whether Pro was actually granted.",
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

async function safeModelProbe(cfg, name, detailed = false, models = null) {
  try {
    return await probeModelRoute(cfg, name, detailed, models);
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
    const models = await getModelCatalog(cfg);
    const pageTokenFound = !!(cfg.xsrf_token || (await getPageTokens(cfg)).at);
    const proRoute = await safeModelProbe(cfg, modelNameForCategory(models, 3), true, models);
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
    models: inspection ? Object.entries(inspection.models).map(([id, model]) => ({
      id,
      description: model.desc,
      ...inspection.routes[id],
    })) : undefined,
  });
}

async function rotateGoogleCookies(cfg) {
  const headers = {
    "Content-Type": "application/json",
    Origin: "https://accounts.google.com",
    Referer: "https://accounts.google.com/",
    "User-Agent": _UA,
    Cookie: cfg.cookie,
  };
  applyAccountHeaders(headers, cfg);
  return httpFetch(ROTATE_COOKIES_URL, {
    method: "POST",
    headers,
    body: ROTATE_COOKIES_BODY,
    timeoutMs: 15000,
    socket: cfg.upstream_socket,
  });
}

function reauthRequiredResponse(cfg) {
  return privateJsonResponse({
    status: "reauth_required",
    cookie: cookieSummary(cfg),
    changed_cookie_names: [],
    message: "Google 已不接受這份登入態；Worker 無法自行重新登入，請從瀏覽器重新匯入 Cookie。",
  });
}

async function handleCookieRefresh(cfg, env, verifyPage = true) {
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

  let cookie = cfg.cookie;
  const changedCookieNames = [];
  let ignoredCookieCount = 0;
  const rememberRotation = (merged) => {
    cookie = merged.cookie;
    ignoredCookieCount += merged.ignored_cookie_count;
    for (const name of merged.changed_cookie_names) {
      if (!changedCookieNames.includes(name)) changedCookieNames.push(name);
    }
  };
  const recordRefreshFailure = async (reason) => {
    const checkedAt = new Date().toISOString();
    const record = {
      cookie,
      sapisid: cfg.sapisid,
      auth_user: cfg.auth_user,
      xsrf_token: cfg.xsrf_token,
      gemini_bl: cfg.gemini_bl,
      removed_cookie_count: cfg.removed_cookie_count || 0,
      updated_at: cfg.cookie_updated_at || checkedAt,
      refreshed_at: cfg.cookie_refreshed_at || null,
      refresh_checked_at: checkedAt,
      refresh_status: "reauth_required",
      refresh_error: reason,
    };
    await writeStoredAuth(env, record);
    return reauthRequiredResponse(applyStoredAuth(cfg, record));
  };

  try {
    const rotateResponse = await rotateGoogleCookies(cfg);
    if (rotateResponse.status === 401) return await recordRefreshFailure("rotate_401");
    if (!rotateResponse.ok && !verifyPage) throw new Error(`RotateCookies returned ${rotateResponse.status}`);
    if (rotateResponse.ok) rememberRotation(mergeRotatedCookies(cookie, getSetCookieValues(rotateResponse.headers)));
  } catch (e) {
    log(cfg, `RotateCookies failed: ${e}`);
    if (!verifyPage) throw e;
  }

  if (!verifyPage) {
    const now = new Date().toISOString();
    const preserveFailure = cfg.cookie_refresh_status === "reauth_required";
    const record = {
      cookie,
      sapisid: cfg.sapisid,
      auth_user: cfg.auth_user,
      xsrf_token: cfg.xsrf_token,
      gemini_bl: cfg.gemini_bl,
      removed_cookie_count: cfg.removed_cookie_count || 0,
      updated_at: changedCookieNames.length ? now : (cfg.cookie_updated_at || now),
      refreshed_at: preserveFailure ? (cfg.cookie_refreshed_at || null) : now,
      refresh_checked_at: now,
      refresh_status: preserveFailure
        ? "reauth_required"
        : changedCookieNames.length ? "refreshed" : "no_rotation",
      refresh_error: preserveFailure ? cfg.cookie_refresh_error : null,
    };
    await writeStoredAuth(env, record);
    const refreshedCfg = applyStoredAuth(cfg, record);
    return privateJsonResponse({
      status: record.refresh_status,
      cookie: cookieSummary(refreshedCfg),
      changed_cookie_names: changedCookieNames,
      ignored_cookie_count: ignoredCookieCount,
      message: "已完成排程 Cookie 輪替；頁面 token 驗證留給手動刷新。",
    });
  }

  let detectedAuthUser = cfg.auth_user;
  let pageCfg = cfg;
  let page = await fetchAppPage(pageCfg, await buildAppPageHeaders(pageCfg, cookie));
  let response = page.response;
  let tokens = extractPageTokens(page.html);

  if ((!response.ok || !tokens.at) && (cfg.auth_user === null || cfg.auth_user === undefined || cfg.auth_user === "")) {
    for (const authUser of ["0", "1", "2", "3"]) {
      const trialCfg = { ...cfg, auth_user: authUser };
      const trialPage = await fetchAppPage(trialCfg, await buildAppPageHeaders(trialCfg, cookie), 30000, 2);
      const trialTokens = extractPageTokens(trialPage.html);
      page = trialPage;
      response = trialPage.response;
      tokens = trialTokens;
      if (response.ok && tokens.at) {
        pageCfg = trialCfg;
        detectedAuthUser = authUser;
        break;
      }
    }
  }
  const now = new Date().toISOString();

  if (response.ok && !tokens.at) {
    try {
      const at = await probeXsrfToken({ ...pageCfg, cookie }, tokens.bl || pageCfg.gemini_bl);
      if (at) tokens.at = at;
    } catch (e) {
      log(cfg, `XSRF probe failed: ${e}`);
    }
  }

  if (!response.ok || !tokens.at) {
    const redirectSuffix = page.redirect_host ? `_to_${page.redirect_host}` : "";
    return await recordRefreshFailure(!response.ok ? `app_${response.status}${redirectSuffix}` : "missing_page_token");
  }

  rememberRotation(mergeRotatedCookies(cookie, page.setCookieValues));
  const auth = parseAuthPayload({
    cookie,
    sapisid: cfg.sapisid,
    auth_user: detectedAuthUser,
    xsrf_token: tokens.at,
    gemini_bl: tokens.bl || pageCfg.gemini_bl,
  }, true);
  const record = {
    ...auth,
    removed_cookie_count: cfg.removed_cookie_count || 0,
    updated_at: changedCookieNames.length ? now : (cfg.cookie_updated_at || now),
    refreshed_at: now,
    refresh_checked_at: now,
    refresh_status: changedCookieNames.length ? "refreshed" : "no_rotation",
    refresh_error: null,
  };
  await writeStoredAuth(env, record);

  const refreshedCfg = applyStoredAuth(cfg, record);
  await invalidateModelCatalog(cfg, refreshedCfg);
  _pageTokens = {
    key: await authCacheKey(refreshedCfg),
    tokens,
    ts: Date.now(),
  };
  const rotated = changedCookieNames.length > 0;
  return privateJsonResponse({
    status: rotated ? "refreshed" : "no_rotation",
    cookie: cookieSummary(refreshedCfg),
    changed_cookie_names: changedCookieNames,
    ignored_cookie_count: ignoredCookieCount,
    message: rotated
      ? `已保存 Google 輪替的 ${changedCookieNames.length} 個 Cookie。`
      : "登入態有效；已更新頁面 token，Google 本次沒有輪替 Cookie。",
  });
}

async function handleCookieImport(request, cfg, env) {
  if (!cookieStoreStub(env)) {
    return privateJsonResponse({
      error: { message: "COOKIE_STORE 尚未綁定；請使用仓库的 wrangler.toml 部署后再匯入。" },
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
    await invalidateModelCatalog(importedCfg);
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
    await invalidateModelCatalog(cfg);
    const anonymous = getConfig(env);
    return privateJsonResponse({
      status: "deleted",
      cookie: cookieSummary(anonymous),
      message: "已移除 Durable Object 中的 Cookie；Worker 目前為未登入狀態。",
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
  }).replace(/</g, "\\u003c");

  const html = `<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark">
  <title>GeminiWeb2API · Console</title>
  <link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Cdefs%3E%3ClinearGradient id='g' x1='0' y1='0' x2='1' y2='1'%3E%3Cstop offset='0' stop-color='%23fbad41'/%3E%3Cstop offset='1' stop-color='%23f6821f'/%3E%3C/linearGradient%3E%3C/defs%3E%3Cpath d='M16 2 L19.5 12.5 L30 16 L19.5 19.5 L16 30 L12.5 19.5 L2 16 L12.5 12.5 Z' fill='url(%23g)'/%3E%3C/svg%3E">
  <style nonce="${nonce}">
    :root {
      --bg: #0a0e15;
      --panel: #111927;
      --panel-2: #0d1420;
      --line: #1e2c40;
      --line-hi: #31456293;
      --ink: #e7eef8;
      --muted: #8598b3;
      --faint: #71829c;
      --accent: #62b6ff;
      --accent-2: #9a8cff;
      --ok: #3ed598;
      --warn: #f6b95c;
      --err: #ff7373;
      --mono: ui-monospace, SFMono-Regular, "Cascadia Code", Menlo, Consolas, monospace;
      --radius: 14px;
    }
    * { box-sizing: border-box; }
    html, body { margin: 0; }
    body {
      min-width: 340px; min-height: 100vh; color: var(--ink);
      font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", "Noto Sans TC", sans-serif;
      background:
        radial-gradient(1100px 500px at 15% -10%, rgba(98, 182, 255, .10), transparent 60%),
        radial-gradient(900px 500px at 90% -20%, rgba(154, 140, 255, .09), transparent 55%),
        var(--bg);
    }
    button, input, textarea, select { font: inherit; color: inherit; }
    button { cursor: pointer; }
    ::selection { background: rgba(98, 182, 255, .3); }

    .top {
      position: sticky; top: 0; z-index: 10;
      display: flex; align-items: center; gap: 18px; flex-wrap: wrap;
      padding: 12px 22px; border-bottom: 1px solid var(--line);
      background: rgba(10, 14, 21, .82); backdrop-filter: blur(12px);
    }
    .brand { display: flex; align-items: center; gap: 11px; }
    .brand .logo { width: 30px; height: 30px; flex: none; }
    .brand strong { font-size: 1rem; letter-spacing: .01em; }
    .brand a { color: inherit; text-decoration: none; }
    .brand a:hover { color: var(--accent); }
    .brand .author { display: inline-flex; align-items: center; gap: 5px; color: var(--muted); font-size: .82rem; }
    .brand .gh { width: 15px; height: 15px; flex: none; }
    .brand .ver {
      font: .75rem var(--mono); color: var(--accent);
      border: 1px solid rgba(98, 182, 255, .35); border-radius: 99px; padding: 1.5px 8px;
      background: rgba(98, 182, 255, .08);
    }
    .tabs { display: flex; gap: 4px; margin-inline: auto; padding: 4px; border: 1px solid var(--line); border-radius: 12px; background: var(--panel-2); }
    .tab {
      border: 0; background: transparent; color: var(--muted);
      padding: 7px 16px; border-radius: 9px; font-weight: 600; font-size: .9rem;
      transition: color .15s, background .15s;
    }
    .tab:hover { color: var(--ink); }
    .tab.active { color: var(--ink); background: linear-gradient(180deg, #1d2b41, #17233595); box-shadow: inset 0 0 0 1px var(--line-hi); }
    .keybox { display: flex; align-items: center; gap: 8px; }
    .keybox input {
      width: clamp(140px, 22vw, 230px); min-height: 36px; padding: 0 12px;
      border: 1px solid var(--line); border-radius: 10px; background: var(--panel-2);
      font-family: var(--mono); font-size: .9rem;
    }
    .keybox input:focus, textarea:focus, select:focus, .prompt input:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px rgba(98, 182, 255, .15); }
    .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--faint); flex: none; box-shadow: 0 0 0 3px rgba(91, 108, 133, .15); }
    .dot.ok   { background: var(--ok);   box-shadow: 0 0 0 3px rgba(62, 213, 152, .16); }
    .dot.warn { background: var(--warn); box-shadow: 0 0 0 3px rgba(246, 185, 92, .16); }
    .dot.err  { background: var(--err);  box-shadow: 0 0 0 3px rgba(255, 115, 115, .16); }

    .btn {
      display: inline-flex; align-items: center; gap: 7px; min-height: 36px; padding: 0 15px;
      border: 1px solid var(--line-hi); border-radius: 10px; background: #16233795;
      color: var(--ink); font-weight: 600; font-size: .9rem;
      transition: filter .15s, transform .05s, border-color .15s;
    }
    .btn:hover { filter: brightness(1.18); border-color: #3f587c; }
    .btn:active { transform: translateY(1px); }
    .btn:disabled { opacity: .5; cursor: progress; filter: none; }
    .btn:focus-visible, .tab:focus-visible, .switch:focus-visible, .model-list button:focus-visible,
    .value-btn:focus-visible, .howto summary:focus-visible {
      outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 6px;
    }
    .sr-only { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
    .btn.primary {
      border: 0; color: #06121f;
      background: linear-gradient(135deg, var(--accent), var(--accent-2));
    }
    .btn.danger { color: var(--err); border-color: rgba(255, 115, 115, .4); background: rgba(255, 115, 115, .07); }
    .btn.danger.armed { color: #14060a; border-color: var(--err); background: var(--err); }
    .btn.sm { min-height: 30px; padding: 0 11px; font-size: .85rem; border-radius: 8px; }

    main { width: min(1160px, calc(100% - 36px)); margin: 26px auto 60px; }
    .panel { display: none; }
    .panel.active { display: block; animation: rise .22s ease; }
    @keyframes rise { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
    .panel-head { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; margin: 4px 2px 18px; }
    .panel-head h1 { margin: 0; font-size: 1.25rem; letter-spacing: .01em; }
    .panel-head p { margin: 0; color: var(--muted); font-size: .9rem; }
    .panel-tools { margin-left: auto; display: flex; align-items: center; gap: 12px; }
    .stamp { color: var(--faint); font-size: .75rem; font-family: var(--mono); }

    .stat-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 14px; }
    .card {
      border: 1px solid var(--line); border-radius: var(--radius);
      background: linear-gradient(180deg, var(--panel), var(--panel-2));
      padding: 16px 18px;
    }
    .stat header { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
    .stat header span { color: var(--muted); font-size: .75rem; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; }
    .stat .value { margin-top: 9px; font-size: 1.18rem; font-weight: 700; letter-spacing: -.01em; overflow-wrap: anywhere; }
    .stat .value.mono { font-family: var(--mono); font-size: .95rem; font-weight: 600; }
    .value-btn { display: block; width: 100%; border: 0; background: none; padding: 0; text-align: left; color: inherit; cursor: pointer; overflow-wrap: anywhere; }
    .value-btn:hover { color: var(--accent); }
    .stat .sub { margin-top: 5px; color: var(--muted); font-size: .85rem; overflow-wrap: anywhere; }

    .card-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 12px; }
    .card-head h2 { margin: 0; font-size: 1rem; }
    .chip { font: .75rem var(--mono); color: var(--muted); border: 1px solid var(--line); border-radius: 99px; padding: 2px 9px; background: var(--panel-2); }
    .card-head .btn { margin-left: auto; }

    .model-list { list-style: none; margin: 0; padding: 0; max-height: 340px; overflow: auto; border-top: 1px solid var(--line); }
    .model-list li { display: flex; align-items: baseline; gap: 12px; padding: 9px 4px; border-bottom: 1px solid var(--line); }
    .model-list code { font: 600 .9rem var(--mono); color: var(--accent); flex: none; }
    .model-list span { color: var(--muted); font-size: .85rem; flex: 1; min-width: 120px; overflow-wrap: anywhere; }
    .model-list button { border: 0; background: none; color: var(--faint); font-size: .85rem; padding: 2px 6px; border-radius: 6px; }
    .model-list button:hover { color: var(--ink); background: var(--line); }
    .empty { color: var(--faint); font-size: .9rem; padding: 14px 4px; }

    .baseline { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-top: 14px; color: var(--muted); font-size: .85rem; }
    .baseline code { font: .85rem var(--mono); color: var(--ink); background: var(--panel-2); border: 1px solid var(--line); border-radius: 8px; padding: 3px 10px; }
    .mt { margin-top: 16px; }
    .push-right { margin-left: auto; }

    .grid-2 { display: grid; grid-template-columns: minmax(0, 1.08fr) minmax(0, .92fr); gap: 16px; align-items: start; }
    @media (max-width: 880px) { .grid-2 { grid-template-columns: 1fr; } }
    textarea {
      width: 100%; border: 1px solid var(--line); border-radius: 11px; background: var(--panel-2);
      padding: 11px 13px; resize: vertical; font-family: var(--mono); font-size: .9rem; line-height: 1.5;
    }
    .hint { color: var(--faint); font-size: .85rem; margin: 9px 2px 13px; }
    .hint code { font-family: var(--mono); color: var(--muted); }
    .actions { display: flex; gap: 9px; flex-wrap: wrap; align-items: center; }
    .actions .danger { margin-left: auto; }
    .howto { margin: 0 0 13px; border: 1px solid var(--line); border-radius: 10px; background: var(--panel-2); font-size: .85rem; }
    .howto summary { padding: 9px 13px; cursor: pointer; color: var(--accent); font-weight: 600; list-style-position: inside; }
    .howto ol { margin: 0; padding: 0 16px 12px 36px; color: var(--muted); display: grid; gap: 6px; }
    .howto code { font-family: var(--mono); color: var(--ink); }
    .note { margin-top: 12px; font-size: .85rem; color: var(--muted); min-height: 1.2em; overflow-wrap: anywhere; }
    .note.bad { color: var(--err); }
    .note.good { color: var(--ok); }

    .kv { display: grid; grid-template-columns: max-content 1fr; gap: 7px 16px; margin: 0; font-size: .9rem; }
    .kv dt { color: var(--muted); }
    .kv dd { margin: 0; font-family: var(--mono); font-size: .85rem; overflow-wrap: anywhere; }
    .kv dd.good { color: var(--ok); }
    .kv dd.bad { color: var(--err); }
    .issues { margin: 12px 0 0; padding: 10px 12px; border: 1px solid rgba(246, 185, 92, .35); border-radius: 10px; background: rgba(246, 185, 92, .07); color: var(--warn); font-size: .85rem; }
    .issues ul { margin: 4px 0 0; padding-left: 18px; }

    .play-bar { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 13px; }
    .play-bar label { color: var(--muted); font-size: .85rem; display: inline-flex; align-items: center; gap: 7px; }
    select {
      min-height: 36px; padding: 0 10px; border: 1px solid var(--line); border-radius: 10px;
      background: var(--panel-2); font-family: var(--mono); font-size: .9rem; max-width: 300px;
    }
    .switch { position: relative; width: 36px; height: 20px; appearance: none; border-radius: 99px; background: var(--line); transition: background .15s; cursor: pointer; flex: none; }
    .switch::after { content: ""; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: var(--muted); transition: transform .15s, background .15s; }
    .switch:checked { background: rgba(98, 182, 255, .45); }
    .switch:checked::after { transform: translateX(16px); background: var(--accent); }
    .prompt { display: grid; gap: 10px; }
    .prompt input {
      width: 100%; min-height: 38px; padding: 0 13px; border: 1px solid var(--line);
      border-radius: 11px; background: var(--panel-2); font-family: var(--mono); font-size: .9rem;
    }
    .output {
      margin-top: 16px; border: 1px solid var(--line); border-radius: var(--radius);
      background: var(--panel-2); min-height: 190px; padding: 15px 17px;
      white-space: pre-wrap; overflow-wrap: anywhere; font-size: .95rem; line-height: 1.65;
    }
    .output.idle { color: var(--faint); }
    .out-meta { margin-top: 9px; color: var(--faint); font: .85rem var(--mono); min-height: 1.2em; }

    #toast {
      position: fixed; left: 50%; bottom: 26px; transform: translate(-50%, 20px);
      padding: 10px 18px; border-radius: 11px; border: 1px solid var(--line-hi);
      background: #172335; color: var(--ink); font-size: .9rem;
      opacity: 0; pointer-events: none; transition: opacity .2s, transform .2s; max-width: 84vw; z-index: 30;
    }
    #toast.show { opacity: 1; transform: translate(-50%, 0); }
    #toast.bad { border-color: rgba(255, 115, 115, .5); color: #ffc2c2; }
    @media (max-width: 760px) {
      .tabs { order: 3; width: 100%; margin: 2px 0 0; }
      .keybox { margin-left: auto; }
    }
  </style>
</head>
<body>
  <header class="top">
    <div class="brand">
      <svg class="logo" viewBox="0 0 32 32" aria-hidden="true">
        <defs><linearGradient id="spark" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#fbad41"/><stop offset="1" stop-color="#f6821f"/>
        </linearGradient></defs>
        <path d="M16 2 L19.5 12.5 L30 16 L19.5 19.5 L16 30 L12.5 19.5 L2 16 L12.5 12.5 Z" fill="url(#spark)"/>
      </svg>
      <a href="https://github.com/banana2556/gemini2api-cfworker" target="_blank" rel="noopener noreferrer"><strong>GeminiWeb2API</strong></a>
      <a class="author" href="https://github.com/banana2556" target="_blank" rel="noopener noreferrer"><svg class="gh" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 .2a8 8 0 0 0-2.5 15.6c.4.1.5-.2.5-.4v-1.4c-2.1.5-2.6-.9-2.6-.9-.3-.8-.8-1-.8-1-.7-.5.1-.5.1-.5.8.1 1.2.8 1.2.8.7 1.2 1.9.9 2.3.7.1-.5.3-.9.5-1.1-1.7-.2-3.5-.9-3.5-3.9 0-.9.3-1.6.8-2.1-.1-.2-.4-1 .1-2.1 0 0 .7-.2 2.2.8a7.4 7.4 0 0 1 4 0c1.5-1 2.2-.8 2.2-.8.4 1.1.2 1.9.1 2.1.5.6.8 1.3.8 2.1 0 3-1.8 3.6-3.5 3.8.3.2.5.7.5 1.4v2.1c0 .2.1.5.5.4A8 8 0 0 0 8 .2Z"/></svg>@banana2556</a>
      <span class="ver" id="ver-chip">v—</span>
    </div>
    <nav class="tabs" role="tablist" aria-label="主要區域">
      <button class="tab active" data-tab="info" role="tab" aria-selected="true" aria-controls="panel-info">資訊面板</button>
      <button class="tab" data-tab="import" role="tab" aria-selected="false" aria-controls="panel-import" tabindex="-1">匯入面板</button>
      <button class="tab" data-tab="play" role="tab" aria-selected="false" aria-controls="panel-play" tabindex="-1">Playground</button>
    </nav>
    <div class="keybox">
      <span class="dot" id="conn-dot" title="連線狀態" aria-hidden="true"></span>
      <span class="sr-only" id="conn-text" role="status">尚未連線</span>
      <input id="api-key" type="password" placeholder="API Key" autocomplete="off" aria-label="API Key">
      <button class="btn primary" id="connect">連線</button>
    </div>
  </header>

  <main>
    <section class="panel active" id="panel-info" role="tabpanel">
      <div class="panel-head">
        <h1>資訊面板</h1>
        <p>Worker、排程與 Cookie 的即時狀態總覽。</p>
        <div class="panel-tools">
          <span class="stamp" id="info-stamp"></span>
          <button class="btn sm" id="refresh-info">重新整理</button>
        </div>
      </div>

      <div class="stat-grid">
        <article class="card stat" id="stat-worker">
          <header><span>Worker 狀態</span><i class="dot"></i></header>
          <div class="value">—</div><div class="sub">正在偵測…</div>
        </article>
        <article class="card stat" id="stat-cron">
          <header><span>Cron 運行狀態</span><i class="dot"></i></header>
          <div class="value">—</div><div class="sub">—</div>
        </article>
        <article class="card stat" id="stat-do">
          <header><span>Durable Object</span><i class="dot"></i></header>
          <div class="value">—</div><div class="sub">—</div>
        </article>
        <article class="card stat" id="stat-cookie">
          <header><span>Cookie 狀態</span><i class="dot"></i></header>
          <div class="value">—</div><div class="sub">—</div>
        </article>
        <article class="card stat" id="stat-build">
          <header><span>Gemini Build</span><i class="dot"></i></header>
          <button type="button" class="value mono value-btn" id="build-value" title="點擊複製" aria-label="複製 Gemini Build 字串">—</button><div class="sub">—</div>
        </article>
        <article class="card stat" id="stat-version">
          <header><span>版本</span><i class="dot"></i></header>
          <div class="value mono">—</div><div class="sub">gemini2api-cfworker</div>
        </article>
      </div>

      <div class="card mt">
        <div class="card-head">
          <h2>模型列表</h2>
          <span class="chip" id="model-count">0 個</span>
          <button class="btn sm" id="refresh-models">重新整理目錄</button>
        </div>
        <ul class="model-list" id="model-list"><li class="empty">尚未載入模型。</li></ul>
        <div class="baseline">
          API Base URL <code id="base-url">—</code>
          <button class="btn sm" id="copy-base">複製</button>
        </div>
      </div>
    </section>

    <section class="panel" id="panel-import" role="tabpanel">
      <div class="panel-head">
        <h1>匯入面板</h1>
        <p>將 Gemini 網頁版 Cookie 匯入 Durable Object 持久保存。</p>
      </div>
      <div class="grid-2">
        <div class="card">
          <div class="card-head"><h2>匯入 Cookie</h2></div>
          <details class="howto">
            <summary>如何取得 Cookie？</summary>
            <ol>
              <li>用桌面瀏覽器登入 <code>gemini.google.com</code>。</li>
              <li>按 F12 開啟開發人員工具 → Network（網路）→ 重新整理頁面後點選任一個 gemini.google.com 的請求。</li>
              <li>在 Request Headers 找到 <code>cookie:</code>，複製整行的值貼到下方；內容需包含 <code>SAPISID</code> 與 <code>__Secure-1PSID</code>。</li>
            </ol>
          </details>
          <textarea id="import-input" rows="9" spellcheck="false" aria-label="Cookie 內容" placeholder="貼上完整 Cookie 字串或 Cookie Sync JSON…"></textarea>
          <p class="hint">支援：原始 Cookie 字串、Cookie Sync JSON、或 <code>{"auth": …}</code> 包裝；需含 <code>SAPISID</code> 與 <code>__Secure-1PSID</code>（原文只存入 DO，不會回傳）。</p>
          <div class="actions">
            <button class="btn primary" id="do-import">匯入並驗證</button>
            <button class="btn" id="do-refresh">手動重新整理</button>
            <button class="btn danger" id="do-delete">清除 Cookie</button>
          </div>
          <p class="note" id="import-note"></p>
        </div>
        <div class="card">
          <div class="card-head">
            <h2>Cookie 資訊</h2>
            <button class="btn sm" id="reload-cookie">重新讀取</button>
          </div>
          <dl class="kv" id="cookie-kv"><dt>狀態</dt><dd>尚未載入（需要 API Key）</dd></dl>
          <div class="issues" id="cookie-issues" hidden></div>
        </div>
      </div>
    </section>

    <section class="panel" id="panel-play" role="tabpanel">
      <div class="panel-head">
        <h1>Playground</h1>
        <p>直接對 <code>/v1/chat/completions</code> 發送測試請求。</p>
      </div>
      <div class="card">
        <div class="play-bar">
          <label>模型
            <select id="play-model"><option value="">（尚未載入）</option></select>
          </label>
          <label><input type="checkbox" class="switch" id="play-stream" checked>串流輸出</label>
          <button class="btn primary push-right" id="play-send">送出（Ctrl+Enter）</button>
        </div>
        <div class="prompt">
          <input id="play-system" aria-label="System prompt（選填）" placeholder="System prompt（選填）" spellcheck="false">
          <textarea id="play-input" rows="5" spellcheck="false" aria-label="訊息內容" placeholder="輸入訊息…"></textarea>
        </div>
        <div class="output idle" id="play-output" aria-live="polite">回應會顯示在這裡。</div>
        <div class="out-meta" id="play-meta"></div>
      </div>
    </section>
  </main>

  <div id="toast" role="status"></div>

  <script nonce="${nonce}">
    "use strict";
    var BOOT = ${boot};
    var KEY_STORE = "gemini-worker-api-key";
    var state = { key: "", models: [] };
    try { state.key = sessionStorage.getItem(KEY_STORE) || ""; } catch (_) {}

    function $(id) { return document.getElementById(id); }
    function headersFor(json) {
      var h = {};
      if (json) h["Content-Type"] = "application/json";
      if (state.key) { h["x-api-key"] = state.key; h["Authorization"] = "Bearer " + state.key; }
      return h;
    }
    async function api(path, opts) {
      var res = await fetch(path, opts || { headers: headersFor(false) });
      var data = null;
      try { data = await res.json(); } catch (_) {}
      if (!res.ok) {
        var msg = (data && data.error && (data.error.message || data.error.code)) || ("HTTP " + res.status);
        var err = new Error(msg); err.status = res.status; throw err;
      }
      return data;
    }

    var toastTimer = null;
    function toast(msg, bad) {
      var t = $("toast");
      t.textContent = msg;
      t.className = bad ? "show bad" : "show";
      clearTimeout(toastTimer);
      toastTimer = setTimeout(function () { t.className = ""; }, 3200);
    }
    function busy(btn, on) {
      if (!btn.dataset.label) btn.dataset.label = btn.textContent;
      btn.disabled = on;
      btn.textContent = on ? "處理中…" : btn.dataset.label;
    }
    async function copyText(value, label) {
      try { await navigator.clipboard.writeText(value); toast(label + " 已複製"); }
      catch (_) { toast("無法存取剪貼簿，請手動複製", true); }
    }
    function fmtTime(iso) {
      if (!iso) return "—";
      var d = new Date(iso);
      return isNaN(d) ? String(iso) : d.toLocaleString();
    }
    function fmtAgo(iso) {
      if (!iso) return null;
      var ms = Date.now() - new Date(iso).getTime();
      if (isNaN(ms)) return null;
      if (ms < 0) ms = 0;
      var m = Math.floor(ms / 60000);
      if (m < 1) return "剛剛";
      if (m < 60) return m + " 分鐘前";
      var h = Math.floor(m / 60);
      if (h < 24) return h + " 小時前";
      return Math.floor(h / 24) + " 天前";
    }
    function setStat(id, tone, value, sub) {
      var card = $(id);
      card.querySelector(".dot").className = "dot" + (tone ? " " + tone : "");
      var v = card.querySelector(".value");
      if (!v.id) v.textContent = value;
      var s = card.querySelector(".sub");
      if (sub !== undefined) s.textContent = sub;
      return v;
    }

    // ── 分頁切換（含 ARIA tab 鍵盤模式）──
    var tabs = Array.prototype.slice.call(document.querySelectorAll(".tab"));
    function activateTab(tab, focus) {
      tabs.forEach(function (t) {
        var on = t === tab;
        t.classList.toggle("active", on);
        t.setAttribute("aria-selected", on ? "true" : "false");
        t.tabIndex = on ? 0 : -1;
      });
      document.querySelectorAll(".panel").forEach(function (p) {
        p.classList.toggle("active", p.id === "panel-" + tab.dataset.tab);
      });
      if (focus) tab.focus();
    }
    tabs.forEach(function (tab, i) {
      tab.addEventListener("click", function () { activateTab(tab, false); });
      tab.addEventListener("keydown", function (e) {
        var next = null;
        if (e.key === "ArrowRight") next = tabs[(i + 1) % tabs.length];
        else if (e.key === "ArrowLeft") next = tabs[(i - 1 + tabs.length) % tabs.length];
        else if (e.key === "Home") next = tabs[0];
        else if (e.key === "End") next = tabs[tabs.length - 1];
        if (next) { e.preventDefault(); activateTab(next, true); }
      });
    });

    // ── 資訊面板 ──
    async function loadHealth() {
      try {
        var h = await api("/health");
        setStat("stat-worker", "ok", "運作中", "健康檢查 /health 正常");
        setStat("stat-version", "ok", h.version || BOOT.version, "gemini2api-cfworker");
        $("ver-chip").textContent = "v" + (h.version || BOOT.version || "?");
        var bl = h.gemini_bl || "";
        var bv = $("build-value");
        bv.textContent = bl || "未知";
        bv.dataset.full = bl;
        setStat("stat-build", bl ? "ok" : "warn", "", bl ? "動態上游 build（點擊值可複製）" : "尚未取得上游 build");
        $("conn-dot").className = "dot ok";
        $("conn-text").textContent = state.key ? "已連線" : "服務正常，尚未輸入 API Key";
        return true;
      } catch (e) {
        setStat("stat-worker", "err", "離線", "健康檢查失敗：" + e.message);
        setStat("stat-build", "err", "", "無法取得");
        $("build-value").textContent = "—";
        $("conn-dot").className = "dot err";
        $("conn-text").textContent = "連線失敗：" + e.message;
        return false;
      }
    }

    function renderCookieKv(cookie) {
      var kv = $("cookie-kv");
      kv.textContent = "";
      if (!cookie) {
        var dt = document.createElement("dt"); dt.textContent = "狀態";
        var dd = document.createElement("dd"); dd.textContent = "尚未載入（需要 API Key）";
        kv.append(dt, dd);
        $("cookie-issues").hidden = true;
        return;
      }
      var yn = function (v) { return v ? "是" : "否"; };
      var rows = [
        ["已設定", yn(cookie.configured), cookie.configured ? "good" : "bad"],
        ["結構檢查", yn(cookie.structurally_valid), cookie.structurally_valid ? "good" : "bad"],
        ["儲存來源", cookie.source || "—"],
        ["匯入時間", fmtTime(cookie.updated_at)],
        ["最後檢查", fmtTime(cookie.refresh_checked_at)],
        ["最近成功", fmtTime(cookie.refreshed_at)],
        ["刷新狀態", cookie.refresh_status || "—", cookie.refresh_status === "reauth_required" ? "bad" : ""],
        ["刷新錯誤", cookie.refresh_error || "—", cookie.refresh_error ? "bad" : ""],
        ["Cookie 數量", (cookie.cookie_count != null ? cookie.cookie_count : "—") + (cookie.removed_cookie_count ? "（已過濾 " + cookie.removed_cookie_count + "）" : "")],
        ["大小", cookie.byte_length != null ? cookie.byte_length + " bytes" : "—"],
        ["SAPISID", yn(cookie.sapisid_present), cookie.sapisid_present ? "good" : "bad"],
        ["Session Cookie", cookie.session_cookie || "—"],
        ["XSRF Token", yn(cookie.xsrf_token_present)],
        ["Auth User", cookie.auth_user != null && cookie.auth_user !== "" ? String(cookie.auth_user) : "—"],
      ];
      rows.forEach(function (row) {
        var dt = document.createElement("dt"); dt.textContent = row[0];
        var dd = document.createElement("dd"); dd.textContent = row[1];
        if (row[2]) dd.className = row[2];
        kv.append(dt, dd);
      });
      var box = $("cookie-issues");
      var issues = cookie.issues || [];
      if (issues.length) {
        box.textContent = "";
        var head = document.createElement("strong"); head.textContent = "偵測到問題";
        var ul = document.createElement("ul");
        issues.forEach(function (msg) {
          var li = document.createElement("li"); li.textContent = String(msg); ul.append(li);
        });
        box.append(head, ul);
        box.hidden = false;
      } else {
        box.hidden = true;
      }
    }

    function applyAdmin(data) {
      var cookie = data.cookie || {};
      setStat("stat-do", data.storage_available ? "ok" : "err",
        data.storage_available ? "運作中" : "無法使用",
        "CookieStore（SQLite DO）· 來源：" + (cookie.source || "無"));

      if (!cookie.configured) {
        setStat("stat-cookie", "warn", "未設定", "尚未匯入 Cookie，僅能使用訪客路由");
        setStat("stat-cron", "idle", "待命", "每 10 分鐘排程運行，目前沒有可重新整理的 Cookie");
      } else {
        var healthy = cookie.structurally_valid && cookie.sapisid_present;
        setStat("stat-cookie", healthy ? "ok" : "warn",
          healthy ? "有效" : "異常",
          (cookie.session_cookie || "無 session") + " · " + (cookie.cookie_count || 0) + " 條" +
          ((cookie.issues || []).length ? " · " + cookie.issues.length + " 項問題" : ""));
        var checkedAgo = fmtAgo(cookie.refresh_checked_at);
        if (!cookie.refresh_checked_at) {
          setStat("stat-cron", "warn", "尚未檢查", "每 10 分鐘排程 · 還沒有檢查紀錄");
        } else if (cookie.refresh_status === "reauth_required") {
          setStat("stat-cron", "err", "需要重匯入",
            "每 10 分鐘排程 · 最後檢查：" + checkedAgo + " · Google 已不接受這份 Cookie");
        } else {
          var overdue = Date.now() - new Date(cookie.refresh_checked_at).getTime() > 30 * 60000;
          setStat("stat-cron", overdue ? "warn" : "ok", overdue ? "已逾期" : "正常",
            "每 10 分鐘排程 · 最後檢查：" + checkedAgo +
            (overdue ? "；請按「手動重新整理」或檢查 Cookie 是否失效" : ""));
        }
      }
      renderCookieKv(data.cookie || null);
    }

    async function loadAdmin() {
      if (!state.key) {
        setStat("stat-cron", "idle", "需要 API Key", "輸入管理金鑰後可查看排程狀態");
        setStat("stat-do", "idle", "需要 API Key", "輸入管理金鑰後可查看儲存狀態");
        setStat("stat-cookie", "idle", "需要 API Key", "輸入管理金鑰後可查看 Cookie 狀態");
        renderCookieKv(null);
        return;
      }
      try {
        applyAdmin(await api("/admin/status"));
      } catch (e) {
        var msg = e.status === 401 ? "API 金鑰無效" : e.message;
        setStat("stat-cron", "err", "讀取失敗", msg);
        setStat("stat-do", "err", "讀取失敗", msg);
        setStat("stat-cookie", "err", "讀取失敗", msg);
        throw e;
      }
    }

    function renderModels(models) {
      state.models = models || [];
      $("model-count").textContent = state.models.length + " 個";
      var list = $("model-list");
      list.textContent = "";
      if (!state.models.length) {
        var li = document.createElement("li");
        li.className = "empty";
        li.textContent = state.key ? "目前沒有可用模型。" : "輸入 API Key 並連線後載入模型。";
        list.append(li);
      } else {
        state.models.forEach(function (m) {
          var li = document.createElement("li");
          var code = document.createElement("code"); code.textContent = m.id;
          var desc = document.createElement("span"); desc.textContent = m.description || "";
          var btn = document.createElement("button"); btn.type = "button"; btn.textContent = "複製";
          btn.addEventListener("click", function () { copyText(m.id, "模型 ID"); });
          li.append(code, desc, btn);
          list.append(li);
        });
      }
      var sel = $("play-model");
      var prev = sel.value || BOOT.defaultModel || "";
      sel.textContent = "";
      if (!state.models.length) {
        var opt = document.createElement("option");
        opt.value = ""; opt.textContent = "（尚未載入）";
        sel.append(opt);
      } else {
        state.models.forEach(function (m) {
          var opt = document.createElement("option");
          opt.value = m.id; opt.textContent = m.id;
          sel.append(opt);
        });
        if (prev && state.models.some(function (m) { return m.id === prev; })) sel.value = prev;
      }
    }

    async function loadModels(force) {
      var data = await api("/v1/models" + (force ? "?refresh=1" : ""));
      renderModels((data && data.data) || []);
    }

    async function refreshAll(quiet) {
      var jobs = [loadHealth()];
      jobs.push(loadAdmin().catch(function (e) { if (!quiet) toast(e.message, true); }));
      jobs.push(loadModels(false).catch(function (e) {
        if (!quiet && state.key) toast("模型載入失敗：" + e.message, true);
      }));
      await Promise.all(jobs);
      $("info-stamp").textContent = "更新於 " + new Date().toLocaleTimeString();
    }

    // ── 匯入面板 ──
    function importNote(msg, bad) {
      var note = $("import-note");
      note.textContent = msg || "";
      note.className = "note" + (msg ? (bad ? " bad" : " good") : "");
    }
    async function importAction(btn, run) {
      if (!state.key) { toast("請先輸入 API Key 並連線", true); return; }
      busy(btn, true);
      try {
        var data = await run();
        if (data && data.cookie) renderCookieKv(data.cookie);
        importNote((data && data.message) || "完成（" + ((data && data.status) || "ok") + "）", false);
        await Promise.all([
          loadAdmin().catch(function () {}),
          loadModels(true).catch(function () {}),
        ]);
      } catch (e) {
        importNote(e.message, true);
        toast(e.message, true);
      } finally { busy(btn, false); }
    }

    $("do-import").addEventListener("click", function () {
      var raw = $("import-input").value.trim();
      if (!raw) { importNote("請先貼上 Cookie 內容。", true); return; }
      importAction(this, function () {
        return api("/admin/cookie", {
          method: "PUT",
          headers: headersFor(true),
          body: JSON.stringify({ auth: raw }),
        });
      });
    });
    $("do-refresh").addEventListener("click", function () {
      importAction(this, function () {
        return api("/admin/cookie/refresh", { method: "POST", headers: headersFor(false) });
      });
    });
    var deleteArmTimer = null;
    function disarmDelete() {
      var btn = $("do-delete");
      clearTimeout(deleteArmTimer);
      btn.classList.remove("armed");
      btn.textContent = "清除 Cookie";
    }
    $("do-delete").addEventListener("click", function () {
      var btn = this;
      if (!state.key) { toast("請先輸入 API Key 並連線", true); return; }
      if (!btn.classList.contains("armed")) {
        btn.classList.add("armed");
        btn.textContent = "再按一次確認清除";
        importNote("清除後 Worker 將回到未登入狀態；6 秒內再按一次即執行。", true);
        deleteArmTimer = setTimeout(function () {
          disarmDelete();
          importNote("", false);
        }, 6000);
        return;
      }
      disarmDelete();
      importAction(btn, function () {
        return api("/admin/cookie", { method: "DELETE", headers: headersFor(false) });
      });
    });
    $("reload-cookie").addEventListener("click", function () {
      var btn = this; busy(btn, true);
      loadAdmin().catch(function (e) { toast(e.message, true); })
        .finally(function () { busy(btn, false); });
    });

    // ── Playground ──
    var playAbort = null;
    async function runPlayground() {
      var btn = $("play-send");
      var out = $("play-output");
      var meta = $("play-meta");
      var model = $("play-model").value;
      var text = $("play-input").value.trim();
      if (!model) { toast("尚未載入模型，請先連線", true); return; }
      if (!text) { toast("請輸入訊息", true); return; }

      var messages = [];
      var sys = $("play-system").value.trim();
      if (sys) messages.push({ role: "system", content: sys });
      messages.push({ role: "user", content: text });
      var wantStream = $("play-stream").checked;

      playAbort = new AbortController();
      if (!btn.dataset.label) btn.dataset.label = btn.textContent;
      btn.textContent = "中止";
      btn.classList.add("danger");
      out.className = "output";
      out.textContent = "";
      meta.textContent = wantStream ? "串流中…" : "等待回應…";
      var t0 = performance.now();
      try {
        var res = await fetch("/v1/chat/completions", {
          method: "POST",
          headers: headersFor(true),
          body: JSON.stringify({ model: model, messages: messages, stream: wantStream }),
          signal: playAbort.signal,
        });
        if (!res.ok) {
          var errData = null;
          try { errData = await res.json(); } catch (_) {}
          throw new Error((errData && errData.error && errData.error.message) || ("HTTP " + res.status));
        }
        var elapsed;
        if (wantStream && res.body) {
          var reader = res.body.getReader();
          var dec = new TextDecoder();
          var buf = "", finish = "", upstream = "";
          while (true) {
            var chunk = await reader.read();
            if (chunk.done) break;
            buf += dec.decode(chunk.value, { stream: true });
            var lines = buf.split("\\n");
            buf = lines.pop();
            lines.forEach(function (line) {
              line = line.trim();
              if (!line.startsWith("data:")) return;
              var payload = line.slice(5).trim();
              if (!payload || payload === "[DONE]") return;
              try {
                var j = JSON.parse(payload);
                if (j.upstream_model) upstream = j.upstream_model;
                var c = j.choices && j.choices[0];
                if (c && c.delta && c.delta.content) out.textContent += c.delta.content;
                if (c && c.finish_reason) finish = c.finish_reason;
              } catch (_) {}
            });
          }
          elapsed = ((performance.now() - t0) / 1000).toFixed(1);
          meta.textContent = elapsed + "s · 串流" +
            (upstream ? " · 上游 " + upstream : "") +
            (finish ? " · " + finish : "");
        } else {
          var data = await res.json();
          elapsed = ((performance.now() - t0) / 1000).toFixed(1);
          var choice = data.choices && data.choices[0];
          out.textContent = (choice && choice.message && choice.message.content) || "(空回應)";
          var usage = data.usage || {};
          meta.textContent = elapsed + "s" +
            " · 上游 " + (data.upstream_model || "unknown") +
            " · " + (data.route_status || "unknown") +
            (usage.total_tokens != null ? " · " + usage.total_tokens + " tokens" : "");
        }
        if (!out.textContent) { out.className = "output idle"; out.textContent = "(沒有文字內容)"; }
      } catch (e) {
        if (e && e.name === "AbortError") {
          meta.textContent = "已中止" + (out.textContent ? "（保留已收到的內容）" : "");
          if (!out.textContent) { out.className = "output idle"; out.textContent = "請求已中止。"; }
        } else {
          out.className = "output idle";
          out.textContent = "請求失敗：" + e.message;
          meta.textContent = "失敗";
          toast(e.message, true);
        }
      } finally {
        playAbort = null;
        btn.classList.remove("danger");
        btn.textContent = btn.dataset.label;
      }
    }
    $("play-send").addEventListener("click", function () {
      if (playAbort) { playAbort.abort(); return; }
      runPlayground();
    });
    $("play-input").addEventListener("keydown", function (e) {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        if (!playAbort) runPlayground();
      }
    });

    // ── 其他 ──
    $("build-value").addEventListener("click", function () {
      if (this.dataset.full) copyText(this.dataset.full, "Gemini Build");
    });
    $("copy-base").addEventListener("click", function () {
      copyText(location.origin + "/v1", "API Base URL");
    });
    $("refresh-info").addEventListener("click", function () {
      var btn = this; busy(btn, true);
      refreshAll(false).finally(function () { busy(btn, false); });
    });
    $("refresh-models").addEventListener("click", function () {
      var btn = this; busy(btn, true);
      loadModels(true).catch(function (e) { toast(e.message, true); })
        .finally(function () { busy(btn, false); });
    });
    $("connect").addEventListener("click", function () {
      state.key = $("api-key").value.trim();
      try { sessionStorage.setItem(KEY_STORE, state.key); } catch (_) {}
      var btn = this; busy(btn, true);
      refreshAll(false).then(function () {
        if (state.key) toast("已更新狀態");
      }).finally(function () { busy(btn, false); });
    });
    $("api-key").addEventListener("keydown", function (e) {
      if (e.key === "Enter") $("connect").click();
    });

    // ── 啟動 ──
    $("ver-chip").textContent = "v" + (BOOT.version || "?");
    $("api-key").value = state.key;
    $("base-url").textContent = location.origin + "/v1";
    refreshAll(true);
    setInterval(function () {
      if (document.visibilityState === "visible") refreshAll(true);
    }, 60000);
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
      if (!(cfg.api_keys || []).length) {
        return privateJsonResponse({ error: { message: "管理功能已停用；請先設定 API_KEYS。" } }, 403);
      }
      if (!adminAuthorized(request, cfg)) {
        return privateJsonResponse({ error: { message: "API 金鑰無效" } }, 401);
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
          const refresh = parseBool(url.searchParams.get("refresh"), false);
          const models = await getModelCatalog(cfg, refresh);
          return jsonResponse({
            object: "list",
            dynamic: true,
            data: Object.entries(models).map(([n, c]) => ({
              id: n,
              object: "model",
              created: 1700000000,
              owned_by: "google",
              description: c.desc,
            })),
          });
        }
        if (path.startsWith("/v1beta/models")) {
          const refresh = parseBool(url.searchParams.get("refresh"), false);
          const models = await getModelCatalog(cfg, refresh);
          return jsonResponse({
            dynamic: true,
            models: Object.entries(models).map(([n, c]) => ({
              name: `models/${n}`,
              displayName: n,
              description: c.desc,
              supportedGenerationMethods: ["generateContent", "streamGenerateContent"],
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
          return jsonResponse({ status: "ok", version: VERSION, gemini_bl: publicCfg.gemini_bl, model_catalog: "dynamic" });
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

  async scheduled(_controller, env, ctx) {
    ctx.waitUntil((async () => {
      const cfg = await getRequestConfig(env);
      if (!cfg.cookie || !cookieStoreStub(env)) return;
      const response = await handleCookieRefresh(cfg, env, false);
      const result = await response.json();
      log(cfg, `automatic Cookie refresh: ${result.status || result.error?.message || response.status}`);
    })().catch((e) => log(getConfig(env), `automatic Cookie refresh failed: ${e}`)));
  },
};

// Node 测试挂点。Cloudflare 会把具名 export 当成 Durable Object / Worker
// entrypoint，因此仅在 Node 环境挂到 globalThis，不进入线上导出表。
if (typeof process !== "undefined" && process.versions && process.versions.node) {
  globalThis.__GEMINI_WORKER_TEST__ = {
    MODEL_CATEGORIES, GUEST_MODE, SLOT, modelAlias, extractRpcPayload, extractRouteVariant, buildModelCatalog,
    computeAccountCapacity, buildModelSelectHeader,
    guestModelCatalog, defaultModelName, modelNameForCategory, resolveModel, getConfig, getRequestConfig, getModelCatalog, applyStoredAuth,
    parseAuthPayload, cookieSummary, authCacheKey,
    getSetCookieValues, mergeRotatedCookies,
    buildPayload, getUrl, buildHeaders, cleanText,
    extractTextsFromLine, extractResponseText, extractActualModel, routeStatus, generate, generateResult, generateStream,
    messagesToPrompt, parseToolCalls, toOpenAIStreamToolCallDeltas, googleContentsToPrompt, parseGoogleFunctionCalls,
    makeSapisidHash, parseImageUrl, extractGeminiBl, extractPageTokens, extractXsrfToken, getPageTokens, uploadImage, resolveImages,
    __setConnect, httpFetch, socketHttp, timingSafeEqual, MAX_IMAGE_BYTES,
  };
}
