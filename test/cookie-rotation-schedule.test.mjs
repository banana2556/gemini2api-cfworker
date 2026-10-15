import assert from "node:assert/strict";
import test from "node:test";

import worker, { CookieStore } from "../worker.js";

const api = globalThis.__GEMINI_WORKER_TEST__;
const start = Date.parse("2026-10-15T02:40:31.000Z");
const hour = 60 * 60 * 1000;
const iso = (ms) => new Date(ms).toISOString();

function authRecord(lifetime = 100 * hour) {
  const auth = api.parseAuthPayload("__Secure-1PSID=schedule-session; __Secure-1PSIDTS=schedule-ts", true);
  for (const cookie of auth.cookie_jar) {
    cookie.updated_at = start;
    cookie.expires = Math.floor((start + (cookie.name === "__Secure-1PSIDTS" ? lifetime : 200 * hour)) / 1000);
  }
  return {
    ...auth,
    updated_at: iso(start),
    last_rotation_attempt_at: iso(start),
    next_rotation_at: iso(start + 10 * 60000),
  };
}

function durableStore(record) {
  let saved = structuredClone(record);
  const storage = {
    async get() { return structuredClone(saved); },
    async put(_key, value) { saved = structuredClone(value); },
    async transaction(run) { return run(storage); },
  };
  const object = new CookieStore({ storage });
  const stub = { fetch(input, init) { return object.fetch(new Request(input, init)); } };
  return {
    peek() { return structuredClone(saved); },
    idFromName() { return "settings"; },
    get() { return stub; },
  };
}

test("known expiry rotates at 95% and the deadline does not slide between checks", () => {
  const auth = authRecord();
  const expected = iso(start + 95 * hour);
  assert.equal(api.cookieRotationPlan(auth, start + hour).next_rotation_at, expected);
  assert.equal(api.cookieRotationPlan(auth, start + 40 * hour).next_rotation_at, expected);
  assert.equal(api.cookieRotationPlan(auth, start + 94 * hour).policy, "expiry_95_percent");
});

test("an imported expiry without an issuance time uses the fixed import time", () => {
  const auth = authRecord();
  for (const cookie of auth.cookie_jar) cookie.updated_at = 0;
  assert.equal(api.cookieRotationPlan(auth, start + hour).next_rotation_at, iso(start + 95 * hour));
  assert.equal(api.cookieRotationPlan(auth, start + 30 * hour).next_rotation_at, iso(start + 95 * hour));
});

test("the earliest PSIDTS expiry determines rotation and ignores unrelated cookies", () => {
  const auth = authRecord();
  auth.cookie_jar.push({ ...auth.cookie_jar[1], name: "__Secure-3PSIDTS", expires: (start + 80 * hour) / 1000 });
  auth.cookie_jar.push({ ...auth.cookie_jar[1], name: "NID", expires: (start + hour) / 1000 });
  auth.cookie_jar.push({ ...auth.cookie_jar[1], domain: "unrelated.google.com", host_only: true, expires: (start + 2 * hour) / 1000 });
  assert.equal(api.cookieRotationPlan(auth, start + hour).next_rotation_at, iso(start + 76 * hour));
  auth.cookie_jar = auth.cookie_jar.filter((cookie) => !cookie.name.endsWith("PSIDTS"));
  assert.equal(api.cookieRotationPlan(auth, start + hour).next_rotation_at, iso(start + 190 * hour));
});

test("unknown expiry preserves the fallback schedule and failures retry in ten minutes", () => {
  const auth = authRecord();
  const failed = { ...auth, last_rotation_attempt_at: iso(start + hour), rotation_error: "rotate_http_503" };
  assert.deepEqual(api.cookieRotationPlan(failed, start + hour), {
    policy: "retry", next_rotation_at: iso(start + hour + 10 * 60000),
  });
  for (const cookie of auth.cookie_jar) cookie.expires = null;
  assert.deepEqual(api.cookieRotationPlan(auth, start), {
    policy: "unknown_expiry", next_rotation_at: auth.next_rotation_at,
  });
  auth.next_rotation_at = iso(start + 95 * hour);
  assert.equal(api.cookieRotationPlan(auth, start).next_rotation_at, iso(start + 10 * 60000 + 15000));
});

test("an overdue unchanged PSIDTS retries without postponing until the SID expires", () => {
  const auth = authRecord();
  auth.last_rotation_attempt_at = iso(start + 101 * hour);
  assert.deepEqual(api.cookieRotationPlan(auth, start + 101 * hour), {
    policy: "retry", next_rotation_at: iso(start + 101 * hour + 10 * 60000),
  });
  auth.cookie_jar[1].updated_at = start + 101 * hour;
  auth.cookie_jar[1].expires = (start + 201 * hour) / 1000;
  assert.equal(api.cookieRotationPlan(auth, start + 101 * hour).next_rotation_at, iso(start + 196 * hour));
});

test("Durable Object migrates a legacy due time and claims only at the 95% deadline", async () => {
  const store = durableStore(authRecord());
  const originalNow = Date.now;
  try {
    let now = start + 11 * 60000;
    Date.now = () => now;
    const claim = () => store.get().fetch("https://cookie-store.internal/maintenance/claim", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "rotation", scheduled: true }),
    });
    const deferred = await (await claim()).json();
    assert.equal(deferred.claimed, false);
    assert.equal(deferred.reason, "not_due");
    assert.equal(store.peek().next_rotation_at, iso(start + 95 * hour));
    assert.equal(store.peek().last_rotation_attempt_at, iso(start));
    now = start + 95 * hour;
    assert.equal((await (await claim()).json()).claimed, true);
    assert.equal(store.peek().last_rotation_attempt_at, iso(now));
    assert.equal((await (await claim()).json()).reason, "in_progress");
  } finally {
    Date.now = originalNow;
  }
});

test("Cron waits for expiry-based rotation while manual refresh can still renew immediately", async () => {
  const store = durableStore(authRecord());
  const env = { API_KEYS: "schedule-test-key", COOKIE_STORE: store, UPSTREAM_SOCKET: "false", LOG_REQUESTS: "false" };
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  let rotations = 0;
  try {
    const now = start + 11 * 60000;
    Date.now = () => now;
    globalThis.fetch = async (input) => {
      assert.match(String(input), /RotateCookies/);
      rotations += 1;
      return new Response("ok", { headers: {
        "Set-Cookie": `__Secure-1PSIDTS=renewed-schedule-ts; Domain=.google.com; Path=/; Max-Age=360000; Secure; HttpOnly`,
      } });
    };
    const tasks = [];
    await worker.scheduled({}, env, { waitUntil(task) { tasks.push(task); } });
    await Promise.all(tasks);
    assert.equal(rotations, 0);
    assert.equal(store.peek().next_rotation_at, iso(start + 95 * hour));
    // Manual refresh always attempts rotation, even though its expiry deadline
    // is still far away. Page verification stays separate from this assertion.
    globalThis.fetch = async (input) => {
      if (String(input).includes("RotateCookies")) {
        rotations += 1;
        return new Response("ok", { headers: { "Set-Cookie": "__Secure-1PSIDTS=renewed-schedule-ts; Domain=.google.com; Path=/; Max-Age=360000; Secure; HttpOnly" } });
      }
      return new Response('<a aria-label="Sign in" href="https://accounts.google.com/ServiceLogin">Sign in</a>');
    };
    await worker.fetch(new Request("https://worker.example/admin/cookie/refresh", {
      method: "POST", headers: { Authorization: "Bearer schedule-test-key" },
    }), env);
    assert.equal(rotations, 1);
    assert.match(store.peek().cookie, /__Secure-1PSIDTS=renewed-schedule-ts/);
    assert.equal(store.peek().next_rotation_at, iso(now + 95 * hour));
  } finally {
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
  }
});
