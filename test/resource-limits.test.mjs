import assert from 'node:assert/strict';
import test from 'node:test';
import worker from '../worker.js';

const api = globalThis.__GEMINI_WORKER_TEST__;
const enc = new TextEncoder();
const tick = () => new Promise(resolve => setImmediate(resolve));

function frame(text) {
  const inner = new Array(43).fill(null);
  inner[4] = [[null, [text]]];
  inner[42] = '3.5 Flash-Lite';
  return JSON.stringify([['wrb.fr', 'rpc', JSON.stringify(inner)]]);
}

function socketSource(packets) {
  let reads = 0, closed = false;
  const readable = new ReadableStream({
    pull(c) {
      if (reads === packets.length) { c.close(); return; }
      c.enqueue(enc.encode(packets[reads++]));
    },
  }, { highWaterMark: 0 });
  const socket = { readable, writable: new WritableStream(), close() { closed = true; } };
  return { connect: () => socket, get reads() { return reads; }, get closed() { return closed; } };
}

test('socket emits partial HTTP chunks without draining the upstream ahead of its consumer', async () => {
  const source = socketSource([
    'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n',
    '8\r\nab', 'cd', 'ef', 'gh\r\n0\r\n\r\n',
  ]);
  const response = await api.socketHttp(source.connect, 'https://example.test', { timeoutMs: 0 });
  const reader = response.body.getReader();
  try {
    const first = await reader.read();
    assert.equal(new TextDecoder().decode(first.value), 'ab');
    await tick();
    assert.ok(source.reads <= 3, `read ${source.reads} packets before consumer requested them`);
  } finally { await reader.cancel(); }
  assert.ok(source.closed);
});

test('socket reports truncated chunks instead of accepting partial responses', async () => {
  const source = socketSource(['HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n8\r\nab']);
  const response = await api.socketHttp(source.connect, 'https://example.test', { timeoutMs: 0 });
  await assert.rejects(response.text(), /incomplete|truncated/i);
  assert.ok(source.closed);
});

test('socket accepts large Google-style response headers split across packets', async () => {
  const csp = "script-src " + 'a'.repeat(20 * 1024);
  const wire = `HTTP/1.1 200 OK\r\nContent-Security-Policy: ${csp}\r\nContent-Length: 2\r\n\r\nOK`;
  const source = socketSource(wire.match(/[\s\S]{1,1024}/g));
  const response = await api.socketHttp(source.connect, 'https://example.test', { timeoutMs: 0 });
  assert.equal(response.headers.get('content-security-policy'), csp);
  assert.equal(await response.text(), 'OK');
  assert.ok(source.closed);
});

test('socket permits the header budget boundary and rejects aggregate overflow', async () => {
  const prefix = 'HTTP/1.1 200 OK\r\nX-Large: ';
  const suffix = '\r\nContent-Length: 0\r\n\r\n';
  const size = 65536 - enc.encode(prefix + suffix).length;
  const source = socketSource([prefix + 'a'.repeat(size) + suffix]);
  const response = await api.socketHttp(source.connect, 'https://example.test', { timeoutMs: 0 });
  assert.equal(await response.text(), '');
  assert.ok(source.closed);

  // Each header is short, but their combined size exceeds the total budget.
  const oversized = socketSource(['HTTP/1.1 200 OK\r\n' + ('X-Pad: ' + 'a'.repeat(1024) + '\r\n').repeat(65) + '\r\n']);
  await assert.rejects(api.socketHttp(oversized.connect, 'https://example.test', { timeoutMs: 0 }),
    e => e.code === 'resource_limit' && /response headers/.test(e.message));
  assert.ok(oversized.closed);
});

test('long trailers share a bounded header budget while chunk-size lines remain small', async () => {
  const source = socketSource(['HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n1\r\nx\r\n0\r\nX-Trailer: ' + 'a'.repeat(12 * 1024) + '\r\n\r\n']);
  const response = await api.socketHttp(source.connect, 'https://example.test', { timeoutMs: 0 });
  assert.equal(await response.text(), 'x');
  assert.ok(source.closed);

  const badChunk = socketSource(['HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n1;' + 'x'.repeat(8192) + '\r\nx\r\n0\r\n\r\n']);
  const rejected = await api.socketHttp(badChunk.connect, 'https://example.test', { timeoutMs: 0 });
  await assert.rejects(rejected.text(), e => e.code === 'resource_limit' && /8192/.test(e.message));
  assert.ok(badChunk.closed);
});

test('non-stream generation consumes body frames without response.text()', async t => {
  api.__setConnect(null);
  const text = '你好 🌍 cumulative answer';
  const raw = frame('你好') + '\n' + frame(text);
  const bytes = enc.encode(raw);
  t.mock.method(globalThis, 'fetch', async input => {
    if (String(input).includes('/app')) return new Response('{"cfb2h":"boq_assistant-bard-web-server_test"}');
    let offset = 0;
    return {
      ok: true, status: 200, headers: new Headers(),
      body: new ReadableStream({ pull(c) {
        if (offset === bytes.length) return c.close();
        c.enqueue(bytes.subarray(offset, offset += Math.min(7, bytes.length - offset)));
      } }),
      text() { throw new Error('whole-response buffering is forbidden'); },
    };
  });
  const cfg = api.getConfig({ GEMINI_ORIGIN: 'https://incremental.test', UPSTREAM_SOCKET: 'false', RETRY_ATTEMPTS: '1', LOG_REQUESTS: 'false' });
  const result = await api.generateResult(cfg, 'hi', 4, 1);
  assert.equal(result.text, text);
  assert.equal(result.actualModel, '3.5 Flash-Lite');
  assert.equal(result.rawLength, raw.length);
});

test('breaking generation cancels the upstream reader', async t => {
  let cancelled = false;
  api.__setConnect(null);
  t.mock.method(globalThis, 'fetch', async input => {
    if (String(input).includes('/app')) return new Response('{"cfb2h":"boq_assistant-bard-web-server_test"}');
    return new Response(new ReadableStream({
      pull(c) { c.enqueue(enc.encode(frame('answer') + '\n')); },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 }));
  });
  const cfg = api.getConfig({ GEMINI_ORIGIN: 'https://cancel.test', UPSTREAM_SOCKET: 'false', LOG_REQUESTS: 'false' });
  for await (const delta of api.generateStream(cfg, 'hi', 4, 1)) { assert.equal(delta, 'answer'); break; }
  assert.ok(cancelled);
});

test('health does not fetch an upstream app page', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response(''); });
  const response = await worker.fetch(new Request('https://worker.test/health'), { UPSTREAM_SOCKET: 'false', GEMINI_ORIGIN: 'https://health.test' });
  assert.equal(response.status, 200);
  assert.equal(calls, 0);
});

test('oversized chat bodies are rejected before JSON parsing', async () => {
  let cancelled = false;
  const body = new ReadableStream({
    pull(c) { c.enqueue(new Uint8Array(1024 * 1024).fill(32)); },
    cancel() { cancelled = true; },
  });
  // Header must be checked before attempting to drain an unbounded stream.
  const request = new Request('https://worker.test/v1/chat/completions', {
    method: 'POST', body, duplex: 'half', headers: { 'content-length': String(100 * 1024 * 1024) },
  });
  const response = await worker.fetch(request, { LOG_REQUESTS: 'false' });
  assert.equal(response.status, 413);
  assert.ok(cancelled);
});

test('SSE pauses a producer until the client reads and signals client cancellation', async () => {
  let writes = 0, signal;
  const response = api.sseResponse(async (write, abortSignal) => {
    signal = abortSignal;
    for (let i = 0; i < 100; i++) { writes++; await write(`data: ${i}\n\n`); }
  });
  await tick();
  const reader = response.body.getReader();
  try {
    assert.equal(writes, 1);
    assert.match(new TextDecoder().decode((await reader.read()).value), /data: 0/);
  } finally { await reader.cancel(); }
  await tick();
  assert.ok(signal?.aborted);
});

test('SSE cancellation interrupts a pending upstream read', async t => {
  api.__setConnect(null);
  let cancelled = false, sent = false;
  t.mock.method(globalThis, 'fetch', async input => {
    if (String(input).includes('/app')) return new Response('{"cfb2h":"boq_assistant-bard-web-server_test"}');
    return new Response(new ReadableStream({
      pull(c) {
        if (!sent) { sent = true; c.enqueue(enc.encode(frame('first') + '\n')); }
        else return new Promise(() => {});
      },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 }));
  });
  const cfg = api.getConfig({ GEMINI_ORIGIN: 'https://pending.test', UPSTREAM_SOCKET: 'false', LOG_REQUESTS: 'false' });
  const response = api.sseResponse(async (write, signal) => {
    for await (const delta of api.generateStream(cfg, 'hi', 4, 1, null, null, null, null, signal)) await write(delta);
  });
  const reader = response.body.getReader();
  assert.equal(new TextDecoder().decode((await reader.read()).value), 'first');
  await tick();
  await reader.cancel();
  await tick();
  assert.ok(cancelled);
});

test('socket handles fragmented size lines, CRLF, UTF-8, extensions and trailers', async () => {
  const wire = 'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n6;ext=yes\r\n你好\r\n1\r\n!\r\n0\r\nX-Trailer: ok\r\n\r\n';
  const bytes = enc.encode(wire);
  let offset = 0, closed = false;
  const response = await api.socketHttp(() => ({
    readable: new ReadableStream({ pull(c) {
      if (offset === bytes.length) return c.close();
      c.enqueue(bytes.subarray(offset, ++offset));
    } }, { highWaterMark: 0 }),
    writable: new WritableStream(), close() { closed = true; },
  }), 'https://example.test', { timeoutMs: 0 });
  assert.equal(await response.text(), '你好!');
  assert.ok(closed);
});

test('socket reads content-length and EOF-delimited responses and rejects malformed framing', async () => {
  for (const [headers, payload, expected] of [
    ['Content-Length: 3', 'abcEXCESS', 'abc'],
    ['', 'abc', 'abc'],
    ['Content-Length: 0', '', ''],
  ]) {
    const source = socketSource([`HTTP/1.1 200 OK\r\n${headers ? headers + '\r\n' : ''}\r\n`, payload]);
    const response = await api.socketHttp(source.connect, 'https://example.test', { timeoutMs: 0 });
    assert.equal(await response.text(), expected);
    assert.ok(source.closed);
  }
  for (const payload of ['invalid\r\n', '1\r\naXX\r\n0\r\n\r\n']) {
    const source = socketSource(['HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n' + payload]);
    const response = await api.socketHttp(source.connect, 'https://example.test', { timeoutMs: 0 });
    await assert.rejects(response.text(), /invalid/);
    assert.ok(source.closed);
  }
});

test('bounded readers cancel headerless bodies at the byte limit', async () => {
  let reads = 0, cancelled = false;
  const response = new Response(new ReadableStream({
    pull(c) { reads++; c.enqueue(enc.encode('12345')); },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 }));
  await assert.rejects(api.readLimitedBytes(response, 8, 413), e => e.code === 'resource_limit' && e.status === 413);
  assert.equal(reads, 2);
  assert.ok(cancelled);
});

test('oversized inline images fail before Base64 decoding or upload', async t => {
  let decoded = false;
  t.mock.method(globalThis, 'atob', () => { decoded = true; throw new Error('must not decode'); });
  await assert.rejects(api.resolveImages({ cookie: 'session' }, [{ b64: 'A'.repeat(4 * Math.ceil(api.MAX_IMAGE_BYTES / 3) + 4) }]),
    e => e.code === 'resource_limit' && e.status === 413);
  assert.equal(decoded, false);
});

test('oversized remote image is cancelled without draining it', async t => {
  let cancelled = false;
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({
    cancel() { cancelled = true; },
  }), { headers: { 'content-length': String(api.MAX_IMAGE_BYTES + 1) } }));
  await assert.rejects(api.resolveImages({ cookie: 'session', request_timeout_sec: 10 }, [{ url: 'https://image.test/file' }]),
    e => e.code === 'resource_limit' && e.status === 413);
  assert.ok(cancelled);
});

test('oversized discovery fails once without fallback or generation', async t => {
  api.__setConnect(null);
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return new Response('', { headers: { 'content-length': String(100 * 1024 * 1024) } });
  });
  const cfg = api.getConfig({ GEMINI_ORIGIN: 'https://large-discovery.test', UPSTREAM_SOCKET: 'false', LOG_REQUESTS: 'false' });
  cfg.cookie = 'SAPISID=x; SID=y';
  for (const operation of [() => api.getModelCatalog(cfg), () => api.generateResult(cfg, 'hi', 4, 1), () => api.getPageTokens(cfg)]) {
    const before = calls;
    await assert.rejects(operation(), e => e.code === 'resource_limit');
    assert.equal(calls, before + 1);
  }
});

test('oversized generation frame is cancelled without retrying or switching to guest', async t => {
  api.__setConnect(null);
  let calls = 0, cancelled = false;
  t.mock.method(globalThis, 'fetch', async input => {
    if (String(input).includes('/app')) return new Response('{"cfb2h":"boq_assistant-bard-web-server_test"}');
    calls++;
    return new Response(new ReadableStream({
      start(c) { c.enqueue(enc.encode('x'.repeat(api.MAX_FRAME_CHARS + 1))); },
      cancel() { cancelled = true; },
    }));
  });
  const cfg = api.getConfig({ GEMINI_ORIGIN: 'https://large-frame.test', UPSTREAM_SOCKET: 'false', LOG_REQUESTS: 'false' });
  cfg.cookie = 'SAPISID=x; SID=y'; cfg.xsrf_token = 'at';
  await assert.rejects(api.generateResult(cfg, 'hi', 4, 1), e => e.code === 'resource_limit');
  assert.equal(calls, 1);
  assert.ok(cancelled);
});

test('each generation frame uses one outer and one inner JSON parse', async t => {
  const raw = frame('small') + '\n' + frame('larger answer');
  const original = JSON.parse;
  let parses = 0;
  t.mock.method(JSON, 'parse', (...args) => { parses++; return original(...args); });
  const frames = [];
  for await (const result of api.readGeminiFrames(new Response(raw))) frames.push(result);
  assert.equal(frames.length, 2);
  assert.equal(parses, 4);
});

test('chat supports incremental SSE, empty tools, non-stream output and tool-call SSE', async t => {
  api.__setConnect(null);
  let output = '你好 world';
  t.mock.method(globalThis, 'fetch', async input => String(input).includes('/app')
    ? new Response('{"cfb2h":"boq_assistant-bard-web-server_test"}')
    : new Response(frame(output.slice(0, 2)) + '\n' + frame(output)));
  const env = { GEMINI_ORIGIN: 'https://chat.test', UPSTREAM_SOCKET: 'false', LOG_REQUESTS: 'false' };
  const request = opts => worker.fetch(new Request('https://worker.test/v1/chat/completions', {
    method: 'POST', body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], ...opts }),
  }), env);
  const plain = await (await request({ stream: false })).json();
  assert.equal(plain.choices[0].message.content, output);
  for (const opts of [{ stream: true }, { stream: true, tools: [] }]) {
    const raw = await (await request(opts)).text();
    assert.match(raw, /data: \[DONE\]/);
    const events = raw.split('\n').filter(l => l.startsWith('data: {')).map(l => JSON.parse(l.slice(6)));
    assert.equal(events.slice(0, -1).map(e => e.choices[0].delta.content || '').join(''), output);
    assert.ok(events.length >= 3);
  }
  output = '```tool_call\n{"name":"weather","arguments":{"city":"Taipei"}}\n```';
  const raw = await (await request({ stream: true, tools: [{ type: 'function', function: { name: 'weather', parameters: { type: 'object' } } }] })).text();
  const event = JSON.parse(raw.split('\n')[0].slice(6));
  assert.equal(event.choices[0].finish_reason, 'tool_calls');
  assert.equal(event.choices[0].delta.tool_calls[0].function.name, 'weather');
});

test('cancelling SSE during discovery stops the app-page read before generation', async t => {
  api.__setConnect(null);
  let requested;
  const started = new Promise(resolve => { requested = resolve; });
  let cancelled = false, calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    requested();
    return new Response(new ReadableStream({
      pull() { return new Promise(() => {}); },
      cancel() { cancelled = true; },
    }));
  });
  const cfg = api.getConfig({ GEMINI_ORIGIN: 'https://cancel-discovery.test', UPSTREAM_SOCKET: 'false', LOG_REQUESTS: 'false' });
  const response = api.sseResponse(async (write, signal) => {
    for await (const delta of api.generateStream(cfg, 'hi', 4, 1, null, null, null, null, signal)) await write(delta);
  });
  await started;
  await tick();
  await response.body.cancel();
  await tick();
  assert.ok(cancelled);
  assert.equal(calls, 1);
});
