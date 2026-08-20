import assert from "node:assert/strict";
import test from "node:test";

import "../worker.js";

const {
  MODELS,
  authCacheKey,
  buildHeaders,
  buildPayload,
  extractActualModel,
  extractGeminiBl,
  getConfig,
  getUrl,
  messagesToPrompt,
  parseAuthPayload,
  parseGoogleFunctionCalls,
  parseToolCalls,
  resolveModel,
  routeStatus,
  toOpenAIStreamToolCallDeltas,
} = globalThis.__GEMINI_WORKER_TEST__;

test("existing Flash aliases remain stable", () => {
  const models = [
    "gemini-3.6-flash",
    "gemini-3.6-flash-lite",
    "gemini-3.6-flash-thinking",
    "gemini-3.6-flash-thinking-lite",
  ];

  assert.deepEqual(Object.keys(MODELS).filter((name) => name.startsWith("gemini-3.6-flash")).sort(), models.sort());
  for (const model of models) assert.equal(resolveModel(model, "gemini-3.6-flash").name, model);
});

test("upstream Gemini 3.7 Flash alias is available", () => {
  assert.equal(resolveModel("gemini-3.7-flash", "gemini-3.6-flash").name, "gemini-3.7-flash");
});

test("current Gemini Web route includes model ID, mode, and thinking level", () => {
  const rm = resolveModel("gemini-3.1-pro", "gemini-3.6-flash");
  const outer = JSON.parse(new URLSearchParams(buildPayload("PING", rm.modeId, rm.thinkMode, null, rm.extra)).get("f.req"));
  const inner = JSON.parse(outer[1]);

  assert.equal(inner[59], "9d8ca3786ebdfbea");
  assert.equal(inner[64], "e6fa609c3fa255c0");
  assert.equal(inner[75], 3);
  assert.equal(inner[79], 3);
  assert.equal(inner[80], 1);
});

test("raw Cookie and gemini-auth JSON preserve account metadata", async () => {
  const raw = "NID=534=value=with=equals; SAPISID=sapi/value; __Secure-1PSID=session; S=a=b";
  const parsed = parseAuthPayload(raw, true);
  assert.equal(parsed.cookie, "SAPISID=sapi/value; __Secure-1PSID=session");
  assert.equal(parsed.sapisid, "sapi/value");
  assert.equal(parsed.removed_cookie_count, 2);

  const cfg = getConfig({
    GEMINI_COOKIE: JSON.stringify({
      cookie: raw,
      sapisid: "sapi/value",
      auth_user: 2,
      xsrf_token: "xsrf-token",
      gemini_bl: "boq_assistant-bard-web-server_test",
    }),
  });
  assert.equal(cfg.auth_user, "2");
  assert.equal(cfg.xsrf_token, "xsrf-token");
  assert.match(getUrl(cfg), /\/u\/2\/_\/BardChatUi/);
  const headers = await buildHeaders(cfg);
  assert.equal(headers["X-Goog-AuthUser"], "2");
  assert.equal(headers.Referer, "https://gemini.google.com/u/2/app");
});

test("Cookie validation rejects an incomplete login session", () => {
  assert.throws(() => parseAuthPayload("SAPISID=value", true), /工作階段 Cookie/);
});

test("page-token cache identity changes with the Cookie", async () => {
  const a = await authCacheKey(getConfig({ GEMINI_COOKIE: "SAPISID=a; SID=session-a" }));
  const b = await authCacheKey(getConfig({ GEMINI_COOKIE: "SAPISID=b; SID=session-b" }));
  assert.notEqual(a, b);
});

test("Gemini build is extracted from the app page", () => {
  assert.equal(
    extractGeminiBl('<script>"cfb2h":"boq_assistant-bard-web-server_20260806.01_p0"</script>'),
    "boq_assistant-bard-web-server_20260806.01_p0",
  );
});

test("actual upstream model and fallback routing are extracted from StreamGenerate", () => {
  const inner = new Array(43).fill(null);
  inner[42] = "3.5 Flash-Lite";
  const raw = JSON.stringify([["wrb.fr", "rpc", JSON.stringify(inner)]]);

  assert.equal(extractActualModel(raw), "3.5 Flash-Lite");
  assert.equal(routeStatus(6, "3.5 Flash-Lite"), "matched");
  assert.equal(routeStatus(3, "3.5 Flash-Lite"), "fallback");
  assert.equal(routeStatus(3, "3.1 Pro"), "matched");
  assert.equal(routeStatus(4, "3.5 Flash-Lite"), "auto");
});

const tools = [
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Write content to a local file.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
          overwrite: { type: "boolean" },
        },
        required: ["path", "content"],
      },
    },
  },
];

test("OpenAI tool prompt uses DSML and explains local tool execution", () => {
  const [prompt] = messagesToPrompt([{ role: "user", content: "Update README.md" }], tools, "auto");

  assert.match(prompt, /<\|DSML\|tool_calls>/);
  assert.match(prompt, /CDATA/);
  assert.match(prompt, /local environment/i);
  assert.match(prompt, /write_file/);
});

test("DSML tool calls are parsed into OpenAI tool_calls with typed arguments", () => {
  const [clean, toolCalls] = parseToolCalls(
    [
      "Preparing the edit.",
      '<|DSML|tool_calls>',
      '  <|DSML|invoke name="write_file">',
      '    <|DSML|parameter name="path"><![CDATA[README.md]]></|DSML|parameter>',
      '    <|DSML|parameter name="content"><![CDATA[# Title\\n<keep>]]></|DSML|parameter>',
      '    <|DSML|parameter name="overwrite">true</|DSML|parameter>',
      '  </|DSML|invoke>',
      '</|DSML|tool_calls>',
    ].join("\n"),
    tools,
  );

  assert.equal(clean, "Preparing the edit.");
  assert.equal(toolCalls.length, 1);
  assert.equal(toolCalls[0].type, "function");
  assert.equal(toolCalls[0].function.name, "write_file");
  assert.deepEqual(JSON.parse(toolCalls[0].function.arguments), {
    path: "README.md",
    content: "# Title\\n<keep>",
    overwrite: true,
  });
});

test("legacy tool_call code fences still parse", () => {
  const [clean, toolCalls] = parseToolCalls(
    [
      "```tool_call",
      '{"name":"write_file","arguments":{"path":"README.md","content":"ok"}}',
      "```",
    ].join("\n"),
    tools,
  );

  assert.equal(clean, "");
  assert.equal(toolCalls.length, 1);
  assert.equal(toolCalls[0].function.name, "write_file");
});

test("streaming tool_calls include OpenAI-compatible indexes", () => {
  const deltas = toOpenAIStreamToolCallDeltas([
    {
      id: "call_1",
      type: "function",
      function: { name: "write_file", arguments: "{\"path\":\"README.md\",\"content\":\"ok\"}" },
    },
  ]);

  assert.equal(deltas[0].index, 0);
  assert.equal(deltas[0].id, "call_1");
  assert.equal(deltas[0].type, "function");
});

test("Google function calling parser accepts DSML tool calls", () => {
  const [clean, calls] = parseGoogleFunctionCalls(
    [
      '<|DSML|tool_calls>',
      '  <|DSML|invoke name="write_file">',
      '    <|DSML|parameter name="path"><![CDATA[README.md]]></|DSML|parameter>',
      '    <|DSML|parameter name="content"><![CDATA[ok]]></|DSML|parameter>',
      '  </|DSML|invoke>',
      '</|DSML|tool_calls>',
    ].join("\n"),
    tools,
  );

  assert.equal(clean, "");
  assert.deepEqual(calls, [{ name: "write_file", args: { path: "README.md", content: "ok" } }]);
});
