import assert from "node:assert/strict";
import test from "node:test";

import worker from "../worker.js";

const internals = globalThis.__GEMINI_WORKER_TEST__;

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
  assert.match(html, /Worker 狀態，一眼看完/);
  assert.match(html, /id="api-key"/);
  assert.doesNotMatch(html, /id="admin-key"|gemini-worker-admin-key|ADMIN_KEY/);
  assert.match(html, /gemini-worker-api-key/);
  assert.doesNotMatch(html, /id="access-key"|gemini-worker-key/);
  assert.doesNotMatch(html, /never-render-this|session-secret/);
  const script = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  assert.doesNotThrow(() => new Function(script));
});

test("root keeps health JSON compatibility for non-browser clients", async () => {
  const env = { GEMINI_ORIGIN: "data:text/plain,", UPSTREAM_SOCKET: "false", LOG_REQUESTS: "false" };
  const root = await worker.fetch(new Request("https://worker.example/"), env);
  const health = await worker.fetch(new Request("https://worker.example/health"), env);
  assert.match(root.headers.get("content-type"), /application\/json/);
  assert.equal((await root.json()).status, "ok");
  assert.equal((await health.json()).status, "ok");
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
    body: JSON.stringify({ auth: "SAPISID=sapi; SID=session; SIDCC=old-cc; NID=old-nid" }),
  }), env);
  assert.equal(imported.status, 200);

  const originalFetch = globalThis.fetch;
  internals.__setConnect(null);
  try {
    globalThis.fetch = async () => {
      const headers = new Headers({ "Content-Type": "text/html" });
      headers.append("Set-Cookie", "SIDCC=rotated-cc; Path=/; Secure; HttpOnly");
      headers.append("Set-Cookie", "NID=rotated-nid; Path=/; Secure");
      headers.append("Set-Cookie", "UNRELATED=ignore-me; Path=/");
      return new Response('{"SNlM0e":"fresh-at","cfb2h":"boq_assistant-bard-web-server_test"}', { headers });
    };

    const refreshed = await worker.fetch(new Request("https://worker.example/admin/cookie/refresh", {
      method: "POST",
      headers: adminHeaders,
    }), env);
    const refreshedText = await refreshed.text();
    const refreshedData = JSON.parse(refreshedText);
    assert.equal(refreshed.status, 200);
    assert.equal(refreshedData.status, "refreshed");
    assert.deepEqual(refreshedData.changed_cookie_names, ["SIDCC", "NID"]);
    assert.ok(refreshedData.cookie.refreshed_at);
    assert.doesNotMatch(refreshedText, /rotated-cc|rotated-nid|ignore-me/);
    assert.match(store.peek().cookie, /SIDCC=rotated-cc/);
    assert.match(store.peek().cookie, /NID=rotated-nid/);
    assert.doesNotMatch(store.peek().cookie, /UNRELATED|ignore-me/);
    assert.equal(store.peek().xsrf_token, "fresh-at");

    const validRecord = structuredClone(store.peek());
    globalThis.fetch = async () => {
      const headers = new Headers({ "Set-Cookie": "SIDCC=rotated-cc; Path=/" });
      return new Response('{"SNlM0e":"newer-at"}', { headers });
    };
    const unchanged = await worker.fetch(new Request("https://worker.example/admin/cookie/refresh", {
      method: "POST",
      headers: adminHeaders,
    }), env);
    assert.equal((await unchanged.json()).status, "no_rotation");
    assert.equal(store.peek().cookie, validRecord.cookie);
    assert.equal(store.peek().updated_at, validRecord.updated_at);
    assert.equal(store.peek().xsrf_token, "newer-at");
    assert.ok(store.peek().refreshed_at);

    globalThis.fetch = async () => new Response("<html>Sign in</html>", {
      headers: { "Set-Cookie": "SIDCC=must-not-save; Path=/" },
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
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("scheduled Cookie refresh automatically persists Google rotations", async () => {
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
    globalThis.fetch = async () => {
      const headers = new Headers({ "Content-Type": "text/html" });
      headers.append("Set-Cookie", "SIDCC=automatic-cc; Path=/; Secure; HttpOnly");
      return new Response('{"SNlM0e":"automatic-at","cfb2h":"boq_assistant-bard-web-server_test"}', { headers });
    };

    const tasks = [];
    await worker.scheduled({}, env, { waitUntil(task) { tasks.push(task); } });
    await Promise.all(tasks);

    assert.match(store.peek().cookie, /SIDCC=automatic-cc/);
    assert.equal(store.peek().xsrf_token, "automatic-at");
    assert.ok(store.peek().refreshed_at);
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
