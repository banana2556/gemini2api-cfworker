import assert from "node:assert/strict";
import test from "node:test";

import worker from "../worker.js";

const internals = globalThis.__GEMINI_WORKER_TEST__;

function googleAuthFetch({
  rotateStatus = 200,
  rotateCookies = [],
  appStatus = 200,
  appCookies = [],
  appBody = '{"SNlM0e":"fresh-at","cfb2h":"boq_assistant-bard-web-server_test"}',
  appRedirectLocation = "",
} = {}) {
  return async (input) => {
    const url = String(typeof input === "string" ? input : input.url);
    if (url.includes("/RotateCookies")) {
      const headers = new Headers({ "Content-Type": "application/json" });
      for (const cookie of rotateCookies) headers.append("Set-Cookie", cookie);
      return new Response(`)]}'\n[["identity.hfcr",600]]`, { status: rotateStatus, headers });
    }
    if (url.includes("rpcids=otAQ7b")) {
      return new Response(modelStatusRaw(), { headers: { "Content-Type": "application/json" } });
    }
    if (url.includes("rpcids=ESY5D")) {
      return new Response(JSON.stringify([["wrb.fr", "ESY5D", "[]", null, null]]), { headers: { "Content-Type": "application/json" } });
    }
    const headers = new Headers({ "Content-Type": "text/html" });
    if (appRedirectLocation && url.includes("/u/0/app")) {
      headers.set("Location", appRedirectLocation);
      return new Response("", { status: 302, headers });
    }
    for (const cookie of appCookies) headers.append("Set-Cookie", cookie);
    return new Response(appBody, { status: appStatus, headers });
  };
}

function statusRow(primary, display, category, route) {
  const row = [];
  row[0] = primary;
  row[6] = [route];
  row[11] = display;
  row[12] = `${display} description`;
  row[17] = category;
  return row;
}

function modelStatusRaw(statusCode = null) {
  const payload = new Array(16).fill(null);
  if (statusCode !== null) payload[14] = statusCode;
  payload[15] = [
    statusRow("cf41b0e0dd7d53e5", "3.5 Flash-Lite", 6, "8c46e95b1a07cecc"),
    statusRow("fbb127bbb056c959", "3.6 Flash", 1, "56fdd199312815e2"),
    statusRow("9d8ca3786ebdfbea", "3.1 Pro", 3, "e6fa609c3fa255c0"),
  ];
  return JSON.stringify([["wrb.fr", "otAQ7b", JSON.stringify(payload), null, null]]);
}

function modelStatusRejectionRaw(code = 7) {
  return JSON.stringify([["wrb.fr", "otAQ7b", null, null, null, [code]]]);
}

const modelAppHtml = [
  '{"SNlM0e":"guest-at","cfb2h":"boq_assistant-bard-web-server_test"}',
  '[["cf41b0e0dd7d53e5","8c46e95b1a07cecc"]]',
  '[["56fdd199312815e2","fbb127bbb056c959"]]',
  '[["e6fa609c3fa255c0","9d8ca3786ebdfbea"]]',
].join("");

function generateRaw(text) {
  const inner = new Array(43).fill(null);
  inner[4] = [[null, [text]]];
  inner[42] = "3.5 Flash-Lite";
  return JSON.stringify([["wrb.fr", "rpc", JSON.stringify(inner)]]);
}

function memoryCookieStore() {
  let record = null;
  return {
    peek() { return record; },
    idFromName() { return "settings"; },
    get() {
      return {
        async fetch(input, init = {}) {
          const method = init.method || (input instanceof Request ? input.method : "GET");
          if (method === "GET") {
            return record
              ? new Response(JSON.stringify(record), { headers: { "Content-Type": "application/json" } })
              : new Response(null, { status: 404 });
          }
          if (method === "PUT") {
            record = JSON.parse(init.body);
            return new Response(null, { status: 204 });
          }
          if (method === "DELETE") {
            record = null;
            return new Response(null, { status: 204 });
          }
          return new Response(null, { status: 405 });
        },
      };
    },
  };
}

function failingCookieStore() {
  let reads = 0;
  return {
    get reads() { return reads; },
    idFromName() { return "settings"; },
    get() {
      return {
        async fetch() {
          reads += 1;
          return new Response(null, { status: 503 });
        },
      };
    },
  };
}

test("browser root serves a CSP-protected console and ignores legacy Cookie secrets", async () => {
  const secret = "SAPISID=never-render-this; SID=session-secret";
  const response = await worker.fetch(new Request("https://worker.example/", {
    headers: { Accept: "text/html" },
  }), { GEMINI_COOKIE: secret });
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/html/);
  assert.match(response.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  assert.match(html, /GeminiWeb2API · Console/);
  assert.match(html, /href="https:\/\/github\.com\/banana2556\/gemini2api-cfworker"[^>]*><strong>GeminiWeb2API<\/strong>/);
  assert.match(html, /class="gh"[^>]*>[\s\S]*@banana2556<\/a>/);
  assert.match(html, /id="api-key"/);
  assert.doesNotMatch(html, /id="admin-key"|gemini-worker-admin-key|ADMIN_KEY/);
  assert.match(html, /gemini-worker-api-key/);
  assert.doesNotMatch(html, /id="probe-models"|即時探測|\?live=1|\?verify=1/);
  assert.match(html, /id="do-import"/);
  assert.match(html, /id="do-refresh"/);
  assert.doesNotMatch(html, /never-render-this|session-secret/);
  const script = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  assert.doesNotThrow(() => new Function(script));
});

test("model catalog falls back to guest when the stored Cookie is rejected", async () => {
  const store = memoryCookieStore();
  const env = {
    API_KEYS: "api-test-key",
    ADMIN_KEY: "admin-test-key",
    COOKIE_STORE: store,
    GEMINI_ORIGIN: "https://fallback-gemini.example",
    UPSTREAM_SOCKET: "false",
    LOG_REQUESTS: "false",
  };
  const imported = await worker.fetch(new Request("https://worker.example/admin/cookie", {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: "Bearer api-test-key" },
    body: JSON.stringify({ auth: "SAPISID=sapi; SID=session" }),
  }), env);
  assert.equal(imported.status, 200);

  const originalFetch = globalThis.fetch;
  internals.__setConnect(null);
  try {
    globalThis.fetch = async (input, init = {}) => {
      const url = String(input);
      const headers = init.headers || {};
      const cookie = headers instanceof Headers ? headers.get("Cookie") : headers.Cookie;
      if (url.includes("/app")) {
        return new Response(cookie ? "<html>Sign in</html>" : modelAppHtml, {
          headers: { "Content-Type": "text/html" },
        });
      }
      if (url.includes("/batchexecute")) {
        return new Response(modelStatusRaw(), { headers: { "Content-Type": "application/json" } });
      }
      throw new Error(`unexpected fetch ${url}`);
    };

    const response = await worker.fetch(new Request("https://worker.example/v1/models", {
      headers: { Authorization: "Bearer api-test-key" },
    }), env);
    const data = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(data.data.map((model) => model.id), ["gemini-auto", "gemini-auto-thinking"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("model catalog does not trust a stale page token from an unauthenticated app page", async () => {
  const store = memoryCookieStore();
  const env = {
    API_KEYS: "api-test-key",
    COOKIE_STORE: store,
    GEMINI_ORIGIN: "https://stale-token.example",
    UPSTREAM_SOCKET: "false",
    LOG_REQUESTS: "false",
  };
  const imported = await worker.fetch(new Request("https://worker.example/admin/cookie", {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: "Bearer api-test-key" },
    body: JSON.stringify({ auth: { cookie: "SAPISID=sapi; SID=session", xsrf_token: "stale-at" } }),
  }), env);
  assert.equal(imported.status, 200);

  const originalFetch = globalThis.fetch;
  internals.__setConnect(null);
  try {
    globalThis.fetch = async (input) => {
      const url = String(typeof input === "string" ? input : input.url);
      if (url.includes("/app")) return new Response([
        '<a aria-label="Sign in" href="https://accounts.google.com/ServiceLogin?continue=https://gemini.google.com/app">Sign in</a>',
        '{"qKIAYe":"feeds/mcudyrk2a4khkz","Ylro7b":"CgcSBWjK7pYx","cfb2h":"boq_assistant-bard-web-server_guest"}',
      ].join(""));
      throw new Error(`unexpected fetch ${url}`);
    };

    const response = await worker.fetch(new Request("https://worker.example/v1/models", {
      headers: { Authorization: "Bearer api-test-key" },
    }), env);
    const data = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(data.data.map((model) => model.id), ["gemini-auto", "gemini-auto-thinking"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("embedded sign-in template text does not reject an authenticated page", async () => {
  const html = '<script>const label = "Sign in"; const href = "https://accounts.google.com/ServiceLogin";</script>{"qKIAYe":"push","Ylro7b":"pctx"}';
  assert.equal(internals.hasAuthenticatedPageMarkers(internals.extractPageTokens(html), html), true);
});

test("an explicit sign-in control wins over a page token", () => {
  const html = '<a aria-label="Sign in" href="https://accounts.google.com/ServiceLogin">Sign in</a>{"SNlM0e":"guest-at","qKIAYe":"push","Ylro7b":"pctx"}';
  assert.equal(internals.hasAuthenticatedPageMarkers(internals.extractPageTokens(html), html), false);
});

test("model catalog rejects an unauthenticated GetUserStatus response", async () => {
  const store = memoryCookieStore();
  const env = {
    API_KEYS: "api-test-key",
    COOKIE_STORE: store,
    GEMINI_ORIGIN: "https://status-unauthenticated.example",
    UPSTREAM_SOCKET: "false",
    LOG_REQUESTS: "false",
  };
  const imported = await worker.fetch(new Request("https://worker.example/admin/cookie", {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: "Bearer api-test-key" },
    body: JSON.stringify({ auth: { cookie: "SAPISID=sapi; SID=session", xsrf_token: "stale-at" } }),
  }), env);
  assert.equal(imported.status, 200);

  const originalFetch = globalThis.fetch;
  internals.__setConnect(null);
  try {
    globalThis.fetch = async (input) => {
      const url = String(typeof input === "string" ? input : input.url);
      if (url.includes("/app")) return new Response([
        '{"qKIAYe":"feeds/mcudyrk2a4khkz","Ylro7b":"CgcSBWjK7pYx","cfb2h":"boq_assistant-bard-web-server_guest"}',
      ].join(""));
      if (url.includes("/batchexecute")) return new Response(modelStatusRaw(1016));
      throw new Error(`unexpected fetch ${url}`);
    };

    const response = await worker.fetch(new Request("https://worker.example/v1/models", {
      headers: { Authorization: "Bearer api-test-key" },
    }), env);
    const data = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(data.data.map((model) => model.id), ["gemini-auto", "gemini-auto-thinking"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Cookie refresh rejects an HTTP 200 GetUserStatus RPC rejection", async () => {
  const store = memoryCookieStore();
  const env = { API_KEYS: "api-test-key", COOKIE_STORE: store, UPSTREAM_SOCKET: "false", LOG_REQUESTS: "false" };
  await worker.fetch(new Request("https://worker.example/admin/cookie", {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: "Bearer api-test-key" },
    body: JSON.stringify({ auth: "SAPISID=sapi; __Secure-1PSID=session" }),
  }), env);
  const originalFetch = globalThis.fetch;
  internals.__setConnect(null);
  try {
    globalThis.fetch = async (input) => {
      const url = String(typeof input === "string" ? input : input.url);
      if (url.includes("/RotateCookies")) return new Response("ok", { status: 200 });
      if (url.includes("/app")) return new Response('{"SNlM0e":"fresh-at","cfb2h":"boq_assistant-bard-web-server_test"}');
      if (url.includes("rpcids=otAQ7b")) return new Response(modelStatusRejectionRaw());
      throw new Error(`unexpected fetch ${url}`);
    };
    const response = await worker.fetch(new Request("https://worker.example/admin/cookie/refresh", {
      method: "POST", headers: { Authorization: "Bearer api-test-key" },
    }), env);
    const data = await response.json();
    assert.equal(data.status, "reauth_required");
    assert.equal(store.peek().refresh_error, "get_user_status_rejected");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("HTTP 200 GetUserStatus without a payload stays retryable and keeps Cookie configured", async () => {
  const store = memoryCookieStore();
  const env = { API_KEYS: "api-test-key", COOKIE_STORE: store, UPSTREAM_SOCKET: "false", LOG_REQUESTS: "false" };
  await worker.fetch(new Request("https://worker.example/admin/cookie", {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: "Bearer api-test-key" },
    body: JSON.stringify({ auth: "SAPISID=sapi; __Secure-1PSID=session" }),
  }), env);
  const originalFetch = globalThis.fetch;
  internals.__setConnect(null);
  try {
    globalThis.fetch = async (input) => {
      const url = String(typeof input === "string" ? input : input.url);
      if (url.includes("/RotateCookies")) return new Response("ok", { status: 200 });
      if (url.includes("/app")) return new Response('{"SNlM0e":"fresh-at","cfb2h":"boq_assistant-bard-web-server_test"}');
      if (url.includes("rpcids=otAQ7b")) return new Response(JSON.stringify([["wrb.fr", "otAQ7b", null, null, null]]));
      throw new Error(`unexpected fetch ${url}`);
    };
    const response = await worker.fetch(new Request("https://worker.example/admin/cookie/refresh", {
      method: "POST", headers: { Authorization: "Bearer api-test-key" },
    }), env);
    const data = await response.json();
    assert.equal(data.status, "retrying");
    assert.equal(data.cookie.configured, true);
    assert.equal(store.peek().refresh_status, "retrying");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("authenticated generation falls back to guest when upstream returns no content", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  internals.__setConnect(null);
  try {
    globalThis.fetch = async (input, init = {}) => {
      const url = String(input);
      const headers = init.headers || {};
      const cookie = headers instanceof Headers ? headers.get("Cookie") : headers.Cookie;
      if (url.includes("/app")) return new Response(cookie ? "<html>Sign in</html>" : modelAppHtml);
      calls.push(cookie ? "authenticated" : "guest");
      return new Response(cookie ? "<html>empty</html>" : generateRaw("guest fallback answer with enough padding to pass parser"));
    };

    const cfg = internals.applyStoredAuth(internals.getConfig({
      GEMINI_ORIGIN: "https://generate-fallback.example",
      GEMINI_BL: "boq_assistant-bard-web-server_test",
      UPSTREAM_SOCKET: "false",
      RETRY_ATTEMPTS: "1",
      LOG_REQUESTS: "false",
    }), { cookie: "SAPISID=sapi; SID=session", sapisid: "sapi" });
    const result = await internals.generateResult(cfg, "hello", 6, 1, null, null);

    assert.deepEqual(calls, ["authenticated", "guest"]);
    assert.match(result.text, /guest fallback answer/);
    assert.equal(result.actualModel, "3.5 Flash-Lite");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("root keeps health JSON compatibility for non-browser clients", async () => {
  const env = { GEMINI_ORIGIN: "data:text/plain,", UPSTREAM_SOCKET: "false", LOG_REQUESTS: "false" };
  const root = await worker.fetch(new Request("https://worker.example/"), env);
  const health = await worker.fetch(new Request("https://worker.example/health"), env);
  assert.match(root.headers.get("content-type"), /application\/json/);
  assert.equal((await root.json()).status, "ok");
  const healthJson = await health.json();
  assert.equal(healthJson.status, "ok");
  assert.equal(healthJson.version, "1.9.10");
});

test("Cookie import persists only in Durable Object and never falls back to a legacy secret", async () => {
  const env = {
    API_KEYS: "api-test-key",
    COOKIE_STORE: memoryCookieStore(),
    GEMINI_COOKIE: "SAPISID=legacy-sapi; SID=legacy-session",
  };
  const raw = "NID=534=value=with=equals; SAPISID=sapi/value; __Secure-1PSID=session-value";
  const authHeaders = {
    "Content-Type": "application/json",
    "X-Admin-Key": "api-test-key",
  };

  const denied = await worker.fetch(new Request("https://worker.example/admin/cookie", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ auth: raw }),
  }), env);
  assert.equal(denied.status, 401);

  const imported = await worker.fetch(new Request("https://worker.example/admin/cookie", {
    method: "PUT",
    headers: authHeaders,
    body: JSON.stringify({ auth: raw }),
  }), env);
  const importedText = await imported.text();
  assert.equal(imported.status, 200);
  assert.doesNotMatch(importedText, /sapi\/value|session-value/);

  const status = await worker.fetch(new Request("https://worker.example/admin/status", {
    headers: { "X-Admin-Key": "api-test-key" },
  }), env);
  const data = await status.json();
  assert.equal(data.cookie.source, "durable_object");
  assert.equal(data.cookie.structurally_valid, true);
  assert.equal(data.cookie.cookie_count, 3);
  assert.equal(data.cookie.removed_cookie_count, 0);
  assert.equal(data.cookie.session_cookie, "__Secure-1PSID");
  assert.equal(status.headers.get("access-control-allow-origin"), null);
  assert.doesNotMatch(JSON.stringify(data), /sapi\/value|session-value/);

  const removed = await worker.fetch(new Request("https://worker.example/admin/cookie", {
    method: "DELETE",
    headers: { "X-Admin-Key": "api-test-key" },
  }), env);
  assert.equal(removed.status, 200);
  const removedData = await removed.json();
  assert.equal(removedData.cookie.configured, false);
  assert.equal(removedData.cookie.source, "none");
  assert.doesNotMatch(JSON.stringify(removedData), /legacy-sapi|legacy-session/);
});

test("Cookie rotation merges approved values and ignores unrelated Set-Cookie fields", () => {
  const headers = new Headers();
  headers.append("Set-Cookie", "SIDCC=rotated-cc; Path=/; Secure; HttpOnly");
  headers.append("Set-Cookie", "NID=rotated-nid; Expires=Wed, 21 Oct 2030 07:28:00 GMT; Path=/");
  headers.append("Set-Cookie", "__Secure-BUCKET=rotated-bucket; Path=/; Secure");
  headers.append("Set-Cookie", "__Secure-STRP=rotated-strp; Path=/; Secure");
  headers.append("Set-Cookie", "__Secure-ENID=rotated-enid; Path=/; Secure");
  headers.append("Set-Cookie", "UNRELATED=ignore-me; Path=/");

  const merged = internals.mergeRotatedCookies(
    "SAPISID=sapi; SID=session; SIDCC=old-cc; NID=old-nid; AEC=untouched; __Secure-BUCKET=old-bucket",
    internals.getSetCookieValues(headers),
  );

  assert.deepEqual(merged.changed_cookie_names, ["SIDCC", "NID", "__Secure-BUCKET", "__Secure-STRP", "__Secure-ENID"]);
  assert.equal(merged.ignored_cookie_count, 1);
  assert.match(merged.cookie, /SID=session/);
  assert.match(merged.cookie, /SAPISID=sapi/);
  assert.match(merged.cookie, /SIDCC=rotated-cc/);
  assert.match(merged.cookie, /NID=rotated-nid/);
  assert.match(merged.cookie, /__Secure-BUCKET=rotated-bucket/);
  assert.match(merged.cookie, /__Secure-STRP=rotated-strp/);
  assert.match(merged.cookie, /__Secure-ENID=rotated-enid/);
  assert.match(merged.cookie, /AEC=untouched/);
  assert.doesNotMatch(merged.cookie, /old-cc|old-nid|ignore-me|UNRELATED/);

  const combined = internals.getSetCookieValues({
    get() {
      return "NID=next; Expires=Wed, 21 Oct 2030 07:28:00 GMT; Path=/, SIDCC=next-cc; Path=/";
    },
  });
  assert.equal(combined.length, 2);
});

test("persistent Cookie jar keeps scope and expiry metadata and applies deletions", () => {
  const now = Date.parse("2026-09-09T00:00:00.000Z");
  const base = internals.importedCookieJar("SAPISID=sapi; __Secure-1PSID=session; __Secure-1PSIDTS=old-ts");
  const merged = internals.mergeCookieJar(base, [
    "__Secure-1PSIDTS=new-ts; Domain=.google.com; Path=/; Max-Age=120; Secure; HttpOnly; SameSite=Lax",
    "SIDCC=account-only; Path=/RotateCookies; Max-Age=60; Secure",
    "UNRELATED=ignored; Domain=.google.com; Path=/",
  ], "https://accounts.google.com/RotateCookies", now);

  const psidts = merged.cookie_jar.find((cookie) => cookie.name === "__Secure-1PSIDTS");
  assert.deepEqual({
    value: psidts.value,
    domain: psidts.domain,
    path: psidts.path,
    expires: psidts.expires,
    secure: psidts.secure,
    http_only: psidts.http_only,
    same_site: psidts.same_site,
  }, {
    value: "new-ts",
    domain: ".google.com",
    path: "/",
    expires: Math.floor(now / 1000) + 120,
    secure: true,
    http_only: true,
    same_site: "Lax",
  });
  assert.match(internals.cookieHeaderForUrl(merged.cookie_jar, "https://accounts.google.com/RotateCookies", null, now), /SIDCC=account-only/);
  assert.doesNotMatch(internals.cookieHeaderForUrl(merged.cookie_jar, "https://gemini.google.com/app", null, now), /SIDCC=account-only/);
  assert.equal(merged.ignored_cookie_count, 1);

  const removed = internals.mergeCookieJar(merged.cookie_jar, [
    "__Secure-1PSIDTS=; Domain=.google.com; Path=/; Max-Age=0",
  ], "https://accounts.google.com/RotateCookies", now + 1000);
  assert.equal(removed.cookie_jar.some((cookie) => cookie.name === "__Secure-1PSIDTS"), false);
  assert.deepEqual(removed.changed_cookie_names, ["__Secure-1PSIDTS"]);
});

test("Cookie Sync arrays preserve browser metadata on import", async () => {
  const store = memoryCookieStore();
  const response = await worker.fetch(new Request("https://worker.example/admin/cookie", {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: "Bearer api-test-key" },
    body: JSON.stringify({ auth: { cookies: [
      { name: "SAPISID", value: "top-secret-sapi", domain: ".google.com", path: "/", secure: true, expirationDate: 1900000000 },
      { name: "__Secure-1PSID", value: "top-secret-session", domain: ".google.com", path: "/", secure: true, expirationDate: 1900000100 },
      { name: "UNRELATED", value: "top-secret-discard", domain: ".google.com", path: "/" },
    ] } }),
  }), { API_KEYS: "api-test-key", COOKIE_STORE: store });
  const text = await response.text();

  assert.equal(response.status, 200);
  assert.equal(store.peek().cookie_jar.length, 2);
  assert.equal(store.peek().cookie_jar.find((cookie) => cookie.name === "__Secure-1PSID").expires, 1900000100);
  assert.equal(store.peek().cookie_jar_version, 1);
  assert.doesNotMatch(text, /top-secret-sapi|top-secret-session|top-secret-discard/);
});

test("Cookie import accepts the flat map formats used by the reference client", async () => {
  const store = memoryCookieStore();
  const env = { API_KEYS: "api-test-key", COOKIE_STORE: store };
  const response = await worker.fetch(new Request("https://worker.example/admin/cookie", {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: "Bearer api-test-key" },
    body: JSON.stringify({ auth: {
      cookies: {
        SAPISID: "flat-sapi",
        "__Secure-1PSID": "flat-session",
        "__Secure-1PSIDTS": "flat-ts",
      },
    } }),
  }), env);
  assert.equal(response.status, 200);
  assert.equal(store.peek().cookie_jar.length, 3);
  assert.match(store.peek().cookie, /__Secure-1PSIDTS=flat-ts/);

  const flatResponse = await worker.fetch(new Request("https://worker.example/admin/cookie", {
    method: "PUT",
    headers: { "Content-Type": "application/json", "x-api-key": "api-test-key" },
    body: JSON.stringify({ auth: {
      SAPISID: "flat-sapi-2",
      "__Secure-1PSID": "flat-session-2",
    } }),
  }), env);
  assert.equal(flatResponse.status, 200);
  assert.equal(store.peek().cookie_jar.length, 2);
  assert.match(store.peek().cookie, /__Secure-1PSID=flat-session-2/);
});

test("authenticated Cookie refresh persists rotations without exposing values and rejects expired login", async () => {
  const store = memoryCookieStore();
  const env = {
    API_KEYS: "api-test-key",
    COOKIE_STORE: store,
    UPSTREAM_SOCKET: "false",
    LOG_REQUESTS: "false",
  };
  const adminHeaders = { Authorization: "Bearer api-test-key" };
  const imported = await worker.fetch(new Request("https://worker.example/admin/cookie", {
    method: "PUT",
    headers: { ...adminHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ auth: "SAPISID=sapi; __Secure-1PSID=session; SIDCC=old-cc; NID=old-nid; __Secure-1PSIDTS=old-ts" }),
  }), env);
  assert.equal(imported.status, 200);

  const originalFetch = globalThis.fetch;
  internals.__setConnect(null);
  try {
    const authFetch = googleAuthFetch({
      rotateCookies: ["__Secure-1PSIDTS=rotated-ts; Path=/; Secure; HttpOnly"],
      appCookies: [
        "SIDCC=rotated-cc; Path=/; Secure; HttpOnly",
        "NID=rotated-nid; Path=/; Secure",
        "UNRELATED=ignore-me; Path=/",
      ],
    });
    globalThis.fetch = (input, init) => {
      if (String(input).includes("/RotateCookies")) {
        assert.equal(init.headers.Cookie, "__Secure-1PSID=session; __Secure-1PSIDTS=old-ts");
        assert.deepEqual(Object.keys(init.headers).sort(), ["Content-Type", "Cookie", "Origin"]);
        assert.equal(init.body, '[000,"-0000000000000000000"]');
      }
      return authFetch(input, init);
    };

    const refreshed = await worker.fetch(new Request("https://worker.example/admin/cookie/refresh", {
      method: "POST",
      headers: adminHeaders,
    }), env);
    const refreshedText = await refreshed.text();
    const refreshedData = JSON.parse(refreshedText);
    assert.equal(refreshed.status, 200);
    assert.equal(refreshedData.status, "refreshed");
    assert.deepEqual(refreshedData.changed_cookie_names, ["__Secure-1PSIDTS", "SIDCC", "NID"]);
    assert.ok(refreshedData.cookie.refreshed_at);
    assert.ok(refreshedData.cookie.refresh_checked_at);
    assert.equal(refreshedData.cookie.refresh_status, "refreshed");
    assert.doesNotMatch(refreshedText, /rotated-ts|rotated-cc|rotated-nid|ignore-me/);
    assert.match(store.peek().cookie, /__Secure-1PSIDTS=rotated-ts/);
    assert.match(store.peek().cookie, /SIDCC=rotated-cc/);
    assert.match(store.peek().cookie, /NID=rotated-nid/);
    assert.doesNotMatch(store.peek().cookie, /UNRELATED|ignore-me/);
    assert.equal(store.peek().xsrf_token, "fresh-at");

    const validRecord = structuredClone(store.peek());
    globalThis.fetch = googleAuthFetch({
      rotateCookies: ["__Secure-1PSIDTS=rotated-ts; Path=/; Secure; HttpOnly"],
      appCookies: ["SIDCC=rotated-cc; Path=/; Secure; HttpOnly"],
      appBody: '{"SNlM0e":"newer-at"}',
    });
    const unchanged = await worker.fetch(new Request("https://worker.example/admin/cookie/refresh", {
      method: "POST",
      headers: adminHeaders,
    }), env);
    const unchangedData = await unchanged.json();
    assert.equal(unchangedData.status, "no_rotation");
    assert.equal(unchangedData.cookie.refresh_status, "verified");
    assert.equal(unchangedData.cookie.refresh_error, null);
    assert.equal(store.peek().cookie, validRecord.cookie);
    assert.equal(store.peek().updated_at, validRecord.updated_at);
    assert.equal(store.peek().xsrf_token, "newer-at");
    assert.ok(store.peek().refreshed_at);
    assert.ok(store.peek().refresh_checked_at);
    assert.equal(store.peek().refresh_status, "verified");

    const beforeExpired = structuredClone(store.peek());
    globalThis.fetch = googleAuthFetch({
      rotateStatus: 401,
      appCookies: ["SIDCC=must-not-save; Path=/"],
      appBody: '<a aria-label="Sign in" href="https://accounts.google.com/ServiceLogin">Sign in</a>',
    });
    const expired = await worker.fetch(new Request("https://worker.example/admin/cookie/refresh", {
      method: "POST",
      headers: adminHeaders,
    }), env);
    const expiredText = await expired.text();
    const expiredData = JSON.parse(expiredText);
    assert.equal(expired.status, 200);
    assert.equal(expiredData.status, "reauth_required");
    assert.doesNotMatch(expiredText, /must-not-save|rotated-cc|rotated-nid/);
    assert.equal(store.peek().cookie, validRecord.cookie);
    assert.equal(store.peek().xsrf_token, "newer-at");
    assert.equal(store.peek().refreshed_at, beforeExpired.refreshed_at);
    assert.ok(store.peek().refresh_checked_at);
    assert.equal(store.peek().refresh_status, "reauth_required");
    assert.equal(store.peek().refresh_error, "sign_in_page");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("manual Cookie refresh validates the session when RotateCookies rejects a repeat request", async () => {
  const store = memoryCookieStore();
  const env = {
    API_KEYS: "api-test-key",
    COOKIE_STORE: store,
    UPSTREAM_SOCKET: "false",
    LOG_REQUESTS: "false",
  };
  const adminHeaders = { Authorization: "Bearer api-test-key" };
  const imported = await worker.fetch(new Request("https://worker.example/admin/cookie", {
    method: "PUT",
    headers: { ...adminHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ auth: "SAPISID=sapi; SID=session" }),
  }), env);
  assert.equal(imported.status, 200);

  const originalFetch = globalThis.fetch;
  internals.__setConnect(null);
  try {
    globalThis.fetch = googleAuthFetch({
      rotateStatus: 401,
      appBody: '{"SNlM0e":"still-valid-at"}',
    });

    const refreshed = await worker.fetch(new Request("https://worker.example/admin/cookie/refresh", {
      method: "POST",
      headers: adminHeaders,
    }), env);
    const data = await refreshed.json();

    assert.equal(refreshed.status, 200);
    assert.equal(data.status, "no_rotation");
    assert.equal(data.cookie.refresh_status, "verified");
    assert.equal(data.cookie.refresh_error, null);
    assert.equal(store.peek().xsrf_token, "still-valid-at");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("overlapping manual refreshes send only one RotateCookies request", async () => {
  const store = memoryCookieStore();
  const env = {
    API_KEYS: "api-test-key",
    COOKIE_STORE: store,
    UPSTREAM_SOCKET: "false",
    LOG_REQUESTS: "false",
  };
  await worker.fetch(new Request("https://worker.example/admin/cookie", {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: "Bearer api-test-key" },
    body: JSON.stringify({ auth: "SAPISID=sapi; __Secure-1PSID=session; __Secure-1PSIDTS=old-ts" }),
  }), env);

  const originalFetch = globalThis.fetch;
  internals.__setConnect(null);
  try {
    let rotateCalls = 0;
    globalThis.fetch = async (input) => {
      const url = String(typeof input === "string" ? input : input.url);
      if (url.includes("rpcids=otAQ7b")) return new Response(modelStatusRaw());
      if (url.includes("rpcids=ESY5D")) return new Response("ok");
      if (url.includes("/RotateCookies")) {
        rotateCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 15));
        return new Response("ok", {
          headers: { "Set-Cookie": "__Secure-1PSIDTS=new-ts; Domain=.google.com; Path=/; Secure; HttpOnly" },
        });
      }
      return new Response('{"SNlM0e":"fresh-at"}', { headers: { "Content-Type": "text/html" } });
    };

    const request = () => worker.fetch(new Request("https://worker.example/admin/cookie/refresh", {
      method: "POST",
      headers: { Authorization: "Bearer api-test-key" },
    }), env);
    const responses = await Promise.all([request(), request()]);
    assert.equal(rotateCalls, 1);
    assert.deepEqual((await Promise.all(responses.map(async (response) => (await response.json()).status))).sort(), ["in_progress", "refreshed"]);
    assert.match(store.peek().cookie, /__Secure-1PSIDTS=new-ts/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a later verified page clears a stale reauthentication result during cooldown", async () => {
  const store = memoryCookieStore();
  const env = {
    API_KEYS: "api-test-key",
    COOKIE_STORE: store,
    UPSTREAM_SOCKET: "false",
    LOG_REQUESTS: "false",
  };
  await worker.fetch(new Request("https://worker.example/admin/cookie", {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: "Bearer api-test-key" },
    body: JSON.stringify({ auth: "SAPISID=sapi; __Secure-1PSID=session" }),
  }), env);

  const originalFetch = globalThis.fetch;
  internals.__setConnect(null);
  try {
    globalThis.fetch = googleAuthFetch({
      rotateStatus: 401,
      appBody: '<a aria-label="Sign in" href="https://accounts.google.com/ServiceLogin">Sign in</a>',
    });
    const first = await worker.fetch(new Request("https://worker.example/admin/cookie/refresh", {
      method: "POST",
      headers: { Authorization: "Bearer api-test-key" },
    }), env);
    assert.equal((await first.json()).status, "reauth_required");
    assert.equal(store.peek().refresh_status, "reauth_required");

    globalThis.fetch = googleAuthFetch({ appBody: '{"SNlM0e":"recovered-at"}' });
    const recovered = await worker.fetch(new Request("https://worker.example/admin/cookie/refresh", {
      method: "POST",
      headers: { Authorization: "Bearer api-test-key" },
    }), env);
    const data = await recovered.json();
    assert.equal(data.status, "no_rotation");
    assert.equal(store.peek().refresh_status, "verified");
    assert.equal(store.peek().refresh_error, null);
    assert.equal(store.peek().xsrf_token, "recovered-at");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Cookie refresh recovers the XSRF token from an authenticated upstream error", async () => {
  const store = memoryCookieStore();
  const env = {
    API_KEYS: "api-test-key",
    COOKIE_STORE: store,
    UPSTREAM_SOCKET: "false",
    LOG_REQUESTS: "false",
  };
  const adminHeaders = { Authorization: "Bearer api-test-key" };
  const imported = await worker.fetch(new Request("https://worker.example/admin/cookie", {
    method: "PUT",
    headers: { ...adminHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ auth: "SAPISID=sapi; SID=session" }),
  }), env);
  assert.equal(imported.status, 200);

  const originalFetch = globalThis.fetch;
  internals.__setConnect(null);
  try {
    globalThis.fetch = async (input) => {
      const url = String(typeof input === "string" ? input : input.url);
      if (url.includes("rpcids=otAQ7b")) return new Response(modelStatusRaw());
      if (url.includes("/RotateCookies")) {
        return new Response(")]}'\n[[\"identity.hfcr\",600]]", { status: 200 });
      }
      if (url.includes("/app")) {
        return new Response('{"qKIAYe":"push","Ylro7b":"pctx","cfb2h":"boq_assistant-bard-web-server_probe"}', {
          headers: { "Content-Type": "text/html" },
        });
      }
      if (url.includes("StreamGenerate")) {
        return new Response(")]}'\n[[\"xsrf\",\"probe-at\"]]", { status: 400 });
      }
      throw new Error(`unexpected fetch ${url}`);
    };

    const refreshed = await worker.fetch(new Request("https://worker.example/admin/cookie/refresh", {
      method: "POST",
      headers: adminHeaders,
    }), env);
    const data = await refreshed.json();
    assert.equal(refreshed.status, 200);
    assert.equal(data.status, "no_rotation");
    assert.equal(store.peek().xsrf_token, "probe-at");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Cookie refresh follows same-origin Gemini app redirects", async () => {
  const store = memoryCookieStore();
  const env = {
    API_KEYS: "api-test-key",
    COOKIE_STORE: store,
    UPSTREAM_SOCKET: "false",
    LOG_REQUESTS: "false",
  };
  const adminHeaders = { Authorization: "Bearer api-test-key" };
  const imported = await worker.fetch(new Request("https://worker.example/admin/cookie", {
    method: "PUT",
    headers: { ...adminHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ auth: { cookie: "SAPISID=sapi; SID=session", auth_user: 0 } }),
  }), env);
  assert.equal(imported.status, 200);

  const originalFetch = globalThis.fetch;
  internals.__setConnect(null);
  try {
    globalThis.fetch = googleAuthFetch({
      appRedirectLocation: "https://gemini.google.com/app",
      appBody: '{"SNlM0e":"redirect-at","cfb2h":"boq_assistant-bard-web-server_redirect"}',
    });

    const refreshed = await worker.fetch(new Request("https://worker.example/admin/cookie/refresh", {
      method: "POST",
      headers: adminHeaders,
    }), env);
    const data = await refreshed.json();
    assert.equal(refreshed.status, 200);
    assert.equal(data.status, "no_rotation");
    assert.equal(data.cookie.refresh_status, "verified");
    assert.equal(store.peek().xsrf_token, "redirect-at");
    assert.equal(store.peek().gemini_bl, "boq_assistant-bard-web-server_redirect");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Cookie refresh follows Google account redirects back to Gemini", async () => {
  const store = memoryCookieStore();
  const env = {
    API_KEYS: "api-test-key",
    COOKIE_STORE: store,
    UPSTREAM_SOCKET: "false",
    LOG_REQUESTS: "false",
  };
  const adminHeaders = { Authorization: "Bearer api-test-key" };
  const imported = await worker.fetch(new Request("https://worker.example/admin/cookie", {
    method: "PUT",
    headers: { ...adminHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ auth: "SAPISID=sapi; SID=session" }),
  }), env);
  assert.equal(imported.status, 200);

  const originalFetch = globalThis.fetch;
  internals.__setConnect(null);
  try {
    let sentToAccounts = false;
    globalThis.fetch = async (input) => {
      const url = String(typeof input === "string" ? input : input.url);
      if (url.includes("rpcids=otAQ7b")) return new Response(modelStatusRaw());
      if (url.includes("rpcids=ESY5D")) return new Response("ok");
      if (url.includes("/RotateCookies")) {
        return new Response(`)]}'\n[["identity.hfcr",600]]`, { status: 200 });
      }
      if (url === "https://gemini.google.com/app" && !sentToAccounts) {
        sentToAccounts = true;
        return new Response("", {
          status: 302,
          headers: { Location: "https://accounts.google.com/ServiceLogin" },
        });
      }
      if (url.startsWith("https://accounts.google.com/")) {
        return new Response("", {
          status: 302,
          headers: { Location: "https://gemini.google.com/app" },
        });
      }
      return new Response('{"SNlM0e":"accounts-at","cfb2h":"boq_assistant-bard-web-server_accounts"}', {
        headers: { "Content-Type": "text/html" },
      });
    };

    const refreshed = await worker.fetch(new Request("https://worker.example/admin/cookie/refresh", {
      method: "POST",
      headers: adminHeaders,
    }), env);
    const data = await refreshed.json();
    assert.equal(refreshed.status, 200);
    assert.equal(data.status, "no_rotation");
    assert.equal(store.peek().xsrf_token, "accounts-at");
    assert.equal(store.peek().gemini_bl, "boq_assistant-bard-web-server_accounts");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Cookie refresh detects auth_user when raw Cookie targets a numbered account", async () => {
  const store = memoryCookieStore();
  const env = {
    API_KEYS: "api-test-key",
    COOKIE_STORE: store,
    UPSTREAM_SOCKET: "false",
    LOG_REQUESTS: "false",
  };
  const adminHeaders = { Authorization: "Bearer api-test-key" };
  const imported = await worker.fetch(new Request("https://worker.example/admin/cookie", {
    method: "PUT",
    headers: { ...adminHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ auth: "SAPISID=sapi; SID=session" }),
  }), env);
  assert.equal(imported.status, 200);

  const originalFetch = globalThis.fetch;
  internals.__setConnect(null);
  try {
    globalThis.fetch = async (input) => {
      const url = String(typeof input === "string" ? input : input.url);
      if (url.includes("rpcids=otAQ7b")) return new Response(modelStatusRaw());
      if (url.includes("rpcids=ESY5D")) return new Response("ok");
      if (url.includes("/RotateCookies")) {
        return new Response(`)]}'\n[["identity.hfcr",600]]`, { status: 200 });
      }
      if (url === "https://gemini.google.com/u/2/app") {
        return new Response('{"SNlM0e":"u2-at","cfb2h":"boq_assistant-bard-web-server_u2"}', {
          headers: { "Content-Type": "text/html" },
        });
      }
      return new Response("", {
        status: 302,
        headers: { Location: "https://www.google.com/" },
      });
    };

    const refreshed = await worker.fetch(new Request("https://worker.example/admin/cookie/refresh", {
      method: "POST",
      headers: adminHeaders,
    }), env);
    const data = await refreshed.json();
    assert.equal(refreshed.status, 200);
    assert.equal(data.status, "no_rotation");
    assert.equal(data.cookie.auth_user, "2");
    assert.equal(store.peek().auth_user, "2");
    assert.equal(store.peek().xsrf_token, "u2-at");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Cookie refresh accepts Google abuse exemption redirects", async () => {
  const store = memoryCookieStore();
  const env = {
    API_KEYS: "api-test-key",
    COOKIE_STORE: store,
    UPSTREAM_SOCKET: "false",
    LOG_REQUESTS: "false",
  };
  const adminHeaders = { Authorization: "Bearer api-test-key" };
  const imported = await worker.fetch(new Request("https://worker.example/admin/cookie", {
    method: "PUT",
    headers: { ...adminHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ auth: "SAPISID=sapi; SID=session" }),
  }), env);
  assert.equal(imported.status, 200);

  const originalFetch = globalThis.fetch;
  internals.__setConnect(null);
  try {
    let issuedAbuse = false;
    globalThis.fetch = async (input, init = {}) => {
      const url = String(typeof input === "string" ? input : input.url);
      const cookie = init.headers instanceof Headers ? init.headers.get("Cookie") : init.headers?.Cookie;
      if (url.includes("rpcids=otAQ7b")) return new Response(modelStatusRaw());
      if (url.includes("rpcids=ESY5D")) return new Response("ok");
      if (url.includes("/RotateCookies")) {
        return new Response(`)]}'\n[["identity.hfcr",600]]`, { status: 200 });
      }
      if (url.startsWith("https://www.google.com/sorry/")) {
        issuedAbuse = true;
        return new Response("", {
          status: 302,
          headers: { Location: "https://gemini.google.com/app?google_abuse=GOOGLE_ABUSE_EXEMPTION%3DID%3Dabuse%3B%20path%3D/%3B%20domain%3Dgoogle.com" },
        });
      }
      if (url === "https://gemini.google.com/app" && !issuedAbuse) {
        return new Response("", {
          status: 302,
          headers: { Location: "https://www.google.com/sorry/index?continue=https://gemini.google.com/app" },
        });
      }
      assert.match(cookie || "", /GOOGLE_ABUSE_EXEMPTION=ID=abuse/);
      return new Response('{"SNlM0e":"abuse-at","cfb2h":"boq_assistant-bard-web-server_abuse"}', {
        headers: { "Content-Type": "text/html" },
      });
    };

    const refreshed = await worker.fetch(new Request("https://worker.example/admin/cookie/refresh", {
      method: "POST",
      headers: adminHeaders,
    }), env);
    const data = await refreshed.json();
    assert.equal(refreshed.status, 200);
    assert.equal(data.status, "no_rotation");
    assert.equal(store.peek().xsrf_token, "abuse-at");
    assert.match(store.peek().cookie, /GOOGLE_ABUSE_EXEMPTION=ID=abuse/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("scheduled Cookie refresh persists rotations without loading the Gemini app page", async () => {
  const store = memoryCookieStore();
  const env = {
    API_KEYS: "api-test-key",
    COOKIE_STORE: store,
    UPSTREAM_SOCKET: "false",
    LOG_REQUESTS: "false",
  };
  const imported = await worker.fetch(new Request("https://worker.example/admin/cookie", {
    method: "PUT",
    headers: { "Content-Type": "application/json", "X-Admin-Key": "api-test-key" },
    body: JSON.stringify({ auth: "SAPISID=sapi; SID=session; SIDCC=old-cc" }),
  }), env);
  assert.equal(imported.status, 200);

  const originalFetch = globalThis.fetch;
  internals.__setConnect(null);
  try {
    const requests = [];
    const mockFetch = googleAuthFetch({
      rotateCookies: ["__Secure-1PSIDTS=automatic-ts; Path=/; Secure; HttpOnly"],
    });
    globalThis.fetch = async (...args) => {
      requests.push(String(typeof args[0] === "string" ? args[0] : args[0].url));
      return mockFetch(...args);
    };

    const tasks = [];
    await worker.scheduled({}, env, { waitUntil(task) { tasks.push(task); } });
    await Promise.all(tasks);

    assert.match(store.peek().cookie, /__Secure-1PSIDTS=automatic-ts/);
    assert.deepEqual(requests, ["https://accounts.google.com/RotateCookies"]);
    assert.equal(store.peek().xsrf_token, "");
    assert.equal(store.peek().refreshed_at, null);
    assert.ok(store.peek().refresh_checked_at);
    assert.equal(store.peek().refresh_status, "refreshed");

    const afterFirst = structuredClone(store.peek());
    globalThis.fetch = googleAuthFetch({ rotateStatus: 401 });
    const rejectedTasks = [];
    await worker.scheduled({}, env, { waitUntil(task) { rejectedTasks.push(task); } });
    await Promise.all(rejectedTasks);
    assert.equal(store.peek().last_rotation_attempt_at, afterFirst.last_rotation_attempt_at);
    assert.equal(store.peek().refresh_status, "refreshed");
    assert.equal(store.peek().refresh_error, null);

    // A missing page token without an explicit signed-out marker is retryable.
    globalThis.fetch = googleAuthFetch({ appBody: "<html>Sign in</html>" });
    const inconclusive = await worker.fetch(new Request("https://worker.example/admin/cookie/refresh", {
      method: "POST",
      headers: { "X-Admin-Key": "api-test-key" },
    }), env);
    assert.equal((await inconclusive.json()).status, "retrying");
    assert.equal(store.peek().refresh_status, "retrying");
    assert.equal(store.peek().refresh_error, "missing_page_token");
    assert.equal(store.peek().refreshed_at, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("scheduled Cookie refresh reads Cloudflare getAll headers and persists consecutive rotations", async () => {
  const store = memoryCookieStore();
  const env = {
    API_KEYS: "api-test-key",
    COOKIE_STORE: store,
    UPSTREAM_SOCKET: "false",
    LOG_REQUESTS: "false",
  };
  const imported = await worker.fetch(new Request("https://worker.example/admin/cookie", {
    method: "PUT",
    headers: { "Content-Type": "application/json", "X-Admin-Key": "api-test-key" },
    body: JSON.stringify({ auth: "SAPISID=sapi; __Secure-1PSID=session; __Secure-1PSIDTS=initial-ts" }),
  }), env);
  assert.equal(imported.status, 200);

  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  internals.__setConnect(null);
  try {
    let now = Date.parse("2026-09-09T00:00:00.000Z");
    Date.now = () => now;
    const rotations = ["first-ts", "second-ts"];
    globalThis.fetch = async (input) => {
      assert.match(String(input), /\/RotateCookies$/);
      const value = rotations.shift();
      return {
        status: 200,
        ok: true,
        headers: {
          getAll(name) {
            return name.toLowerCase() === "set-cookie"
              ? [`__Secure-1PSIDTS=${value}; Path=/; Secure; HttpOnly`]
              : [];
          },
          get() { return null; },
        },
        async text() { return `)]}'\n[["identity.hfcr",600]]`; },
      };
    };

    for (const expected of ["first-ts", "second-ts"]) {
      const tasks = [];
      await worker.scheduled({}, env, { waitUntil(task) { tasks.push(task); } });
      await Promise.all(tasks);
      assert.match(store.peek().cookie, new RegExp(`__Secure-1PSIDTS=${expected}`));
      assert.equal(store.peek().refresh_status, "refreshed");
      assert.equal(store.peek().refresh_error, null);
      now += 11 * 60 * 1000;
    }
    assert.equal(rotations.length, 0);
  } finally {
    Date.now = originalNow;
    globalThis.fetch = originalFetch;
  }
});

test("scheduled 2xx without PSIDTS keeps a verified session and runs the activity heartbeat", async () => {
  const store = memoryCookieStore();
  const env = {
    API_KEYS: "api-test-key",
    COOKIE_STORE: store,
    UPSTREAM_SOCKET: "false",
    LOG_REQUESTS: "false",
  };
  await worker.fetch(new Request("https://worker.example/admin/cookie", {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: "Bearer api-test-key" },
    body: JSON.stringify({ auth: "SAPISID=sapi; __Secure-1PSID=session; __Secure-1PSIDTS=current-ts" }),
  }), env);

  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  internals.__setConnect(null);
  try {
    let now = Date.parse("2026-09-09T00:00:00.000Z");
    Date.now = () => now;
    globalThis.fetch = googleAuthFetch({ appBody: '{"SNlM0e":"verified-at"}' });
    await worker.fetch(new Request("https://worker.example/admin/cookie/refresh", {
      method: "POST",
      headers: { Authorization: "Bearer api-test-key" },
    }), env);
    const verifiedAt = store.peek().refreshed_at;
    assert.equal(store.peek().refresh_status, "verified");

    now += 11 * 60 * 1000;
    let rotationCalls = 0;
    let heartbeatCalls = 0;
    globalThis.fetch = async (input, init = {}) => {
      const url = String(typeof input === "string" ? input : input.url);
      if (url.includes("/RotateCookies")) {
        rotationCalls += 1;
        return new Response("ok", { status: 200 });
      }
      if (url.includes("rpcids=ESY5D")) {
        heartbeatCalls += 1;
        assert.match(String(init.body), /bard_activity_enabled/);
        return new Response("ok", { status: 200 });
      }
      throw new Error(`unexpected fetch ${url}`);
    };

    const tasks = [];
    await worker.scheduled({}, env, { waitUntil(task) { tasks.push(task); } });
    await Promise.all(tasks);
    assert.equal(rotationCalls, 1);
    assert.equal(heartbeatCalls, 1);
    assert.equal(store.peek().refresh_status, "verified");
    assert.equal(store.peek().refresh_error, null);
    assert.equal(store.peek().refreshed_at, verifiedAt);
    assert.equal(store.peek().activity_status, "ok");
    assert.equal(store.peek().rotation_status, "no_change");
  } finally {
    Date.now = originalNow;
    globalThis.fetch = originalFetch;
  }
});

test("signed-in API activity schedules a rate-limited heartbeat", async () => {
  const store = memoryCookieStore();
  const env = {
    API_KEYS: "api-test-key",
    COOKIE_STORE: store,
    UPSTREAM_SOCKET: "false",
    LOG_REQUESTS: "false",
  };
  await worker.fetch(new Request("https://worker.example/admin/cookie", {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: "Bearer api-test-key" },
    body: JSON.stringify({ auth: {
      cookie: "SAPISID=sapi; __Secure-1PSID=session",
      xsrf_token: "stored-at",
    } }),
  }), env);

  const originalFetch = globalThis.fetch;
  internals.__setConnect(null);
  try {
    let heartbeatCalls = 0;
    globalThis.fetch = async (input, init = {}) => {
      const url = String(typeof input === "string" ? input : input.url);
      if (url.includes("rpcids=ESY5D")) {
        heartbeatCalls += 1;
        assert.match(String(init.body), /bard_activity_enabled/);
        return new Response("ok");
      }
      throw new Error(`unexpected fetch ${url}`);
    };
    const tasks = [];
    const response = await worker.fetch(new Request("https://worker.example/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: "Bearer api-test-key", "Content-Type": "application/json" },
      body: "not-json",
    }), env, { waitUntil(task) { tasks.push(task); } });
    await Promise.all(tasks);
    assert.equal(response.status, 400);
    assert.equal(heartbeatCalls, 1);
    assert.equal(store.peek().activity_status, "ok");

    const secondTasks = [];
    await worker.fetch(new Request("https://worker.example/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: "Bearer api-test-key", "Content-Type": "application/json" },
      body: "not-json",
    }), env, { waitUntil(task) { secondTasks.push(task); } });
    await Promise.all(secondTasks);
    assert.equal(heartbeatCalls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("management is disabled when no API key exists", async () => {
  const response = await worker.fetch(new Request("https://worker.example/admin/status"), {});
  assert.equal(response.status, 403);
  assert.match(await response.text(), /請先設定 API_KEYS/);
});

test("a persisted Cookie requires API_KEYS before generation is exposed", async () => {
  const store = memoryCookieStore();
  const imported = await worker.fetch(new Request("https://worker.example/admin/cookie", {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: "Bearer api-test-key" },
    body: JSON.stringify({ auth: "SAPISID=sapi; SID=session" }),
  }), { API_KEYS: "api-test-key", COOKIE_STORE: store });
  assert.equal(imported.status, 200);

  const generated = await worker.fetch(new Request("https://worker.example/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: "hello" }] }),
  }), { COOKIE_STORE: store });
  assert.equal(generated.status, 503);
  assert.equal((await generated.json()).error.code, "api_keys_required_with_cookie");
});

test("Cookie management uses API_KEYS and ignores ADMIN_KEY", async () => {
  const env = {
    API_KEYS: "api-test-key",
    ADMIN_KEY: "admin-test-key",
    COOKIE_STORE: memoryCookieStore(),
  };
  const denied = await worker.fetch(new Request("https://worker.example/admin/status", {
    headers: { Authorization: "Bearer admin-test-key" },
  }), env);
  assert.equal(denied.status, 401);

  const imported = await worker.fetch(new Request("https://worker.example/admin/cookie", {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: "Bearer api-test-key" },
    body: JSON.stringify({ auth: "SAPISID=sapi; SID=session" }),
  }), env);
  assert.equal(imported.status, 200);

  const status = await worker.fetch(new Request("https://worker.example/admin/status", {
    headers: { Authorization: "Bearer api-test-key" },
  }), env);
  assert.equal(status.status, 200);
  assert.equal((await status.json()).cookie.source, "durable_object");
});

test("API key authentication accepts common header variants", async () => {
  const env = { API_KEYS: "asdasd", UPSTREAM_SOCKET: "false", LOG_REQUESTS: "false" };
  for (const headers of [
    { Authorization: "bearer asdasd" },
    { "api-key": " asdasd " },
    { apikey: "asdasd" },
  ]) {
    const response = await worker.fetch(new Request("https://worker.example/v1/models", { headers }), env);
    assert.equal(response.status, 200);
  }

  const denied = await worker.fetch(new Request("https://worker.example/v1/models", {
    headers: { "api-key": "wrong" },
  }), env);
  assert.equal(denied.status, 401);
});

test("anonymous catalog is guest auto routing and does not fetch Gemini", async () => {
  const originalFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = async () => {
    fetches += 1;
    throw new Error("guest catalog must not fetch Gemini");
  };
  try {
    const response = await worker.fetch(new Request("https://worker.example/v1/models"), {
      UPSTREAM_SOCKET: "false",
      LOG_REQUESTS: "false",
    });
    const data = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(data.data.map((model) => model.id), ["gemini-auto", "gemini-auto-thinking"]);
    assert.equal(fetches, 0);

    const refreshed = await worker.fetch(new Request("https://worker.example/v1/models?refresh=1"), {
      UPSTREAM_SOCKET: "false",
      LOG_REQUESTS: "false",
    });
    assert.deepEqual((await refreshed.json()).data.map((model) => model.id), ["gemini-auto", "gemini-auto-thinking"]);
    assert.equal(fetches, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("anonymous generation uses guest auto routing when Gemini catalog discovery fails", async () => {
  const originalFetch = globalThis.fetch;
  internals.__setConnect(null);
  const generateBodies = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.includes("otAQ7b") || url.includes("batchexecute")) {
      throw new Error("guest must not call GetUserStatus");
    }
    if (url.includes("/app")) throw new Error("app unavailable");
    if (url.includes("StreamGenerate")) {
      generateBodies.push(init.body);
      const inner = new Array(43).fill(null);
      inner[4] = [[null, ["hello guest auto"]]];
      inner[42] = "3.5 Flash-Lite";
      const line = JSON.stringify([["wrb.fr", "rpc", JSON.stringify(inner)]]);
      return new Response(`)]}'\n\n${line.length}\n${line}\n`, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  try {
    const response = await worker.fetch(new Request("https://worker.example/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gemini-3.6-flash-thinking",
        messages: [{ role: "user", content: "hello" }],
      }),
    }), { UPSTREAM_SOCKET: "false", LOG_REQUESTS: "false", RETRY_ATTEMPTS: "1" });
    const data = await response.json();
    assert.equal(response.status, 200);
    assert.equal(data.model, "gemini-auto-thinking");
    assert.equal(data.route_status, "auto");
    assert.equal(data.upstream_model, "3.5 Flash-Lite");
    const outer = JSON.parse(new URLSearchParams(generateBodies[0]).get("f.req"));
    const payload = JSON.parse(outer[1]);
    assert.equal(payload[79], 4);
    assert.equal(payload[80], 2);
    assert.equal(payload[64], null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Cookie-store failures fail closed while public health bypasses stored credentials", async () => {
  const store = failingCookieStore();
  const env = {
    API_KEYS: "api-test-key",
    GEMINI_COOKIE: "SAPISID=environment-sapi; SID=environment-session",
    GEMINI_ORIGIN: "data:text/plain,",
    UPSTREAM_SOCKET: "false",
    LOG_REQUESTS: "false",
    COOKIE_STORE: store,
  };

  const health = await worker.fetch(new Request("https://worker.example/health"), env);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).status, "ok");
  assert.equal(store.reads, 0);

  const models = await worker.fetch(new Request("https://worker.example/v1/models", {
    headers: { Authorization: "Bearer api-test-key" },
  }), env);
  assert.equal(models.status, 503);
  assert.equal((await models.json()).error.code, "cookie_store_unavailable");
  assert.equal(store.reads, 1);
});
