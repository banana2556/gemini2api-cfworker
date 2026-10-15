import assert from "node:assert/strict";
import test from "node:test";
import worker, { GenerationRunner } from "../worker.js";

const api = globalThis.__GEMINI_WORKER_TEST__;
const build = "boq_gemini-web-uiserver_20261013.29_p0";
const origin = "https://worker.test";
const preview = "https://lh3.googleusercontent.com/example-generated-image=s1024-rj";
const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
const descriptor = { url: preview, alt: "An orange cat", image_id: "image-example", cid: "c_example", rid: "r_example", rcid: "rc_example" };

function imageFrame({ sparse = false, text = "", images = [descriptor], model = "" } = {}) {
  const data = images.map(image => [[null, null, null, [null, null, image.alt, image.url]], [image.image_id]]);
  const rich = sparse ? [{ "8": [data] }] : new Array(8).fill(null);
  if (!sparse) rich[7] = [data];
  const candidate = [];
  candidate[0] = "rc_example"; candidate[1] = [text]; candidate[12] = rich;
  const inner = new Array(43).fill(null);
  inner[1] = ["c_example", "r_example"]; inner[4] = [candidate]; inner[42] = model || null;
  return JSON.stringify([["wrb.fr", "rpc", JSON.stringify(inner)]]);
}

function setup(tag) {
  let record = { ...api.parseAuthPayload("__Secure-1PSID=image-session", true), xsrf_token: "image-at", gemini_bl: build };
  const env = { API_KEYS: "image-api-key", UPSTREAM_SOCKET: "false", RETRY_ATTEMPTS: "1", LOG_REQUESTS: "false",
    GEMINI_ORIGIN: `https://${tag}.example`, COOKIE_STORE: {
      idFromName() { return "settings"; },
      get() { return { async fetch() { return Response.json(record); } }; },
    } };
  const cfg = { ...api.applyStoredAuth(api.getConfig(env), record), worker_origin: origin };
  return { env, cfg, changeSession() { record = { ...record, ...api.parseAuthPayload("__Secure-1PSID=other-session", true) }; } };
}

function statusResponse(mode = 1) {
  const row = []; row[0] = "aaaaaaaaaaaaaaaa"; row[11] = mode === 3 ? "3.1 Pro" : "3.8 Flash"; row[17] = mode;
  const inner = []; inner[14] = 1000; inner[15] = [row];
  return new Response(JSON.stringify([["wrb.fr", "otAQ7b", JSON.stringify(inner)]]));
}

function upstream(tag, streamBody, onGeneration, mode = 1) {
  return async (input, init = {}) => {
    const url = new URL(String(input));
    assert.equal(url.hostname, `${tag}.example`);
    if (url.pathname.endsWith("/app")) return new Response(JSON.stringify({ cfb2h: build, SNlM0e: "fresh-image-at" }));
    if (url.searchParams.get("rpcids") === "otAQ7b") return statusResponse(mode);
    if (url.pathname.endsWith("/StreamGenerate")) {
      onGeneration?.(init);
      return new Response(streamBody, { headers: { "Content-Type": "application/json" } });
    }
    throw new Error("Unexpected upstream request");
  };
}

test("image parsing supports positional and sparse rich content without losing image-only frames", async () => {
  for (const sparse of [false, true]) {
    const raw = imageFrame({ sparse });
    const frame = api.parseGeminiLine(raw);
    assert.deepEqual(frame.texts, []);
    assert.equal(frame.images.length, 1);
    assert.deepEqual(frame.images[0], descriptor);
    const frames = [];
    for await (const entry of api.readGeminiFrames(new Response(raw))) frames.push(entry);
    assert.equal(frames.length, 1);
    assert.equal(frames[0].images[0].url, preview);
  }
});

test("image parsing rejects arbitrary hosts, non-HTTPS URLs and caps attachment counts", () => {
  const invalid = ["http://lh3.googleusercontent.com/image", "https://example.com/image", "https://lh3.googleusercontent.com.evil.example/image", "https://user:password@lh3.googleusercontent.com/image", "https://lh3.googleusercontent.com:8443/image", "data:image/png;base64,aA=="];
  for (const url of invalid) assert.deepEqual(api.parseGeminiLine(imageFrame({ images: [{ ...descriptor, url }] })).images, []);
  const images = Array.from({ length: 40 }, (_, index) => ({ ...descriptor, image_id: `img-${index}` }));
  assert.equal(api.parseGeminiLine(imageFrame({ images })).images.length, 16);
});

test("generation remembers conversation identifiers from earlier metadata-only frames", async t => {
  const { cfg } = setup("metadata-frames");
  const metadata = JSON.stringify([["wrb.fr", "rpc", JSON.stringify([null, ["c_example", "r_example"]])]]);
  const outer = JSON.parse(imageFrame());
  const inner = JSON.parse(outer[0][2]);
  inner[1] = null;
  outer[0][2] = JSON.stringify(inner);
  const frames = metadata + "\n" + JSON.stringify(outer);
  t.mock.method(globalThis, "fetch", upstream("metadata-frames", frames));
  const result = await api.generateResult(cfg, "Generate a cat", 1, 1);
  assert.equal(result.images[0].cid, "c_example");
  assert.equal(result.images[0].rid, "r_example");
  let images;
  for await (const _delta of api.generateStream(cfg, "Generate a cat", 1, 1, null, null, null, null, null, value => { images = value; })) {}
  assert.equal(images[0].cid, "c_example");
  assert.equal(images[0].rid, "r_example");
});

for (const stream of [false, true]) {
  test(`completion returns image-only output ${stream ? "as SSE" : "as JSON"} without guest fallback or duplicate attachments`, async t => {
    const tag = stream ? "image-stream" : "image-json";
    const { env } = setup(tag);
    let generations = 0;
    t.mock.method(globalThis, "fetch", upstream(tag, imageFrame() + "\n" + imageFrame({ sparse: true }), init => {
      generations += 1;
      assert.match(new Headers(init.headers).get("Cookie"), /__Secure-1PSID=image-session/);
    }));
    const response = await worker.fetch(new Request(origin + "/v1/chat/completions", {
      method: "POST", headers: { Authorization: "Bearer image-api-key", "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "Generate an orange cat image" }], stream }),
    }), env);
    assert.equal(response.status, 200);
    let message;
    if (stream) {
      const raw = await response.text();
      assert.match(raw, /data: \[DONE\]/);
      assert.doesNotMatch(raw, /empty response|upstream error|without usable content/);
      const chunks = raw.split("\n").filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6)));
      const imageChunks = chunks.filter(chunk => chunk.choices[0].delta.images);
      assert.equal(imageChunks.length, 1);
      message = imageChunks[0].choices[0].delta;
    } else {
      message = (await response.json()).choices[0].message;
    }
    assert.equal(generations, 1);
    assert.equal(message.images.length, 1);
    assert.equal(message.images[0].type, "image_url");
    assert.match(message.images[0].image_url.url, /^https:\/\/worker\.test\/v1\/images\/[A-Za-z0-9_-]+$/);
    assert.match(message.content, /!\[Generated image 1\]/);
    assert.ok(message.content.includes(message.images[0].image_url.url));
    assert.ok(!message.content.includes("image-api-key"));
    assert.ok(!message.content.includes("image-session"));
    assert.ok(!message.content.includes("lh3.googleusercontent.com"));
  });
}

test("text and images remain together, including completions with tools enabled", async t => {
  const { env } = setup("image-tools");
  t.mock.method(globalThis, "fetch", upstream("image-tools", imageFrame({ text: "Here is your cat." })));
  const response = await worker.fetch(new Request(origin + "/v1/chat/completions", {
    method: "POST", headers: { Authorization: "Bearer image-api-key", "Content-Type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: "Generate a cat" }], stream: true,
      tools: [{ type: "function", function: { name: "example", parameters: {} } }] }),
  }), env);
  const raw = await response.text();
  assert.match(raw, /Here is your cat/);
  assert.match(raw, /"images":\[/);
  assert.match(raw, /data: \[DONE\]/);
});

test("encrypted links reject tampering, expiry, another origin, changed keys and changed sessions", async () => {
  const { cfg } = setup("tokens");
  const images = await api.completionImages(cfg, [descriptor]);
  const token = new URL(images[0].image_url.url).pathname.split("/").at(-1);
  assert.equal((await api.decodeImageLink(cfg, token)).image.url, preview);
  assert.equal(await api.decodeImageLink(cfg, token.slice(0, 30) + (token[30] === "A" ? "B" : "A") + token.slice(31)), null);
  assert.equal(await api.decodeImageLink({ ...cfg, worker_origin: "https://another.test" }, token), null);
  assert.equal(await api.decodeImageLink({ ...cfg, api_keys: ["changed-key"] }, token), null);
  assert.equal(await api.decodeImageLink({ ...cfg, cookie: "__Secure-1PSID=other", cookie_jar: api.importedCookieJar("__Secure-1PSID=other"), session_key: null }, token), null);
  const now = Date.now;
  try {
    Date.now = () => now() + 3600001;
    assert.equal(await api.decodeImageLink(cfg, token), null);
  } finally { Date.now = now; }
});

test("image proxy downloads authenticated RPC originals and follows bounded text URL hops without leaking cookies", async t => {
  const { env, cfg } = setup("original-image");
  cfg.gemini_bl = "boq_gemini-web-uiserver_generation-build";
  cfg.gemini_session_id = "generation-session";
  const [image] = await api.completionImages(cfg, [descriptor]);
  const calls = [];
  t.mock.method(globalThis, "fetch", async (input, init = {}) => {
    const url = new URL(String(input));
    calls.push(url);
    if (url.searchParams.get("rpcids") === "c8o8Fe") {
      assert.equal(url.searchParams.get("bl"), "boq_gemini-web-uiserver_generation-build");
      assert.equal(url.searchParams.get("f.sid"), "generation-session");
      assert.match(new Headers(init.headers).get("Cookie"), /image-session/);
      const request = JSON.parse(new URLSearchParams(init.body).get("f.req"));
      const payload = JSON.parse(request[0][0][1]);
      assert.deepEqual(payload[1], ["r_example", "rc_example", "c_example", null, ""]);
      assert.deepEqual(payload[0][1], ["image-example", 0]);
      return new Response(JSON.stringify([["wrb.fr", "c8o8Fe", JSON.stringify(["https://lh3.googleusercontent.com/original"])]]));
    }
    assert.equal(url.hostname, "lh3.googleusercontent.com");
    assert.equal(new Headers(init.headers).has("Cookie"), false);
    assert.equal(new Headers(init.headers).has("Authorization"), false);
    assert.equal(init.redirect, "manual");
    if (url.pathname === "/original=d-I") {
      assert.equal(url.searchParams.get("alr"), "yes");
      return new Response("https://lh3.googleusercontent.com/resolved", { headers: { "Content-Type": "text/plain" } });
    }
    if (url.pathname === "/resolved") return new Response("https://lh3.googleusercontent.com/final", { headers: { "Content-Type": "text/plain" } });
    assert.equal(url.pathname, "/final");
    return new Response(png, { headers: { "Content-Type": "image/png" } });
  });
  // No bearer header is needed for a valid capability URL; browser <img> uses it.
  const response = await worker.fetch(new Request(image.image_url.url), env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/png");
  assert.equal(response.headers.get("set-cookie"), null);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), png);
  assert.equal(calls.length, 4);
});

test("failed original RPC falls back to a 2048px preview and HEAD cancels the download", async t => {
  const { env, cfg } = setup("preview-image");
  const [image] = await api.completionImages(cfg, [descriptor]);
  let cancelled = false;
  t.mock.method(globalThis, "fetch", async input => {
    const url = new URL(String(input));
    if (url.searchParams.get("rpcids") === "c8o8Fe") return new Response("no original", { status: 403 });
    assert.equal(url.href, preview.replace("s1024-rj", "s2048-rj"));
    return new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { "Content-Type": "image/jpeg" } });
  });
  const response = await worker.fetch(new Request(image.image_url.url, { method: "HEAD" }), env);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "");
  assert.equal(cancelled, true);
});

test("preview redirects can authenticate at Google's verified image mediator without sending cookies to the CDN", async t => {
  const { env, cfg } = setup("mediated-image");
  const [image] = await api.completionImages(cfg, [{ ...descriptor, image_id: "" }]);
  const calls = [];
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const url = new URL(String(input));
    calls.push(url.hostname);
    const headers = new Headers(init.headers);
    if (url.hostname === "work.fife.usercontent.google.com") {
      assert.match(headers.get("Cookie"), /__Secure-1PSID=image-session/);
      assert.equal(headers.has("Authorization"), false);
      return new Response(null, { status: 302, headers: { Location: "https://lh3.googleusercontent.com/authenticated-image" } });
    }
    assert.equal(headers.has("Cookie"), false);
    if (url.pathname === "/authenticated-image") return new Response(png, { headers: { "Content-Type": "image/png" } });
    return new Response(null, { status: 302, headers: { Location: "https://work.fife.usercontent.google.com/image" } });
  });
  const response = await worker.fetch(new Request(image.image_url.url), env);
  assert.equal(response.status, 200);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), png);
  assert.deepEqual(calls, ["lh3.googleusercontent.com", "work.fife.usercontent.google.com", "lh3.googleusercontent.com"]);
});

test("image-generation placeholders are removed while ordinary text is preserved", () => {
  assert.equal(api.cleanText("Here it is\nhttps://googleusercontent.com/image_generation_content/0\n"), "Here it is");
  assert.equal(api.cleanText("http://googleusercontent.com/card_content/3\n"), "");
});

test("proxy rejects forged links, arbitrary redirects, HTML and oversized image responses", async t => {
  const { env, cfg, changeSession } = setup("rejected-image");
  const [image] = await api.completionImages(cfg, [{ ...descriptor, image_id: "" }]);
  let mode = "redirect";
  let calls = 0;
  t.mock.method(globalThis, "fetch", async input => {
    calls += 1;
    assert.equal(new URL(String(input)).hostname, "lh3.googleusercontent.com");
    if (mode === "redirect") return new Response(null, { status: 302, headers: { Location: "https://attacker.example/image" } });
    if (mode === "html") return new Response("<html>not an image</html>", { headers: { "Content-Type": "text/html" } });
    return new Response(png, { headers: { "Content-Type": "image/png", "Content-Length": String(api.MAX_IMAGE_BYTES + 1) } });
  });
  assert.equal((await worker.fetch(new Request(image.image_url.url), env)).status, 502);
  mode = "html";
  assert.equal((await worker.fetch(new Request(image.image_url.url), env)).status, 502);
  mode = "large";
  assert.equal((await worker.fetch(new Request(image.image_url.url), env)).status, 413);
  const before = calls;
  const forged = origin + "/v1/images/" + "A".repeat(80);
  assert.equal((await worker.fetch(new Request(forged), env)).status, 404);
  changeSession();
  assert.equal((await worker.fetch(new Request(image.image_url.url), env)).status, 404);
  assert.equal(calls, before);
});

test("image downloads execute inside the generation runner without recursive forwarding", async t => {
  const { env, cfg } = setup("offloaded-image");
  const [image] = await api.completionImages(cfg, [{ ...descriptor, image_id: "" }]);
  let runners = 0;
  env.GENERATION_RUNNER = {
    newUniqueId() { runners += 1; return "image-runner"; },
    get() { return new GenerationRunner({}, env); },
  };
  t.mock.method(globalThis, "fetch", async () => new Response(png, { headers: { "Content-Type": "image/png" } }));
  const response = await worker.fetch(new Request(image.image_url.url), env);
  assert.equal(response.status, 200);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), png);
  assert.equal(runners, 1);
});

test("cancelling an image download reaches the upstream reader", async t => {
  const { env, cfg } = setup("cancel-image");
  const [image] = await api.completionImages(cfg, [{ ...descriptor, image_id: "" }]);
  let cancelled = false;
  t.mock.method(globalThis, "fetch", async () => new Response(new ReadableStream({
    pull(controller) { controller.enqueue(png); }, cancel() { cancelled = true; },
  }, { highWaterMark: 0 }), { headers: { "Content-Type": "image/png" } }));
  const response = await worker.fetch(new Request(image.image_url.url), env);
  const reader = response.body.getReader();
  await reader.read();
  await reader.cancel();
  assert.equal(cancelled, true);
});

test("a headerless image download stops when its body exceeds 20 MiB", async t => {
  const { env, cfg } = setup("bounded-image");
  const [image] = await api.completionImages(cfg, [{ ...descriptor, image_id: "" }]);
  let cancelled = false;
  t.mock.method(globalThis, "fetch", async () => new Response(new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024)); },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 }), { headers: { "Content-Type": "image/png" } }));
  const response = await worker.fetch(new Request(image.image_url.url), env);
  await assert.rejects(response.arrayBuffer(), error => error.code === "resource_limit");
  assert.equal(cancelled, true);
});

function imageRequest(body, key = "image-api-key") {
  return new Request(origin + "/v1/images/generations", {
    method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("the image API uses native tool routing and an account-discovered Pro ID without a completion request", async t => {
  const { env } = setup("native-image-api");
  const prompt = "An orange cat beside a window";
  let generations = 0;
  t.mock.method(globalThis, "fetch", upstream("native-image-api", imageFrame(), init => {
    generations += 1;
    const request = JSON.parse(new URLSearchParams(init.body).get("f.req"));
    const inner = JSON.parse(request[1]);
    assert.equal(inner[0][0], prompt);
    assert.deepEqual(inner[17], [[1]]);
    assert.equal(inner[49], 14);
    assert.equal(inner[79], 3);
    assert.equal(JSON.parse(new Headers(init.headers).get("x-goog-ext-525001261-jspb"))[4], "aaaaaaaaaaaaaaaa");
  }, 3));
  const response = await worker.fetch(imageRequest({ model: "gemini-nano-banana-pro", prompt }), env);
  const data = await response.json();
  assert.equal(response.status, 200);
  assert.equal(data.model, "gemini-nano-banana-pro");
  assert.equal(data.image_mode, "tool_14");
  assert.equal(data.aspect_ratio, "auto");
  assert.equal(data.upstream_model, "gemini-3.1-pro");
  assert.equal(data.data.length, 1);
  assert.match(data.data[0].url, /^https:\/\/worker\.test\/v1\/images\//);
  assert.ok(data.data[0].expires_at);
  assert.equal(data.choices, undefined);
  assert.equal(generations, 1);
});

test("image API returns Base64 data and supports a bounded number of images", async t => {
  const { env } = setup("base64-image-api");
  let generations = 0;
  const generate = upstream("base64-image-api", imageFrame(), () => { generations += 1; }, 3);
  t.mock.method(globalThis, "fetch", async (input, init) => {
    if (new URL(String(input)).hostname === "lh3.googleusercontent.com") return new Response(png, { headers: { "Content-Type": "image/png" } });
    return generate(input, init);
  });
  const response = await worker.fetch(imageRequest({ model: "gemini-nano-banana-pro", prompt: "A cat", n: 2, response_format: "b64_json" }), env);
  const data = await response.json();
  assert.equal(response.status, 200);
  assert.equal(data.data.length, 2);
  for (const image of data.data) {
    assert.deepEqual(new Uint8Array(Buffer.from(image.b64_json, "base64")), png);
    assert.equal(image.mime_type, "image/png");
    assert.equal(image.url, undefined);
  }
  assert.equal(generations, 2);
});

test("image model discovery advertises only the images endpoint and completion rejects this alias", async t => {
  const { env } = setup("image-model-catalog");
  let generations = 0;
  t.mock.method(globalThis, "fetch", upstream("image-model-catalog", imageFrame(), () => { generations += 1; }, 3));
  const models = await worker.fetch(new Request(origin + "/v1/models", { headers: { Authorization: "Bearer image-api-key" } }), env);
  const image = (await models.json()).data.find(model => model.id === "gemini-nano-banana-pro");
  assert.equal(image.display_name, "Nano Banana Pro");
  assert.deepEqual(image.supported_aspect_ratios, ["auto", "1:1", "9:16", "3:4", "4:3", "16:9"]);
  assert.deepEqual(image.supported_endpoints, ["/v1/images/generations"]);
  assert.equal(image.owned_by, "gemini-web-adapter");
  const response = await worker.fetch(new Request(origin + "/v1/chat/completions", {
    method: "POST", headers: { Authorization: "Bearer image-api-key", "Content-Type": "application/json" },
    body: JSON.stringify({ model: "gemini-nano-banana-pro", messages: [{ role: "user", content: "cat" }] }),
  }), env);
  assert.equal(response.status, 400);
  assert.match((await response.json()).error.message, /\/v1\/images\/generations/);
  assert.equal(generations, 0);
});

test("invalid image requests fail before model discovery or upstream generation", async t => {
  const { env } = setup("invalid-image-api");
  let fetches = 0;
  t.mock.method(globalThis, "fetch", async () => { fetches += 1; throw new Error("Must validate before upstream"); });
  for (const body of [null, [], {}, { prompt: " " }, { prompt: 1 }, { prompt: "cat", model: "gemini-3.8-flash" },
    { prompt: "cat", n: 0 }, { prompt: "cat", n: 5 }, { prompt: "cat", n: 1.5 }, { prompt: "cat", response_format: "binary" },
    { prompt: "cat", stream: true }, { prompt: "cat", size: "1024x1024" }, { prompt: "cat", quality: "hd" }]) {
    assert.equal((await worker.fetch(imageRequest(body), env)).status, 400);
  }
  assert.equal(fetches, 0);
});

for (const [ratio, option] of [["1:1", 61], ["9:16", 59], ["3:4", 60], ["4:3", 62], ["16:9", 63]]) {
  test(`image API sends the Web image settings for ${ratio} without adding prompt instructions`, async t => {
    const tag = `ratio-${option}`;
    const { env } = setup(tag);
    const prompt = "A ceramic teapot on a wooden table";
    let calls = 0;
    t.mock.method(globalThis, "fetch", upstream(tag, imageFrame(), init => {
      calls += 1;
      const inner = JSON.parse(JSON.parse(new URLSearchParams(init.body).get("f.req"))[1]);
      assert.equal(inner[0][0], prompt);
      assert.deepEqual(inner[0][9], [null, null, null, null, null, null, [null, [null, ratio]]]);
      assert.deepEqual(inner[55], [[option]]);
      assert.deepEqual(inner[17], [[1]]);
      assert.equal(inner[49], 14);
      assert.equal(inner[79], 3);
      assert.equal(inner[0][3], null);
    }, 3));
    const response = await worker.fetch(imageRequest({ model: "gemini-nano-banana-pro", prompt, aspect_ratio: ratio }), env);
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.aspect_ratio, ratio);
    assert.equal(result.data.length, 1);
    assert.equal(calls, 1);
  });
}

test("auto ratio leaves upstream defaults intact and explicit ratio keeps attached files and route IDs", async t => {
  const { env } = setup("auto-image-ratio");
  t.mock.method(globalThis, "fetch", upstream("auto-image-ratio", imageFrame(), init => {
    const inner = JSON.parse(JSON.parse(new URLSearchParams(init.body).get("f.req"))[1]);
    assert.equal(inner[55], null);
    assert.equal(inner[0].length, 7);
  }, 3));
  assert.equal((await worker.fetch(imageRequest({ prompt: "A cat", aspect_ratio: "auto" }), env)).status, 200);
  const raw = api.buildPayload("Describe this", 3, 2, ["/uploaded-file"], { 64: "route", 75: 3 }, "4:3");
  const inner = JSON.parse(JSON.parse(new URLSearchParams(raw).get("f.req"))[1]);
  assert.deepEqual(inner[0][3], [[["/uploaded-file", 1], "image.png"]]);
  assert.equal(inner[0][9][6][1][1], "4:3");
  assert.equal(inner[64], "route");
  assert.equal(inner[75], 3);
  assert.equal(inner[80], 2);
});

test("unsupported or malformed ratios are rejected before upstream requests", async t => {
  const { env } = setup("invalid-aspect");
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls += 1; throw new Error("Must not fetch upstream"); });
  for (const ratio of ["21:9", "2:3", "16/9", " 16:9 ", "", 1, { value: "16:9" }, ["16:9"], "constructor", "__proto__"]) {
    const response = await worker.fetch(imageRequest({ prompt: "A cat", aspect_ratio: ratio }), env);
    assert.equal(response.status, 400);
    assert.match((await response.json()).error.message, /aspect_ratio/);
  }
  assert.equal(calls, 0);
});

test("image API requires a login and an available Pro route", async t => {
  t.mock.method(globalThis, "fetch", upstream("no-pro-image-api", imageFrame()));
  const guest = await worker.fetch(imageRequest({ prompt: "cat" }), { API_KEYS: "image-api-key" });
  assert.equal(guest.status, 401);
  assert.equal((await guest.json()).error.code, "image_login_required");
  const { env } = setup("no-pro-image-api");
  const unavailable = await worker.fetch(imageRequest({ prompt: "cat" }), env);
  assert.equal(unavailable.status, 503);
  assert.equal((await unavailable.json()).error.code, "image_model_unavailable");
});

test("image API reports text-only refusals and never falls back to ordinary chat or guest generation", async t => {
  const { env } = setup("refused-image-api");
  let generations = 0;
  const refusal = imageFrame({ images: [], text: "Image generation is not available for this account." });
  t.mock.method(globalThis, "fetch", upstream("refused-image-api", refusal, () => { generations += 1; }, 3));
  const response = await worker.fetch(imageRequest({ prompt: "cat" }), env);
  assert.equal(response.status, 422);
  const data = await response.json();
  assert.equal(data.error.code, "image_not_generated");
  assert.match(data.error.provider_message, /not available/);
  assert.equal(generations, 1);
});

test("failed image tool generation is attempted once and remains inside the runner", async t => {
  const { env } = setup("failed-native-image");
  let generations = 0;
  let runners = 0;
  env.GENERATION_RUNNER = {
    newUniqueId() { runners += 1; return "native-image-runner"; },
    get() { return new GenerationRunner({}, env); },
  };
  const generate = upstream("failed-native-image", "", undefined, 3);
  t.mock.method(globalThis, "fetch", async (input, init) => {
    if (String(input).includes("/StreamGenerate")) {
      generations += 1;
      assert.match(new Headers(init.headers).get("Cookie"), /image-session/);
      return new Response("rejected", { status: 403 });
    }
    return generate(input, init);
  });
  const response = await worker.fetch(imageRequest({ prompt: "cat" }), env);
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error.code, "image_generation_failed");
  assert.equal(generations, 1);
  assert.equal(runners, 1);
});
