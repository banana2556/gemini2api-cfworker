import assert from 'node:assert/strict';
import test from 'node:test';
import worker, { GenerationRunner } from '../worker.js';

const api = globalThis.__GEMINI_WORKER_TEST__;
const paths = [
  '/v1/chat/completions', '/v1/responses',
  '/v1beta/models/gemini-auto:generateContent',
  '/v1beta/models/gemini-auto:streamGenerateContent',
];
const request = (path = paths[0], body = '{}', key = 'test-key') => new Request(`https://worker.test${path}`, {
  method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body,
});
function frame(text) {
  const inner = new Array(43).fill(null);
  inner[4] = [[null, [text]]];
  inner[42] = '3.5 Flash-Lite';
  return JSON.stringify([['wrb.fr', 'rpc', JSON.stringify(inner)]]);
}

test('ingress forwards untouched request and response streams before reading Cookie storage', async () => {
  const ids = [];
  let incoming;
  const response = new Response('data: first\n\n', { headers: { 'content-type': 'text/event-stream' } });
  const env = {
    API_KEYS: 'test-key',
    COOKIE_STORE: { idFromName() { throw new Error('ingress must not read Cookie storage'); } },
    GENERATION_RUNNER: {
      newUniqueId() { const id = Symbol(); ids.push(id); return id; },
      get(id) {
        assert.equal(id, ids.at(-1));
        return { async fetch(req) {
          assert.equal(req, incoming);
          assert.equal(req.bodyUsed, false);
          return response;
        } };
      },
    },
  };
  for (const path of paths) {
    incoming = request(path);
    assert.equal(await worker.fetch(incoming, env), response);
    assert.equal(incoming.bodyUsed, false);
  }
  assert.equal(new Set(ids).size, paths.length);
  assert.equal(response.bodyUsed, false);
});

test('ingress rejects invalid keys without allocating a runner or reading the body', async () => {
  let allocated = false;
  const req = request(paths[0], '{}', 'wrong');
  const response = await worker.fetch(req, {
    API_KEYS: 'test-key', GENERATION_RUNNER: { newUniqueId() { allocated = true; } },
  });
  assert.equal(response.status, 401);
  assert.equal(allocated, false);
  assert.equal(req.bodyUsed, false);
});

test('runner failure returns 503 without retrying or falling back into ingress generation', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('must not generate in ingress'); });
  const response = await worker.fetch(request(), {
    LOG_REQUESTS: 'false',
    GENERATION_RUNNER: { newUniqueId: () => 'id', get: () => ({ fetch() { calls++; throw new Error('quota exceeded'); } }) },
  });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, 'generation_runner_unavailable');
  assert.equal(calls, 1);
});

test('health, OPTIONS and model listing stay outside the generation runner', async () => {
  const env = { GENERATION_RUNNER: { newUniqueId() { throw new Error('must not offload this route'); } } };
  for (const [path, method, status] of [['/health', 'GET', 200], ['/v1/models', 'GET', 200], [paths[0], 'OPTIONS', 204]]) {
    assert.equal((await worker.fetch(new Request(`https://worker.test${path}`, { method }), env)).status, status);
  }
  for (const [bindings, expected] of [[env, 'durable_object'], [{}, 'worker']]) {
    const health = await worker.fetch(new Request('https://worker.test/health'), bindings);
    assert.equal((await health.json()).generation_runtime, expected);
  }
});

test('runner authenticates independently and fails closed on Cookie storage errors', async () => {
  const badKey = new GenerationRunner({}, { API_KEYS: 'test-key' });
  assert.equal((await badKey.fetch(request(paths[0], '{}', 'wrong'))).status, 401);
  const unavailable = new GenerationRunner({}, {
    LOG_REQUESTS: 'false', COOKIE_STORE: { idFromName() { throw new Error('offline'); } },
  });
  const failure = await unavailable.fetch(request());
  assert.equal(failure.status, 503);
  assert.equal((await failure.json()).error.code, 'cookie_store_unavailable');
  const cookieWithoutKey = new GenerationRunner({}, {
    COOKIE_STORE: { idFromName: () => 'settings', get: () => ({
      fetch: async () => Response.json({ cookie: 'SAPISID=x; SID=y' }),
    }) },
  });
  const response = await cookieWithoutKey.fetch(request());
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, 'api_keys_required_with_cookie');
  assert.equal((await badKey.fetch(new Request('https://worker.test/admin/status'))).status, 404);
});

test('runner enforces JSON and request-size limits', async () => {
  const runner = new GenerationRunner({}, { LOG_REQUESTS: 'false' });
  assert.equal((await runner.fetch(request(paths[0], '{'))).status, 400);
  const req = request();
  req.headers.set('content-length', String(api.MAX_REQUEST_BYTES + 1));
  assert.equal((await runner.fetch(req)).status, 413);
});

test('all generation APIs execute inside runner without recursive forwarding, including a 71,551-byte chat', async t => {
  api.__setConnect(null);
  let generations = 0;
  t.mock.method(globalThis, 'fetch', async input => {
    if (String(input).includes('/app')) return new Response('{"cfb2h":"boq_assistant-bard-web-server_test"}');
    generations++;
    return new Response(frame('runner answer'));
  });
  const env = {
    API_KEYS: 'test-key', GEMINI_ORIGIN: 'https://runner.test', UPSTREAM_SOCKET: 'false', LOG_REQUESTS: 'false',
    GENERATION_RUNNER: { newUniqueId() { throw new Error('recursive forwarding'); } },
  };
  const runner = new GenerationRunner({}, env);
  const chat = { messages: [{ role: 'user', content: '' }], stream: false };
  chat.messages[0].content = 'a'.repeat(71551 - JSON.stringify(chat).length);
  const body = JSON.stringify(chat);
  assert.equal(new TextEncoder().encode(body).length, 71551);
  const plain = await runner.fetch(request(paths[0], body));
  assert.equal(plain.status, 200);
  assert.equal((await plain.json()).choices[0].message.content, 'runner answer');
  const responses = await runner.fetch(request(paths[1], JSON.stringify({ input: 'hi' })));
  assert.equal(responses.status, 200);
  assert.match(JSON.stringify(await responses.json()), /runner answer/);
  const googleBody = JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] });
  for (const path of paths.slice(2)) {
    const response = await runner.fetch(request(path, googleBody));
    assert.equal(response.status, 200);
    assert.match(await response.text(), /runner answer/);
  }
  assert.equal(generations, 4);
});

test('SSE stays incremental through ingress and cancellation reaches upstream', async t => {
  api.__setConnect(null);
  let cancelled = false, sent = false;
  t.mock.method(globalThis, 'fetch', async input => {
    if (String(input).includes('/app')) return new Response('{"cfb2h":"boq_assistant-bard-web-server_test"}');
    return new Response(new ReadableStream({
      pull(c) {
        if (!sent) { sent = true; c.enqueue(new TextEncoder().encode(frame('first') + '\n')); }
        else return new Promise(() => {});
      },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 }));
  });
  const env = { GEMINI_ORIGIN: 'https://runner-stream.test', UPSTREAM_SOCKET: 'false', LOG_REQUESTS: 'false' };
  env.GENERATION_RUNNER = { newUniqueId: () => 'stream', get: () => new GenerationRunner({}, env) };
  const response = await worker.fetch(request(paths[0], JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], stream: true })), env);
  const reader = response.body.getReader();
  let output = '';
  while (!output.includes('first')) {
    const result = await reader.read();
    assert.equal(result.done, false);
    output += new TextDecoder().decode(result.value);
  }
  await reader.cancel();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(cancelled, true);
});

test('incoming request abort interrupts a quiet SSE producer without waiting for its next write', async () => {
  const disconnect = new AbortController();
  let producerSignal;
  const response = api.sseResponse(async (write, signal) => {
    producerSignal = signal;
    await write('first');
    if (signal.aborted) return;
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
  }, disconnect.signal);
  const reader = response.body.getReader();
  assert.equal(new TextDecoder().decode((await reader.read()).value), 'first');
  disconnect.abort(new Error('client disconnected'));
  await assert.rejects(reader.read(), /client disconnected/);
  assert.equal(producerSignal.aborted, true);

  let started = false;
  const cancelled = api.sseResponse(async () => { started = true; }, disconnect.signal);
  await assert.rejects(cancelled.text(), /client disconnected/);
  assert.equal(started, false);
});
